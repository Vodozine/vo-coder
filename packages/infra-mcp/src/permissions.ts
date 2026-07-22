/**
 * Permission tiers replace the old single ALLOW_ELEVATED boolean:
 *
 *   read < write < destructive
 *
 * A global max tier caps everything; per-connection tiers can only restrict
 * further (never exceed the global cap). Destructive tools additionally
 * require `confirm: true` in the tool input — the calling model must restate
 * intent explicitly.
 */

export type Tier = 'read' | 'write' | 'destructive';

const ORDER: Record<Tier, number> = { read: 0, write: 1, destructive: 2 };

export interface PermissionSettings {
  maxTier: Tier;
  perConnection?: Record<string, Tier>;
}

export const DEFAULT_PERMISSIONS: PermissionSettings = { maxTier: 'read' };

export interface GateInput {
  tier: Tier;
  connection?: string;
  confirm?: boolean;
}

export interface GateResult {
  allowed: boolean;
  reason?: string;
}

export function allows(granted: Tier, needed: Tier): boolean {
  return ORDER[granted] >= ORDER[needed];
}

export function gate(perms: PermissionSettings, input: GateInput): GateResult {
  const connectionTier =
    input.connection !== undefined ? perms.perConnection?.[input.connection] : undefined;
  // Per-connection tier can only restrict below the global cap.
  const effective =
    connectionTier !== undefined && ORDER[connectionTier] < ORDER[perms.maxTier]
      ? connectionTier
      : perms.maxTier;

  if (!allows(effective, input.tier)) {
    return {
      allowed: false,
      reason:
        `This tool needs the "${input.tier}" tier but ` +
        (connectionTier !== undefined && effective === connectionTier
          ? `connection "${input.connection}" is capped at "${effective}".`
          : `the global permission cap is "${effective}".`) +
        ' Raise it in MCP_SETTINGS.json (permissions.maxTier / permissions.perConnection).',
    };
  }
  if (input.tier === 'destructive' && input.confirm !== true) {
    return {
      allowed: false,
      reason:
        'Destructive operations require confirm: true in the tool input. ' +
        'Restate what will be destroyed and call again with confirm set.',
    };
  }
  return { allowed: true };
}
