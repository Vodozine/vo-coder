import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
}

export class WhisperLocalStt implements SttProvider {
  readonly id = 'whisper-local';

  constructor(private opts: WhisperLocalOptions) {}

  async transcribe(wav: Uint8Array, transcribeOpts?: TranscribeOptions): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'vo-stt-'));
    const wavPath = join(dir, 'audio.wav');
    try {
      await writeFile(wavPath, wav);
      const args = [
        '-m', this.opts.modelPath,
        '-f', wavPath,
        '--no-timestamps',
        '--no-prints',
        ...(transcribeOpts?.language ? ['-l', transcribeOpts.language] : []),
      ];
      const { stdout } = await pExecFile(this.opts.binaryPath, args, {
        timeout: this.opts.timeoutMs ?? 60_000,
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
