/** The seven questions (plus two conditional follow-ups) as data. Pure — no I/O. */

export interface QuestionOption {
  value: string;
  label: string;
}

export interface QuestionDef {
  /** Key in the answers record. */
  id: string;
  prompt: string;
  kind: 'text' | 'select';
  options?: QuestionOption[];
  /** Only asked when a prior answer matches. */
  dependsOn?: { key: string; equals: string };
  hint?: string;
  /** Text questions that may be skipped with an empty answer. */
  optional?: boolean;
}

/**
 * Environment-level questions describe the machine, not the project — hosts
 * remember these across projects and pre-seed the questionnaire with them.
 */
export const ENV_QUESTION_IDS = ['virtualization', 'hypervisorKind', 'devOs'] as const;

export const QUESTIONS: QuestionDef[] = [
  {
    id: 'description',
    prompt: 'What is your project?',
    kind: 'text',
    hint: 'Project name, purpose, core idea — a sentence or two.',
  },
  {
    id: 'skillLevel',
    prompt: "What's your skill level?",
    kind: 'select',
    options: [
      { value: 'beginner', label: 'Beginner' },
      { value: 'intermediate', label: 'Intermediate' },
      { value: 'advanced', label: 'Advanced' },
    ],
  },
  {
    id: 'projectType',
    prompt: 'What kind of project is this?',
    kind: 'select',
    options: [
      { value: 'backend-service', label: 'Backend Service' },
      { value: 'standalone-app', label: 'Standalone Application' },
      { value: 'library', label: 'Library / SDK' },
      { value: 'cli', label: 'CLI Tool' },
      { value: 'data-processing', label: 'Data Processing' },
      { value: 'other', label: 'Other' },
    ],
  },
  {
    id: 'language',
    prompt: "What's your primary development language?",
    kind: 'select',
    options: [
      { value: 'python', label: 'Python' },
      { value: 'javascript', label: 'JavaScript / Node.js' },
      { value: 'rust', label: 'Rust' },
      { value: 'go', label: 'Go' },
      { value: 'java', label: 'Java' },
      { value: 'other', label: 'Other' },
    ],
  },
  {
    id: 'languageOther',
    prompt: 'Which language?',
    kind: 'text',
    dependsOn: { key: 'language', equals: 'other' },
  },
  {
    id: 'virtualization',
    prompt: 'Do you have a containerization or virtualization environment available?',
    kind: 'select',
    options: [
      { value: 'docker', label: 'Docker / container runtime' },
      { value: 'hypervisor', label: 'Hypervisor (Proxmox, KVM, ESXi, Hyper-V, …)' },
      { value: 'none', label: 'Neither (local development only)' },
    ],
  },
  {
    id: 'hypervisorKind',
    prompt: 'Which hypervisor?',
    kind: 'text',
    dependsOn: { key: 'virtualization', equals: 'hypervisor' },
    hint: 'e.g. proxmox, kvm, esxi, hyper-v',
  },
  {
    id: 'devOs',
    prompt: "What's your primary development OS?",
    kind: 'select',
    options: [
      { value: 'windows', label: 'Windows' },
      { value: 'linux', label: 'Linux' },
      { value: 'macos', label: 'macOS' },
      { value: 'other', label: 'Other' },
    ],
  },
  {
    id: 'philosophy',
    prompt: 'Any project philosophy, constraints, or custom logic?',
    kind: 'text',
    optional: true,
    hint: 'e.g. "anti-e-waste hardware reuse", "minimal dependencies", "real-time constraints"',
  },
];
