/**
 * Renderer-safe DSP: energy-based voice activity detection and WAV encoding.
 * Pure functions over Float32 frames — no node imports, fully testable.
 * The VAD interface leaves room for an ML model (Silero) later.
 */

export interface VadOptions {
  /** RMS energy above this counts as speech. */
  threshold?: number;
  /** Consecutive speech frames required to open an utterance. */
  minSpeechFrames?: number;
  /** Consecutive silent frames that close an utterance (hangover). */
  hangoverFrames?: number;
}

export type VadEvent = 'speech_start' | 'speech_end' | null;

export function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  return Math.sqrt(sum / (frame.length || 1));
}

/** Feed frames in order; emits speech_start / speech_end transitions. */
export class EnergyVad {
  private threshold: number;
  private minSpeechFrames: number;
  private hangoverFrames: number;
  private speechRun = 0;
  private silenceRun = 0;
  private inSpeech = false;

  constructor(opts: VadOptions = {}) {
    this.threshold = opts.threshold ?? 0.015;
    this.minSpeechFrames = opts.minSpeechFrames ?? 3;
    this.hangoverFrames = opts.hangoverFrames ?? 15;
  }

  isSpeaking(): boolean {
    return this.inSpeech;
  }

  reset(): void {
    this.speechRun = 0;
    this.silenceRun = 0;
    this.inSpeech = false;
  }

  push(frame: Float32Array): VadEvent {
    const loud = rms(frame) >= this.threshold;
    if (loud) {
      this.speechRun++;
      this.silenceRun = 0;
      if (!this.inSpeech && this.speechRun >= this.minSpeechFrames) {
        this.inSpeech = true;
        return 'speech_start';
      }
    } else {
      this.silenceRun++;
      this.speechRun = 0;
      if (this.inSpeech && this.silenceRun >= this.hangoverFrames) {
        this.inSpeech = false;
        return 'speech_end';
      }
    }
    return null;
  }
}

/** Concatenate Float32 frames and encode as WAV PCM16 mono. */
export function encodeWavPcm16(frames: Float32Array[], sampleRate: number): Uint8Array {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const dataBytes = total * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i++) {
      const clamped = Math.max(-1, Math.min(1, frame[i]!));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}
