/** The eight questions (plus two conditional follow-ups) as data. Pure — no I/O. */

export interface QuestionOption {
  value: string;
  label: string;
  /** Plain-language "why pick this" — surfaced to beginners so the choice is informed. */
  description?: string;
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
  /** Extra guidance shown only to beginners: how to think about the question. */
  beginnerHint?: string;
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
      {
        value: 'beginner',
        label: 'Beginner',
        description:
          'New to programming or to this kind of project. The setup explains every choice and the agents guide you step by step.',
      },
      {
        value: 'intermediate',
        label: 'Intermediate',
        description:
          "You've built and shipped a few things — comfortable coding, still like a safety net.",
      },
      {
        value: 'advanced',
        label: 'Advanced',
        description: 'You know your stack. Guidance stays terse and out of the way.',
      },
    ],
  },
  {
    id: 'projectType',
    prompt: 'What kind of project is this?',
    kind: 'select',
    beginnerHint:
      'Think about how your software is used: does a person open it (application), does it wait for requests (backend), do other developers import it (library)?',
    options: [
      {
        value: 'backend-service',
        label: 'Backend Service',
        description:
          'Runs on a server and answers requests — APIs, bots, the engine behind a website or app.',
      },
      {
        value: 'standalone-app',
        label: 'Standalone Application',
        description:
          'A program people open and use directly — a desktop, mobile, or web app with an interface.',
      },
      {
        value: 'library',
        label: 'Library / SDK',
        description:
          'Code other developers install and reuse in their own projects. No interface of its own.',
      },
      {
        value: 'cli',
        label: 'CLI Tool',
        description: 'A command-line tool you run in a terminal — flags in, output out.',
      },
      {
        value: 'data-processing',
        label: 'Data Processing',
        description: 'Scripts or pipelines that read, transform, and analyze data.',
      },
      {
        value: 'other',
        label: 'Other',
        description: "Doesn't fit these boxes — describe it in the philosophy question at the end.",
      },
    ],
  },
  {
    id: 'targetPlatform',
    prompt: 'What kind of software is this — where will it run?',
    kind: 'select',
    beginnerHint:
      "Where will people USE the finished thing — not where you write the code (that's asked later). Aiming at several platforms? Pick the main one, or cross-platform desktop.",
    options: [
      {
        value: 'windows-desktop',
        label: 'Desktop — Windows',
        description: 'An app installed and run on Windows PCs.',
      },
      {
        value: 'macos-desktop',
        label: 'Desktop — macOS',
        description: 'An app installed and run on Macs.',
      },
      {
        value: 'linux-desktop',
        label: 'Desktop — Linux',
        description: 'An app installed and run on Linux machines.',
      },
      {
        value: 'cross-desktop',
        label: 'Desktop — cross-platform',
        description:
          'One codebase, apps for Windows + macOS + Linux (Electron, Tauri, Qt, …). Most reach for a desktop tool.',
      },
      {
        value: 'android',
        label: 'Android app',
        description: 'Phones and tablets, shipped through the Play Store or as an APK.',
      },
      {
        value: 'ios',
        label: 'iOS app',
        description:
          'iPhone / iPad, shipped through the App Store. Building requires a Mac with Xcode.',
      },
      {
        value: 'website',
        label: 'Website',
        description:
          'Pages people visit to read and look around — a portfolio, blog, business site, landing page.',
      },
      {
        value: 'web',
        label: 'Web app (browser)',
        description:
          'A program that runs in the browser — dashboards, editors, tools. Nothing to install, works on every device.',
      },
      {
        value: 'server',
        label: 'Server / cloud',
        description:
          'Lives on a server; people reach it through other apps or APIs, never run it themselves.',
      },
      {
        value: 'other',
        label: 'Other / not sure',
        description: "Embedded, game console, plugin, or undecided — the agents will help narrow it down.",
      },
    ],
  },
  {
    id: 'language',
    prompt: "What's your primary development language?",
    kind: 'select',
    beginnerHint:
      'Not sure? Python is the gentlest start; JavaScript if it runs in a browser or as a cross-platform app. Android favors Java/Kotlin, iOS favors Swift (choose Other and type it).',
    options: [
      {
        value: 'python',
        label: 'Python',
        description:
          'Friendliest to learn, reads like English. Superb for automation, data, AI, and servers.',
      },
      {
        value: 'javascript',
        label: 'JavaScript / Node.js',
        description:
          'The language of the web — websites, servers, and cross-platform desktop/mobile apps with one language.',
      },
      {
        value: 'rust',
        label: 'Rust',
        description:
          'Very fast and memory-safe systems language. Steeper learning curve, excellent tooling.',
      },
      {
        value: 'go',
        label: 'Go',
        description: 'Simple, fast, compiles to one binary — great for servers and network tools.',
      },
      {
        value: 'java',
        label: 'Java',
        description:
          'Battle-tested, runs everywhere, the native language of Android. Verbose but dependable.',
      },
      {
        value: 'other',
        label: 'Other',
        description: 'Swift, Kotlin, C#, C++, Zig, … — type the name next.',
      },
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
    beginnerHint:
      "This is about your setup, not the project. If you've never installed Docker or run a virtual machine, the honest answer is Neither — and that's fine.",
    options: [
      {
        value: 'docker',
        label: 'Docker / container runtime',
        description:
          'You have Docker (or Podman) installed — apps can run in isolated containers.',
      },
      {
        value: 'hypervisor',
        label: 'Hypervisor (Proxmox, KVM, ESXi, Hyper-V, …)',
        description:
          'You run virtual machines — the infra tools can provision test machines into them.',
      },
      {
        value: 'none',
        label: 'Neither (local development only)',
        description: 'Everything runs directly on this computer. Simplest, and plenty to start.',
      },
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
    beginnerHint:
      "The operating system on the computer you write code with — not where the software will run.",
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
