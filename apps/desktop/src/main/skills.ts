import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';

/**
 * SKILLS — packaged know-how the agents can pull in on demand. A skill is a
 * folder holding a SKILL.md (optionally with bundled reference files or
 * scripts beside it). Only the one-line catalog rides the system prompt;
 * the full body loads through the skill_read tool when a task matches —
 * a card catalog, not a library in every pocket.
 *
 * Imports accept the Claude Agent Skills layout (SKILL.md with YAML
 * frontmatter) and bare markdown files. Foreign skills are stored VERBATIM;
 * the translation to this app's tool names happens at serve time, so the
 * mapping can improve without re-importing anything.
 */

export interface SkillMeta {
  /** Folder name under skills/ — the stable id. */
  slug: string;
  name: string;
  description: string;
  path: string;
  /** Bundled files beside SKILL.md (relative paths), scripts included. */
  files: string[];
}

const SKILL_FILE = 'SKILL.md';
/** A skill folder larger than this is a mistake, not a skill. */
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'dist']);
/** Markdown every repo carries. A folder whose only .md is one of these is not
 *  a skill — it is a project, and any skills live in the folders inside. */
const BOILERPLATE_MD = new Set([
  'readme.md',
  'contributing.md',
  'license.md',
  'licence.md',
  'changelog.md',
  'code_of_conduct.md',
  'security.md',
]);

/** Could this file BE the skill, or is it just a repo's furniture? */
const isCandidateMd = (name: string): boolean =>
  extname(name).toLowerCase() === '.md' && !BOILERPLATE_MD.has(name.toLowerCase());

/** The .md files in a folder that could actually BE the skill. */
function candidateMarkdown(dir: string): string[] {
  return readdirSync(dir).filter(isCandidateMd);
}

export function skillsDir(userData: string): string {
  return join(userData, 'skills');
}

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'skill';

/** Minimal frontmatter read: name + description lines from a leading --- block. */
function parseFrontmatter(text: string): { name?: string; description?: string; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: text };
  const head = m[1] ?? '';
  const grab = (key: string): string | undefined => {
    const line = head.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'mi'));
    return line?.[1]?.trim().replace(/^["']|["']$/g, '');
  };
  return {
    ...(grab('name') ? { name: grab('name') } : {}),
    ...(grab('description') ? { description: grab('description') } : {}),
    body: text.slice(m[0].length),
  };
}

/** First markdown heading, else first non-empty line — fallbacks for bare files. */
function sniffTitle(body: string): { name?: string; description?: string } {
  const lines = body.split(/\r?\n/);
  const heading = lines.find((l) => /^#\s+/.test(l));
  const firstText = lines.find((l) => l.trim() && !/^#/.test(l.trim()));
  return {
    ...(heading ? { name: heading.replace(/^#+\s*/, '').trim() } : {}),
    ...(firstText ? { description: firstText.trim().slice(0, 140) } : {}),
  };
}

function listBundledFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (p: string, rel: string, depth: number): void => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase())) walk(join(p, e.name), `${rel}${e.name}/`, depth + 1);
      } else if (e.isFile() && e.name !== SKILL_FILE) {
        out.push(`${rel}${e.name}`);
      }
    }
  };
  walk(dir, '', 0);
  return out.sort();
}

function readMeta(userData: string, slug: string): SkillMeta | null {
  const dir = join(skillsDir(userData), slug);
  const file = join(dir, SKILL_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const fm = parseFrontmatter(text);
  const sniff = sniffTitle(fm.body);
  return {
    slug,
    name: fm.name ?? sniff.name ?? slug,
    description: fm.description ?? sniff.description ?? '(no description)',
    path: dir,
    files: listBundledFiles(dir),
  };
}

export function listSkills(userData: string): SkillMeta[] {
  const dir = skillsDir(userData);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => readMeta(userData, e.name))
    .filter((m): m is SkillMeta => m !== null)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * The catalog that rides the system prompt: one line per enabled skill,
 * stable ordering so local models keep their prompt cache. Empty string when
 * there is nothing to advertise — no skills, no note.
 */
export function skillsCatalog(userData: string, disabled: string[]): string {
  const off = new Set(disabled.map((s) => s.toLowerCase()));
  const skills = listSkills(userData).filter((s) => !off.has(s.slug.toLowerCase()));
  if (!skills.length) return '';
  return (
    '\n\nSKILLS — packaged know-how you can pull in when a task matches. The catalog:\n' +
    skills.map((s) => `- ${s.name} — ${s.description}`).join('\n') +
    '\nWhen a task matches a skill, call skill_read with its name FIRST and follow what it ' +
    'says before improvising. The catalog line is a summary; the skill is the instructions.'
  );
}

/**
 * "/slug" at the head of a message is an explicit summons — the user already
 * knows which skill they want, so the agent does not get to re-decide. Returns
 * null when the token names nothing installed and switched on; then it is just
 * a slash the user typed, and the message goes through untouched.
 */
export function parseSkillCall(
  userData: string,
  disabled: string[],
  text: string,
): SkillMeta | null {
  const m = /^\s*\/([A-Za-z0-9][A-Za-z0-9._-]*)(\s|$)/.exec(text);
  if (!m) return null;
  const want = m[1]!.toLowerCase();
  const off = new Set(disabled.map((s) => s.toLowerCase()));
  if (off.has(want)) return null;
  return listSkills(userData).find((s) => s.slug.toLowerCase() === want) ?? null;
}

/**
 * The note that rides a summons. The catalog invites the agent to choose; this
 * is the user overruling that choice, so it says so in as many words.
 */
export function skillCallNote(meta: SkillMeta): string {
  return (
    `\n[the user invoked the "${meta.name}" skill by name (/${meta.slug}). Call skill_read ` +
    `with "${meta.slug}" FIRST and follow it for this request — they picked it deliberately, ` +
    'so do not substitute your own approach or a different skill.]'
  );
}

/**
 * Serve-time translation: foreign skills speak other harnesses' tool names.
 * Prepended when reading, never baked into the stored file — the mapping can
 * improve without re-importing.
 */
const TRANSLATION_PREAMBLE =
  '[Skill translation: where this skill says bash, shell, or terminal commands, use ws_run. ' +
  'File reads/writes are ws_read / ws_write. "CLAUDE.md" or "AGENTS.md" means VO-CODER.md ' +
  'here. Web lookups are web_search / web_fetch. Bundled files are listed below with paths ' +
  'relative to the skill folder — reference them by absolute path when running scripts.]\n\n';

export function readSkill(
  userData: string,
  nameOrSlug: string,
): { meta: SkillMeta; content: string } | null {
  const want = nameOrSlug.trim().toLowerCase();
  const all = listSkills(userData);
  const meta =
    all.find((s) => s.slug.toLowerCase() === want) ??
    all.find((s) => s.name.toLowerCase() === want) ??
    all.find((s) => s.name.toLowerCase().includes(want) || s.slug.toLowerCase().includes(want));
  if (!meta) return null;
  const raw = readFileSync(join(meta.path, SKILL_FILE), 'utf8');
  const { body } = parseFrontmatter(raw);
  const filesNote = meta.files.length
    ? `\n\n[Bundled files in ${meta.path}:\n${meta.files.map((f) => `- ${f}`).join('\n')}]`
    : '';
  return { meta, content: `${TRANSLATION_PREAMBLE}# ${meta.name}\n\n${body.trim()}${filesNote}` };
}

function dirSize(p: string): number {
  let total = 0;
  const walk = (d: string, depth: number): void => {
    if (depth > 4 || total > MAX_IMPORT_BYTES) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase())) walk(full, depth + 1);
      } else {
        try {
          total += statSync(full).size;
        } catch {
          /* unreadable file — size unknown, skip */
        }
      }
    }
  };
  walk(p, 0);
  return total;
}

/**
 * Import a skill from a folder (Claude layout: SKILL.md inside, assets
 * beside) or a single .md file. The source is copied verbatim under
 * skills/<slug>/ — originals stay untouched wherever they came from.
 */
export function importSkill(
  userData: string,
  sourcePath: string,
): { ok: true; slug: string; name: string } | { ok: false; error: string } {
  let st;
  try {
    st = statSync(sourcePath);
  } catch {
    return { ok: false, error: `Not found: ${sourcePath}` };
  }

  let mdText: string;
  let copyDir: string | null = null;
  if (st.isDirectory()) {
    const mdPath = join(sourcePath, SKILL_FILE);
    if (existsSync(mdPath)) {
      mdText = readFileSync(mdPath, 'utf8');
    } else {
      // A folder without SKILL.md: accept it if it holds exactly one .md that
      // isn't repo boilerplate — that file becomes the skill body.
      const mds = candidateMarkdown(sourcePath);
      if (mds.length !== 1) {
        return {
          ok: false,
          error: 'The folder needs a SKILL.md (or exactly one .md file) to be a skill.',
        };
      }
      mdText = readFileSync(join(sourcePath, mds[0]!), 'utf8');
    }
    if (dirSize(sourcePath) > MAX_IMPORT_BYTES) {
      return { ok: false, error: 'Skill folder is over 20 MB — that is a project, not a skill.' };
    }
    copyDir = sourcePath;
  } else if (extname(sourcePath).toLowerCase() === '.md') {
    mdText = readFileSync(sourcePath, 'utf8');
  } else {
    return { ok: false, error: 'Pick a skill folder or a .md file.' };
  }

  const fm = parseFrontmatter(mdText);
  const sniff = sniffTitle(fm.body);
  const name =
    fm.name ?? sniff.name ?? basename(sourcePath, extname(sourcePath)).replace(/[-_]+/g, ' ');
  let slug = slugify(name);
  const root = skillsDir(userData);
  mkdirSync(root, { recursive: true });
  if (existsSync(join(root, slug))) {
    let n = 2;
    while (existsSync(join(root, `${slug}-${n}`))) n++;
    slug = `${slug}-${n}`;
  }
  const dest = join(root, slug);
  try {
    if (copyDir) {
      cpSync(copyDir, dest, {
        recursive: true,
        filter: (src) => !SKIP_DIRS.has(basename(src).toLowerCase()),
      });
      // Normalize the entry file name so every installed skill reads the same.
      if (!existsSync(join(dest, SKILL_FILE))) {
        const mds = candidateMarkdown(dest);
        if (mds.length === 1) cpSync(join(dest, mds[0]!), join(dest, SKILL_FILE));
      }
    } else {
      mkdirSync(dest, { recursive: true });
      cpSync(sourcePath, join(dest, SKILL_FILE));
    }
  } catch (err) {
    try {
      rmSync(dest, { recursive: true, force: true });
    } catch {
      /* partial import cleanup is best-effort */
    }
    return { ok: false, error: `Copy failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const meta = readMeta(userData, slug);
  return { ok: true, slug, name: meta?.name ?? name };
}

/* ---- GitHub import ------------------------------------------------------
 * Paste the address of a skill you found and it lands installed. Nothing is
 * cloned and git is not required: the contents API lists the folder, the raw
 * files come down into a staging dir, and the ordinary folder import takes it
 * from there — so slugging, collision suffixes and the size cap stay in one
 * place.
 */

export interface GitHubSkillRef {
  owner: string;
  repo: string;
  /** Branch/tag/sha. Omitted means the repo's default branch. */
  ref?: string;
  /** Folder or .md inside the repo; '' is the repo root. */
  path: string;
}

/** How many skills one collection import may bring in. */
const MAX_COLLECTION = 20;
/** Per-import file budget — a skill is a document, not a distribution. */
const MAX_FILES = 200;

/**
 * Accepts what the address bar gives you — a repo, a folder inside one
 * (/tree/), a single file (/blob/ or raw.githubusercontent.com) — plus the
 * bare owner/repo shorthand.
 */
export function parseGitHubSkillUrl(input: string): GitHubSkillRef | null {
  let t = input.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (!t) return null;
  t = t.replace(/^git\+/, '').replace(/\.git$/, '');
  const raw = /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/i.exec(t);
  if (raw) {
    return { owner: raw[1]!, repo: raw[2]!, ref: raw[3]!, path: raw[4]! };
  }
  const site = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/(.*))?$/i.exec(t);
  const parts = site
    ? { owner: site[1]!, repo: site[2]!, rest: site[3] ?? '' }
    : (() => {
        // Shorthand: owner/repo, optionally with a path after it.
        const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:\/(.*))?$/.exec(t);
        return m ? { owner: m[1]!, repo: m[2]!, rest: m[3] ? `tree/HEAD/${m[3]}` : '' } : null;
      })();
  if (!parts) return null;
  if (!parts.rest) return { owner: parts.owner, repo: parts.repo, path: '' };
  const deep = /^(?:tree|blob)\/([^/]+)(?:\/(.*))?$/.exec(parts.rest);
  if (!deep) return null; // /issues, /pulls, … — not a path to content
  const ref = deep[1]!;
  return {
    owner: parts.owner,
    repo: parts.repo,
    ...(ref === 'HEAD' ? {} : { ref }),
    path: deep[2] ?? '',
  };
}

interface GhEntry {
  name: string;
  path: string;
  type: string;
  size?: number;
  download_url?: string | null;
}

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const ghUrl = (r: GitHubSkillRef, path: string): string =>
  `https://api.github.com/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}` +
  `/contents/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}` +
  (r.ref ? `?ref=${encodeURIComponent(r.ref)}` : '');

/** GitHub's failures, said plainly — the status code alone helps nobody. */
function ghError(status: number, what: string): string {
  if (status === 404) return `GitHub has nothing at ${what} — check the branch and the folder.`;
  if (status === 403 || status === 429)
    return 'GitHub is rate-limiting this connection (it allows a handful of anonymous fetches per hour). Try again shortly.';
  return `GitHub said ${status} for ${what}.`;
}

export async function importSkillFromGitHub(
  userData: string,
  input: string,
  fetcher?: Fetcher,
): Promise<{ ok: true; imported: Array<{ slug: string; name: string }> } | { ok: false; error: string }> {
  const get: Fetcher =
    fetcher ??
    ((url) =>
      fetch(url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Vo-Coder' },
      }) as unknown as ReturnType<Fetcher>);
  const ref = parseGitHubSkillUrl(input);
  if (!ref) {
    return {
      ok: false,
      error: 'That does not look like a GitHub address. Paste the link to a skill folder, a SKILL.md, or a repo.',
    };
  }

  const listing = async (path: string): Promise<GhEntry[] | GhEntry | { error: string }> => {
    let res;
    try {
      res = await get(ghUrl(ref, path));
    } catch (err) {
      return { error: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!res.ok) return { error: ghError(res.status, path ? `/${path}` : `${ref.owner}/${ref.repo}`) };
    try {
      return JSON.parse(await res.text()) as GhEntry[] | GhEntry;
    } catch {
      return { error: 'GitHub returned something unreadable.' };
    }
  };

  const budget = { files: 0, bytes: 0 };
  /** Download one folder into `dest`, recursing into subfolders. `pre` is the
   *  listing when the caller already has it — anonymous GitHub allows only a
   *  handful of calls an hour, so never ask twice for the same folder. */
  const pull = async (
    path: string,
    dest: string,
    depth: number,
    pre?: GhEntry[],
  ): Promise<string | null> => {
    if (depth > 3) return null;
    const got = pre ?? (await listing(path));
    if (!Array.isArray(got)) return 'error' in got ? got.error : 'Expected a folder there.';
    mkdirSync(dest, { recursive: true });
    for (const e of got) {
      if (e.type === 'dir') {
        if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
        const err = await pull(e.path, join(dest, e.name), depth + 1);
        if (err) return err;
        continue;
      }
      if (e.type !== 'file' || !e.download_url) continue;
      if (++budget.files > MAX_FILES) return 'That folder holds too many files to be a skill.';
      budget.bytes += e.size ?? 0;
      if (budget.bytes > MAX_IMPORT_BYTES) return 'That skill is over 20 MB — too big to import.';
      let res;
      try {
        res = await get(e.download_url);
      } catch (err) {
        return `Could not download ${e.name}: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (!res.ok) return ghError(res.status, e.path);
      writeFileSync(join(dest, e.name), await res.text());
    }
    return null;
  };

  const stageRoot = mkdtempSync(join(tmpdir(), 'vo-skill-'));
  const cleanup = (): void => {
    try {
      rmSync(stageRoot, { recursive: true, force: true });
    } catch {
      /* the OS sweeps its own temp dir eventually */
    }
  };

  try {
    const head = await listing(ref.path);
    if (!Array.isArray(head) && 'error' in head) return { ok: false, error: head.error };

    // A single .md is a skill on its own — same as the local "Add .md file".
    if (!Array.isArray(head)) {
      if (extname(head.name).toLowerCase() !== '.md' || !head.download_url) {
        return { ok: false, error: 'That file is not a markdown skill.' };
      }
      const res = await get(head.download_url);
      if (!res.ok) return { ok: false, error: ghError(res.status, head.path) };
      const file = join(stageRoot, head.name);
      writeFileSync(file, await res.text());
      const done = importSkill(userData, file);
      return done.ok
        ? { ok: true, imported: [{ slug: done.slug, name: done.name }] }
        : { ok: false, error: done.error };
    }

    const single = async (path: string, entries: GhEntry[]) => {
      const dest = join(stageRoot, 'skill');
      const err = await pull(path, dest, 0, entries);
      if (err) return { ok: false as const, error: err };
      const done = importSkill(userData, dest);
      return done.ok
        ? { ok: true as const, imported: [{ slug: done.slug, name: done.name }] }
        : { ok: false as const, error: done.error };
    };

    const isSkillFolder = (entries: GhEntry[]): boolean =>
      entries.some((e) => e.type === 'file' && e.name === SKILL_FILE) ||
      entries.filter((e) => e.type === 'file' && isCandidateMd(e.name)).length === 1;

    // await, not a bare return: the finally below deletes the staging dir the
    // moment this try block ends, and handing out an unresolved promise would
    // pull the ground out from under the download.
    if (head.some((e) => e.type === 'file' && e.name === SKILL_FILE)) {
      return await single(ref.path, head);
    }

    // No SKILL.md at the address itself — so look inside. A skills LIBRARY is
    // usually repo → skills/ → one folder each, and pasting its front page
    // has to work, which is why the scan goes two levels before giving up.
    // This runs BEFORE the single-markdown guess: a repo root often has one
    // stray .md (THIRD_PARTY_NOTICES and friends) that is not the skill.
    const found: Array<{ name: string; path: string; entries: GhEntry[] }> = [];
    const seen = new Set<string>();
    const scan = async (entries: GhEntry[], depth: number): Promise<void> => {
      if (depth > 2 || found.length >= MAX_COLLECTION) return;
      for (const d of entries) {
        if (found.length >= MAX_COLLECTION) return;
        if (d.type !== 'dir' || SKIP_DIRS.has(d.name.toLowerCase()) || d.name.startsWith('.')) {
          continue;
        }
        if (seen.has(d.path)) continue;
        seen.add(d.path);
        const inner = await listing(d.path);
        if (!Array.isArray(inner)) continue;
        if (isSkillFolder(inner)) found.push({ name: d.name, path: d.path, entries: inner });
        else await scan(inner, depth + 1);
      }
    };
    await scan(head, 1);

    if (!found.length) {
      const loneMd = head.filter((e) => e.type === 'file' && isCandidateMd(e.name));
      if (loneMd.length === 1) return await single(ref.path, head);
      return {
        ok: false,
        error:
          'No SKILL.md there, and none in the folders inside it. Point at the skill folder itself.',
      };
    }
    if (found.length === 1) return await single(found[0]!.path, found[0]!.entries);

    const imported: Array<{ slug: string; name: string }> = [];
    const skipped: string[] = [];
    for (const f of found) {
      const dest = join(stageRoot, `c-${imported.length}`);
      const err = await pull(f.path, dest, 0, f.entries);
      if (err) {
        skipped.push(f.name);
        continue;
      }
      const done = importSkill(userData, dest);
      if (done.ok) imported.push({ slug: done.slug, name: done.name });
      else skipped.push(f.name);
    }
    if (imported.length) return { ok: true, imported };
    return {
      ok: false,
      error: `Found skills there but none imported cleanly (${skipped.join(', ')}).`,
    };
  } finally {
    cleanup();
  }
}

export function removeSkill(userData: string, slug: string): boolean {
  const dir = join(skillsDir(userData), slug);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
