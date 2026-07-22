export interface TranscribeOptions {
  language?: string;
}

export interface SttProvider {
  readonly id: string;
  /** Audio is WAV (PCM16, mono, 16 kHz) — one capture format for every backend. */
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
