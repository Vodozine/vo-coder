/**
 * Windows speech, both halves of it.
 *
 * Windows keeps its voices in two registry categories. The classic one holds
 * the three "Desktop" voices every machine ships with; everything downloaded
 * since — Settings → Time & language → Speech → Add voices — lands in
 * Speech_OneCore instead. .NET's System.Speech reads only the first, so a
 * voice that plainly works in Narrator is invisible to GetInstalledVoices()
 * and unselectable by SelectVoice().
 *
 * SAPI's own COM objects can address both: a token category is opened by
 * registry path, and a token from either one can be handed to SpVoice. So
 * listing and speaking both go through SAPI COM, and the picker can never
 * offer a voice the speaker cannot then select.
 *
 * Rules for every script here, learned the hard way:
 * - NOT ONE DOUBLE QUOTE. Node's argument quoting turns them into \" and
 *   powershell.exe eats them. Single quotes survive; '' is one inside a
 *   PowerShell literal, and [char]9 is a tab.
 * - Console encoding is forced to UTF-8, or "Guðrún" arrives mangled and
 *   matches no voice at all.
 */

/** Both category paths, as a PowerShell array literal. Classic first, so a
 *  name that exists in both resolves the way it always did. */
const CATEGORIES =
  "@('HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\Voices'," +
  "'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech_OneCore\\Voices')";

/** GetAttribute throws on a token that lacks the attribute — never fatal. */
const ATTR_FN = 'function attr($t, $k) { try { $t.GetAttribute($k) } catch { $null } }; ';

/** Emits `name<TAB>language<TAB>gender` per voice, both categories, no repeats. */
export const LIST_VOICES_SCRIPT =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
  ATTR_FN +
  '$seen = @{}; ' +
  `foreach ($c in ${CATEGORIES}) { try { ` +
  '$cat = New-Object -ComObject SAPI.SpObjectTokenCategory; ' +
  '$cat.SetId($c, $false); ' +
  'foreach ($t in $cat.EnumerateTokens()) { ' +
  '$n = attr $t Name; ' +
  'if (-not $n -or $seen.ContainsKey($n)) { continue }; ' +
  '$seen[$n] = $true; ' +
  // Language is a hex LCID ("809"), and a multilingual voice lists several.
  '$lang = $null; try { $lang = [System.Globalization.CultureInfo]::GetCultureInfo(' +
  "[Convert]::ToInt32(((attr $t Language) -split ';')[0], 16)).Name } catch {}; " +
  '$n + [char]9 + $lang + [char]9 + (attr $t Gender) ' +
  '} } catch {} }';

/** Points $v at the voice named in VO_TTS_VOICE; a name that no longer exists
 *  leaves the machine default speaking, exactly as SelectVoice used to. */
const SELECT_VOICE =
  ATTR_FN +
  '$want = $env:VO_TTS_VOICE; ' +
  `foreach ($c in ${CATEGORIES}) { try { ` +
  '$cat = New-Object -ComObject SAPI.SpObjectTokenCategory; ' +
  '$cat.SetId($c, $false); ' +
  '$tok = @($cat.EnumerateTokens() | Where-Object { (attr $_ Name) -eq $want })[0]; ' +
  'if ($tok) { $v.Voice = $tok; break } ' +
  '} catch {} }; ';

/**
 * Speaks whatever arrives on stdin. Pitch has no API on SpVoice, only markup:
 * SAPI's own `pitch absmiddle` takes -10…10, the same scale this app uses.
 *
 * The flags matter. 16 is "this is NOT markup" — without it an answer that
 * happens to contain a tag gets parsed as XML instead of read aloud. 8 says
 * the opposite, and is used only where the text was escaped first.
 */
export function speakScript(opts: { rate: number; pitch: number; hasVoice: boolean }): string {
  const q = "''"; // one single quote inside a PowerShell literal
  const read = '[Console]::In.ReadToEnd()';
  const say = opts.pitch
    ? `$t = [System.Security.SecurityElement]::Escape(${read}); ` +
      `[void]$v.Speak('<pitch absmiddle=${q}${opts.pitch}${q}>' + $t + '</pitch>', 8)`
    : `[void]$v.Speak(${read}, 16)`;
  return (
    // Stdin is UTF-8 from Node; without this the console codepage eats accents.
    'try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}; ' +
    '$v = New-Object -ComObject SAPI.SpVoice; ' +
    (opts.hasVoice ? SELECT_VOICE : '') +
    `$v.Rate = ${opts.rate}; ` +
    say
  );
}
