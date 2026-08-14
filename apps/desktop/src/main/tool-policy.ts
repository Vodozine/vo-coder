/**
 * Read-only built-in tools run without a permission prompt anywhere — in-app
 * chats, Telegram chats, and missions. Everything else (writes, commands, MCP
 * calls) keeps its gate.
 *
 * Two rules keep this set honest, and both are worth stating because the set is
 * the only place in the app where a tool runs with no human in the loop at all:
 *
 * 1. Nothing that WRITES belongs here, however small the write. memory_note and
 *    map_update used to sit in this list; they persist agent-chosen content, so
 *    they now take the ordinary gate.
 *
 * 2. Nothing that sends data OUTWARD belongs here. Reading a page can steer the
 *    agent (a fetched page is untrusted input), and this set also grants
 *    unprompted reads of the project and of the cross-everything journal, so an
 *    auto-approved outbound request completes a path from private data to an
 *    attacker-chosen host without the user ever seeing a prompt. web_fetch
 *    therefore prompts. web_search stays, since its destination is fixed rather
 *    than agent-chosen.
 */
export const AUTO_ALLOWED_TOOLS = new Set([
  'ws_list',
  'ws_read',
  'look_at_image',
  'file_identify',
  'web_search',
  'mission_list',
  'memory_recall',
  'archive_search',
  'archive_read',
  'map_query',
  // Reading installed know-how touches nothing outside the skills folder.
  'skill_read',
]);

/**
 * The opposite list: tools that a human confirms EVERY time, and that no
 * setting can wave through — not Auto mode, not a mission's autoApprove, not a
 * group member's allowance.
 *
 * Money is the only thing here, and it is here because every other gate in this
 * app has a legitimate "the user opted into autonomy" escape. Spending has no
 * safe version of that: a mission is unattended by design, and an agent cannot
 * tell an instruction from the user apart from one embedded in a page it read.
 * A confirm that can be turned off is not a confirm.
 */
export const ALWAYS_CONFIRM_TOOLS = new Set(['payment_spend']);

/**
 * Everything that reads or writes the project's memory, in one place. An agent
 * whose card says "no project memory" gets none of these — they are stripped
 * from its advertised toolset AND refused at execution (a brief that still
 * names one, or a local model imitating its own history, must not slip a call
 * through). Every surface that assembles an agent's toolset filters on this:
 * chat/group sessions (SessionManager) and missions (remoteTools).
 */
export const MEMORY_TOOLS = new Set([
  'memory_recall',
  'memory_note',
  'map_query',
  'map_update',
  'archive_search',
  'archive_read',
]);

/**
 * The permission decision shared by every surface (chat, Telegram, missions).
 * 'allow' runs without a prompt; 'ask' means the caller must confirm in its own
 * way — a modal, a Telegram button, a mission's deny-when-unattended.
 *
 * `autoAllow` is the surface's own escape (Auto/Plan mode, a mission's
 * autoApprove, a group member's grant). It can wave through an ordinary gated
 * tool but NEVER an ALWAYS_CONFIRM one, and read-only AUTO_ALLOWED tools never
 * prompt regardless. Centralised because the missions copy had dropped the
 * AUTO_ALLOWED fast-path, so an un-attended read-only call was denied.
 */
export function permissionFor(name: string, autoAllow: boolean): 'allow' | 'ask' {
  if (AUTO_ALLOWED_TOOLS.has(name)) return 'allow';
  if (ALWAYS_CONFIRM_TOOLS.has(name)) return 'ask';
  return autoAllow ? 'allow' : 'ask';
}
