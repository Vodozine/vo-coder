import { readFileSync, writeFileSync } from 'node:fs';
import type { ToolSpec } from '@vo-coder/providers';
import type { PaymentMethod, SpendRecord } from '../shared/ipc-contract';
import type { ConfigStore } from './config';
import type { SecretStore } from './secrets';

/**
 * Spending, and the three things that keep it from being a disaster.
 *
 * 1. THE AGENT CANNOT NAME A PAYEE. It picks from methods the user registered
 *    and supplies an amount and a reason. This is the load-bearing one: an
 *    agent reads web pages, repos and issue trackers, and it cannot reliably
 *    tell an instruction from the user apart from one embedded in what it read.
 *    If it could address arbitrary payees, any page could address one.
 * 2. CAPS ARE CHECKED BEFORE THE HUMAN IS ASKED. Over the per-transaction or
 *    rolling-24h limit is refused outright, so a confirm dialog is never the
 *    only thing between a typo and the money.
 * 3. EVERY ATTEMPT IS RECORDED, approved or not. The ledger is what the daily
 *    cap is computed from, so it cannot be quietly bypassed by not looking.
 *
 * The permission prompt itself is not optional and lives in tool-policy's
 * ALWAYS_CONFIRM_TOOLS — no mode, mission flag or group allowance waives it.
 */

const LEDGER_KEEP = 500;

export class SpendLedger {
  private records: SpendRecord[] = [];
  private seq = 0;

  constructor(private path: string) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as SpendRecord[];
      if (Array.isArray(raw)) this.records = raw;
    } catch {
      /* first run */
    }
  }

  list(): SpendRecord[] {
    return this.records.map((r) => ({ ...r }));
  }

  /** What has actually left the account in the last 24 hours. */
  spentToday(): number {
    const since = Date.now() - 24 * 60 * 60_000;
    return this.records
      .filter((r) => r.at >= since && r.outcome === 'approved')
      .reduce((sum, r) => sum + r.amount, 0);
  }

  add(rec: Omit<SpendRecord, 'id' | 'at'>): SpendRecord {
    const full: SpendRecord = { ...rec, id: `spend_${Date.now()}_${++this.seq}`, at: Date.now() };
    this.records.push(full);
    if (this.records.length > LEDGER_KEEP) this.records = this.records.slice(-LEDGER_KEEP);
    try {
      writeFileSync(this.path, JSON.stringify(this.records, null, 2));
    } catch {
      /* a ledger that cannot be written must not block the refusal path */
    }
    return full;
  }
}

/** Offered only when spending is on AND at least one method is usable. */
export function paymentToolSpecs(config: ConfigStore): ToolSpec[] {
  const policy = config.get().spending;
  const usable = policy.methods.filter((m) => m.enabled);
  if (!policy.enabled || usable.length === 0) return [];
  const list = usable
    .map((m) => `"${m.id}" (${m.label}, ${m.kind}, ${m.currency}${m.maxAmount ? `, max ${m.maxAmount}` : ''})`)
    .join('; ');
  return [
    {
      name: 'payment_spend',
      description:
        'Spend money through one of the payment methods the USER registered. The user confirms ' +
        'every single call — there is no autonomous mode for this, so say plainly what it is for. ' +
        `Registered methods: ${list}. You cannot pay anyone else: if what you need is not on that ` +
        'list, say so and ask the user to add it.',
      inputSchema: {
        type: 'object',
        properties: {
          method_id: { type: 'string', description: 'One of the registered method ids' },
          amount: { type: 'number', description: 'Amount in the method’s own currency' },
          purpose: {
            type: 'string',
            description: 'What this buys and why, in one line — the user reads this before deciding',
          },
        },
        required: ['method_id', 'amount', 'purpose'],
      },
    },
  ];
}

export interface SpendContext {
  /** Who asked — chat title, agent name or mission title, for the record. */
  askedBy: string;
}

export async function executePaymentTool(
  args: unknown,
  config: ConfigStore,
  secrets: SecretStore,
  ledger: SpendLedger,
  ctx: SpendContext,
): Promise<{ content: string; isError?: boolean }> {
  const a = (args ?? {}) as Record<string, unknown>;
  const policy = config.get().spending;
  if (!policy.enabled) {
    return { content: 'Spending is turned off in Settings → Spending.', isError: true };
  }
  const method: PaymentMethod | undefined = policy.methods.find(
    (m) => m.id === String(a.method_id ?? '') && m.enabled,
  );
  if (!method) {
    const names = policy.methods.filter((m) => m.enabled).map((m) => m.id).join(', ') || '(none)';
    return {
      content: `No registered payment method "${String(a.method_id ?? '')}". Registered: ${names}. Ask the user to add one — you cannot pay an address of your own choosing.`,
      isError: true,
    };
  }
  const amount = Number(a.amount);
  const purpose = String(a.purpose ?? '').trim();
  if (!Number.isFinite(amount) || amount <= 0) {
    return { content: 'Amount must be a positive number.', isError: true };
  }
  if (!purpose) return { content: 'Say what the money is for.', isError: true };

  const record = (outcome: SpendRecord['outcome'], detail?: string) =>
    ledger.add({
      methodId: method.id,
      methodLabel: method.label,
      amount,
      currency: method.currency,
      purpose,
      askedBy: ctx.askedBy,
      outcome,
      ...(detail ? { detail } : {}),
    });

  // Caps first: refused before anyone is asked, so a confirm dialog is never
  // the only thing standing between a mistake and the money.
  const cap = Math.min(policy.perTransactionMax, method.maxAmount ?? Infinity);
  if (amount > cap) {
    record('over-cap');
    return {
      content: `Refused: ${amount} ${method.currency} is over the ${cap} ${method.currency} limit for "${method.label}". The user can raise it in Settings → Spending; you cannot.`,
      isError: true,
    };
  }
  const spent = ledger.spentToday();
  if (spent + amount > policy.dailyMax) {
    record('over-cap', `daily ${spent} + ${amount} > ${policy.dailyMax}`);
    return {
      content: `Refused: this would put the last 24 hours at ${spent + amount} ${policy.currency}, over the ${policy.dailyMax} daily limit.`,
      isError: true,
    };
  }

  // 'checkout' never moves money from here — that is the point of the kind.
  if (method.kind === 'checkout') {
    record('approved', 'basket prepared; the human completes checkout');
    return {
      content:
        `Ready for checkout on "${method.label}" — ${amount} ${method.currency} for ${purpose}. ` +
        'Nothing has been paid: complete it yourself, this method stops here by design.',
    };
  }

  const token = method.secretRef ? secrets.get(method.secretRef) : null;
  if (!token) {
    record('failed', 'no credential');
    return {
      content: `"${method.label}" has no saved credential (Settings → Spending).`,
      isError: true,
    };
  }
  if (!method.url) {
    record('failed', 'no endpoint');
    return { content: `"${method.label}" has no endpoint configured.`, isError: true };
  }

  try {
    const res = await fetch(method.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        amount,
        currency: method.currency,
        description: purpose,
        ...(method.kind === 'payout' && method.payee ? { payee: method.payee } : {}),
      }),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      record('failed', `${res.status} ${body.slice(0, 200)}`);
      return { content: `Payment failed (${res.status}): ${body.slice(0, 300)}`, isError: true };
    }
    record('approved');
    return {
      content: `Paid ${amount} ${method.currency} via "${method.label}" for ${purpose}.`,
    };
  } catch (err) {
    record('failed', err instanceof Error ? err.message : String(err));
    return {
      content: `Payment could not be sent: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
