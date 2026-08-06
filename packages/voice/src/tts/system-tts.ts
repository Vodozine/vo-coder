import { spawn, type ChildProcess } from 'node:child_process';
import type { TtsOutput, TtsProvider } from '../types.js';

export interface SystemTtsOptions {
  /** Installed voice name (SAPI voice on Windows, `say -v` voice on macOS). */
  voice?: string;
  /** Speaking rate: -10 (slow) … 10 (fast); 0 = default. */
  rate?: number;
  /**
   * Pitch: -10 (low) … 10 (high); 0 = the voice's own. Only the local engines
   * can do this — every OpenAI-compatible speech API offers speed and nothing
   * else. Each platform gets it a different way: SSML prosody on Windows,
   * an embedded `[[pbas]]` command on macOS, `-p` on espeak.
   */
  pitch?: number;
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
      const pitch = Math.max(-10, Math.min(10, Math.round(this.opts.pitch ?? 0)));
      if (process.platform === 'win32') {
        // Voice name goes through an env var — never into the command string.
        const select = this.opts.voice
          ? 'try { $s.SelectVoice($env:VO_TTS_VOICE) } catch {}; '
          : '';
        // Plain Speak() has no pitch. SSML does — but it needs the text XML
        // escaped, which happens in PowerShell on the piped text so nothing
        // from the model is ever interpolated into the command line.
        // XML attributes are quoted with '' (a doubled single quote inside a
        // PowerShell literal). Double quotes do NOT survive the spawn boundary
        // — Node's command-line quoting eats them and SAPI then rejects the
        // SSML as invalid. Verified the hard way.
        const q = "''";
        const say = pitch
          ? '$t = [System.Security.SecurityElement]::Escape([Console]::In.ReadToEnd()); ' +
            `$s.SpeakSsml('<speak version=${q}1.0${q} xmlns=${q}http://www.w3.org/2001/10/synthesis${q} xml:lang=${q}en-US${q}><prosody pitch=${q}${pitch > 0 ? '+' : ''}${pitch * 5}%${q}>' + $t + '</prosody></speak>')`
          : '$s.Speak([Console]::In.ReadToEnd())';
        child = spawn(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            'Add-Type -AssemblyName System.Speech; ' +
              '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
              select +
              `$s.Rate = ${rate}; ` +
              say,
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
        if (pitch !== 0) args.push('-p', String(Math.max(0, Math.min(99, 50 + pitch * 4))));
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
      // macOS `say` takes pitch as an embedded speech command in the text
      // itself — there is no flag for it.
      child.stdin?.end(
        process.platform === 'darwin' && pitch !== 0
          ? `[[pbas ${Math.max(20, Math.min(80, 50 + pitch * 3))}]] ${text}`
          : text,
      );
    });
  }

  stop(): void {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}
