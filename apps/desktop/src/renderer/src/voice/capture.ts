/** Mic capture at 16 kHz mono Float32 frames — one format for every STT backend. */
export class MicCapture {
  private constructor(
    private stream: MediaStream,
    private ctx: AudioContext,
    private processor: ScriptProcessorNode,
    private gain: GainNode,
  ) {}

  frames: Float32Array[] = [];
  onFrame: ((frame: Float32Array) => void) | null = null;

  static async start(onFrame?: (frame: Float32Array) => void): Promise<MicCapture> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const ctx = new AudioContext({ sampleRate: 16000 });
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(1024, 1, 1);
    // Muted sink keeps the processor pumping without echoing the mic.
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const capture = new MicCapture(stream, ctx, processor, gain);
    capture.onFrame = onFrame ?? null;
    processor.onaudioprocess = (e) => {
      const frame = new Float32Array(e.inputBuffer.getChannelData(0));
      capture.frames.push(frame);
      capture.onFrame?.(frame);
    };
    source.connect(processor);
    processor.connect(gain);
    gain.connect(ctx.destination);
    return capture;
  }

  sampleRate(): number {
    return this.ctx.sampleRate;
  }

  takeFrames(): Float32Array[] {
    const taken = this.frames;
    this.frames = [];
    return taken;
  }

  async stop(): Promise<Float32Array[]> {
    this.processor.disconnect();
    this.gain.disconnect();
    for (const track of this.stream.getTracks()) track.stop();
    await this.ctx.close().catch(() => {});
    return this.frames;
  }
}
