import { describe, expect, it } from 'vitest';
import type { ProviderEvent } from '../src/types.ts';
import {
  CODEX_CLI_DEFAULT_MODEL,
  codexCliArgs,
  codexCliPrompt,
  codexCliSandbox,
  codexCliSeedModels,
  newCodexCliParseState,
  parseCodexCliLine,
} from '../src/adapters/codex-cli.ts';

const feed = (lines: unknown[], state = newCodexCliParseState()) => {
  const events: ProviderEvent[] = [];
  let threadId: string | undefined;
  for (const l of lines) {
    const r = parseCodexCliLine(typeof l === 'string' ? l : JSON.stringify(l), state);
    events.push(...r.events);
    threadId ??= r.threadId;
  }
  return { events, threadId, state };
};

const msg = (kind: 'started' | 'updated' | 'completed', id: string, text: string) => ({
  type: `item.${kind}`,
  item: { id, type: 'agent_message', text },
});

describe('argv building', () => {
  it('a fresh thread passes no id (Codex assigns it); resume names the thread', () => {
    const fresh = codexCliArgs({ model: 'gpt-5.5', sandbox: 'bypass' });
    expect(fresh[0]).toBe('exec');
    expect(fresh).not.toContain('resume');
    expect(fresh).toContain('--json');
    expect(fresh).toContain('--model');
    // The prompt rides stdin, marked by the `-` argument.
    expect(fresh[fresh.length - 1]).toBe('-');

    const resume = codexCliArgs({ resumeId: 'thread-1', model: 'gpt-5.5', sandbox: 'bypass' });
    expect(resume.slice(0, 3)).toEqual(['exec', 'resume', 'thread-1']);
  });

  it('the default model means "no --model flag" — the CLI uses its own setting', () => {
    const args = codexCliArgs({ model: CODEX_CLI_DEFAULT_MODEL, sandbox: 'read-only' });
    expect(args).not.toContain('--model');
  });

  it('sandbox mapping: auto works unsandboxed, plan and manual stay read-only', () => {
    expect(codexCliSandbox('auto')).toBe('bypass');
    expect(codexCliSandbox('plan')).toBe('read-only');
    expect(codexCliSandbox('manual')).toBe('read-only');
    expect(codexCliArgs({ model: 'x', sandbox: 'bypass' })).toContain(
      '--dangerously-bypass-approvals-and-sandbox',
    );
    const ro = codexCliArgs({ model: 'x', sandbox: 'read-only' });
    expect(ro).toContain('--sandbox');
    expect(ro).toContain('read-only');
  });
});

describe('JSONL mapping', () => {
  it('announces the thread id once, from thread.started', () => {
    const { threadId, events } = feed([
      { type: 'thread.started', thread_id: 'th-1' },
      { type: 'turn.started' },
    ]);
    expect(threadId).toBe('th-1');
    // Both lines are heartbeats — no prose, no tool_call.
    expect(events.every((e) => e.type === 'tool_progress')).toBe(true);
  });

  it('agent_message snapshots emit only the unseen suffix — never a repeat', () => {
    const { events } = feed([
      msg('started', 'i1', ''),
      msg('updated', 'i1', 'Hello '),
      msg('updated', 'i1', 'Hello world'),
      msg('completed', 'i1', 'Hello world'),
    ]);
    const text = events
      .filter((e): e is Extract<ProviderEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('Hello world');
  });

  it('reasoning becomes thinking, tools become work-log lines and heartbeats', () => {
    const { events } = feed([
      { type: 'item.updated', item: { id: 'r1', type: 'reasoning', text: 'thinking…' } },
      {
        type: 'item.started',
        item: { id: 'c1', type: 'command_execution', command: 'npm test', status: 'in_progress' },
      },
      {
        type: 'item.completed',
        item: { id: 'c1', type: 'command_execution', command: 'npm test', exit_code: 0 },
      },
    ]);
    expect(events.some((e) => e.type === 'thinking_delta')).toBe(true);
    const prose = events
      .filter((e): e is Extract<ProviderEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(prose).toContain('npm test');
    // THE invariant: a CLI's internal tool use must never surface as tool_call.
    expect(events.every((e) => e.type !== 'tool_call')).toBe(true);
  });

  it('a failing command surfaces one visible line', () => {
    const { events } = feed([
      {
        type: 'item.completed',
        item: {
          id: 'c2',
          type: 'command_execution',
          command: 'npm test',
          exit_code: 1,
          aggregated_output: 'FAIL src/x.test.ts',
        },
      },
    ]);
    const prose = events
      .filter((e): e is Extract<ProviderEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(prose).toContain('✗ exit 1');
    expect(prose).toContain('FAIL');
  });

  it('turn.completed maps usage (reasoning counted as output) and ends the turn', () => {
    const { events, state } = feed([
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 80,
          output_tokens: 20,
          reasoning_output_tokens: 5,
        },
      },
    ]);
    expect(state.sawResult).toBe(true);
    const usage = events.find(
      (e): e is Extract<ProviderEvent, { type: 'usage' }> => e.type === 'usage',
    );
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 25, cacheReadTokens: 80 });
    expect(events[events.length - 1]).toEqual({ type: 'done', stopReason: 'end_turn' });
  });

  it('turn.failed is an error and NOT a result — the resume-retry depends on that', () => {
    const { events, state } = feed([
      { type: 'turn.failed', error: { message: 'stream disconnected' } },
    ]);
    expect(state.sawResult).toBe(false);
    expect(events[0]?.type).toBe('error');
  });

  it('a revoked login is reported as an auth problem with the codex login fix', () => {
    const { events } = feed([
      {
        type: 'error',
        message:
          'Your access token could not be refreshed because your refresh token was revoked.',
      },
    ]);
    const err = events.find(
      (e): e is Extract<ProviderEvent, { type: 'error' }> => e.type === 'error',
    );
    expect(err?.error.kind).toBe('auth');
    expect(err?.error.message).toContain('codex login');
  });

  it('a nested API-error JSON is unwrapped, and an outdated CLI names its fix', () => {
    const { events } = feed([
      {
        type: 'error',
        message:
          '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.6-sol\' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}',
      },
    ]);
    const err = events.find(
      (e): e is Extract<ProviderEvent, { type: 'error' }> => e.type === 'error',
    );
    // The human sentence, not the JSON blob.
    expect(err?.error.message).not.toContain('"status"');
    expect(err?.error.message).toContain('newer version of Codex');
    expect(err?.error.message).toContain('codex update');
  });

  it('debug noise and unknown lines are heartbeats, never aborts', () => {
    const { events } = feed([
      '2026-08-20T23:28:52Z ERROR codex_models_manager::cache: failed to load models cache',
      { type: 'something.new' },
      'not json at all {',
    ]);
    expect(events.every((e) => e.type === 'tool_progress')).toBe(true);
  });
});

describe('prompt building', () => {
  it('the persona rides a fresh prompt above the body; without one the body stands alone', () => {
    expect(codexCliPrompt('You are Pio.', 'Fix the bug.')).toBe(
      'You are Pio.\n\n---\n\nFix the bug.',
    );
    expect(codexCliPrompt(undefined, 'Fix the bug.')).toBe('Fix the bug.');
    expect(codexCliPrompt('  ', 'Fix the bug.')).toBe('Fix the bug.');
  });
});

describe('seed models', () => {
  it('every seed claims tools and the codex provider', () => {
    for (const m of codexCliSeedModels()) {
      expect(m.provider).toBe('codex-cli');
      expect(m.supportsTools).toBe(true);
    }
  });
});
