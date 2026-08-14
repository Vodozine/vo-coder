import type { HarnessMessage } from '@vo-coder/providers';

/**
 * How many chars a message contributes to a replay-window budget. A rough
 * token proxy, shared so every surface weighs a turn the same way.
 *
 * Attachments are weighed by their REAL inlined size, not a nominal constant:
 * the adapters ship the full base64 image / decoded text file on the wire, so a
 * flat weight let a 1MB attachment linger in the buffer for dozens of turns and
 * re-ship every tool round-trip.
 */
export function approxChars(msg: HarnessMessage): number {
  if (msg.role === 'tool') return msg.content.length;
  let n = 0;
  for (const part of msg.content) {
    if (part.type === 'text' || part.type === 'thinking') n += part.text.length;
    else if (part.type === 'tool_call') n += JSON.stringify(part.args ?? {}).length + 40;
    else if (part.type === 'image') n += 6400; // ~1.6k tokens; true cost needs dimensions we lack
    else if (part.type === 'file') {
      const inlined = part.mediaType.startsWith('text/') || part.mediaType === 'application/json';
      n += inlined ? Math.ceil(part.data.length * 0.75) : 400;
    }
  }
  return n;
}

/**
 * The recent-turn cut, shared by every surface that bounds a replay window:
 * walk back from the newest turn until `budgetChars` of weighed content is
 * covered, then snap FORWARD to the next user message so the request always
 * opens on a user turn and a tool_call/result pair is never split. Returns the
 * start index to slice from — 0 means the whole history fits, replay it all.
 *
 * When ONE turn's traffic alone overflows the budget there is no user turn
 * ahead of the cut. Snapping to 0 there would silently re-ship the ENTIRE
 * history, so it snaps BACK to the turn that overflowed instead — over budget
 * by one turn is bounded, a full replay is not.
 */
export function cutAtUserBoundary(
  history: readonly HarnessMessage[],
  budgetChars: number,
  weigh: (m: HarnessMessage) => number = approxChars,
  minMessages = 12,
): number {
  if (history.length <= minMessages) return 0;
  let chars = 0;
  let over = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    chars += weigh(history[i]!);
    if (chars > budgetChars) {
      over = i;
      break;
    }
    if (i === 0) return 0; // whole history fits the budget
  }
  for (let k = over; k < history.length; k++) {
    if (history[k]!.role === 'user') return k;
  }
  for (let k = over - 1; k >= 0; k--) {
    if (history[k]!.role === 'user') return k;
  }
  return 0;
}

// ---- The dialogue-preserving plan ----
//
// One tool-heavy turn produces more chars than a whole replay budget, so a cut
// that weighs tool dumps the same as dialogue evicts the CONVERSATION first:
// the agent stops seeing its own previous question and answers "yes" blind.
// Recency has to be measured in dialogue — the window keeps what was SAID as
// far back as the budget reaches, and sheds the bulk (tool results, oversized
// call args, attachment payloads) from turns past the hot zone instead of
// dropping the turns themselves.

/** Elided-zone caps: what an old tool result / tool call keeps on the wire. */
const KEEP_RESULT_CHARS = 160;
const KEEP_ARGS_CHARS = 120;
const ELIDED_NOTE = ' …[elided — old tool output; the full text is in the conversation archive]';
const OLD_IMAGE_STUB =
  '[image from an earlier turn — dropped from the window; ask the user to re-attach it if it matters now]';
const oldFileStub = (name: string): string =>
  `[file "${name}" from an earlier turn — no longer inlined; read it from the workspace if it matters now]`;

/**
 * What a message will weigh on the wire AFTER elision: dialogue text in full —
 * the conversation is what the window exists to preserve — tool traffic and
 * attachments at their stub size. Thinking weighs nothing here: adapters never
 * replay it.
 */
export function elidedChars(msg: HarnessMessage): number {
  if (msg.role === 'tool')
    return Math.min(msg.content.length, KEEP_RESULT_CHARS + ELIDED_NOTE.length);
  let n = 0;
  for (const part of msg.content) {
    if (part.type === 'text') n += part.text.length;
    else if (part.type === 'tool_call')
      n += Math.min(JSON.stringify(part.args ?? {}).length, KEEP_ARGS_CHARS + 24) + 40;
    else if (part.type === 'image') n += OLD_IMAGE_STUB.length;
    else if (part.type === 'file') n += oldFileStub(part.name).length;
  }
  return n;
}

export interface WindowPlan {
  /** First message to ship — always a user turn (0 = whole history). */
  start: number;
  /** Messages in [start, hot) ship elided; [hot, …) ship verbatim. 0 = nothing elided. */
  hot: number;
}

/**
 * Two-zone window. The newest ~hotChars ship verbatim — the running turn needs
 * its own tool results whole — and BEFORE that the window reaches back through
 * ~dialogueChars of elision-weighed turns, so the conversation survives even
 * when every turn is tool-heavy. Both boundaries land on user turns.
 */
export function planWindow(
  history: readonly HarnessMessage[],
  hotChars: number,
  dialogueChars: number,
  minMessages = 12,
): WindowPlan {
  const hot = cutAtUserBoundary(history, hotChars, approxChars, minMessages);
  if (hot === 0) return { start: 0, hot: 0 };
  const start = cutAtUserBoundary(history.slice(0, hot), dialogueChars, elidedChars, 0);
  return { start, hot };
}

/**
 * Rewrite the wire window so messages before `hotOffset` keep their dialogue
 * verbatim but shed the bulk: tool results truncated, oversized tool-call args
 * capped, attachment payloads stubbed to one line. tool_call/result pairs
 * shrink but never split, so strict providers still see a well-formed
 * transcript. Never mutates the input; untouched messages are reused as-is.
 */
export function elideOldTraffic(
  messages: readonly HarnessMessage[],
  hotOffset: number,
): HarnessMessage[] {
  if (hotOffset <= 0) return [...messages];
  return messages.map((m, i) => {
    if (i >= hotOffset) return m;
    if (m.role === 'tool') {
      if (m.content.length <= KEEP_RESULT_CHARS + ELIDED_NOTE.length) return m;
      return { ...m, content: m.content.slice(0, KEEP_RESULT_CHARS) + ELIDED_NOTE };
    }
    if (m.role === 'assistant') {
      const oversized = m.content.some(
        (p) => p.type === 'tool_call' && JSON.stringify(p.args ?? {}).length > KEEP_ARGS_CHARS,
      );
      if (!oversized) return m;
      return {
        ...m,
        content: m.content.map((p) => {
          if (p.type !== 'tool_call') return p;
          const json = JSON.stringify(p.args ?? {});
          if (json.length <= KEEP_ARGS_CHARS) return p;
          return {
            ...p,
            args: {
              elided: `${json.slice(0, KEEP_ARGS_CHARS)}… (+${json.length - KEEP_ARGS_CHARS} chars)`,
            },
          };
        }),
      };
    }
    if (!m.content.some((p) => p.type === 'image' || p.type === 'file')) return m;
    return {
      ...m,
      content: m.content.map((p) =>
        p.type === 'image'
          ? ({ type: 'text', text: OLD_IMAGE_STUB } as const)
          : p.type === 'file'
            ? ({ type: 'text', text: oldFileStub(p.name) } as const)
            : p,
      ),
    };
  });
}
