import { AsyncLocalStorage } from 'node:async_hooks';
import type { CrewUser } from '../shared/ipc-contract';
import { ipcMain } from 'electron';

/**
 * One place that knows every IPC handler and every pushed event.
 *
 * Today the renderer reaches the main process through Electron IPC, which only
 * works because the two are in the same process. Remote mode needs the same
 * calls to arrive over a socket from another machine — so the handlers have to
 * be reachable by name, not just wired to `ipcMain`.
 *
 * The cheap way to get that is to keep every call site exactly as it is and
 * record what goes past: `handle()` is a drop-in for `ipcMain.handle()` that
 * files the function here *and* registers it with Electron. Local mode keeps
 * behaving identically — same functions, same channels — and the registry
 * falls out for free.
 *
 * Handlers are already pure `(args) => result`: nothing in the app reads the
 * IpcMainInvokeEvent (no `event.sender`, no `BrowserWindow.fromWebContents`),
 * every one of them names the parameter `_e` and ignores it. That is what makes
 * calling them with no event at all safe.
 */

/** Electron's own listener type, so anything valid for ipcMain.handle fits. */
type IpcHandler = Parameters<typeof ipcMain.handle>[1];

/** A handler as the socket calls it: no event, just the arguments. */
type BareHandler = (...args: unknown[]) => unknown;

const registry = new Map<string, BareHandler>();

/**
 * Extra destinations for pushed events. The remote server adds one per attached
 * front end; a desktop host that also has its own window open therefore fans
 * out to both, which is the point — one brain, several views of it.
 */
const sinks = new Set<(channel: string, payload: unknown) => void>();

/** Drop-in for `ipcMain.handle` that also files the handler by channel. */
export function handle(channel: string, fn: IpcHandler): void {
  const bare = fn as unknown as (event: null, ...args: unknown[]) => unknown;
  registry.set(channel, (...args: unknown[]) => bare(null, ...args));
  ipcMain.handle(channel, fn);
}

/**
 * Who asked for the call currently running.
 *
 * Handlers are pure `(args) => result` and none of them wants a caller
 * argument threaded through — but a few things genuinely depend on where the
 * request came from. A file dialog is the case that forces it: raised for a
 * laptop driving this machine, it must open on the LAPTOP. Opened here it
 * would appear on a screen nobody is watching and block the call forever.
 *
 * Async-local rather than a parameter, so 153 handlers stay untouched and the
 * two that care can ask.
 */
export interface Caller {
  /** Put a question to the front end that made this call, and await its answer. */
  ask(kind: string, payload: unknown): Promise<unknown>;
  /**
   * The person behind this call, when the backend knows one.
   *
   * Null on a backend that has no crew yet — the single-key case, where there
   * is nobody to name. Handlers that care about identity must treat null as
   * "the machine itself" rather than assuming somebody.
   */
  user: CrewUser | null;
}

const callerStore = new AsyncLocalStorage<Caller>();

/** The front end behind the current call, or null when it came from this window. */
export function currentCaller(): Caller | null {
  return callerStore.getStore() ?? null;
}

/** Call a channel by name, the way an arriving socket message does. */
export async function invoke(channel: string, args: unknown[], caller?: Caller): Promise<unknown> {
  const fn = registry.get(channel);
  if (!fn) throw new Error(`Unknown channel: ${channel}`);
  return caller ? await callerStore.run(caller, () => fn(...args)) : await fn(...args);
}

export function hasChannel(channel: string): boolean {
  return registry.has(channel);
}

/** Every registered channel — used by the contract-parity test. */
export function registeredChannels(): string[] {
  return [...registry.keys()];
}

/** Attach a front end. Returns the detach function. */
export function addSink(sink: (channel: string, payload: unknown) => void): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

export function sinkCount(): number {
  return sinks.size;
}

/**
 * Push an event to every attached front end. A throwing sink (a socket that
 * died between the check and the write) must not stop the others, and must not
 * take down whatever was mid-stream when it happened.
 */
export function emitToSinks(channel: string, payload: unknown): void {
  for (const sink of sinks) {
    try {
      sink(channel, payload);
    } catch {
      /* a dead front end is the socket layer's problem, not the sender's */
    }
  }
}
