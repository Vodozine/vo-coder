/**
 * The PROJECT_CONFIG.md contract shared by the scaffold engine and the infra
 * MCP. The markdown file carries a machine-readable JSON blob in an HTML
 * comment (`<!-- vo-config: {...} -->`) for lossless round-trips; the
 * human-readable "Your Answers" section is presentation.
 */

export type SkillLevel = 'beginner' | 'intermediate' | 'advanced';
export type ProjectType =
  | 'backend-service'
  | 'standalone-app'
  | 'library'
  | 'cli'
  | 'data-processing'
  | 'other';
export type Language = 'python' | 'javascript' | 'rust' | 'go' | 'java' | 'other';
/** Where the finished software runs — not where it is developed (that's DevOs). */
export type TargetPlatform =
  | 'windows-desktop'
  | 'macos-desktop'
  | 'linux-desktop'
  | 'cross-desktop'
  | 'android'
  | 'ios'
  | 'website'
  | 'web'
  | 'server'
  | 'other';
export type Virtualization = 'docker' | 'hypervisor' | 'none';
export type DevOs = 'windows' | 'linux' | 'macos' | 'other';

export interface ProjectAnswers {
  description: string;
  skillLevel: SkillLevel;
  projectType: ProjectType;
  /** Optional because configs generated before this question exist on disk. */
  targetPlatform?: TargetPlatform;
  language: Language;
  /** Free-text language name when language === 'other'. */
  languageOther?: string;
  virtualization: Virtualization;
  /** e.g. 'proxmox', 'kvm', 'hyper-v' — asked when virtualization === 'hypervisor'. */
  hypervisorKind?: string;
  devOs: DevOs;
  philosophy: string;
  /** Recorded for the live preview pane (P6). */
  devServer?: { command: string; port: number };
}

export interface ProjectConfig {
  version: 1;
  generatedAt?: string;
  answers: ProjectAnswers;
}

const MARKER_RE = /<!--\s*vo-config:\s*(\{[\s\S]*?\})\s*-->/;

export function parseProjectConfig(markdown: string): ProjectConfig | null {
  const match = markdown.match(MARKER_RE);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]!) as ProjectConfig;
    if (parsed.version !== 1 || typeof parsed.answers !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function configMarker(config: ProjectConfig): string {
  return `<!-- vo-config: ${JSON.stringify(config)} -->`;
}

export function languageLabel(answers: ProjectAnswers): string {
  return answers.language === 'other'
    ? (answers.languageOther ?? 'other')
    : answers.language;
}
