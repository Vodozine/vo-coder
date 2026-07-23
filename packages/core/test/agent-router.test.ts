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

describe('vision agents wait for an actual image', () => {
  const coder: AgentSpec = {
    id: 'coder',
    name: 'MrBig',
    systemPrompt: 'You are a senior software engineer. You write and fix code.',
    routingHints: 'code, bug, fix, build',
  };
  const vision: AgentSpec = {
    id: 'vision',
    name: 'The VisionMaster',
    systemPrompt: 'You describe images and photos. You see pictures and analyze visual content.',
    routingHints: 'see, look, image, photo, picture, vision',
  };
  const staff = [coder, vision];

  it('"i cant see the cards" without an image never summons the vision agent', () => {
    const text = 'i cant see the cards while dragging them...they get invisible';
    const match = matchAgentForMessage(text, staff, { hasImage: false });
    expect(match?.agent.id).not.toBe('vision');
    // Even in "My agents only" mode the vision agent scores zero here.
    const always = matchAgentForMessage(text, staff, { always: true, hasImage: false });
    expect(always?.agent.id).toBe('coder');
  });

  it('the same vision words DO count once an image is confirmed present', () => {
    const match = matchAgentForMessage('look at this photo — what mood is it?', staff, {
      hasImage: true,
    });
    expect(match?.agent.id).toBe('vision');
  });

  it('name-word "The" never counts as being addressed; the real name does', () => {
    const ranked = rankAgents('they get the cards from the deck', [vision], { hasImage: false });
    expect(ranked[0]!.score).toBe(0);
    const byName = matchAgentForMessage('visionmaster, are you there?', staff, { hasImage: false });
    expect(byName?.agent.id).toBe('vision');
  });

  it('non-vision hints on a vision agent still work without an image', () => {
    const cataloger: AgentSpec = { ...vision, routingHints: 'see, look, photo, catalog' };
    const match = matchAgentForMessage('catalog this folder for me', [coder, cataloger], {
      hasImage: false,
    });
    expect(match?.agent.id).toBe('vision');
  });
});
