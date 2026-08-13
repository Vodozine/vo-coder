import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SttProvider, TranscribeOptions } from '../types.js';

const pExecFile = promisify(execFile);

export interface WhisperLocalOptions {
  /** Path to a whisper.cpp CLI binary (whisper-cli / main.exe). Spawned as an
   *  external process on purpose — no native Node bindings, no Electron ABI pain. */
  binaryPath: string;
  modelPath: string;
  timeoutMs?: number;
  /** Decode threads; defaults to the machine's cores minus two. */
  threads?: number;
}

export class WhisperLocalStt implements SttProvider {
  readonly id = 'whisper-local';

  constructor(private opts: WhisperLocalOptions) {}

  async transcribe(wav: Uint8Array, transcribeOpts?: TranscribeOptions): Promise<string> {
    // whisper.cpp reads WAV with its own decoder and nothing else. Saying so is
    // the whole fix: handed a Telegram voice note it would otherwise fail deep
    // inside the CLI with a message about a header, which reads like a bug.
    const type = transcribeOpts?.mimeType?.toLowerCase() ?? 'audio/wav';
    if (!/wav|wave|pcm/.test(type)) {
      throw new Error(
        `whisper-local reads WAV only — this clip is ${type}. Point speech→text at a ` +
          'transcription server (Settings → Voice) to accept it as it is.',
      );
    }
    const dir = await mkdtemp(join(tmpdir(), 'vo-stt-'));
    const wavPath = join(dir, 'audio.wav');
    try {
      await writeFile(wavPath, wav);
      // whisper.cpp defaults to 4 threads whatever the machine has. Measured on
      // a 12-core laptop with large-v3-turbo: 28.0s at the default, 15.8s when
      // told about the cores — the same words, for free. Two are left for the
      // rest of the app, which is mid-conversation while this runs.
      const threads = Math.max(4, (this.opts.threads ?? cpus().length) - 2);
      const args = [
        '-m', this.opts.modelPath,
        '-f', wavPath,
        '-t', String(threads),
        '--no-timestamps',
        '--no-prints',
        ...(transcribeOpts?.language ? ['-l', transcribeOpts.language] : []),
      ];
      // Scaled to the audio, not fixed. A big model runs several times slower
      // than realtime on CPU — large-v3-turbo measured ~4x — so the old flat
      // 60s killed any longer sentence the moment someone swapped in a model
      // good enough for their language. PCM16 mono at 16 kHz = 32000 B/s.
      const audioSeconds = wav.byteLength / 32_000;
      const { stdout } = await pExecFile(this.opts.binaryPath, args, {
        timeout: this.opts.timeoutMs ?? Math.max(60_000, Math.ceil(audioSeconds) * 15_000),
        windowsHide: true,
      });
      return String(stdout).trim();
    } catch (err) {
      // execFile's default message is just the command line — surface what
      // whisper.cpp actually said (e.g. "main is deprecated, use whisper-cli").
      const e = err as { stderr?: unknown; stdout?: unknown; message?: string };
      const detail = `${String(e.stderr ?? '')}\n${String(e.stdout ?? '')}`
        .trim()
        .split('\n')
        .filter((l) => l.trim())
        .slice(-3)
        .join(' ')
        .slice(0, 300);
      throw new Error(`whisper.cpp failed${detail ? `: ${detail}` : `: ${e.message ?? 'unknown error'}`}`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
