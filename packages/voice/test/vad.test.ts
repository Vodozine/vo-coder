import { describe, expect, it } from 'vitest';
import { EnergyVad, encodeWavPcm16, rms } from '../src/dsp.ts';

const FRAME = 320; // 20 ms at 16 kHz

function silence(): Float32Array {
  return new Float32Array(FRAME);
}
function tone(amplitude = 0.3): Float32Array {
  const f = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) f[i] = Math.sin((i / FRAME) * Math.PI * 8) * amplitude;
  return f;
}

describe('EnergyVad', () => {
  it('opens after minSpeechFrames of speech and closes after the hangover', () => {
    const vad = new EnergyVad({ threshold: 0.02, minSpeechFrames: 3, hangoverFrames: 5 });
    const events: Array<{ i: number; ev: string }> = [];
    const frames = [
      ...Array.from({ length: 10 }, silence),
      ...Array.from({ length: 20 }, () => tone()),
      ...Array.from({ length: 10 }, silence),
    ];
    frames.forEach((f, i) => {
      const ev = vad.push(f);
      if (ev) events.push({ i, ev });
    });
    expect(events).toEqual([
      { i: 12, ev: 'speech_start' }, // 3rd loud frame (indices 10,11,12)
      { i: 34, ev: 'speech_end' }, // 5th silent frame after speech (30..34)
    ]);
  });

  it('ignores blips shorter than minSpeechFrames', () => {
    const vad = new EnergyVad({ threshold: 0.02, minSpeechFrames: 3, hangoverFrames: 5 });
    const frames = [silence(), tone(), silence(), tone(), silence(), silence()];
    const events = frames.map((f) => vad.push(f)).filter(Boolean);
    expect(events).toEqual([]);
  });

  it('brief pauses inside speech do not close the utterance', () => {
    const vad = new EnergyVad({ threshold: 0.02, minSpeechFrames: 2, hangoverFrames: 6 });
    const frames = [
      ...Array.from({ length: 4 }, () => tone()),
      ...Array.from({ length: 3 }, silence), // shorter than hangover
      ...Array.from({ length: 4 }, () => tone()),
      ...Array.from({ length: 7 }, silence),
    ];
    const events = frames.map((f) => vad.push(f)).filter(Boolean);
    expect(events).toEqual(['speech_start', 'speech_end']);
  });
});

describe('WAV encoding', () => {
  it('produces a valid PCM16 mono RIFF header and correct sizes', () => {
    const frames = [tone(0.5), tone(0.5)];
    const wav = encodeWavPcm16(frames, 16000);
    expect(wav.length).toBe(44 + FRAME * 2 * 2);
    const text = (start: number, len: number) =>
      String.fromCharCode(...wav.slice(start, start + len));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    const view = new DataView(wav.buffer);
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(FRAME * 2 * 2);
  });

  it('clamps out-of-range samples instead of wrapping', () => {
    const hot = new Float32Array([2, -2]);
    const wav = encodeWavPcm16([hot], 16000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
  });

  it('rms distinguishes silence from tone', () => {
    expect(rms(silence())).toBe(0);
    expect(rms(tone())).toBeGreaterThan(0.1);
  });
});
