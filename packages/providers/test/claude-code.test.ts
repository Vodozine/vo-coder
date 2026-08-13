import { describe, expect, it } from 'vitest';
import type { HarnessMessage, ProviderEvent } from '../src/types.ts';
import {
  CLAUDE_CODE_DEFAULT_MODEL,
  claudeCodeArgs,
  claudeCodePermissionMode,
  claudeCodeSeedModels,
  latestUserText,
  newClaudeCodeParseState,
  parseClaudeCodeLine,
  renderHistoryPrompt,
} from '../src/adapters/claude-code.ts';

const feed = (lines: unknown[], state = newClaudeCodeParseState()) => {
  const events: ProviderEvent[] = [];
  let sessionId: string | undefined;
  for (const l of lines) {
    const r = parseClaudeCodeLine(typeof l === 'string' ? l : JSON.stringify(l), state);
    events.push(...r.events);
    sessionId ??= r.sessionId;
  }
  return { events, sessionId, state };
};

const delta = (text: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
});

describe('argv building', () => {
  it('a fresh session assigns the id and carries the persona; resume does neither', () => {
    const fresh = claudeCodeArgs({
      newSessionId: 'uuid-1',
      model: 'opus',
      system: 'You are CC.',
      permissionMode: 'bypassPermissions',
    });
    expect(fresh).toContain('--session-id');
    expect(fresh).toContain('--append-system-prompt');
    expect(fresh).toContain('--model');
    expect(fresh).toContain('--include-partial-messages');

    const resume = claudeCodeArgs({
      resumeId: 'uuid-1',
      model: 'opus',
      system: 'You are CC.',
      permissionMode: 'bypassPermissions',
    });
    expect(resume).toContain('--resume');
    expect(resume).not.toContain('--session-id');
    // The session already holds the persona — re-appending it every turn
    // would stack copies of the same prompt.
    expect(resume).not.toContain('--append-system-prompt');
  });

  it('the default model means "no --model flag" — the CLI uses its own setting', () => {
    const args = claudeCodeArgs({
      newSessionId: 'u',
      model: CLAUDE_CODE_DEFAULT_MODEL,
      permissionMode: 'plan',
    });
    expect(args).not.toContain('--model');
  });
});

describe('permission mapping', () => {
  it('mirrors what each Vo-Coder mode promises', () => {
    expect(claudeCodePermissionMode('auto')).toBe('bypassPermissions');
    expect(claudeCodePermissionMode('plan')).toBe('plan');
    // Headless cannot prompt: manual denies rather than silently approving.
    expect(claudeCodePermissionMode('manual')).toBe('dontAsk');
  });
});

describe('stream-json mapping', () => {
  it('streams prose as deltas and does not repeat it from the assistant message', () => {
    const { events } = feed([
      { type: 'system', subtype: 'init', session_id: 'abc' },
      delta('Hello '),
      delta('world'),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
      { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('Hello world');
    expect(events.at(-2)).toEqual({ type: 'usage', inputTokens: 10, outputTokens: 5 });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
  });

  it('an older CLI with no partial deltas still gets its prose from the assistant message', () => {
    const { events } = feed([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Whole message.' }] } },
      { type: 'result', subtype: 'success', usage: {} },
    ]);
    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('Whole message.');
  });

  it('captures the session id from the first line that carries one', () => {
    const { sessionId } = feed([{ type: 'system', subtype: 'init', session_id: 's-123' }]);
    expect(sessionId).toBe('s-123');
  });

  it('tool activity becomes progress heartbeats and a work-log line — never a tool_call', () => {
    const { events } = feed([
      {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Edit' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"file_path":"a.ts"' } },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/app.ts' } }] },
      },
      { type: 'result', subtype: 'success', usage: {} },
    ]);
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
    const progress = events.filter((e) => e.type === 'tool_progress');
    expect(progress.some((e) => (e as { name?: string }).name === 'Edit')).toBe(true);
    const log = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('');
    expect(log).toContain('· Edit — src/app.ts');
  });

  it('a failed tool result surfaces one visible line; successes stay quiet', () => {
    const { events } = feed([
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', is_error: true, content: 'ENOENT: no such file' }] },
      },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    ]);
    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toContain('✗ ENOENT');
    expect(text).not.toContain('ok');
  });

  it('an error result is a single final auth-classified error, with no done after', () => {
    const { events } = feed([
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Please log in to continue' },
    ]);
    expect(events).toHaveLength(1);
    const err = events[0] as Extract<ProviderEvent, { type: 'error' }>;
    expect(err.type).toBe('error');
    expect(err.error.kind).toBe('auth');
    expect(err.error.message).toContain('sign in');
  });

  it('debug noise and unknown types are heartbeats, never aborts', () => {
    const { events } = feed(['not json at all', { type: 'brand_new_event_type' }]);
    expect(events).toEqual([
      { type: 'tool_progress', chars: 0 },
      { type: 'tool_progress', chars: 0 },
    ]);
  });
});

describe('prompt building', () => {
  const history: HarnessMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'build me a thing' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Built it.' },
        { type: 'tool_call', id: 't1', name: 'ws_write', args: {} },
      ],
    },
    { role: 'user', content: [{ type: 'text', text: 'now improve it' }] },
  ];

  it('a resumed turn sends only the newest user text', () => {
    expect(latestUserText(history)).toBe('now improve it');
  });

  it('a first turn with prior history renders it as context above the new message', () => {
    const prompt = renderHistoryPrompt(history);
    expect(prompt).toContain('build me a thing');
    expect(prompt).toContain('Built it.');
    expect(prompt).toContain('· used ws_write');
    expect(prompt.endsWith('now improve it')).toBe(true);
  });

  it('attachments become stubs — the CLI cannot see them', () => {
    const msgs: HarnessMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', mediaType: 'image/png', data: 'AAAA' },
        ],
      },
    ];
    expect(latestUserText(msgs)).toContain('[attachment omitted');
  });

  it('history rendering is tail-capped', () => {
    const long: HarnessMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(50_000) }] },
      { role: 'user', content: [{ type: 'text', text: 'the end' }] },
    ];
    const prompt = renderHistoryPrompt(long, 10_000);
    expect(prompt.length).toBeLessThan(12_000);
    expect(prompt).toContain('the end');
  });
});

describe('seed models', () => {
  it('offers at least one model so the agent form can save', () => {
    const models = claudeCodeSeedModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]!.id).toBe(CLAUDE_CODE_DEFAULT_MODEL);
    expect(models.every((m) => m.provider === 'claude-code')).toBe(true);
  });
});
