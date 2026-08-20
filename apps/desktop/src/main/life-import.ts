import { readFileSync, statSync } from 'node:fs';
import type { MemoryBank, LifeOp } from './membank';
import type { LifeScanDto } from '../shared/ipc-contract';
import { openZip, readZipText } from './zip-read';

/**
 * Life import: reads a personal chat-export dump (ChatGPT, Claude, Gemini
 * Takeout) and dilutes it into the memory bank's LIFE notes — durable,
 * provenance-stamped knowledge about the user from their years with OTHER
 * assistants. The funnel is deliberate: plain code does the massacre (parse,
 * trim, dedupe), and a model only ever reads small pre-trimmed bites, so a
 * 300MB dump never becomes a 75M-token bill.
 *
 * Nothing from the dump enters the conversation archive: those chats did not
 * happen here, and the whole point of the provenance stamp is that Vodo knows
 * it. Only the distilled notes land, each carrying its source.
 */

export type LifeSource = 'chatgpt' | 'claude' | 'gemini';

export function lifeSourceLabel(source: string): string {
  return source === 'chatgpt'
    ? 'ChatGPT'
    : source === 'claude'
      ? 'Claude'
      : source === 'gemini'
        ? 'Gemini (Google)'
        : source;
}

interface RawMsg {
  role: 'user' | 'assistant';
  text: string;
}

interface RawChat {
  title: string;
  at: number;
  msgs: RawMsg[];
}

/** One chat, trimmed to its dense rendered block, ready to pack into bites. */
interface TrimmedChat {
  at: number;
  block: string;
}

export interface LifeProgressEvent {
  batchId: number;
  phase: 'reading' | 'final' | 'done' | 'error' | 'canceled';
  /** Chats digested so far / total kept chats. */
  processed: number;
  total: number;
  /** Life notes written so far by this run. */
  notes: number;
  summary?: string;
  error?: string;
}

// ---- trim budgets ----
// Deep read: the user's words are the signal, the assistant's mostly noise —
// so user text keeps ~3× the budget. Skim: title + opening user message only.
const USER_MSG_MAX = 1_200;
const ASSIST_MSG_MAX = 350;
const CHAT_MSGS_MAX = 30;
const CHAT_CHARS_MAX = 4_800;
const SKIM_FIRST_MAX = 280;
const MIN_USER_CHARS = 40;

/** One model call's worth of chats. The Ollama adapter sizes num_ctx to the
 *  request, so the bound is about keeping extraction focused, not window fit. */
const BITE_MAX_CHARS = 13_000;
/** Prompt framing + existing-notes index, for the token estimate. */
const CALL_OVERHEAD_CHARS = 4_500;
const MAX_OPS_PER_BITE = 10;

// ---- export parsing ----

function asText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** ChatGPT export: conversations.json, each chat a node tree ("mapping"). */
function parseChatGpt(arr: unknown[]): RawChat[] {
  const chats: RawChat[] = [];
  for (const item of arr) {
    const conv = item as {
      title?: unknown;
      create_time?: unknown;
      mapping?: Record<string, { message?: unknown; parent?: unknown }>;
      current_node?: unknown;
    };
    const mapping = conv.mapping ?? {};
    type GptMsg = {
      author?: { role?: unknown };
      create_time?: unknown;
      content?: { content_type?: unknown; parts?: unknown[]; text?: unknown };
      metadata?: { is_visually_hidden_from_conversation?: unknown };
    };
    // Walk the current branch root-ward: retries and abandoned branches fall
    // away for free — exactly the dedupe we want.
    const chain: GptMsg[] = [];
    let node = typeof conv.current_node === 'string' ? mapping[conv.current_node] : undefined;
    let hops = 0;
    while (node && hops++ < 5_000) {
      if (node.message) chain.push(node.message as GptMsg);
      node = typeof node.parent === 'string' ? mapping[node.parent] : undefined;
    }
    if (chain.length === 0) {
      // Broken current_node: fall back to every node in time order.
      for (const n of Object.values(mapping)) if (n.message) chain.push(n.message as GptMsg);
      chain.sort((a, b) => (Number(a.create_time) || 0) - (Number(b.create_time) || 0));
    } else {
      chain.reverse();
    }
    const msgs: RawMsg[] = [];
    let firstAt = 0;
    for (const m of chain) {
      const role = m.author?.role;
      if (role !== 'user' && role !== 'assistant') continue;
      if (m.metadata?.is_visually_hidden_from_conversation === true) continue;
      const parts = Array.isArray(m.content?.parts) ? m.content.parts : [];
      const text =
        parts
          .map((p) => asText(p))
          .filter(Boolean)
          .join('\n') || asText(m.content?.text);
      if (!text.trim()) continue;
      if (!firstAt && Number(m.create_time)) firstAt = Number(m.create_time) * 1000;
      msgs.push({ role, text });
    }
    const at = Number(conv.create_time) ? Number(conv.create_time) * 1000 : firstAt || Date.now();
    chats.push({ title: asText(conv.title) || 'Untitled', at, msgs });
  }
  return chats;
}

/** Claude (claude.ai) export: conversations.json with chat_messages. */
function parseClaude(arr: unknown[]): RawChat[] {
  const chats: RawChat[] = [];
  for (const item of arr) {
    const conv = item as {
      name?: unknown;
      created_at?: unknown;
      chat_messages?: Array<{
        sender?: unknown;
        text?: unknown;
        content?: Array<{ type?: unknown; text?: unknown }>;
      }>;
    };
    const msgs: RawMsg[] = [];
    for (const m of conv.chat_messages ?? []) {
      const role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : null;
      if (!role) continue;
      const text =
        asText(m.text).trim() ||
        (m.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => asText(c.text))
          .join('\n');
      if (!text.trim()) continue;
      msgs.push({ role, text });
    }
    const at = Date.parse(asText(conv.created_at)) || Date.now();
    chats.push({ title: asText(conv.name) || 'Untitled', at, msgs });
  }
  return chats;
}

/**
 * Gemini via Google Takeout ("My Activity → Gemini Apps", JSON): prompt-only
 * activity records. No assistant side exists in the export, so each day's
 * prompts become one user-only chat — thin, but the user's own words are the
 * part that matters for life notes anyway.
 */
function parseGemini(arr: unknown[]): RawChat[] {
  const byDay = new Map<string, RawChat>();
  for (const item of arr) {
    const rec = item as { title?: unknown; time?: unknown; header?: unknown };
    const title = asText(rec.title);
    if (!title.startsWith('Prompted ')) continue;
    const at = Date.parse(asText(rec.time)) || Date.now();
    const key = day(at);
    let chat = byDay.get(key);
    if (!chat) {
      chat = { title: `Gemini prompts — ${key}`, at, msgs: [] };
      byDay.set(key, chat);
    }
    chat.msgs.push({ role: 'user', text: title.slice('Prompted '.length) });
  }
  return [...byDay.values()];
}

function sniffSource(arr: unknown[]): LifeSource | undefined {
  for (const item of arr.slice(0, 5)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (o.mapping && typeof o.mapping === 'object') return 'chatgpt';
    if (Array.isArray(o.chat_messages)) return 'claude';
    if (
      typeof o.title === 'string' &&
      (o.title.startsWith('Prompted ') || String(o.header ?? '').includes('Gemini'))
    ) {
      return 'gemini';
    }
  }
  return undefined;
}

function parseJsonExport(text: string): { source: LifeSource; chats: RawChat[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of conversations.');
  const source = sniffSource(parsed);
  if (!source) {
    throw new Error(
      'Format not recognized. Supported: ChatGPT export (conversations.json), Claude export ' +
        '(conversations.json), Google Takeout Gemini activity (MyActivity.json).',
    );
  }
  const chats =
    source === 'chatgpt'
      ? parseChatGpt(parsed)
      : source === 'claude'
        ? parseClaude(parsed)
        : parseGemini(parsed);
  return { source, chats };
}

export function parseExportFile(path: string): { source: LifeSource; chats: RawChat[] } {
  const size = statSync(path).size;
  if (size > 1_500_000_000) {
    throw new Error(
      'That archive is over 1.5GB. For Google Takeout, export only "My Activity → Gemini Apps" ' +
        '(JSON format); for others, point me at the conversations.json inside the export.',
    );
  }
  if (path.toLowerCase().endsWith('.zip')) {
    const zip = openZip(path);
    // The known layouts first, then any JSON that sniffs as a supported shape.
    const conv = zip.entries.find((e) => /(^|\/)conversations\.json$/i.test(e.name));
    if (conv) return parseJsonExport(readZipText(zip, conv));
    const gemini = zip.entries.find(
      (e) => /MyActivity\.json$/i.test(e.name) && /gemini/i.test(e.name),
    );
    if (gemini) return parseJsonExport(readZipText(zip, gemini));
    const candidates = zip.entries
      .filter((e) => e.name.toLowerCase().endsWith('.json') && e.size > 1_000)
      .sort((a, b) => b.size - a.size)
      .slice(0, 5);
    for (const c of candidates) {
      try {
        return parseJsonExport(readZipText(zip, c));
      } catch {
        // try the next one
      }
    }
    throw new Error(
      'No conversations.json (ChatGPT/Claude) or Gemini MyActivity.json found in that archive.',
    );
  }
  if (path.toLowerCase().endsWith('.json')) {
    return parseJsonExport(readFileSync(path, 'utf8'));
  }
  throw new Error('Give me the export .zip or the conversations.json from inside it.');
}

// ---- trimming: the free 100× ----

function trimDeep(chats: RawChat[]): TrimmedChat[] {
  const out: TrimmedChat[] = [];
  for (const chat of chats) {
    const userChars = chat.msgs
      .filter((m) => m.role === 'user')
      .reduce((n, m) => n + m.text.length, 0);
    if (userChars < MIN_USER_CHARS) continue;
    let block = `[${day(chat.at)}] "${squash(chat.title).slice(0, 120)}"\n`;
    let prev = '';
    let taken = 0;
    for (const m of chat.msgs) {
      if (taken >= CHAT_MSGS_MAX || block.length >= CHAT_CHARS_MAX) break;
      const text = squash(m.text);
      if (!text || text === prev) continue; // duplicated retries
      prev = text;
      const cap = m.role === 'user' ? USER_MSG_MAX : ASSIST_MSG_MAX;
      const line = `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${text.slice(0, cap)}\n`;
      if (block.length + line.length > CHAT_CHARS_MAX) break;
      block += line;
      taken++;
    }
    out.push({ at: chat.at, block });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

function trimSkim(chats: RawChat[]): TrimmedChat[] {
  const out: TrimmedChat[] = [];
  for (const chat of chats) {
    const firstUser = chat.msgs.find((m) => m.role === 'user');
    if (!firstUser || squash(firstUser.text).length < MIN_USER_CHARS) continue;
    const turns = chat.msgs.filter((m) => m.role === 'user').length;
    out.push({
      at: chat.at,
      block:
        `[${day(chat.at)}] "${squash(chat.title).slice(0, 120)}" — ` +
        `${squash(firstUser.text).slice(0, SKIM_FIRST_MAX)} (${turns} user turns)\n`,
    });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

interface Bite {
  from: number;
  to: number; // exclusive
  text: string;
}

function packBites(trimmed: TrimmedChat[]): Bite[] {
  const bites: Bite[] = [];
  let from = 0;
  let text = '';
  for (let i = 0; i < trimmed.length; i++) {
    const block = trimmed[i]!.block + '\n';
    if (text && text.length + block.length > BITE_MAX_CHARS) {
      bites.push({ from, to: i, text });
      from = i;
      text = '';
    }
    text += block;
  }
  if (text) bites.push({ from, to: trimmed.length, text });
  return bites;
}

function estTokens(trimmed: TrimmedChat[]): number {
  const content = trimmed.reduce((n, t) => n + t.block.length + 1, 0);
  const calls = Math.max(1, Math.ceil(content / BITE_MAX_CHARS));
  return Math.ceil((content + calls * CALL_OVERHEAD_CHARS + 8_000) / 4);
}

// ---- prompts ----

function bitePrompt(
  source: LifeSource,
  index: string,
  bite: Bite,
  total: number,
): string {
  return (
    `You are building the LIFE MEMORY of this app's user by reading their exported ` +
    `${lifeSourceLabel(source)} archive — conversations they had with ANOTHER assistant, outside ` +
    'this app, before now. Distill this slice into durable notes about the USER.\n' +
    'Keep only what still matters across months: who they are (identity), how they like things ' +
    'done (preference), projects that kept coming back and their fate (project), skills and tools ' +
    '(skill), lasting facts (fact), or a defining period (era).\n' +
    'Op shapes:\n' +
    '{"op":"upsert","kind":"identity|preference|project|skill|fact|era","title":"short name",' +
    '"body":"1-2 dense sentences","period":"e.g. 2024 or 2023-2025","tags":"a,b"}\n' +
    '{"op":"status","kind":"project","title":"short name","status":"superseded"}\n' +
    `Rules: REUSE an existing title when it is the same thing — the upsert updates it; never ` +
    `restate an existing note unchanged; no chat-by-chat trivia; at most ${MAX_OPS_PER_BITE} ops; ` +
    '{"ops":[]} if nothing durable. Output ONLY the JSON object.\n\n' +
    `EXISTING LIFE NOTES:\n${index || '(none yet)'}\n\n` +
    `THE SLICE (chats ${bite.from + 1}–${bite.to} of ${total}, oldest first):\n${bite.text}`
  );
}

function finalPrompt(source: LifeSource, total: number, span: string, notes: string): string {
  return (
    `You are Vodo. You have just finished reading the user's exported ` +
    `${lifeSourceLabel(source)} archive — ${total} conversations, ${span} — and distilled it ` +
    'into the life notes below. Those conversations happened with a DIFFERENT assistant, outside ' +
    'this app: you were not there, and no transcript of them exists here. These notes are all ' +
    'you keep.\n' +
    'Write, in first person to the user, what you learned about them: the big threads, who they ' +
    'are, what kept coming back. Warm and concrete, 1-2 short paragraphs, no bullet lists, no ' +
    'preamble.\n' +
    'Then on its own line write --- followed by a JSON object {"ops":[...]} with up to 6 upserts ' +
    'that merge or sharpen the MOST important notes (shapes: {"op":"upsert","kind":"identity|' +
    'preference|project|skill|fact|era","title":"...","body":"...","period":"...","tags":"..."}), ' +
    'or {"ops":[]}.\n\n' +
    `LIFE NOTES FROM THIS ARCHIVE:\n${notes}`
  );
}

/** Strict parse mirroring membank.parseOps — garbage throws, the bite retries. */
export function parseLifeOps(raw: string): LifeOp[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('digester returned no JSON object');
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { ops?: unknown };
  if (!Array.isArray(parsed.ops)) throw new Error('digester JSON has no ops array');
  return parsed.ops.filter(
    (o): o is LifeOp =>
      !!o && typeof o === 'object' && ['upsert', 'status'].includes((o as LifeOp).op),
  );
}

function parseFinal(raw: string): { summary: string; ops: LifeOp[] } {
  const cut = raw.lastIndexOf('---');
  if (cut >= 0) {
    let ops: LifeOp[] = [];
    try {
      ops = parseLifeOps(raw.slice(cut + 3));
    } catch {
      ops = [];
    }
    return { summary: raw.slice(0, cut).trim().slice(0, 4_000), ops };
  }
  const trimmedRaw = raw.trim();
  if (trimmedRaw.startsWith('{')) {
    try {
      return { summary: '', ops: parseLifeOps(trimmedRaw) };
    } catch {
      // fall through — treat it as prose
    }
  }
  return { summary: trimmedRaw.slice(0, 4_000), ops: [] };
}

// ---- the importer ----

export type LifeComplete = (prompt: string, signal: AbortSignal) => Promise<string>;

interface ParseCache {
  path: string;
  source: LifeSource;
  deep: TrimmedChat[];
  skim: TrimmedChat[];
  span: string;
}

export class LifeImporter {
  private run: { batchId: number; abort: AbortController; processed: number; total: number } | null =
    null;
  private cache: ParseCache | null = null;

  constructor(
    private deps: {
      bank: MemoryBank;
      notify: (ev: LifeProgressEvent) => void;
    },
  ) {}

  running(): { batchId: number; processed: number; total: number } | undefined {
    return this.run
      ? { batchId: this.run.batchId, processed: this.run.processed, total: this.run.total }
      : undefined;
  }

  cancel(): void {
    this.run?.abort.abort();
  }

  private parse(path: string): ParseCache {
    if (this.cache?.path === path) return this.cache;
    const { source, chats } = parseExportFile(path);
    const deep = trimDeep(chats);
    const skim = trimSkim(chats);
    const dated = deep.length ? deep : skim;
    const span = dated.length ? `${day(dated[0]!.at)} to ${day(dated[dated.length - 1]!.at)}` : '';
    this.cache = { path, source, deep, skim, span };
    return this.cache;
  }

  /** Parse + trim + count — the free stage, so the price tag comes BEFORE the burn. */
  scan(path: string): LifeScanDto {
    try {
      const { source, chats } = parseExportFile(path);
      this.cache = null; // re-derive below so scan always reflects the file on disk
      const deep = trimDeep(chats);
      const skim = trimSkim(chats);
      const dated = deep.length ? deep : skim;
      const span = dated.length
        ? `${day(dated[0]!.at)} to ${day(dated[dated.length - 1]!.at)}`
        : '';
      this.cache = { path, source, deep, skim, span };
      return {
        ok: true,
        source,
        sourceLabel: lifeSourceLabel(source),
        chatsFound: chats.length,
        chatsKept: deep.length,
        estTokensDeep: estTokens(deep),
        estTokensSkim: estTokens(skim),
        span,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async start(
    path: string,
    opts: { depth: 'deep' | 'skim'; resumeBatchId?: number; modelLabel: string },
    complete: LifeComplete,
    completeFinal: LifeComplete,
  ): Promise<{ ok: boolean; batchId?: number; error?: string }> {
    if (this.run) return { ok: false, error: 'An import is already running.' };
    let parsed: ParseCache;
    try {
      parsed = this.parse(path);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const trimmed = opts.depth === 'skim' ? parsed.skim : parsed.deep;
    if (trimmed.length === 0) {
      return { ok: false, error: 'Nothing worth reading survived the trim — is this the right file?' };
    }
    const bank = this.deps.bank;
    let batchId: number;
    let notes = 0;
    if (opts.resumeBatchId !== undefined) {
      const batch = bank.lifeBatchGet(opts.resumeBatchId);
      if (!batch) return { ok: false, error: 'That import run no longer exists.' };
      if (batch.status === 'done' || batch.status === 'running') {
        return { ok: false, error: 'That import run is not resumable.' };
      }
      if (batch.chatsTotal !== trimmed.length || batch.source !== parsed.source) {
        return { ok: false, error: 'The file no longer matches that run — start a fresh import.' };
      }
      batchId = batch.id;
      notes = batch.notes;
      bank.lifeBatchUpdate(batchId, { status: 'running', error: '', model: opts.modelLabel });
    } else {
      batchId = bank.lifeBatchCreate({
        source: parsed.source,
        file: path,
        model: opts.modelLabel,
        chatsTotal: trimmed.length,
        depth: opts.depth,
      });
    }
    const abort = new AbortController();
    const startFrom = opts.resumeBatchId !== undefined
      ? (bank.lifeBatchGet(batchId)?.cursor ?? 0)
      : 0;
    this.run = { batchId, abort, processed: startFrom, total: trimmed.length };
    void this.loop(parsed, trimmed, batchId, startFrom, notes, complete, completeFinal, abort.signal);
    return { ok: true, batchId };
  }

  private async loop(
    parsed: ParseCache,
    trimmed: TrimmedChat[],
    batchId: number,
    startFrom: number,
    notesSoFar: number,
    complete: LifeComplete,
    completeFinal: LifeComplete,
    signal: AbortSignal,
  ): Promise<void> {
    const bank = this.deps.bank;
    const total = trimmed.length;
    let notes = notesSoFar;
    const emit = (ev: Omit<LifeProgressEvent, 'batchId' | 'total' | 'notes'>) =>
      this.deps.notify({ batchId, total, notes, ...ev });
    try {
      for (const bite of packBites(trimmed)) {
        if (bite.to <= startFrom) continue; // resumed past this bite already
        if (signal.aborted) throw new Error('canceled');
        const prompt = bitePrompt(parsed.source, bank.lifeIndex(), bite, total);
        // Two attempts per bite; a bite that still fails to parse yields no
        // ops but must not wedge the whole run.
        let ops: LifeOp[] = [];
        let lastErr: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            ops = parseLifeOps(await complete(prompt, signal));
            lastErr = undefined;
            break;
          } catch (err) {
            lastErr = err;
            if (signal.aborted) throw err;
          }
        }
        if (lastErr && !(lastErr instanceof SyntaxError) && !String(lastErr).includes('JSON')) {
          // A real transport/model failure (not just unparsable output): stop
          // resumable rather than silently skipping the rest of the archive.
          throw lastErr;
        }
        notes += bank.lifeApplyOps(ops, { source: parsed.source, batchId });
        this.run!.processed = bite.to;
        bank.lifeBatchUpdate(batchId, { cursor: bite.to, notes });
        emit({ phase: 'reading', processed: bite.to });
      }
      // The final pass runs on Vodo's own model: the part that becomes his
      // voice — "here is what I learned about you" — is written by the brain
      // that will live with it. Its input is only the distilled notes: tiny.
      emit({ phase: 'final', processed: total });
      let summary = '';
      try {
        const batchNotes = bank.lifeIndex(9_000, batchId);
        const res = parseFinal(
          await completeFinal(finalPrompt(parsed.source, total, parsed.span, batchNotes), signal),
        );
        summary = res.summary;
        notes += bank.lifeApplyOps(res.ops, { source: parsed.source, batchId });
      } catch (err) {
        if (signal.aborted) throw err;
        // The notes are already saved — the valuable part. Note the miss and finish.
        bank.lifeBatchUpdate(batchId, {
          error: `final pass failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      bank.lifeBatchUpdate(batchId, {
        status: 'done',
        cursor: total,
        notes,
        summary,
        finishedAt: Date.now(),
      });
      emit({ phase: 'done', processed: total, summary });
    } catch (err) {
      const canceled = signal.aborted;
      const message = err instanceof Error ? err.message : String(err);
      bank.lifeBatchUpdate(batchId, {
        status: canceled ? 'canceled' : 'error',
        ...(canceled ? {} : { error: message }),
      });
      emit({
        phase: canceled ? 'canceled' : 'error',
        processed: this.run?.processed ?? startFrom,
        ...(canceled ? {} : { error: message }),
      });
    } finally {
      this.run = null;
    }
  }
}
