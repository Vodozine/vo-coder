export interface TranscribeOptions {
  language?: string;
  /**
   * What the bytes actually are, when they did not come from the mic — a
   * Telegram voice note (Opus) or a clip the user attached. Server-side engines
   * take these as they come; whisper.cpp reads WAV only and says so.
   */
  mimeType?: string;
  fileName?: string;
}

export interface SttProvider {
  readonly id: string;
  /** Audio is WAV (PCM16, mono, 16 kHz) unless opts says otherwise. */
  transcribe(wav: Uint8Array, opts?: TranscribeOptions): Promise<string>;
}

export type TtsOutput =
  /** Encoded audio for the host to play (and to stop, for barge-in). */
  | { kind: 'audio'; data: Uint8Array; mimeType: string }
  /** Spoken natively on this machine (system TTS); stop() cancels it. */
  | { kind: 'native' };

export interface TtsProvider {
  readonly id: string;
  speak(text: string): Promise<TtsOutput>;
  stop(): void;
}

/** One voice installed on this machine, as the local speech engine names it. */
export interface SystemVoice {
  /** Exactly what SelectVoice / `say -v` / `espeak -v` matches on. */
  name: string;
  /** BCP-47-ish tag the engine reported, e.g. "en-US", "is-IS". */
  language?: string;
  gender?: string;
}
