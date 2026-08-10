import { describe, expect, it } from 'vitest';
import {
  listSystemVoices,
  parseEspeakVoices,
  parseMacVoices,
  parseWindowsVoices,
} from '../src/tts/system-voices.ts';

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
