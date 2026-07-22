import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProjectConfig, type ProjectConfig } from '@vo-coder/project-config';

export type ProjectState = 'managed' | 'existing' | 'new';

export interface Detection {
  state: ProjectState;
  /** Which structure markers were found (informational). */
  markers: string[];
  /** Parsed config when state === 'managed' and the file is valid. */
  config?: ProjectConfig;
}

const STRUCTURE_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'src',
];

/**
 * managed  → PROJECT_CONFIG.md present (we own it; regen only with force)
 * existing → the folder has structure another tool or human created (read,
 *            don't overwrite: only missing files may be written)
 * new      → empty or dotfiles-only (full inject is safe)
 */
export function detectProject(dir: string): Detection {
  const configPath = join(dir, 'PROJECT_CONFIG.md');
  if (existsSync(configPath)) {
    const config = parseProjectConfig(readFileSync(configPath, 'utf8')) ?? undefined;
    return { state: 'managed', markers: ['PROJECT_CONFIG.md'], config };
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { state: 'new', markers: [] };
  }

  const markers = STRUCTURE_MARKERS.filter((m) => existsSync(join(dir, m)));
  if (markers.length > 0) return { state: 'existing', markers };

  const visible = entries.filter((e) => !e.startsWith('.'));
  return visible.length === 0 ? { state: 'new', markers: [] } : { state: 'existing', markers: [] };
}
