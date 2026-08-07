import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * VO-CODER.md — the standing agreement between the user and the agents that
 * work in a folder. "## Rules" belongs to the user (their decisions, their
 * words); "## Map" belongs to the agents (layout, commands, key files, kept
 * fresh). The file is never created silently: the PROJECT GATE below notices
 * when a folder has quietly become a real development project and licenses the
 * agent to raise it ONCE, in conversation — one recommendation at a time,
 * never a questionnaire. A "no" is persisted and stays a no.
 */

/** Accepted spellings, probed in order; the first one is what agents are told to write. */
const PROJECT_MD_NAMES = ['VO-CODER.md', 'Vo-Coder.md', 'vo-coder.md'];

/** Enough code files to call it a real project rather than a couple of scripts. */
const GATE_MIN_CODE_FILES = 8;
/** Counting stops here — "40+" says "a lot" without walking a monorepo. */
const GATE_COUNT_STOP = 40;
const WALK_MAX_DEPTH = 4;
/** Bound on directory entries visited, so a huge non-code folder costs little. */
const WALK_MAX_ENTRIES = 2_000;
/** The walk is re-run at most this often per folder (chat cadence is human). */
const GATE_MEMO_TTL_MS = 5 * 60_000;
/** Rules ride the system prompt every turn — keep the injected slice bounded. */
const RULES_MAX_CHARS = 1_500;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'release',
  'vendor',
  'venv',
  '.venv',
  '__pycache__',
  'target',
  '.next',
  'coverage',
]);

const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rs', 'go', 'java', 'kt', 'cs',
  'c', 'cc', 'cpp', 'h', 'hpp',
  'html', 'css', 'scss', 'vue', 'svelte',
  'php', 'rb', 'swift', 'lua', 'sql', 'sh', 'ps1',
]);

/** The folder's VO-CODER.md (any accepted casing), or null. */
export function projectMdPath(dir: string): string | null {
  for (const name of PROJECT_MD_NAMES) {
    const p = join(dir, name);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* keep probing */
    }
  }
  return null;
}

export interface ProjectRules {
  path: string;
  /** Body of "## Rules" (to the next h2), trimmed and bounded. '' when absent. */
  rules: string;
  truncated: boolean;
}

/** Read the folder's VO-CODER.md and extract the user's Rules section. */
export function readProjectRules(dir: string): ProjectRules | null {
  const path = projectMdPath(dir);
  if (!path) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+rules\b/i.test(l.trim()));
  let rules = '';
  if (start >= 0) {
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^##\s/.test(l.trim()));
    rules = (end >= 0 ? rest.slice(0, end) : rest).join('\n').trim();
  }
  const truncated = rules.length > RULES_MAX_CHARS;
  if (truncated) rules = `${rules.slice(0, RULES_MAX_CHARS)}…`;
  return { path, rules, truncated };
}

export interface GateResult {
  codeFiles: number;
  /** True when counting stopped at the cap — read as "codeFiles or more". */
  capped: boolean;
}

const gateMemo = new Map<string, { at: number; result: GateResult | null }>();

/**
 * Has this folder quietly become a real development project with no structure?
 * Null unless it holds enough code files while lacking BOTH version control
 * and a VO-CODER.md. The two cheap absence checks run first — a structured
 * folder never pays for the walk.
 */
export function projectGate(dir: string): GateResult | null {
  try {
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  if (existsSync(join(dir, '.git'))) return null;
  if (projectMdPath(dir)) return null;
  const hit = gateMemo.get(dir);
  if (hit && Date.now() - hit.at < GATE_MEMO_TTL_MS) return hit.result;

  let entries = 0;
  let codeFiles = 0;
  let capped = false;
  const stack: Array<{ p: string; depth: number }> = [{ p: dir, depth: 0 }];
  while (stack.length) {
    const next = stack.pop();
    if (!next) break;
    let dirents;
    try {
      dirents = readdirSync(next.p, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (++entries > WALK_MAX_ENTRIES) {
        capped = true;
        stack.length = 0;
        break;
      }
      if (d.isDirectory()) {
        if (next.depth + 1 <= WALK_MAX_DEPTH && !SKIP_DIRS.has(d.name.toLowerCase())) {
          stack.push({ p: join(next.p, d.name), depth: next.depth + 1 });
        }
      } else if (d.isFile()) {
        const dot = d.name.lastIndexOf('.');
        if (dot > 0 && CODE_EXTS.has(d.name.slice(dot + 1).toLowerCase())) {
          codeFiles++;
          if (codeFiles >= GATE_COUNT_STOP) {
            capped = true;
            stack.length = 0;
            break;
          }
        }
      }
    }
  }
  const result = codeFiles >= GATE_MIN_CODE_FILES ? { codeFiles, capped } : null;
  gateMemo.set(dir, { at: Date.now(), result });
  return result;
}

/**
 * The one-time brake, appended to the USER's message — the recency position
 * that hours of in-context precedent cannot bury (the delegation notes taught
 * us that a rule at position zero loses on a long chat). Written as a licence
 * to talk, not a form to run: models default to questionnaires, and the user's
 * verdict on those is that half the questions never make sense.
 */
export function gateNudge(codeFiles: number, capped: boolean): string {
  const n = `${codeFiles}${capped ? '+' : ''}`;
  return (
    `\n[project gate — fires once, never again for this folder: it now holds ${n} code files ` +
    'but no version control and no VO-CODER.md — a real development project growing without ' +
    'structure. Finish answering the current request first. THEN step on the brakes like a ' +
    'senior colleague: say what you see this becoming, and talk the user through structure and ' +
    'workflow — ONE recommendation or question per message, plain conversation, NEVER a list of ' +
    'questions. Infer what the folder already answers (language, framework, layout) instead of ' +
    'asking about it. Lead with recommendations they can veto with one word: git init? a cleaner ' +
    'layout before it hardens? guardrails you will hold yourself to (typecheck after edits, tests ' +
    'beside features)? What you agree on goes into VO-CODER.md in the folder root, two sections: ' +
    '"## Rules" — the user\'s decisions in their words, which only they may change — and ' +
    '"## Map" — layout, build/run/test commands, key files, kept fresh by you. If the user wants ' +
    'none of it, accept it, write nothing, and never raise it again.]'
  );
}

/**
 * System-prompt note for any session working in a folder that has a
 * VO-CODER.md. Stable while the file is unchanged, so local models keep their
 * prompt cache; editing the file costs one reprefill, which is the point of
 * an edit.
 */
export function projectMdNote(dir: string): string {
  const md = readProjectRules(dir);
  if (!md) return '';
  const name = basename(md.path);
  return (
    `\n\nPROJECT FILE: this folder has a ${name} — the standing agreement between the user and ` +
    'the agents working here. ' +
    (md.rules
      ? `Its "## Rules" section BINDS your work${md.truncated ? ' (shown truncated — read the file for the rest)' : ''}:\n${md.rules}\n`
      : 'Its "## Rules" section is empty so far. ') +
    `Before exploring the folder blindly, ws_read ${name} — the "## Map" section orients you ` +
    'faster than ws_list. When the structure changes (files added or moved, commands changed), ' +
    'update the Map section to match — edit ONLY that section. NEVER edit "## Rules" yourself: ' +
    'rules belong to the user. If they state a new standing rule in chat, offer to add it and ' +
    'let them confirm first.'
  );
}
