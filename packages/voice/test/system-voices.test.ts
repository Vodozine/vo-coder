import { describe, expect, it } from 'vitest';
import {
  listSystemVoices,
  parseEspeakVoices,
  parseMacVoices,
  parseWindowsVoices,
} from '../src/tts/system-voices.ts';
import { LIST_VOICES_SCRIPT, speakScript } from '../src/tts/windows-sapi.ts';

describe('parseWindowsVoices', () => {
  it('reads name, culture and gender off the tab-separated lines', () => {
    const out = parseWindowsVoices(
      'Microsoft Hazel Desktop\ten-GB\tFemale\r\nMicrosoft David Desktop\ten-US\tMale\r\n',
    );
    expect(out).toEqual([
      { name: 'Microsoft Hazel Desktop', language: 'en-GB', gender: 'Female' },
      { name: 'Microsoft David Desktop', language: 'en-US', gender: 'Male' },
    ]);
  });

  it('keeps a voice that reports no gender, and drops blank lines', () => {
    expect(parseWindowsVoices('\nGuðrún\tis-IS\tNotSet\n\n')).toEqual([
      { name: 'Guðrún', language: 'is-IS' },
    ]);
  });
});

describe('parseMacVoices', () => {
  it('anchors on the locale, so names keep their spaces however wide the column', () => {
    const out = parseMacVoices(
      [
        'Alex                en_US    # Most people recognize me by my voice.',
        // Long names eat the padding down to a single space.
        'Eddy (English (UK)) en_GB    # Hello! My name is Eddy.',
        'Grandma (English (U.S.)) en_US # Hello, my name is Grandma.',
        'Bad line without a locale',
      ].join('\n'),
    );
    expect(out).toEqual([
      { name: 'Alex', language: 'en-US' },
      { name: 'Eddy (English (UK))', language: 'en-GB' },
      { name: 'Grandma (English (U.S.))', language: 'en-US' },
    ]);
  });
});

describe('parseEspeakVoices', () => {
  it('takes the voice name column and reads gender off age/gender', () => {
    const out = parseEspeakVoices(
      [
        'Pty Language Age/Gender VoiceName          File          Other Languages',
        ' 5  af             M  afrikaans            other/af',
        ' 5  is             F  icelandic            europe/is',
      ].join('\n'),
    );
    expect(out).toEqual([
      { name: 'afrikaans', language: 'af', gender: 'Male' },
      { name: 'icelandic', language: 'is', gender: 'Female' },
    ]);
  });
});

describe('windows sapi scripts', () => {
  const scripts = [
    LIST_VOICES_SCRIPT,
    speakScript({ rate: 0, pitch: 0, hasVoice: false }),
    speakScript({ rate: -3, pitch: 7, hasVoice: true }),
  ];

  // Node's argument quoting turns a double quote into \" and powershell.exe
  // then eats it. Every script here has to survive that boundary.
  it('never uses a double quote', () => {
    for (const s of scripts) expect(s).not.toContain('"');
  });

  it('reads both voice categories, not just the classic one', () => {
    for (const s of [scripts[0]!, scripts[2]!]) {
      expect(s).toContain('SOFTWARE\\Microsoft\\Speech\\Voices');
      expect(s).toContain('SOFTWARE\\Microsoft\\Speech_OneCore\\Voices');
    }
  });

  it('speaks plain text as NOT-markup, so a tag in an answer is read aloud', () => {
    expect(scripts[1]).toMatch(/Speak\(\[Console\]::In\.ReadToEnd\(\), 16\)/);
    expect(scripts[1]).not.toContain('VO_TTS_VOICE');
  });

  it('escapes the text before wrapping it in pitch markup', () => {
    const s = scripts[2]!;
    expect(s).toContain('SecurityElement]::Escape');
    expect(s).toContain("<pitch absmiddle=''7''>");
    expect(s).toMatch(/, 8\)$/);
    expect(s).toContain('$v.Rate = -3;');
    // The name itself never enters the command line.
    expect(s).toContain('$env:VO_TTS_VOICE');
  });
});

describe('listSystemVoices', () => {
  it('asks the platform engine and drops repeats', async () => {
    const seen: string[] = [];
    const out = await listSystemVoices({
      platform: 'darwin',
      run: async (cmd, args) => {
        seen.push([cmd, ...args].join(' '));
        return 'Alex   en_US  # hi\nAlex   en_US  # hi again\nSamantha  en_US  # hi';
      },
    });
    expect(seen).toEqual(['say -v ?']);
    expect(out.map((v) => v.name)).toEqual(['Alex', 'Samantha']);
  });

  it('answers with an empty list when there is no speech engine to ask', async () => {
    const out = await listSystemVoices({
      platform: 'linux',
      run: async () => {
        throw new Error('spawn espeak ENOENT');
      },
    });
    expect(out).toEqual([]);
  });
});
