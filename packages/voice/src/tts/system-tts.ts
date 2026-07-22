import { spawn, type ChildProcess } from 'node:child_process';
import type { TtsOutput, TtsProvider } from '../types.js';

/**
 * Zero-dependency fallback: Windows SAPI via PowerShell, macOS `say`,
 * Linux `espeak` if present. Speaks natively on this machine; stop() kills
 * the child (barge-in).
 */
export class SystemTts implements TtsProvider {
  readonly id = 'system-tts';
  private child: ChildProcess | null = null;

  speak(text: string): Promise<TtsOutput> {
    this.stop();
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      if (process.platform === 'win32') {
        child = spawn(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            'Add-Type -AssemblyName System.Speech; ' +
              '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
              '$s.Speak([Console]::In.ReadToEnd())',
          ],
          { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] },
        );
      } else if (process.platform === 'darwin') {
        child = spawn('say', [], { stdio: ['pipe', 'ignore', 'ignore'] });
      } else {
        child = spawn('espeak', ['--stdin'], { stdio: ['pipe', 'ignore', 'ignore'] });
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
