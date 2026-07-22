import { describe, expect, it } from 'vitest';
import type { HarnessMessage } from '../src/types.ts';
import { AnthropicProvider } from '../src/adapters/anthropic.ts';
import { OllamaProvider } from '../src/adapters/ollama.ts';
import { XaiProvider } from '../src/adapters/openai-compatible.ts';
import { collect, fixture } from './helpers.ts';

const PNG_B64 = 'aW1hZ2VieXRlcw=='; // "imagebytes"
const TXT_B64 = Buffer.from('hello from file', 'utf8').toString('base64');
const PDF_B64 = 'cGRmYnl0ZXM='; // "pdfbytes"

const multimodalMessages: HarnessMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'image', mediaType: 'image/png', data: PNG_B64 },
      { type: 'file', mediaType: 'application/pdf', name: 'doc.pdf', data: PDF_B64 },
      { type: 'file', mediaType: 'text/plain', name: 'notes.txt', data: TXT_B64 },
      { type: 'text', text: 'What do you see?' },
    ],
  },
];

const toolHistory: HarnessMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'read both files' }] },
  {
    role: 'assistant',
    content: [
      { type: 'tool_call', id: 't1', name: 'fs__read', args: { path: 'a' } },
      { type: 'tool_call', id: 't2', name: 'fs__read', args: { path: 'b' } },
    ],
  },
  { role: 'tool', toolCallId: 't1', content: 'aaa' },
  { role: 'tool', toolCallId: 't2', content: 'bbb', isError: true },
];

/** fetch stub that records the JSON request body and answers with a fixture. */
function recordingFetch(responseBody: string, contentType: string) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchFn = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
    return new Response(responseBody, {
      status: 200,
      headers: { 'content-type': contentType },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, bodies };
}

describe('attachment part mapping per provider wire format', () => {
  it('Anthropic: image → image block, pdf → document block, text file → inlined text', async () => {
    const { fetchFn, bodies } = recordingFetch(
      fixture('anthropic-basic.sse.txt'),
      'text/event-stream',
    );
    const p = new AnthropicProvider({ apiKey: 'k', fetch: fetchFn });
    await collect(p, { model: 'claude-sonnet-5', messages: multimodalMessages });

    const msgs = bodies[0]!.messages as Array<{ role: string; content: unknown[] }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: PDF_B64 },
      },
      { type: 'text', text: expect.stringContaining('hello from file') },
      { type: 'text', text: 'What do you see?' },
    ]);
  });

  it('Anthropic: consecutive tool results merge into one user turn', async () => {
    const { fetchFn, bodies } = recordingFetch(
      fixture('anthropic-basic.sse.txt'),
      'text/event-stream',
    );
    const p = new AnthropicProvider({ apiKey: 'k', fetch: fetchFn });
    await collect(p, { model: 'claude-sonnet-5', messages: toolHistory });

    const msgs = bodies[0]!.messages as Array<{ role: string; content: unknown[] }>;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'aaa' },
      { type: 'tool_result', tool_use_id: 't2', content: 'bbb', is_error: true },
    ]);
  });

  it('Ollama: images ride the images array; text files inline into content', async () => {
    const { fetchFn, bodies } = recordingFetch(
      fixture('ollama-basic.ndjson.txt'),
      'application/x-ndjson',
    );
    const p = new OllamaProvider({ fetch: fetchFn });
    await collect(p, { model: 'llama3.2', messages: multimodalMessages });

    const msgs = bodies[0]!.messages as Array<{
      role: string;
      content: string;
      images?: string[];
    }>;
    expect(msgs[0]!.images).toEqual([PNG_B64]);
    expect(msgs[0]!.content).toContain('hello from file');
    expect(msgs[0]!.content).toContain('What do you see?');
    // PDFs cannot be inlined for Ollama — a visible placeholder, not a silent drop.
    expect(msgs[0]!.content).toContain('doc.pdf');
  });

  it('OpenAI-compatible: image → image_url data URI; tool history → tool_calls + tool msgs', async () => {
    const { fetchFn, bodies } = recordingFetch('data: [DONE]\n\n', 'text/event-stream');
    const p = new XaiProvider({ apiKey: 'k', fetch: fetchFn });
    await collect(p, { model: 'grok-4', messages: multimodalMessages });
    await collect(p, { model: 'grok-4', messages: toolHistory });

    const userMsg = (bodies[0]!.messages as Array<{ role: string; content: unknown }>)[0]!;
    expect(userMsg.content).toContainEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${PNG_B64}` },
    });

    const msgs = bodies[1]!.messages as Array<Record<string, unknown>>;
    const assistant = msgs.find((m) => m.role === 'assistant')!;
    expect(assistant.tool_calls).toEqual([
      {
        id: 't1',
        type: 'function',
        function: { name: 'fs__read', arguments: JSON.stringify({ path: 'a' }) },
      },
      {
        id: 't2',
        type: 'function',
        function: { name: 'fs__read', arguments: JSON.stringify({ path: 'b' }) },
      },
    ]);
    expect(msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['t1', 't2']);
  });
});
