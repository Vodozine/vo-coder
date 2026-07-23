import { spawn, type ChildProcess } from 'node:child_process';
import type { TtsOutput, TtsProvider } from '../types.js';

export interface SystemTtsOptions {
  /** Installed voice name (SAPI voice on Windows, `say -v` voice on macOS). */
  voice?: string;
  /** Speaking rate: -10 (slow) … 10 (fast); 0 = default. */
  rate?: number;
}

/**
 * Zero-dependency fallback: Windows SAPI via PowerShell, macOS `say`,
 * Linux `espeak` if present. Speaks natively on this machine; stop() kills
 * the child (barge-in).
 */
export class SystemTts implements TtsProvider {
  readonly id = 'system-tts';
  private child: ChildProcess | null = null;

  constructor(private opts: SystemTtsOptions = {}) {}

  speak(text: string): Promise<TtsOutput> {
    this.stop();
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      const rate = Math.max(-10, Math.min(10, Math.round(this.opts.rate ?? 0)));
      if (process.platform === 'win32') {
        // Voice name goes through an env var — never into the command string.
        const select = this.opts.voice
          ? 'try { $s.SelectVoice($env:VO_TTS_VOICE) } catch {}; '
          : '';
        child = spawn(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            'Add-Type -AssemblyName System.Speech; ' +
              '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
              select +
              `$s.Rate = ${rate}; ` +
              '$s.Speak([Console]::In.ReadToEnd())',
          ],
          {
            windowsHide: true,
            stdio: ['pipe', 'ignore', 'ignore'],
            env: this.opts.voice
              ? { ...process.env, VO_TTS_VOICE: this.opts.voice }
              : process.env,
          },
        );
      } else if (process.platform === 'darwin') {
        const args: string[] = [];
        if (this.opts.voice) args.push('-v', this.opts.voice);
        if (rate !== 0) args.push('-r', String(175 + rate * 15));
        child = spawn('say', args, { stdio: ['pipe', 'ignore', 'ignore'] });
      } else {
        const args = ['--stdin'];
        if (this.opts.voice) args.push('-v', this.opts.voice);
        if (rate !== 0) args.push('-s', String(160 + rate * 12));
        child = spawn('espeak', args, { stdio: ['pipe', 'ignore', 'ignore'] });
      }
      this.child = child;
      child.on('error', (err) => {
        this.child = null;
        reject(new Error(`System TTS unavailable: ${err.message}`));
      });
      child.on('close', () => {
        this.child = null;
        resolve({ kind: 'native' });
      });
      child.stdin?.end(text);
    });
  }

  stop(): void {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}
