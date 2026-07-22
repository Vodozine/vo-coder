# Vo-Coder

A provider-agnostic LLM agent harness — the **tool shed**. The harness is the shed holding the tools (integrations, file access, compute environments, MCP servers); the model is the engineer who walks in and decides what to use. The harness stays lightweight: it routes requests and responses, and all heavy compute lives in the tools.

Cross-platform Electron desktop app (Windows / macOS / Linux), Node + TypeScript end to end.

## Packages

| Package | Role |
|---|---|
| `apps/desktop` | Electron shell — chat UI, agents, settings, scaffold wizard, preview |
| `packages/providers` | Provider abstraction + adapters: Anthropic, OpenAI, OpenRouter, Ollama |
| `packages/core` | Agent runtime: session loop, MCP client management, middleware |
| `packages/scaffold` | Markdown scaffolding: PROJECT_SETUP.md questionnaire → PROJECT_CONFIG.md |
| `packages/project-config` | Shared PROJECT_CONFIG.md contract (types + parse/serialize) |
| `packages/infra-mcp` | Universal infrastructure MCP server (discovery + hypervisor drivers) |
| `packages/capability-registry` | Model catalog, hardware fit, task→model routing |
| `packages/voice` | Pluggable STT / TTS / VAD for push-to-talk and live chat |

`packages/scaffold` and `packages/infra-mcp` are independently publishable and usable outside the harness.

## Development

```bash
npm install
npm run dev        # launch the desktop app with HMR
npm test           # run all package test suites
npm run typecheck  # typecheck everything
```
