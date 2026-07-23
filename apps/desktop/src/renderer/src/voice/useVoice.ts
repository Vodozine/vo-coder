import { useCallback, useEffect, useRef, useState } from 'react';
import { EnergyVad, encodeWavPcm16 } from '@vo-coder/voice/dsp';
import { useStore } from '../state/store';
import { MicCapture } from './capture';

export type LiveState = 'off' | 'listening' | 'processing' | 'speaking';

/**
 * Push-to-talk + live chat, both built on the same 16 kHz capture.
 * Live-chat barge-in reuses the injection/abort primitive: user speech during
 * playback stops TTS, aborts generation, and the utterance goes in as the
 * next message.
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
  } | null>(null);
  const liveStateRef = useRef<LiveState>('off');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastSpokenIdRef = useRef<number>(0);

  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);

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
        void send(result.text); // busy session → graceful injection
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
        capture: null as unknown as MicCapture,
      };
      state.capture = await MicCapture.start((frame) => {
        // Keep ~0.6s of preroll so utterance starts aren't clipped.
        state.preroll.push(frame);
        if (state.preroll.length > 10) state.preroll.shift();
        if (state.collecting) state.utterance.push(frame);
        const event = state.vad.push(frame);
        if (event === 'speech_start') {
          // Barge-in: user talking over playback/generation.
          if (liveStateRef.current === 'speaking') {
            stopPlayback();
            void stop();
          }
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
  }, [handleUtterance, stop, stopPlayback]);

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
    void window.vo.voiceSpeak(text).then((result) => {
      if (liveStateRef.current === 'off') return;
      if (!result.ok) {
        setVoiceError(result.error);
        setLiveState('listening');
        return;
      }
      if (result.output.kind === 'audio') {
        const blob = new Blob([result.output.data], { type: result.output.mimeType });
        const audio = new Audio(URL.createObjectURL(blob));
        audioRef.current = audio;
        audio.onended = () => {
          audioRef.current = null;
          if (liveStateRef.current === 'speaking') setLiveState('listening');
        };
        void audio.play();
      } else {
        // Native (system) TTS finished speaking synchronously.
        if (liveStateRef.current === 'speaking') setLiveState('listening');
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
