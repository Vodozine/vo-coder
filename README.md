<p align="center">
  <img src="docs/img/vodo-full.png" alt="Vodo — the Vo-Coder assistant" width="240"/>
</p>

<h1 align="center">Vo-Coder</h1>

<p align="center">
  <strong>You talk to Vodo. Vodo picks the right man for the job.</strong><br/>
  A provider-agnostic AI agent workbench for the desktop — built to humanize AI coding and stop overpaying for tokens.
</p>

<p align="center">
  <a href="https://vodozine.github.io/vo-coder/"><strong>Website</strong></a> ·
  <a href="https://github.com/Vodozine/vo-coder/releases/latest"><strong>Download</strong></a> ·
  <a href="https://github.com/Vodozine/vo-coder/discussions"><strong>Discussions</strong></a> ·
  <a href="#whats-inside">Features</a>
</p>

<p align="center">
  <img src="docs/img/chat.png" alt="Vo-Coder — Vodo builds a page with thinking and tool calls" width="760"/>
</p>

---

## What is Vo-Coder?

Vo-Coder is a desktop workbench for working *with* AI agents — chatting, building software, running background jobs, controlling your homelab — without being married to any one AI vendor, and without paying frontier-model prices for every throwaway question.

The design follows one metaphor all the way down: the **tool shed**. The harness itself is deliberately lightweight — it holds the tools (file access, terminals, web search, vision, MCP servers, infrastructure drivers) and coordinates requests. The model is the engineer who walks into the shed and decides what to pick up. Models are interchangeable; the shed is yours.

**You talk to Vodo.** Vodo is the coordinator agent — the one face in front of every model. For each message, Vodo reads the task's actual demands — is this casual chat or a build request? does it need vision, tools, hard reasoning? — and routes it to the **cheapest model that's genuinely adequate**, scored from live provider pricing and real benchmark data (LMArena Elo, coding-weighted). "Make this look modern" in a project folder wakes a capable executor; "thanks!" costs a fraction of a cent. Every routed reply shows its reasoning and estimated cost, and per-project meters keep the spending honest. When you'd rather delegate to your own hand-built specialists — or pin one model forever — routing is a setting, not a religion.

And because an assistant should not be trapped in one window, Vodo works as one continuous entity across surfaces: the desktop chat, background **missions** running on schedules, your **Telegram** account when you're away from the machine — all sharing one **memory journal**, so "what was I working on last Monday?" has an answer no matter where you ask it.

Everything runs on your machine. API keys are encrypted with your OS keychain and go only to the providers you configured. Local models (Ollama, LM Studio) are first-class citizens, not an afterthought. Agents act through permission prompts — in a chat you see every file write and command before it happens. Missions are the deliberate exception: they run unattended, so approving the mission is what approves its work, and the prompt that creates one says so.

## The story

Vo-Coder is a **pet project**. I built it for myself and I use it daily — it's shared because it's useful, not because it's finished. There will be bugs; I'm working through them as they surface. Found one, or want something it doesn't do yet? **[Discussions](https://github.com/Vodozine/vo-coder/discussions)** is the place.

It's also a port of something bigger. Vo-Coder began as the brain of **Vodomation OS** — my own highly customized Linux distro with its own desktop environment, currently in the works. There it runs far deeper than any desktop app can: most of Vodomation's built-in apps don't need compiling, so Vo-Coder can change and extend *every one of them while you use them* — the multimedia and design apps included. Ask **Vaudio** (the audio app) for an effect that doesn't exist, and Vo-Coder writes the audio plugin on the fly. An OS that grows with you.

That framework is so different from a conventional desktop that a straight port was impossible — so this standalone Vo-Coder was **rebuilt from scratch** to bring the same brain to Windows, macOS, and Linux.

## Screens

<p align="center">
  <img src="docs/img/group-8.png" alt="Group project: six specialists working one goal side by side" width="880"/><br/>
  <sub>A group project mid-flight: six specialists on one goal, Vodo coordinating — 8 panes per page.</sub>
</p>

<table>
  <tr>
    <td width="50%"><img src="docs/img/agents-edit.png" alt="Priced model picker"/><br/><sub>Compare models by price and context — pick the right one per agent.</sub></td>
    <td width="50%"><img src="docs/img/missions.png" alt="Missions"/><br/><sub>Missions run in the background, on a schedule, concurrent with your chats.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/img/preview.png" alt="Live code view"/><br/><sub>Watch agents build — live code view with change states.</sub></td>
    <td><img src="docs/img/settings.png" alt="Settings"/><br/><sub>Everything in one full-canvas settings page.</sub></td>
  </tr>
</table>

Every feature, explained in detail, on the **[website ↗](https://vodozine.github.io/vo-coder/)**.

## What's inside
<a id="whats-inside"></a>

**🤖 Seven providers, one chat** — Anthropic, OpenAI, OpenRouter, xAI (Grok), NVIDIA (NIM cloud), Ollama, LM Studio. Keys live encrypted in your OS keychain. Grok also supports **subscription sign-in** (SuperGrok / X Premium) — no API key needed. Flip any provider **On/Off** without deleting credentials so auto-routing skips it until you want it back — and agents can go **off duty** the same way, keeping their setup while routing and groups pass them by.

**🧭 Smart routing, your rules** — four modes: *Auto* (cheapest adequate model per message), *My agents first* (your specialist agents get matching work, Auto as fallback), *My agents only* (every turn lands on one of your agents), or *Off*. Every routed reply shows the reasoning and estimated cost. Busy or failing endpoints (429 / 5xx / ResourceExhausted) back off and retry; models that keep failing get benched so routing moves on.

**🛠 Agents with hands** — agents don't hand you instructions; they do the work. Workspace tools (list/read/write files, run commands) scoped to your project folder, gated by per-call permission prompts. Web search and page fetching are built into every session — no API key, no setup. Folder-bound chats follow strict **workspace discipline**: this folder only, other apps are read-only reference even when used "as a base", versions bumped before every build, one build-output folder — never a pile of `release-fix2` clones.

**📂 Point a chat at any folder** — attach any folder to a chat and the agent gets tools over it: browse, read, run, and *see*. Binding a chat to a folder also **rehomes it to the project that owns that folder** (created from the folder's name when it's new), and its memory record moves along — so two apps never share one briefing and the agent never drifts back into the wrong codebase. Review a codebase, or catalog a folder of photos so you can find them later by feel — "the moody one," "the sunny beach shot."

**📐 A rulebook per folder** — when a folder quietly becomes a real project (code piling up, no git, no structure), the agent steps on the brakes **once**, like a senior colleague — and talks it through with you, one question at a time, never a questionnaire. What you agree on lands in `VO-CODER.md`: **`## Rules`** is yours and binds every agent working in that folder, every turn; **`## Map`** is theirs, kept fresh so the next session starts oriented instead of exploring. Say no and it never asks again.

**👁 Real eyes for any model** — `look_at_image` runs an image file through your vision model and hands the description back as text, so even a text-only coder can "see" a screenshot or photo. Camera **RAW** files (NEF, CR2/CR3, ARW, RAF, ORF, RW2, DNG, and 20+ more) open via their embedded preview. `file_identify` decodes camera/app naming schemes — which device shot each file, and the date baked into the name. Vision model pickers filter for real vision-capable IDs (including xAI when you're on Grok login).

**🔍 One-click code review** — a Review button runs a real read-only pass over the folder, ranks findings by severity, and ends with proposed changes behind an **Approve / Revise / Don't accept** pill. Approve and the agent applies the edits and verifies them; decline and nothing is touched.

**🎨 Image generation in-chat** — point an image-output model at a prompt and the result renders inline *and* lands in the project's `designs/` folder. Supports **xAI Grok Imagine** (API key or Grok login), OpenRouter image models, and OpenAI — pick them from Settings → Image model.

**👥 Group projects** — Vodo splits a goal across your specialists and runs them side by side (4, 8, or 16 panes per page). One big deliverable splits too: he writes a **blueprint**, hands out numbered blocks, the whole team builds in parallel and code — not a model — merges the result. Mid-run he can seat another roster agent (`group_add`), *"use all agents"* means **all** of them or a reason per agent, and a group is not done until the deliverable actually **ran** — build, tests, start — under his eyes. Every group is one foldable row in the sidebar, always.

**🚀 Missions** — background objectives Vodo pursues in its own isolated agent instances, one-shot or looping on a schedule. Missions run concurrently with your chats, so long work never blocks the conversation. Just ask: *"check my backups every hour and report problems."*

**📱 Telegram remote** — pair your own Telegram bot with a one-time code and talk to Vodo from anywhere: ask questions, launch missions, get run notifications, approve tool calls with inline buttons. Replies always come from **Vodo's own model** — turning a provider off never silences your phone.

**🧠 Cross-everything memory** — a timestamped journal records activity across all projects, chats, missions, and tools. Ask Vodo *"what was I working on last Monday at 10pm?"* and it answers from the record. Pin durable facts any agent can recall.

**🗂 A memory bank per project** — every conversation is kept verbatim in a local SQLite archive, and distilled into a structured **map** (decisions, files, tasks, facts, and their links) you can browse and edit in the Memory view. Turn on **Smart context** and the window becomes a buffer over that map — a chat that once replayed 290k tokens a turn drops to a few thousand, with the full record always one search away.

**🎙 Voice** — push-to-talk and hands-free live chat. One-click whisper.cpp setup for fully offline speech-to-text. Text-to-speech through your system voice, OpenAI, ElevenLabs, or **any OpenAI-compatible endpoint** (Groq, local Kokoro, …) — replies are spoken sentence-by-sentence while the model is still writing. Cloud endpoints get **model and voice dropdowns** once the key is in, plus a one-click **Test voice** and a speed control; the system voice adds rate and pitch.

**👀 Live code view** — watch agents build in real time: project tree with change states, per-line diffs, syntax highlighting, git-aware review. Select any code and ask for an explanation, a rethink, or a change — right where it is.

**🏗 Project scaffolding** — an 8-question setup (including the target platform: Windows/macOS/Linux desktop, Android, iOS, website, web app, server) generates a `PROJECT_CONFIG.md` that agents and tools treat as the project's north star. Beginners get every option explained; environment answers are remembered across projects.

**🖥 Infrastructure MCP** — a bundled, generalized infrastructure server: environment discovery plus a Proxmox driver (VMs, containers, snapshots, backups) behind read < write < destructive permission tiers. Works in any MCP client, not just Vo-Coder. Finding more tools is built in: search the official MCP registry and add servers with one click.

**🎮 Unreal & Unity bridges** — one click in Settings → MCP fetches and builds an MIT engine bridge ([sam-david/unreal-mcp](https://github.com/sam-david/unreal-mcp), [CoderGamester/mcp-unity](https://github.com/CoderGamester/mcp-unity)) and runs it on the app's **own** Node — no system Node needed. Unreal needs no C++ plugin (it drives the editor through UE's built-in Python Remote Execution, UE 5.3+); Unity installs as a plain Package Manager git URL (Unity 6+). Then *"spawn a cube 200 units up"* is just a sentence to Vodo — actors, Blueprints, materials and builds on one side; scenes, GameObjects, prefabs and tests on the other.

**📟 The essentials** — real PTY terminal with tabs, a live app preview that starts (and stops) your project's dev server and follows whichever project you're in, per-project + all-time usage tracking, auto-updates that keep your settings and keys. Composer drafts survive tab switches; chat only auto-scrolls when you're already near the bottom.

**🛡 Built to not hang** — a silent or throttled model can't freeze a turn (a stall watchdog aborts it), Stop always interrupts even a wedged command, and long build-and-verify runs get room to finish instead of dying halfway. Three operating modes — **Auto** (autonomous), **Plan** (read-only, proposes a plan), **Manual** (approve every action).

## What's new

**1.2.16** — the game-engine release, and the one where chats stop getting lost. **Unreal Engine & Unity bridges**: one-click MCP setup for both editors — Vodo drives them in plain language. **One folder ↔ one project**: binding a chat to a folder rehomes it (memory included) to the project that owns that folder, so two apps never share one briefing and the agent never drifts back into the old codebase. Groups grew up: *"use all agents"* means all of them, `group_add` seats another specialist mid-run, and a group is not done until the deliverable actually **ran**. Plus: one sidebar row per group always (orphaned group chats fold too), a 16-pane split view, strict workspace discipline (versioned builds, one output folder, no assumptions), and Telegram always answering as Vodo — a disabled provider can't silence your phone any more.

**1.2.15** — agents that ask before your project grows wild: the **VO-CODER.md project gate** (one senior-dev brake, your rules bind every agent in the folder), agent **On/Off** switches, Mr Homelab configured in his own tab, TTS model/voice pickers with a Test button + speed/pitch, folded settings with real checkboxes, **parallel blocks** (blueprint → blocks → code-merged deliverable), and the delegation guards that keep Vodo overseeing instead of building.

**1.2.14** — generated images appear in the chat (and stay there — no Preview hijack), and the Proxmox driver honours `insecureTls` for self-signed homelab certs.

**1.2.13 and earlier** — image requests stay on your model and render through your configured image model; Mr Homelab + Z.ai (GLM Coding Plan); stable prompt prefix so local models stop re-reading everything; group projects; multi-endpoint local servers with `model@endpoint` pinning. Full notes on the [Releases page](https://github.com/Vodozine/vo-coder/releases).

## Install

Grab the latest installer from **[Releases](https://github.com/Vodozine/vo-coder/releases)** — Windows (auto-updating), macOS (Apple Silicon **and** Intel), and Linux AppImage.

**macOS:** open the DMG and drag Vo-Coder to Applications. Pick the **arm64** DMG for Apple Silicon (M-series) or the **x64** DMG for Intel. On first launch, **right-click the app → Open → Open** — a plain double-click is blocked because the build isn't notarized (no Apple Developer account behind it, just an open-source project). If macOS still says the app is *"damaged"*, run this once in Terminal and open it again:

```bash
xattr -cr /Applications/Vo-Coder.app
```

On first run: add one API key (or start a local Ollama/LM Studio server — no key needed), and say hello to Vodo.

## Build from source

```bash
git clone https://github.com/Vodozine/vo-coder.git
cd vo-coder
npm install
npx tsc -b                      # compile workspace packages
npm run preview                 # native Electron window (preferred)
# or: npm run dev -w apps/desktop
```

`npm run preview` launches the **real Electron shell** with an isolated dev profile. Do not use a browser-only Vite server of the renderer — that is not the app. Details: [docs/desktop-preview.md](docs/desktop-preview.md).

Package an installer: `npm run dist:test -w apps/desktop` → `apps/desktop/release-local/`.

Official multi-platform builds (Windows NSIS, macOS DMG arm64+x64, Linux AppImage) run on GitHub Actions when a `v*` tag is pushed — see [`.github/workflows/release.yml`](.github/workflows/release.yml) and [docs/packaging.md](docs/packaging.md).

The monorepo: `apps/desktop` (Electron shell) plus independently publishable packages — `providers` (streaming adapters), `core` (agent loop, MCP client), `capability-registry` (catalog, pricing, routing), `scaffold`, `voice`, `infra-mcp`, `project-config`.

## License

MIT-style with one extra condition: **if you build on Vo-Coder, say so.** Fork it, extend it, ship it commercially, keep your changes closed — all fine. The only obligation for derived works is a visible *"Based on Vo-Coder"* credit. See [LICENSE](LICENSE). Branch it and take it to the next level.

---

<p align="center"><sub>Vo-Coder — the tool shed for AI agents. 🤍</sub></p>
