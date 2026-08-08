import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServerConfig } from '@vo-coder/core';

/**
 * Game-engine bridges: third-party MIT MCP servers fetched and built under
 * userData/tools, then run on the app's OWN Node runtime (ELECTRON_RUN_AS_NODE,
 * same trick as the bundled infra MCP) — end users need git+npm to install,
 * but neither a system Node nor an engine C++ toolchain to run:
 * - Unreal drives the editor through UE's built-in Python Remote Execution
 *   (no plugin to compile).
 * - Unity talks to a WebSocket host inside the editor, installed as a plain
 *   Package Manager git URL.
 * Cloned, not bundled: both projects move fast, and `Update` is a git pull.
 */
export interface EngineBridge {
  id: 'unreal' | 'unity';
  title: string;
  repo: string;
  /** Folder holding the server's package.json, '' = repo root. */
  serverDir: string;
  /** Built entry point, relative to the repo root. */
  bin: string;
  /** Present when binding means picking a project file for an env var. */
  projectPick?: { extensions: string[]; envVar: string; label: string };
}

export const ENGINE_BRIDGES: Record<string, EngineBridge> = {
  unreal: {
    id: 'unreal',
    title: 'Unreal Engine',
    repo: 'https://github.com/sam-david/unreal-mcp.git',
    serverDir: '',
    bin: 'dist/bin.js',
    projectPick: {
      extensions: ['uproject'],
      envVar: 'UNREAL_MCP_PROJECT_PATH',
      label: 'Unreal project',
    },
  },
  unity: {
    id: 'unity',
    title: 'Unity',
    repo: 'https://github.com/CoderGamester/mcp-unity.git',
    serverDir: 'Server~',
    bin: 'Server~/build/index.js',
  },
};

export function bridgeDir(userData: string, id: string): string {
  return join(userData, 'tools', `${id}-mcp`);
}

export function bridgeInstalled(userData: string, id: string): boolean {
  const def = ENGINE_BRIDGES[id];
  if (!def) return false;
  return existsSync(join(bridgeDir(userData, id), ...def.bin.split('/')));
}

function run(cmd: string, args: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolvePromise) => {
    // shell:true so Windows resolves git.exe / npm.cmd from PATH — but the
    // shell CONCATENATES args, so a path with a space (user profiles can
    // have them) must be quoted or it splits. No user-typed input reaches
    // this; quoting is for paths, not sanitising.
    const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
    const child = spawn(cmd, quoted, { cwd, shell: true, windowsHide: true });
    let out = '';
    const grab = (b: Buffer) => {
      out += b.toString();
      if (out.length > 20_000) out = out.slice(-20_000);
    };
    child.stdout?.on('data', grab);
    child.stderr?.on('data', grab);
    child.on('error', (err) => resolvePromise({ ok: false, out: `${out}\n${String(err)}` }));
    child.on('close', (code) => resolvePromise({ ok: code === 0, out }));
  });
}

export interface BridgeInstallResult {
  ok: boolean;
  step: 'git' | 'fetch' | 'dependencies' | 'build' | 'verify' | 'done';
  log: string;
}

/** Fetch + build a bridge. Idempotent: an existing clone is pulled, not re-cloned. */
export async function bridgeInstall(userData: string, id: string): Promise<BridgeInstallResult> {
  const def = ENGINE_BRIDGES[id];
  if (!def) return { ok: false, step: 'verify', log: `Unknown bridge "${id}".` };
  const dir = bridgeDir(userData, id);
  const git = await run('git', ['--version']);
  if (!git.ok) {
    return { ok: false, step: 'git', log: 'Git is not on PATH — install Git, then retry.' };
  }
  const fetchStep = existsSync(join(dir, '.git'))
    ? await run('git', ['-C', dir, 'pull', '--ff-only'])
    : await run('git', ['clone', '--depth', '1', def.repo, dir]);
  if (!fetchStep.ok) return { ok: false, step: 'fetch', log: fetchStep.out };
  const serverCwd = def.serverDir ? join(dir, def.serverDir) : dir;
  // ci wants a lockfile; fall back to install for repos that ship without one.
  let deps = await run('npm', ['ci', '--no-audit', '--no-fund'], serverCwd);
  if (!deps.ok) deps = await run('npm', ['install', '--no-audit', '--no-fund'], serverCwd);
  if (!deps.ok) return { ok: false, step: 'dependencies', log: deps.out };
  const build = await run('npm', ['run', 'build'], serverCwd);
  if (!build.ok) return { ok: false, step: 'build', log: build.out };
  if (!bridgeInstalled(userData, id)) {
    return { ok: false, step: 'verify', log: `Build finished but ${def.bin} is missing.` };
  }
  return { ok: true, step: 'done', log: `${def.title} bridge built.` };
}

/** The MCP entry for a built bridge — runs on the app's own Node when packaged. */
export function bridgeConfig(
  userData: string,
  id: string,
  execPath: string,
  packaged: boolean,
  projectPath?: string,
): McpServerConfig {
  const def = ENGINE_BRIDGES[id];
  if (!def) throw new Error(`Unknown bridge "${id}".`);
  const dir = bridgeDir(userData, id);
  const env: Record<string, string> = {
    ...(packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...(def.projectPick && projectPath ? { [def.projectPick.envVar]: projectPath } : {}),
  };
  return {
    name: def.id,
    command: packaged ? execPath : 'node',
    args: [join(dir, ...def.bin.split('/'))],
    cwd: dir,
    ...(Object.keys(env).length ? { env } : {}),
  };
}
