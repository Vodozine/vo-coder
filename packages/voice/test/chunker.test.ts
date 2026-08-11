import { describe, expect, it } from 'vitest';
import { nextSpeechCut } from '../src/chunker.ts';

/** Replay a reply the way a stream delivers it and collect what gets spoken. */
function replay(reply: string): Array<{ atPercent: number; text: string }> {
  let spoken = 0;
  const out: Array<{ atPercent: number; text: string }> = [];
  for (let i = 7; i <= reply.length; i += 7) {
    const arrived = reply.slice(0, i);
    const cut = nextSpeechCut(arrived.slice(spoken), { streaming: true, opening: spoken === 0 });
    if (cut > 0) {
      out.push({ atPercent: Math.round((i / reply.length) * 100), text: arrived.slice(spoken, spoken + cut) });
      spoken += cut;
    }
  }
  const tail = nextSpeechCut(reply.slice(spoken), { streaming: false, opening: spoken === 0 });
  if (tail > 0) out.push({ atPercent: 100, text: reply.slice(spoken, spoken + tail) });
  return out;
}

describe('nextSpeechCut', () => {
  it('starts talking on the first sentence, not once the reply is nearly done', () => {
    const chunks = replay(
      'Short answer: no, not on purpose. ' +
        'There is no user dossier sitting somewhere with your coffee order. ' +
        'What actually exists is project state and homelab crumbs, which is work residue. ' +
        'So: activity memory yes, personal profile no.',
    );
    expect(chunks[0]!.atPercent).toBeLessThan(25);
    expect(chunks[0]!.text).toContain('Short answer');
  });

  it('buffers after the opening, so a list is not one request per line', () => {
    const list =
      'Here is what changed.\n\n' +
      ['- the first item is here', '- the second item is here', '- the third item is here', '- the fourth item is here']
        .join('\n') +
      '\n\nThat is everything.';
    // Four bullets and two sentences, but not six chunks.
    expect(replay(list).length).toBeLessThanOrEqual(3);
  });

  it('never cuts inside an open code fence', () => {
    const cut = nextSpeechCut('Here is the fix. Now:\n\n```ts\nconst a = 1;\nconst b = 2;\n', {
      streaming: true,
      opening: true,
    });
    // The cut may land on the sentence before the fence, but never inside it.
    expect(cut).toBeLessThanOrEqual('Here is the fix. Now:\n\n'.length);
  });

  it('takes a closed block whole, for the cleaner to omit', () => {
    const reply =
      'Here is the fix, and it is a long enough sentence to clear the buffered ' +
      'minimum on its own so the block below is genuinely in play.\n\n' +
      '```ts\nconst a = 1;\n```\n\nTests pass. ';
    const cut = nextSpeechCut(reply, { streaming: true, opening: false });
    expect(reply.slice(0, cut)).toContain('```ts');
    expect(reply.slice(0, cut).match(/```/g)).toHaveLength(2);
  });

  it('waits rather than speak a fragment once the voice is already going', () => {
    expect(nextSpeechCut('Short. ', { streaming: true, opening: false })).toBe(0);
  });

  it('hands back everything left when the stream closes', () => {
    expect(nextSpeechCut('a trailing fragment with no full stop', {
      streaming: false,
      opening: false,
    })).toBe('a trailing fragment with no full stop'.length);
    expect(nextSpeechCut('', { streaming: false, opening: true })).toBe(0);
  });
});
