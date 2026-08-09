import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
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
      // A folder without SKILL.md: accept it if it holds exactly one .md —
      // that file becomes the skill body.
      const mds = readdirSync(sourcePath).filter((f) => extname(f).toLowerCase() === '.md');
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
        const mds = readdirSync(dest).filter((f) => extname(f).toLowerCase() === '.md');
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

export function removeSkill(userData: string, slug: string): boolean {
  const dir = join(skillsDir(userData), slug);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
