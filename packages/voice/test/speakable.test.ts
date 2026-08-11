import { describe, expect, it } from 'vitest';
import { speakable } from '../src/speakable.ts';

describe('speakable', () => {
  it('strips emphasis, headers, and bullets', () => {
    const out = speakable('### **Quick Tips**\n- **Fresh beans** → grind just before brewing');
    expect(out).not.toMatch(/[*#>-]/);
    expect(out).toContain('Quick Tips');
    expect(out).toContain('Fresh beans to grind just before brewing');
  });

  it('turns tables and <br> into speech pauses', () => {
    const out = speakable('| Step | Details |\n|------|---------|\n| **1. Gather** | milk <br> espresso |');
    expect(out).not.toContain('|');
    expect(out).not.toMatch(/<br>/i);
    expect(out).not.toContain('---');
    expect(out).toContain('Gather');
  });

  // Live voice speaks a reply in pieces. A piece cut mid-block used to arrive
  // with a fence the paired rule could not match, and the engine read the
  // backticks and the source aloud.
  it('omits a code block the chunker cut in half', () => {
    const opens = speakable('Here is the fix:\n```ts\nconst a = 1;');
    expect(opens).not.toContain('`');
    expect(opens).not.toContain('const a');
    expect(opens).toContain('Code block omitted');
    expect(speakable('half `an identifier')).not.toContain('`');
  });

  it('reads identifiers and paths the way a person would', () => {
    expect(speakable('the `CENTER_CROP` value')).toContain('CENTER CROP');
    expect(speakable('APK: `app/build/outputs/apk/debug/app-debug.apk`')).toContain('app-debug.apk');
    expect(speakable('APK: `app/build/outputs/apk/debug/app-debug.apk`')).not.toContain('build');
    expect(speakable('stretch to exact W×H')).toContain('W by H');
    expect(speakable('`FIT_CENTER` / `EXACT`')).toContain('FIT CENTER, EXACT');
  });

  it('omits code blocks and de-noises links', () => {
    const out = speakable('Run this:\n```js\nconst x = 1;\n```\nSee [the docs](https://example.com) or https://raw.example.com/x');
    expect(out).toContain('Code block omitted');
    expect(out).not.toContain('const x');
    expect(out).toContain('the docs');
    expect(out).not.toContain('https://');
  });
});
