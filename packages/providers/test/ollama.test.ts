import { describe, expect, it } from 'vitest';
import { OllamaProvider } from '../src/adapters/ollama.ts';
import { collect, fetchRejecting, fetchReturning, fixture, userText } from './helpers.ts';

const req = { model: 'llama3.2', messages: [userText('hi')] };

describe('OllamaProvider event normalization', () => {
  it('normalizes an NDJSON text stream', async () => {
    const p = new OllamaProvider({
      fetch: fetchReturning(fixture('ollama-basic.ndjson.txt'), {
        contentType: 'application/x-ndjson',
      }),
    });
    const events = await collect(p, req);
    expect(events).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      { type: 'text_delta', text: ' there' },
      { type: 'usage', inputTokens: 10, outputTokens: 3 },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('emits tool_call events with synthesized ids and stopReason tool_use', async () => {
    const p = new OllamaProvider({
      fetch: fetchReturning(fixture('ollama-tooluse.ndjson.txt'), {
        contentType: 'application/x-ndjson',
      }),
    });
    const events = await collect(p, req);
    expect(events).toEqual([
      { type: 'tool_call', id: 'ollama_call_0', name: 'list_files', args: { path: '/tmp' } },
      { type: 'usage', inputTokens: 25, outputTokens: 9 },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it('yields a friendly network error when Ollama is unreachable', async () => {
    const p = new OllamaProvider({ fetch: fetchRejecting(new TypeError('fetch failed')) });
    const events = await collect(p, req);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'network' } });
    expect((events[0] as { error: { message: string } }).error.message).toContain('is it running');
  });

  it('yields done:aborted when the caller aborts', async () => {
    const abortErr = Object.assign(new Error('This operation was aborted'), {
      name: 'AbortError',
    });
    const p = new OllamaProvider({ fetch: fetchRejecting(abortErr) });
    const ac = new AbortController();
    ac.abort();
    const events = await collect(p, req, ac.signal);
    expect(events).toEqual([{ type: 'done', stopReason: 'aborted' }]);
  });
});
