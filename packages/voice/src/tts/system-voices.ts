import { execFile } from 'node:child_process';
import type { SystemVoice } from '../types.js';

/**
 * What voices can this machine actually speak with?
 *
 * The name is not a label — it is the exact string SAPI's SelectVoice, `say -v`
 * and espeak's `-v` match on, so it is passed through untouched. Everything
 * else (language, gender) is decoration for the picker.
 *
 * Every platform is asked with the same engine that later does the speaking,
 * so the list can never offer a voice {@link SystemTts} cannot select.
 */

export type { SystemVoice };

/** Runs a command and hands back stdout; injected so the parsers are testable. */
export type Runner = (cmd: string, args: string[]) => Promise<string>;

const run: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { windowsHide: true, timeout: 15_000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        // espeak writes its voice table and exits non-zero on some builds —
        // output we can parse beats a tidy exit code.
        if (err && !String(stdout).trim()) reject(err);
        else resolve(String(stdout));
      },
    );
  });

/**
 * System.Speech is what SystemTts speaks through, so it is also what gets
 * asked. Two details are load-bearing:
 *
 * - Console output is forced to UTF-8, or the console codepage mangles a name
 *   like "Microsoft Guðrún" into one SelectVoice will never match.
 * - Not one double quote in the whole command. Node's argument quoting turns
 *   them into \" and powershell.exe eats them — the same boundary that once
 *   made SystemTts's SSML invalid. [char]9 is the tab that survives.
 */
const WINDOWS_QUERY =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
  'Add-Type -AssemblyName System.Speech; ' +
  '(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ' +
  'Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo } | ' +
  'ForEach-Object { $_.Name + [char]9 + $_.Culture.Name + [char]9 + $_.Gender }';

/** name<TAB>culture<TAB>gender, one voice per line. */
export function parseWindowsVoices(stdout: string): SystemVoice[] {
  const out: SystemVoice[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [name, culture, gender] = line.split('\t');
    if (!name?.trim()) continue;
    out.push({
      name: name.trim(),
      ...(culture?.trim() ? { language: culture.trim() } : {}),
      ...(gender?.trim() && gender.trim() !== 'NotSet' ? { gender: gender.trim() } : {}),
    });
  }
  return out;
}

/** `say -v ?`: "Alex                en_US    # Most people know me…" */
export function parseMacVoices(stdout: string): SystemVoice[] {
  const out: SystemVoice[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    // The name may hold spaces ("Eddy (English (UK))") and a long enough one
    // eats the column padding down to a single space — so the anchor is the
    // locale before the comment, not the gap in front of it.
    const m = /^(.+?)\s+([A-Za-z]{2,3}[_-][A-Za-z0-9]{2,8})\s*(?:#.*)?$/.exec(line);
    if (!m) continue;
    out.push({ name: m[1]!.trim(), language: m[2]!.replace('_', '-') });
  }
  return out;
}

/** `espeak --voices`: "Pty Language Age/Gender VoiceName File Other Languages". */
export function parseEspeakVoices(stdout: string): SystemVoice[] {
  const out: SystemVoice[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || !/^\d+$/.test(cols[0]!)) continue;
    const [, language, ageGender, name] = cols;
    const gender = ageGender?.endsWith('M') ? 'Male' : ageGender?.endsWith('F') ? 'Female' : '';
    out.push({
      name: name!,
      ...(language ? { language } : {}),
      ...(gender ? { gender } : {}),
    });
  }
  return out;
}

/**
 * The installed voices, or an empty list when the platform cannot be asked —
 * a machine with no speech engine is not an error worth throwing over, the
 * picker just falls back to a plain text field.
 */
export async function listSystemVoices(
  opts: { platform?: NodeJS.Platform; run?: Runner } = {},
): Promise<SystemVoice[]> {
  const platform = opts.platform ?? process.platform;
  const exec = opts.run ?? run;
  try {
    if (platform === 'win32') {
      return dedupe(
        parseWindowsVoices(await exec('powershell', ['-NoProfile', '-Command', WINDOWS_QUERY])),
      );
    }
    if (platform === 'darwin') return dedupe(parseMacVoices(await exec('say', ['-v', '?'])));
    return dedupe(parseEspeakVoices(await exec('espeak', ['--voices'])));
  } catch {
    return [];
  }
}

/** espeak lists a voice once per alias; the picker wants it once. */
function dedupe(voices: SystemVoice[]): SystemVoice[] {
  const seen = new Set<string>();
  return voices.filter((v) => (seen.has(v.name) ? false : (seen.add(v.name), true)));
}
