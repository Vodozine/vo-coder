/**
 * Emotional-context awareness as hard token economics: a frustrated user
 * spinning in circles burns tokens. Detect the spiral early and ask directly —
 * "are we on the wrong path?" — instead of silently guessing. Local-only data;
 * failure is data, not shame.
 */

export interface EmotionalSignals {
  /** Near-duplicate of a recent request (normalized similarity ≥ threshold). */
  repeatedRequest: boolean;
  /** How many recent messages this one nearly duplicates. */
  repeatCount: number;
  /** Messages arriving in rapid succession. */
  rapidFire: boolean;
  /** SHOUTING or excessive!!! punctuation??? */
  aggressiveTone: boolean;
}

export interface CheckinSuggestion {
  triggered: boolean;
  reasons: string[];
  /** The direct question the UI should surface. */
  prompt?: string;
}

export interface RequestLogEntry {
  text: string;
  at: number;
  sessionId: string;
}

export interface EmotionalOptions {
  /** 0..1 normalized similarity above which two requests count as the same ask. */
  similarityThreshold?: number;
  /** Repeats of the same ask (across sessions) before a check-in triggers. */
  repeatTrigger?: number;
  /** Two messages within this window count toward rapid-fire. */
  rapidFireMs?: number;
  /** Rapid-fire messages before it contributes to a trigger. */
  rapidFireTrigger?: number;
  /** How much history to keep. */
  maxLog?: number;
}

const DEFAULTS: Required<EmotionalOptions> = {
  // Reworded repeats ("…please", "can you…") land around 0.75–0.8; genuinely
  // different asks stay well under 0.5.
  similarityThreshold: 0.72,
  repeatTrigger: 3,
  rapidFireMs: 5_000,
  rapidFireTrigger: 4,
  maxLog: 200,
};

/** Levenshtein distance normalized to 0..1 similarity. */
export function similarity(a: string, b: string): number {
  const s = a.toLowerCase().trim();
  const t = b.toLowerCase().trim();
  if (s === t) return 1;
  if (!s.length || !t.length) return 0;
  // Cap the cost of very long strings; the tail rarely changes the verdict.
  const sa = s.slice(0, 400);
  const tb = t.slice(0, 400);
  const prev = new Array<number>(tb.length + 1);
  const curr = new Array<number>(tb.length + 1);
  for (let j = 0; j <= tb.length; j++) prev[j] = j;
  for (let i = 1; i <= sa.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= tb.length; j++) {
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + (sa[i - 1] === tb[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= tb.length; j++) prev[j] = curr[j]!;
  }
  const dist = prev[tb.length]!;
  return 1 - dist / Math.max(sa.length, tb.length);
}

export function detectTone(text: string): boolean {
  const letters = text.replace(/[^a-zA-Z]/g, '');
  const caps = letters.replace(/[^A-Z]/g, '');
  const shouting = letters.length >= 12 && caps.length / letters.length > 0.7;
  const punctBursts = /([!?])\1{2,}/.test(text);
  return shouting || punctBursts;
}

export class EmotionalMiddleware {
  private opts: Required<EmotionalOptions>;
  private log: RequestLogEntry[];

  constructor(opts: EmotionalOptions = {}, seedLog: RequestLogEntry[] = []) {
    this.opts = { ...DEFAULTS, ...opts };
    this.log = [...seedLog];
  }

  /** Persisted by the host (cross-session memory of what was asked). */
  exportLog(): RequestLogEntry[] {
    return [...this.log];
  }

  observe(sessionId: string, text: string, now: number): CheckinSuggestion {
    const trimmed = text.trim();
    const signals = this.analyze(trimmed, now);
    this.log.push({ text: trimmed, at: now, sessionId });
    if (this.log.length > this.opts.maxLog) this.log.shift();

    const reasons: string[] = [];
    if (signals.repeatCount + 1 >= this.opts.repeatTrigger) {
      reasons.push(`asked ${signals.repeatCount + 1} times without landing`);
    }
    if (signals.rapidFire && signals.aggressiveTone) {
      reasons.push('rapid-fire messages with a frustrated tone');
    }
    if (reasons.length === 0) return { triggered: false, reasons: [] };

    const prompt = reasons[0]!.startsWith('asked')
      ? "You've asked me this several times and I keep missing it. Let's reset — walk me through exactly what you need, and what the last attempts got wrong."
      : 'Are we on the wrong path? Tell me what you actually need and what I should fix — a sentence of direction saves us both a lot of retries.';
    return { triggered: true, reasons, prompt };
  }

  private analyze(text: string, now: number): EmotionalSignals {
    // Short acknowledgements ("ok", "yes", "thanks") never count as repeats.
    const substantive = text.length >= 12;
    let repeatCount = 0;
    if (substantive) {
      for (const entry of this.log) {
        if (entry.text.length < 12) continue;
        if (similarity(entry.text, text) >= this.opts.similarityThreshold) repeatCount++;
      }
    }
    const recent = this.log.filter((e) => now - e.at < this.opts.rapidFireMs);
    return {
      repeatedRequest: repeatCount > 0,
      repeatCount,
      rapidFire: recent.length + 1 >= this.opts.rapidFireTrigger,
      aggressiveTone: detectTone(text),
    };
  }
}
