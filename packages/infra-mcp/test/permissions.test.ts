import { describe, expect, it } from 'vitest';
import { gate, type PermissionSettings } from '../src/permissions.ts';

describe('permission tier gate', () => {
  const cases: Array<{
    perms: PermissionSettings;
    input: Parameters<typeof gate>[1];
    allowed: boolean;
    reasonMatch?: RegExp;
  }> = [
    // Global cap matrix
    { perms: { maxTier: 'read' }, input: { tier: 'read' }, allowed: true },
    { perms: { maxTier: 'read' }, input: { tier: 'write' }, allowed: false, reasonMatch: /"read"/ },
    { perms: { maxTier: 'read' }, input: { tier: 'destructive', confirm: true }, allowed: false },
    { perms: { maxTier: 'write' }, input: { tier: 'read' }, allowed: true },
    { perms: { maxTier: 'write' }, input: { tier: 'write' }, allowed: true },
    { perms: { maxTier: 'write' }, input: { tier: 'destructive', confirm: true }, allowed: false },
    { perms: { maxTier: 'destructive' }, input: { tier: 'write' }, allowed: true },
    {
      perms: { maxTier: 'destructive' },
      input: { tier: 'destructive', confirm: true },
      allowed: true,
    },
    // Destructive always needs confirm, even when the tier allows it
    {
      perms: { maxTier: 'destructive' },
      input: { tier: 'destructive' },
      allowed: false,
      reasonMatch: /confirm/,
    },
    // Per-connection caps can only restrict below the global cap
    {
      perms: { maxTier: 'destructive', perConnection: { homelab: 'read' } },
      input: { tier: 'write', connection: 'homelab' },
      allowed: false,
      reasonMatch: /homelab.*read/,
    },
    {
      perms: { maxTier: 'read', perConnection: { homelab: 'destructive' } },
      input: { tier: 'write', connection: 'homelab' },
      allowed: false, // per-connection cannot EXCEED the global cap
    },
    {
      perms: { maxTier: 'destructive', perConnection: { other: 'read' } },
      input: { tier: 'destructive', connection: 'homelab', confirm: true },
      allowed: true, // cap on a different connection does not apply
    },
  ];

  for (const [i, c] of cases.entries()) {
    it(`case ${i}: ${c.perms.maxTier} cap, ${c.input.tier} needed${c.input.connection ? ` on ${c.input.connection}` : ''} → ${c.allowed ? 'allow' : 'deny'}`, () => {
      const result = gate(c.perms, c.input);
      expect(result.allowed).toBe(c.allowed);
      if (c.reasonMatch) expect(result.reason).toMatch(c.reasonMatch);
    });
  }
});
