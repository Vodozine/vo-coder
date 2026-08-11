/**
 * How much of a streaming reply is ready to be spoken.
 *
 * Two pressures pull against each other. Speak too eagerly and every fragment
 * costs a synthesis round trip, which is where the stutter came from; wait too
 * long and the reply is finished before a word comes out, which is where the
 * silence came from. So: the opening piece is the first sentence available,
 * and everything after it buffers — by then the next chunk is being fetched
 * underneath the one playing, so the bigger pieces cost nothing.
 */
export interface CutOptions {
  /** The stream is still open — a partial sentence may still be arriving. */
  streaming: boolean;
  /** Nothing of this reply has been spoken yet. */
  opening: boolean;
}

/** Shortest opening fragment worth a request of its own. */
const OPENING_MIN = 24;
/** Once the voice is going, chunks this size keep the seams rare. */
const BUFFERED_MIN = 160;

/**
 * Characters of `pending` that can be spoken now, or 0 for "not yet".
 * A finished stream hands back everything left.
 */
export function nextSpeechCut(pending: string, opts: CutOptions): number {
  if (!pending) return 0;
  if (!opts.streaming) return pending.length;

  // Never cut inside a code fence. A chunk that ends mid-block reaches the
  // cleaner with an unclosed ``` it cannot pair, and the engine reads the
  // backticks and the source out loud. An odd count means the last fence is
  // still open, so nothing past it is speakable yet.
  let searchable = pending;
  if (((pending.match(/```/g) ?? []).length & 1) === 1) {
    searchable = pending.slice(0, pending.lastIndexOf('```'));
  }

  const ends: number[] = [];
  for (const m of searchable.matchAll(/[.!?](?:\s|$)|\n\n/g)) {
    ends.push(m.index + m[0].length);
  }
  const cut = opts.opening
    ? (ends.find((e) => e >= OPENING_MIN) ?? 0)
    : (ends.filter((e) => e >= BUFFERED_MIN).pop() ?? 0);
  return cut;
}
