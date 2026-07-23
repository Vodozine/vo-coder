import { useCallback, useEffect, useRef, useState } from 'react';
import { EnergyVad, encodeWavPcm16 } from '@vo-coder/voice/dsp';
import { useStore } from '../state/store';
import { MicCapture } from './capture';

export type LiveState = 'off' | 'listening' | 'processing' | 'speaking';

/**
 * Push-to-talk + live chat, both built on the same 16 kHz capture.
 * Live chat is half-duplex: the mic goes deaf while our own TTS plays (no
 * echo-cancellation exists for system TTS, which plays outside Chromium), so
 * the assistant can never hear itself and loop. Speaking during generation
 * still injects gracefully; interrupt playback by clicking Live or typing.
 */
export function useVoice(appendToInput: (text: string) => void) {
  const [recording, setRecording] = useState(false);
  const [live, setLive] = useState<LiveState>('off');
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const pttRef = useRef<MicCapture | null>(null);
  const liveRef = useRef<{
    capture: MicCapture;
    vad: EnergyVad;
    utterance: Float32Array[];
    preroll: Float32Array[];
    collecting: boolean;
    muted: boolean;
  } | null>(null);
  const liveStateRef = useRef<LiveState>('off');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastSpokenIdRef = useRef<number>(0);
  /** Mic stays deaf until this time — set when our own TTS stops playing. */
  const muteUntilRef = useRef<number>(0);

  const send = useStore((s) => s.send);

  const setLiveState = (state: LiveState) => {
    liveStateRef.current = state;
    setLive(state);
  };

  // ---- push-to-talk ----
  const pttStart = useCallback(async () => {
    if (pttRef.current || liveStateRef.current !== 'off') return;
    setVoiceError(null);
    try {
      pttRef.current = await MicCapture.start();
      setRecording(true);
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const pttStop = useCallback(async () => {
    const capture = pttRef.current;
    if (!capture) return;
    pttRef.current = null;
    setRecording(false);
    const frames = await capture.stop();
    const totalMs = (frames.reduce((n, f) => n + f.length, 0) / 16000) * 1000;
    if (totalMs < 250) return; // accidental tap
    const wav = encodeWavPcm16(frames, 16000);
    const result = await window.vo.voiceTranscribe(wav.buffer as ArrayBuffer);
    if (result.ok && result.text) appendToInput(result.text);
    else if (!result.ok) setVoiceError(result.error ?? 'Transcription failed');
  }, [appendToInput]);

  // ---- live chat ----
  const stopPlayback = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    void window.vo.voiceStopSpeak();
  }, []);

  const handleUtterance = useCallback(
    async (frames: Float32Array[]) => {
      const totalMs = (frames.reduce((n, f) => n + f.length, 0) / 16000) * 1000;
      if (totalMs < 300) {
        if (liveStateRef.current === 'processing') setLiveState('listening');
        return;
      }
      setLiveState('processing');
      const wav = encodeWavPcm16(frames, 16000);
      const result = await window.vo.voiceTranscribe(wav.buffer as ArrayBuffer);
      if (liveStateRef.current === 'off') return;
      if (result.ok && result.text) {
        // Whisper labels non-speech as bracketed noise — never send those.
        const cleaned = result.text
          .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, '')
          .trim();
        if (cleaned.length < 2) {
          setLiveState('listening');
          return;
        }
        void send(cleaned); // busy session → graceful injection
      } else if (!result.ok) {
        setVoiceError(result.error ?? 'Transcription failed');
      }
      setLiveState('listening');
    },
    [send],
  );

  const liveStop = useCallback(async () => {
    const session = liveRef.current;
    liveRef.current = null;
    setLiveState('off');
    stopPlayback();
    if (session) await session.capture.stop();
  }, [stopPlayback]);

  const liveStart = useCallback(async () => {
    if (liveRef.current) return;
    setVoiceError(null);
    try {
      const vad = new EnergyVad();
      const state = {
        vad,
        utterance: [] as Float32Array[],
        preroll: [] as Float32Array[],
        collecting: false,
        muted: false,
        capture: null as unknown as MicCapture,
      };
      state.capture = await MicCapture.start((frame) => {
        // Half-duplex: while our own TTS plays (plus a short decay tail), the
        // mic mostly hears the speakers — treating that as speech loops the
        // assistant into talking to itself. Browser echo-cancellation can't
        // help for system TTS (it plays outside Chromium), so we go deaf
        // instead. Interrupt during playback by clicking Live or typing.
        if (liveStateRef.current === 'speaking' || Date.now() < muteUntilRef.current) {
          if (!state.muted) {
            state.muted = true;
            state.collecting = false;
            state.utterance = [];
            state.preroll = [];
            state.vad.reset();
          }
          return;
        }
        state.muted = false;
        // Keep ~0.6s of preroll so utterance starts aren't clipped.
        state.preroll.push(frame);
        if (state.preroll.length > 10) state.preroll.shift();
        if (state.collecting) state.utterance.push(frame);
        const event = state.vad.push(frame);
        if (event === 'speech_start') {
          state.collecting = true;
          state.utterance = [...state.preroll];
        } else if (event === 'speech_end' && state.collecting) {
          state.collecting = false;
          const frames = state.utterance;
          state.utterance = [];
          void handleUtterance(frames);
        }
      });
      liveRef.current = state;
      setLiveState('listening');
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : String(err));
      setLiveState('off');
    }
  }, [handleUtterance]);

  const liveToggle = useCallback(() => {
    if (liveStateRef.current === 'off') void liveStart();
    else void liveStop();
  }, [liveStart, liveStop]);

  // Speak each finished assistant reply while live mode is on.
  const activeSession = useStore((s) =>
    s.activeSessionId ? s.sessions[s.activeSessionId] : undefined,
  );
  useEffect(() => {
    if (liveStateRef.current === 'off' || !activeSession) return;
    const last = activeSession.messages[activeSession.messages.length - 1];
    if (!last || last.role !== 'assistant' || last.streaming) return;
    if (last.id <= lastSpokenIdRef.current) return;
    const text = (last.segments ?? [])
      .filter((seg) => seg.kind === 'text')
      .map((seg) => (seg as { text: string }).text)
      .join(' ')
      .trim();
    if (!text) return;
    lastSpokenIdRef.current = last.id;
    setLiveState('speaking');
    // Room-decay grace after playback so the mic doesn't catch the TTS tail.
    const resumeListening = () => {
      muteUntilRef.current = Date.now() + 600;
      if (liveStateRef.current === 'speaking') setLiveState('listening');
    };
    void window.vo.voiceSpeak(text).then((result) => {
      if (liveStateRef.current === 'off') return;
      if (!result.ok) {
        setVoiceError(result.error);
        resumeListening();
        return;
      }
      if (result.output.kind === 'audio') {
        const blob = new Blob([result.output.data], { type: result.output.mimeType });
        const audio = new Audio(URL.createObjectURL(blob));
        audioRef.current = audio;
        audio.onended = () => {
          audioRef.current = null;
          resumeListening();
        };
        void audio.play();
      } else {
        // Native (system) TTS finished speaking synchronously.
        resumeListening();
      }
    });
  }, [activeSession]);

  // Teardown on unmount.
  useEffect(
    () => () => {
      void pttRef.current?.stop();
      void liveStop();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return { recording, live, voiceError, pttStart, pttStop, liveToggle };
}
