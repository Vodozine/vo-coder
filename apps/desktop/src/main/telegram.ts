import { randomBytes, randomInt } from 'node:crypto';

import { AgentSession, type PermissionDecision } from '@vo-coder/core';
import type { AgentSpec, BoundModel, ToolSpec, UserPart } from '@vo-coder/providers';
import type { TelegramInfo } from '../shared/ipc-contract';
import type { ConfigStore } from './config';
import { elideOldTraffic, planWindow } from './context-window';
import { fmtStamp } from './journal';
import type { SecretStore } from './secrets';
import { permissionFor } from './tool-policy';

/**
 * Telegram remote control: talk to Vodo from your phone, start missions, get
 * mission notifications, and approve tool calls with inline buttons. Long
 * polling — no webhook, no public IP, works from behind any NAT.
 *
 * Security model: the bot only ever talks to PAIRED chats. Pairing needs a
 * one-time code generated in Settings on this machine — a stranger finding the
 * bot can't do anything but ask to pair.
 */

const POLL_TIMEOUT_SEC = 50;
const RETRY_DELAY_MS = 5_000;
const PAIR_CODE_TTL_MS = 10 * 60_000;
const MAX_PAIR_ATTEMPTS = 5;
const PERMISSION_TIMEOUT_MS = 4 * 60_000;
const CHUNK = 3_900;

/** Telegram caps bot downloads at 20 MB; refuse before spending the round trip. */
const MAX_INBOUND_BYTES = 20 * 1024 * 1024;
/** …and bot uploads at 50 MB. Stop short of it so the failure is ours, and legible. */
const MAX_OUTBOUND_BYTES = 45 * 1024 * 1024;
/** Tools the bridge runs itself — everything else goes to the app's executor. */
const PHONE_TOOLS = new Set(['telegram_voice_note', 'telegram_send_file']);

interface TgAudio {
  file_id: string;
  duration?: number;
  mime_type?: string;
  file_name?: string;
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    caption?: string;
    photo?: unknown[];
    /** A held-mic voice note (Opus), a sent audio file, and a round video. */
    voice?: TgAudio;
    audio?: TgAudio;
    video_note?: TgAudio;
    chat: { id: number; first_name?: string; username?: string; type: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number } };
  };
}

export interface TelegramAgentBackend {
  vodoSpec(): AgentSpec;
  /** Words out of a clip the user sent. Absent = voice not configured. */
  transcribe?(data: Uint8Array, mimeType: string, fileName: string): Promise<string>;
  /** Speech as bytes, for a voice note. Null when the engine only speaks aloud here. */
  synthesize?(text: string): Promise<{ data: Uint8Array; mimeType: string } | null>;
  /** A file the user asked for, read under the same folder policy as the app. */
  readFile?(path: string): { data: Uint8Array; name: string } | { error: string };
  resolve(spec: AgentSpec, override?: { provider?: string; model?: string }): BoundModel;
  tools(): ToolSpec[];
  execute(name: string, args: unknown): Promise<{ content: string; isError?: boolean }>;
  missionsSummary(): string;
  onUsage(bound: BoundModel | undefined, ev: { inputTokens: number; outputTokens: number }): void;
  onChanged(info: TelegramInfo): void;
  /** Activity journaling for incoming messages. */
  log?(text: string): void;
}

interface ChatState {
  session: AgentSession;
  bound?: BoundModel;
  buffer: string;
  basePrompt: string;
}

export class TelegramBridge {
  private running = false;
  private abort: AbortController | null = null;
  private offset = 0;
  private botUsername?: string;
  private lastError?: string;
  private pairCode: { code: string; expiresAt: number; failures: number } | null = null;
  private chats = new Map<number, ChatState>();
  // Each pending request remembers the chat that raised it, so an approval can
  // only come back from that same chat rather than from any paired one.
  private pendingPerms = new Map<
    string,
    { chatId: number; resolve: (d: PermissionDecision) => void }
  >();
  private permSeq = 0;

  constructor(
    private config: ConfigStore,
    private secrets: SecretStore,
    private backend: TelegramAgentBackend,
  ) {}

  private token(): string | null {
    return this.secrets.get('telegram');
  }

  info(): TelegramInfo {
    const cfg = this.config.get();
    return {
      configured: !!this.token(),
      enabled: cfg.telegramEnabled,
      polling: this.running,
      paired: cfg.telegramPaired,
      ...(this.botUsername ? { botUsername: this.botUsername } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /** Start/stop polling to match config + token. Call after any relevant change. */
  sync(): void {
    const should = this.config.get().telegramEnabled && !!this.token();
    if (should && !this.running) void this.start();
    if (!should && this.running) this.stop();
    this.changed();
  }

  /**
   * Pairing is the whole perimeter — a paired chat can drive the agent — so the
   * code comes from the CSPRNG rather than Math.random (xorshift128+, and
   * predictable from prior output), and it burns after a handful of wrong
   * guesses instead of standing until its TTL.
   */
  generatePairCode(): { code: string; expiresInSec: number } {
    const code = String(randomInt(100000, 1000000));
    this.pairCode = { code, expiresAt: Date.now() + PAIR_CODE_TTL_MS, failures: 0 };
    return { code, expiresInSec: PAIR_CODE_TTL_MS / 1000 };
  }

  unpair(chatId: number): void {
    const cfg = this.config.get();
    this.config.set({ telegramPaired: cfg.telegramPaired.filter((p) => p.id !== chatId) });
    this.chats.delete(chatId);
    this.changed();
  }

  /** Ask the (first) paired user to approve a tool call — mission fallback. */
  askPermissionFromUser(
    label: string,
    tool: string,
    args: unknown,
  ): Promise<PermissionDecision> {
    const first = this.config.get().telegramPaired[0];
    if (!first || !this.running) return Promise.resolve('deny');
    return this.requestPermission(first.id, `${tool} — mission "${label}"`, args);
  }

  /** Broadcast to every paired chat (mission notifications). */
  notify(text: string): void {
    if (!this.running) return;
    for (const p of this.config.get().telegramPaired) {
      void this.sendText(p.id, text);
    }
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
    this.abort = null;
    this.changed();
  }

  private changed(): void {
    this.backend.onChanged(this.info());
  }

  private async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.lastError = undefined;
    const me = await this.api<{ username?: string }>('getMe', {});
    if (!me.ok) {
      this.lastError = `Token check failed: ${me.error}`;
      this.running = false;
      this.changed();
      return;
    }
    this.botUsername = me.result?.username;
    this.changed();
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      this.abort = new AbortController();
      try {
        const res = await this.api<TgUpdate[]>(
          'getUpdates',
          { timeout: POLL_TIMEOUT_SEC, offset: this.offset, allowed_updates: ['message', 'callback_query'] },
          this.abort.signal,
          (POLL_TIMEOUT_SEC + 15) * 1000,
        );
        if (!this.running) return;
        if (!res.ok) {
          // 409 = another poller owns this token (e.g. dev + installed app).
          this.lastError = res.error;
          this.changed();
          await this.sleep(RETRY_DELAY_MS);
          continue;
        }
        if (this.lastError) {
          this.lastError = undefined;
          this.changed();
        }
        for (const update of res.result ?? []) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          try {
            await this.handle(update);
          } catch (err) {
            console.error('[telegram] update failed:', err);
          }
        }
      } catch {
        if (!this.running) return;
        await this.sleep(RETRY_DELAY_MS);
      }
    }
  }

  private async handle(update: TgUpdate): Promise<void> {
    if (update.callback_query) {
      const cb = update.callback_query;
      const match = /^perm:([^:]+):(allow|deny)$/.exec(cb.data ?? '');
      const chatId = cb.message?.chat.id;
      if (match && chatId !== undefined && this.isPaired(chatId)) {
        const pending = this.pendingPerms.get(match[1]!);
        // Bound to its origin chat: with two paired phones, one must not be able
        // to answer a prompt raised on the other.
        if (pending && pending.chatId === chatId) {
          this.pendingPerms.delete(match[1]!);
          pending.resolve(match[2] as PermissionDecision);
          void this.api('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: match[2] === 'allow' ? 'Allowed ✓' : 'Denied ✕',
          });
          return;
        }
      }
      void this.api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Expired.' });
      return;
    }

    const msg = update.message;
    if (!msg || msg.chat.type !== 'private') return;
    const chatId = msg.chat.id;
    const text = (msg.text ?? '').trim();

    if (!this.isPaired(chatId)) {
      const codeAttempt = /^\/start\s+(\d{6})$/.exec(text)?.[1] ?? /^(\d{6})$/.exec(text)?.[1];
      if (codeAttempt && this.pairCode && Date.now() < this.pairCode.expiresAt) {
        if (codeAttempt !== this.pairCode.code) {
          // Wrong guess: burn the code well before six digits can be walked.
          if (++this.pairCode.failures >= MAX_PAIR_ATTEMPTS) {
            this.pairCode = null;
            await this.sendText(
              chatId,
              'That code is wrong, and too many attempts have been made. Generate a fresh code in Vo-Coder and try again.',
            );
            return;
          }
        } else {
          this.pairCode = null;
          const cfg = this.config.get();
          const name = msg.chat.username ?? msg.chat.first_name;
          this.config.set({
            telegramPaired: [
              ...cfg.telegramPaired,
              { id: chatId, ...(name ? { name } : {}) },
            ],
          });
          this.changed();
          await this.sendText(
            chatId,
            '🔗 Paired with Vo-Coder. You are talking to Vodo — ask for anything, ' +
              'start missions ("check my proxmox backups every hour"), or send /missions to see them.',
          );
          return;
        }
      }
      if (text.startsWith('/start')) {
        await this.sendText(
          chatId,
          'This Vo-Coder instance is not paired with you. Open Vo-Coder → Settings → Telegram, ' +
            'generate a pairing code, and send it here.',
        );
      }
      return; // silence for anything else from strangers
    }

    if (msg.photo) {
      await this.sendText(chatId, 'Photos are not supported from Telegram yet — text only for now.');
      return;
    }

    // A voice note is you talking. It gets transcribed and handled like typing;
    // whether the ANSWER comes back as speech is Vodo's call, made from what you
    // asked for — he has a voice-note tool and uses it when you want it.
    const clip = msg.voice ?? msg.audio ?? msg.video_note;
    if (clip) {
      const heard = await this.transcribeClip(chatId, clip);
      if (!heard) return;
      const caption = (msg.caption ?? '').trim();
      await this.chat(chatId, caption ? `${heard}\n\n(${caption})` : heard);
      return;
    }
    if (!text) return;

    if (text === '/missions') {
      await this.sendText(chatId, this.backend.missionsSummary());
      return;
    }
    if (text === '/help' || text === '/start') {
      await this.sendText(
        chatId,
        'You are talking to Vodo. Plain messages are handled like in the app — it can search the web, ' +
          'run missions, and use your MCP tools. Commands: /missions — list missions.',
      );
      return;
    }

    await this.chat(chatId, text);
  }

  /**
   * Voice note → words. The clip is echoed back as text first: transcription is
   * never perfect, and seeing what was heard is how you catch the turn that went
   * wrong — especially in a language the model is guessing at.
   */
  private async transcribeClip(chatId: number, clip: TgAudio): Promise<string | null> {
    if (!this.backend.transcribe) {
      await this.sendText(chatId, '🎤 Voice is not wired up on this machine.');
      return null;
    }
    const file = await this.download(clip.file_id);
    if (!file) {
      await this.sendText(chatId, '🎤 Could not fetch that clip (Telegram caps bot downloads at 20 MB).');
      return null;
    }
    const name = clip.file_name ?? file.path.split('/').pop() ?? 'voice.ogg';
    try {
      const text = (await this.backend.transcribe(file.data, clip.mime_type ?? 'audio/ogg', name)).trim();
      if (!text) {
        await this.sendText(chatId, '🎤 Nothing came through in that clip.');
        return null;
      }
      await this.sendText(chatId, `🎤 “${text}”`);
      return text;
    } catch (err) {
      await this.sendText(
        chatId,
        `🎤 Could not transcribe that: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private isPaired(chatId: number): boolean {
    return this.config.get().telegramPaired.some((p) => p.id === chatId);
  }

  private chatState(chatId: number): ChatState {
    let state = this.chats.get(chatId);
    if (state) return state;

    const base = this.backend.vodoSpec();
    const basePrompt =
      `${base.systemPrompt ?? ''}\n\n` +
      'You are talking to the user over Telegram — they are away from the machine. Keep replies ' +
      'compact and plain-text (no markdown tables). You have web tools, mission tools, and ' +
      'cross-everything memory (memory_recall over the full activity journal; memory_note to pin ' +
      'facts); for long or repeating work, create a mission instead of doing it inline.\n\n' +
      'BUILDING IS NOT YOUR JOB — you are the dispatcher. Vodo at the machine has the folders, ' +
      'the file tools and the agent team; you have a phone connection. When the user asks for ' +
      'something BUILT (a project, an app, a site, a document, any real work in a folder), hand ' +
      'it over with vodo_dispatch instead of attempting it here. Pass the request ON in full — ' +
      'especially WHERE the folder goes and whether they said "project" or "GROUP PROJECT" — ' +
      'and add anything the two of you worked out in this chat, because the Vodo receiving it ' +
      'cannot see these messages. Ask for a location if they did not give one. Then tell the ' +
      'user it is running and that they can watch it in the app. Questions, lookups, status and ' +
      'memory you answer here yourself.\n' +
      'MOST PHONE WORK CONTINUES SOMETHING THAT EXISTS. A conversation here rarely maps to one ' +
      'dispatch: the user thinks of another change, then another. Each of those belongs to the ' +
      'SAME project, so pass its name in the dispatch `project` field (the tool lists what ' +
      'exists) instead of letting every message start a new one. Only leave it out when they ' +
      'are genuinely starting something new — and if you are unsure which project it is, ask ' +
      'them, it is one short question.\n\n' +
      'THIS IS A PHONE, so you can answer with more than text — but only when it is what was ' +
      'asked for. telegram_voice_note speaks a reply aloud: use it when they ask you to talk, to ' +
      'read something out, or say they are driving or walking; not otherwise, and never as well ' +
      'as the same thing in text. A voice message from them is just them talking — it does NOT ' +
      'mean they want spoken answers back, so keep replying in text until they say. ' +
      'telegram_send_file puts a file from the machine on their phone when they ask for one.';
    const spec: AgentSpec = {
      ...base,
      id: `tg_${chatId}`,
      name: 'Vodo',
      systemPrompt: basePrompt,
    };

    const fresh: ChatState = {
      buffer: '',
      basePrompt,
      session: undefined as unknown as AgentSession,
    };
    let windowHotOff = 0;
    fresh.session = new AgentSession({
      id: `tg_${chatId}`,
      spec,
      // A paired phone chat runs for months. Without a bound it replayed its
      // ENTIRE history to the model every message and held it all in main-process
      // memory for the app's life. Keep a generous recent tail (~15k tokens)
      // verbatim, reach further back through the dialogue with tool bulk elided,
      // and cut at user boundaries so tool pairs are never split.
      contextStart: (history) => {
        const plan = planWindow(history, 60_000, 24_000);
        windowHotOff = plan.hot - plan.start;
        return plan.start;
      },
      prepareMessages: (messages) => elideOldTraffic(messages, windowHotOff),
      resolve: (s) => {
        const bound = this.backend.resolve(s);
        fresh.bound = bound;
        return bound;
      },
      emit: (_sid, event) => {
        if (event.type === 'text_delta') fresh.buffer += event.text;
        else if (event.type === 'error') {
          fresh.buffer += `\n⚠ ${event.error.message}`;
        } else if (event.type === 'usage') {
          this.backend.onUsage(fresh.bound, event);
        } else if (event.type === 'status' && event.status === 'idle') {
          const out = fresh.buffer.trim();
          fresh.buffer = '';
          if (out) void this.sendText(chatId, out);
        }
      },
      toolExecutor: {
        tools: () => [...this.backend.tools(), ...this.phoneToolSpecs()],
        execute: (name, args) =>
          PHONE_TOOLS.has(name)
            ? this.runPhoneTool(chatId, name, args)
            : this.backend.execute(name, args),
      },
      permission: (req) => this.requestPermission(chatId, req.name, req.args),
    });
    state = fresh;
    this.chats.set(chatId, state);
    return state;
  }

  /**
   * What Vodo can put on your phone besides words. These are TOOLS rather than
   * a setting because the choice belongs in the conversation: "send me that
   * file", "just talk to me for a while" and "read that back" are three
   * different answers to three different requests, and a global "always speak"
   * switch gets every one of them wrong half the time.
   */
  private phoneToolSpecs(): ToolSpec[] {
    const specs: ToolSpec[] = [];
    if (this.backend.synthesize) {
      specs.push({
        name: 'telegram_voice_note',
        description:
          'Say something to the user as a VOICE NOTE on Telegram instead of text. Use it when ' +
          'they asked to be spoken to, asked you to read something out, or are clearly away ' +
          'from a screen (driving, walking). Keep it short and speakable — no markdown, no code, ' +
          'no lists. Your written reply still goes as text unless you say otherwise, so do not ' +
          'repeat yourself: put the answer in ONE of the two.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'What to say aloud.' } },
          required: ['text'],
        },
      });
    }
    if (this.backend.readFile) {
      specs.push({
        name: 'telegram_send_file',
        description:
          'Send a file from this machine to the user on Telegram — a document, an image, a log, ' +
          'anything they asked to be sent over. Absolute path. Up to 45 MB.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path of the file to send.' },
            caption: { type: 'string', description: 'Optional one-line note with it.' },
          },
          required: ['path'],
        },
      });
    }
    return specs;
  }

  private async runPhoneTool(
    chatId: number,
    name: string,
    args: unknown,
  ): Promise<{ content: string; isError?: boolean }> {
    const a = (args ?? {}) as { text?: string; path?: string; caption?: string };
    if (name === 'telegram_voice_note') {
      const text = (a.text ?? '').trim();
      if (!text) return { content: 'Nothing to say.', isError: true };
      try {
        const audio = await this.backend.synthesize?.(text);
        if (!audio) {
          return {
            content:
              'No voice available: the speech engine is the local system voice, which speaks out ' +
              'of the machine rather than producing a file. Settings → Voice can point it at a ' +
              'server (Kokoro, Piper, OpenAI, ElevenLabs). Answer as text this time.',
            isError: true,
          };
        }
        // sendVoice demands OGG/Opus; everything else goes as an audio file,
        // which plays the same way with a different bubble.
        const ogg = /ogg|opus/.test(audio.mimeType);
        const sent = await this.upload(
          ogg ? 'sendVoice' : 'sendAudio',
          chatId,
          ogg ? 'voice' : 'audio',
          audio.data,
          ogg ? 'voice.ogg' : `voice.${audio.mimeType.includes('wav') ? 'wav' : 'mp3'}`,
          audio.mimeType,
        );
        return sent.ok
          ? { content: 'Voice note sent.' }
          : { content: `Could not send it: ${sent.error}`, isError: true };
      } catch (err) {
        return {
          content: `Speech failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    }
    if (name === 'telegram_send_file') {
      const path = (a.path ?? '').trim();
      if (!path) return { content: 'No path given.', isError: true };
      const file = this.backend.readFile?.(path);
      if (!file) return { content: 'Sending files is not available.', isError: true };
      if ('error' in file) return { content: file.error, isError: true };
      if (file.data.byteLength > MAX_OUTBOUND_BYTES) {
        return { content: 'That file is over Telegram\'s 45 MB bot limit.', isError: true };
      }
      const sent = await this.upload(
        'sendDocument',
        chatId,
        'document',
        file.data,
        file.name,
        'application/octet-stream',
        a.caption ? { caption: a.caption.slice(0, 1000) } : {},
      );
      return sent.ok
        ? { content: `Sent ${file.name}.` }
        : { content: `Could not send it: ${sent.error}`, isError: true };
    }
    return { content: `Unknown tool ${name}.`, isError: true };
  }

  private async chat(chatId: number, text: string): Promise<void> {
    const state = this.chatState(chatId);
    this.backend.log?.(text);
    // Keep the SYSTEM prompt byte-stable so provider prompt caching holds. The
    // clock used to be stamped INTO the system prompt every message — a
    // per-turn-changing prefix, the exact trap the main app documents avoiding:
    // it forces a full re-prefill of the whole prompt (base + phone briefing +
    // every tool schema) on every reply, ~25-36s to first token on a local
    // model. The time rides on the user turn instead, where it costs nothing.
    state.session.spec = { ...state.session.spec, systemPrompt: state.basePrompt };
    // NO routing gate here — Telegram answers with Vodo's own model, always.
    // The gate used to pick per message, pinned turns to whatever provider it
    // favoured (OpenRouter, seen live), and a disabled provider then meant
    // silence on the phone while the app itself answered fine.
    const parts: UserPart[] = [{ type: 'text', text: `[${fmtStamp(Date.now())}] ${text}` }];

    const result =
      state.session.getStatus() === 'idle'
        ? state.session.send(parts)
        : state.session.inject(parts);
    if (!result.ok) {
      await this.sendText(chatId, `⚠ ${result.error ?? 'Could not start that.'}`);
    } else if (result.queued) {
      await this.sendText(chatId, '⏳ Queued behind the current task.');
    }
  }

  private requestPermission(
    chatId: number,
    name: string,
    args: unknown,
  ): Promise<PermissionDecision> {
    // Auto: no prompts. Plan: allow through — the executor's plan-mode block
    // replies instructively instead of a dead Allow/Deny exchange. Spending
    // (ALWAYS_CONFIRM) is asked in every mode — permissionFor enforces that.
    const mode = this.config.get().approvalMode;
    if (permissionFor(name, mode === 'auto' || mode === 'plan') === 'allow') {
      return Promise.resolve('allow');
    }
    return new Promise((resolve) => {
      const id = `tg${++this.permSeq}_${randomBytes(4).toString('hex')}`;
      this.pendingPerms.set(id, { chatId, resolve });
      const argsText = JSON.stringify(args ?? {}, null, 1);
      void this.api('sendMessage', {
        chat_id: chatId,
        text: `🔐 Vodo wants to run "${name}":\n${argsText.slice(0, 900)}`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Allow', callback_data: `perm:${id}:allow` },
              { text: '⛔ Deny', callback_data: `perm:${id}:deny` },
            ],
          ],
        },
      });
      setTimeout(() => {
        if (this.pendingPerms.delete(id)) resolve('deny');
      }, PERMISSION_TIMEOUT_MS);
    });
  }

  private async sendText(chatId: number, text: string): Promise<void> {
    for (let i = 0; i < text.length; i += CHUNK) {
      await this.api('sendMessage', { chat_id: chatId, text: text.slice(i, i + CHUNK) });
    }
  }

  /** Upload a file to a chat — voice notes, documents and photos are multipart,
   *  not JSON, so they cannot go through api(). */
  private async upload(
    method: string,
    chatId: number,
    field: string,
    data: Uint8Array,
    fileName: string,
    mimeType: string,
    extra: Record<string, string> = {},
  ): Promise<{ ok: boolean; error?: string }> {
    const token = this.token();
    if (!token) return { ok: false, error: 'No bot token.' };
    const form = new FormData();
    form.append('chat_id', String(chatId));
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    form.append(
      field,
      new Blob([data as unknown as ArrayBuffer], { type: mimeType }),
      fileName,
    );
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 120_000);
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        body: form,
        signal: ctl.signal,
      });
      const json = (await res.json()) as { ok: boolean; description?: string };
      return json.ok ? { ok: true } : { ok: false, error: json.description ?? `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Download an attachment the user sent (file_id → bytes). */
  private async download(fileId: string): Promise<{ data: Uint8Array; path: string } | null> {
    const token = this.token();
    if (!token) return null;
    const meta = await this.api<{ file_path?: string; file_size?: number }>('getFile', {
      file_id: fileId,
    });
    const filePath = meta.result?.file_path;
    if (!meta.ok || !filePath) return null;
    if ((meta.result?.file_size ?? 0) > MAX_INBOUND_BYTES) return null;
    try {
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
      if (!res.ok) return null;
      return { data: new Uint8Array(await res.arrayBuffer()), path: filePath };
    } catch {
      return null;
    }
  }

  private async api<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<{ ok: boolean; result?: T; error?: string }> {
    const token = this.token();
    if (!token) return { ok: false, error: 'No bot token.' };
    // The timeout applies ALWAYS, even when the caller passes its own signal.
    // It used to be skipped whenever a signal was given, so the long-poll's
    // explicit 65s bound was silently dropped and a half-open socket hung on
    // undici's ~5-minute default — freezing the whole bridge for minutes.
    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
    const composite = signal
      ? AbortSignal.any([signal, timeoutCtl.signal])
      : timeoutCtl.signal;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: composite,
      });
      const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
      if (!json.ok) return { ok: false, error: json.description ?? `HTTP ${res.status}` };
      return { ok: true, result: json.result as T };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
