import { describe, expect, it } from 'vitest';
import { render } from '../src/render.ts';

const ctx = {
  answers: { language: 'python', virtualization: 'none', philosophy: '' },
  languageLabel: 'python',
};

describe('markdown renderer', () => {
  it('substitutes dot-path keys and warns on unknown ones', () => {
    const r = render('Lang: {{answers.language}} / {{nope.missing}}!', ctx);
    expect(r.output).toBe('Lang: python / !');
    expect(r.warnings).toEqual(['Unknown template key: {{nope.missing}}']);
  });

  it('keeps and drops when-blocks by == and !=', () => {
    const template = [
      '<!-- when: answers.language == "python" -->PY<!-- /when -->',
      '<!-- when: answers.language == "go" -->GO<!-- /when -->',
      '<!-- when: answers.virtualization != "none" -->VIRT<!-- /when -->',
    ].join('\n');
    const r = render(template, ctx);
    expect(r.output).toContain('PY');
    expect(r.output).not.toContain('GO');
    expect(r.output).not.toContain('VIRT');
  });

  it('bare key tests truthiness (empty string is false)', () => {
    const template =
      '<!-- when: answers.philosophy -->HAS<!-- /when --><!-- when: languageLabel -->LABEL<!-- /when -->';
    const r = render(template, ctx);
    expect(r.output).toBe('LABEL');
  });

  it('supports nested when-blocks', () => {
    const template =
      '<!-- when: answers.language == "python" -->outer <!-- when: answers.virtualization == "none" -->inner<!-- /when --><!-- /when -->';
    expect(render(template, ctx).output).toBe('outer inner');
    const flipped = render(template, {
      ...ctx,
      answers: { ...ctx.answers, virtualization: 'docker' },
    });
    expect(flipped.output).toBe('outer ');
  });

  it('throws on unbalanced markers', () => {
    expect(() => render('<!-- when: x -->oops', ctx)).toThrow(/Unclosed/);
    expect(() => render('oops<!-- /when -->', ctx)).toThrow(/Unbalanced/);
  });
});
