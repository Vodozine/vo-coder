import { describe, expect, it } from 'vitest';
import type { AgentSpec } from '@vo-coder/providers';
import { matchAgentForMessage, rankAgents } from '../src/agent/agent-router.ts';

const agents: AgentSpec[] = [
  {
    id: 'a1',
    name: 'Danny',
    systemPrompt: 'You manage Proxmox infrastructure: virtual machines, containers, snapshots.',
    routingHints: 'proxmox, vm, hypervisor, container',
  },
  {
    id: 'a2',
    name: 'Pixel',
    systemPrompt: 'You are a frontend specialist for React components and CSS styling.',
    routingHints: 'css, react, frontend, ui',
  },
  {
    id: 'a3',
    name: 'Scribe',
    systemPrompt: 'You write documentation.',
  },
];

describe('matchAgentForMessage', () => {
  it('routes by hint keywords to the right specialist', () => {
    const match = matchAgentForMessage('can you snapshot the proxmox vm before we upgrade?', agents);
    expect(match?.agent.id).toBe('a1');
    expect(match?.matched).toContain('proxmox');
  });

  it('picks the stronger match when hints overlap topics', () => {
    const match = matchAgentForMessage('fix the css on the react settings ui please', agents);
    expect(match?.agent.id).toBe('a2');
  });

  it('matches on the agent name being addressed', () => {
    const match = matchAgentForMessage('hey danny, is the cluster healthy? check the vm list', agents);
    expect(match?.agent.id).toBe('a1');
  });

  it('returns null for generic chatter — no hijacking casual messages', () => {
    expect(matchAgentForMessage('what is the weather like today', agents)).toBeNull();
    expect(matchAgentForMessage('thanks, that looks good', agents)).toBeNull();
  });

  it('prompt-only agents need substantial overlap, not a single word', () => {
    // One prompt word ("documentation") alone scores below the threshold.
    expect(matchAgentForMessage('add some documentation', agents)).toBeNull();
  });

  it('rankAgents returns every agent, best first, stable on ties', () => {
    const ranked = rankAgents('snapshot the proxmox vm', agents);
    expect(ranked).toHaveLength(3);
    expect(ranked[0]?.agent.id).toBe('a1');
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    // Total tie (chatter): creation order preserved.
    const tied = rankAgents('what is the weather like today', agents);
    expect(tied.map((r) => r.agent.id)).toEqual(['a1', 'a2', 'a3']);
    expect(tied.every((r) => r.score === 0)).toBe(true);
  });

  it('always mode ("My agents only") lands on some agent regardless of score', () => {
    // Weak signal still beats the threshold rule…
    const weak = matchAgentForMessage('add some documentation', agents, { always: true });
    expect(weak?.agent.id).toBe('a3');
    // …and pure chatter falls back to the best available (first on total tie).
    const none = matchAgentForMessage('what is the weather like today', agents, { always: true });
    expect(none?.agent.id).toBe('a1');
    expect(none?.matched).toEqual(['best available']);
    // No agents defined → still null.
    expect(matchAgentForMessage('hello', [], { always: true })).toBeNull();
  });
});
