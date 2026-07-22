import { readFileSync } from 'node:fs';
import type { ChatProvider, ChatRequest, ProviderEvent } from '../src/types.ts';

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

/** A fetch stub that always answers with the given body. */
export function fetchReturning(
  body: string,
  init: { status?: number; contentType?: string } = {},
): typeof fetch {
  return (async () =>
    new Response(body, {
      status: init.status ?? 200,
      headers: { 'content-type': init.contentType ?? 'text/event-stream' },
    })) as unknown as typeof fetch;
}

export function fetchRejecting(err: Error): typeof fetch {
  return (async () => {
    throw err;
  }) as unknown as typeof fetch;
}

export async function collect(
  provider: ChatProvider,
  req: ChatRequest,
  signal?: AbortSignal,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const ev of provider.stream(req, {
    signal: signal ?? new AbortController().signal,
  })) {
    events.push(ev);
  }
  return events;
}

export const userText = (text: string) =>
  ({ role: 'user', content: [{ type: 'text', text }] }) as const;
