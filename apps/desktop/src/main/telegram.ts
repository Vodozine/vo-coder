import { AgentSession, type PermissionDecision } from '@vo-coder/core';
import type { AgentSpec, BoundModel, ToolSpec, UserPart } from '@vo-coder/providers';
import type { TelegramInfo } from '../shared/ipc-contract';
import type { ConfigStore } from './config';
import { fmtStamp } from './journal';
import type { SecretStore } from './secrets';
import { AUTO_ALLOWED_TOOLS } from './tool-policy';

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
const PERMISSION_TIMEOUT_MS = 4 * 60_000;
const CHUNK = 3_900;

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    photo?: unknown[];
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
  resolve(spec: AgentSpec, override?: { provider?: string; model?: string }): BoundModel;
  route(
    text: string,
  ): Promise<{ provider: string; model: string; rationale: string } | undefined>;
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
  routedNote?: string;
  basePrompt: string;
}

export class TelegramBridge {
  private running = false;
  private abort: AbortController | null = null;
  private offset = 0;
  private botUsername?: string;
  private lastError?: string;
  private pairCode: { code: string; expiresAt: number } | null = null;
  private chats = new Map<number, ChatState>();
  private pendingPerms = new Map<string, (d: PermissionDecision) => void>();
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

  generatePairCode(): { code: string; expiresInSec: number } {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    this.pairCode = { code, expiresAt: Date.now() + PAIR_CODE_TTL_MS };
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
        const resolve = this.pendingPerms.get(match[1]!);
        if (resolve) {
          this.pendingPerms.delete(match[1]!);
          resolve(match[2] as PermissionDecision);
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
        if (codeAttempt === this.pairCode.code) {
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
      'facts); for long or repeating work, create a mission instead of doing it inline.';
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
    fresh.session = new AgentSession({
      id: `tg_${chatId}`,
      spec,
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
          const note = fresh.routedNote;
          fresh.routedNote = undefined;
          if (out) void this.sendText(chatId, note ? `${out}\n\n🧭 ${note}` : out);
        }
      },
      toolExecutor: {
        tools: () => this.backend.tools(),
        execute: (name, args) => this.backend.execute(name, args),
      },
      permission: (req) => this.requestPermission(chatId, req.name, req.args),
    });
    state = fresh;
    this.chats.set(chatId, state);
    return state;
  }

  private async chat(chatId: number, text: string): Promise<void> {
    const state = this.chatState(chatId);
    this.backend.log?.(text);
    // Keep the agent's clock fresh — the spec is rebuilt per turn.
    state.session.spec = {
      ...state.session.spec,
      systemPrompt: `${state.basePrompt}\nCurrent local date-time: ${fmtStamp(Date.now())}.`,
    };
    const pick = await this.backend.route(text).catch(() => undefined);
    const parts: UserPart[] = [{ type: 'text', text }];
    if (pick) state.routedNote = pick.rationale;

    const result =
      state.session.getStatus() === 'idle'
        ? state.session.send(parts, pick ? { provider: pick.provider, model: pick.model } : undefined)
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
    if (AUTO_ALLOWED_TOOLS.has(name)) return Promise.resolve('allow');
    return new Promise((resolve) => {
      const id = `tg${++this.permSeq}`;
      this.pendingPerms.set(id, resolve);
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

  private async api<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<{ ok: boolean; result?: T; error?: string }> {
    const token = this.token();
    if (!token) return { ok: false, error: 'No bot token.' };
    const ctl = signal ? null : new AbortController();
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? ctl!.signal,
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
