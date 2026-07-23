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

  it('omits code blocks and de-noises links', () => {
    const out = speakable('Run this:\n```js\nconst x = 1;\n```\nSee [the docs](https://example.com) or https://raw.example.com/x');
    expect(out).toContain('Code block omitted');
    expect(out).not.toContain('const x');
    expect(out).toContain('the docs');
    expect(out).not.toContain('https://');
  });
});
