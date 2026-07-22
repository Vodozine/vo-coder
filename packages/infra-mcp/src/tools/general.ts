import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { parseProjectConfig } from '@vo-coder/project-config';
import { renderEnvironmentMd } from '../environment-md.js';
import { runDiscovery, type Exec, defaultExec } from '../discovery/index.js';
import type { DriverContext, InfraDriver, ToolModule } from '../drivers/types.js';

const INSTALL_ALLOWLIST = [
  'npm', 'pnpm', 'yarn', 'npx', 'pip', 'pip3', 'uv', 'poetry',
  'cargo', 'go', 'mvn', 'gradle', 'bundle', 'composer', 'dotnet', 'brew',
];

function runShell(
  command: string,
  cwd: string,
  timeoutMs = 10 * 60_000,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let output = '';
    const cap = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 60_000) output = output.slice(-60_000);
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ code: null, output: err.message });
    });
  });
}

export function generalTools(
  ctx: DriverContext,
  drivers: InfraDriver[],
  exec: Exec = defaultExec,
): ToolModule[] {
  const { settings } = ctx;
  return [
    {
      name: 'env_discover',
      title: 'Discover environment',
      description:
        'Scan this machine: runtimes, container daemons, configured hypervisor connections, hardware. Caches results in MCP_SETTINGS.json and writes MCP_ENVIRONMENT.md.',
      tier: 'read',
      inputSchema: {
        dir: z.string().optional().describe('Where to write MCP_ENVIRONMENT.md (default: cwd)'),
      },
      handler: async (args) => {
        const discovery = await runDiscovery(settings, drivers, exec);
        settings.save({ discovery });
        const md = renderEnvironmentMd(discovery);
        const target = resolve(String(args.dir ?? process.cwd()), 'MCP_ENVIRONMENT.md');
        writeFileSync(target, md, 'utf8');
        return {
          text: `Discovery complete — ${discovery.runtimes.length} runtimes, ${Object.keys(discovery.containers).length} container daemon(s), ${discovery.hypervisors.length} hypervisor(s). Wrote ${target}.`,
          data: discovery,
        };
      },
    },
    {
      name: 'env_read',
      title: 'Read discovered environment',
      description: 'Return the cached discovery results (run env_discover first).',
      tier: 'read',
      inputSchema: {},
      handler: async () => {
        const d = settings.get().discovery;
        if (!d) {
          return { text: 'No cached discovery yet — run env_discover first.', isError: true };
        }
        return { text: renderEnvironmentMd(d), data: d };
      },
    },
    {
      name: 'connection_list',
      title: 'List connections',
      description: 'List configured infrastructure connections (secrets redacted).',
      tier: 'read',
      inputSchema: {},
      handler: async () => {
        const conns = Object.entries(settings.get().connections).map(([name, c]) => ({
          name,
          driver: c.driver,
          host: c.host,
          port: c.port ?? 8006,
          user: c.user,
          hasSecret: !!settings.resolveSecret(c),
        }));
        return {
          text: conns.length
            ? conns.map((c) => `${c.name}: ${c.driver} @ ${c.host}:${c.port}`).join('\n')
            : 'No connections configured. Use connection_add.',
          data: conns,
        };
      },
    },
    {
      name: 'connection_add',
      title: 'Add connection',
      description:
        'Add or update a hypervisor connection in MCP_SETTINGS.json. Prefer tokenSecret "env:VAR_NAME" over literals.',
      tier: 'write',
      inputSchema: {
        name: z.string(),
        driver: z.literal('proxmox'),
        host: z.string(),
        port: z.number().int().optional(),
        user: z.string().optional().describe('e.g. root@pam'),
        tokenId: z.string().optional(),
        tokenSecret: z.string().optional().describe('Literal or "env:VAR_NAME"'),
        insecureTls: z
          .boolean()
          .optional()
          .describe('Accept self-signed certificates (homelab only)'),
      },
      handler: async (args) => {
        const connections = { ...settings.get().connections };
        connections[String(args.name)] = {
          driver: 'proxmox',
          host: String(args.host),
          ...(args.port !== undefined ? { port: Number(args.port) } : {}),
          ...(args.user !== undefined ? { user: String(args.user) } : {}),
          ...(args.tokenId !== undefined ? { tokenId: String(args.tokenId) } : {}),
          ...(args.tokenSecret !== undefined ? { tokenSecret: String(args.tokenSecret) } : {}),
          ...(args.insecureTls ? { tls: { rejectUnauthorized: false } } : {}),
        };
        settings.save({ connections });
        return { text: `Connection "${args.name}" saved to ${settings.location()}.` };
      },
    },
    {
      name: 'settings_export',
      title: 'Export settings',
      description:
        'Export MCP_SETTINGS.json for reuse on another machine — literal secrets are replaced with env-references.',
      tier: 'read',
      inputSchema: {
        path: z.string().optional().describe('Default: MCP_SETTINGS.export.json in cwd'),
      },
      handler: async (args) => {
        const target = resolve(String(args.path ?? 'MCP_SETTINGS.export.json'));
        writeFileSync(target, JSON.stringify(settings.exportable(), null, 2), 'utf8');
        return { text: `Exported sanitized settings to ${target}.` };
      },
    },
    {
      name: 'settings_import',
      title: 'Import settings',
      description: 'Import a previously exported MCP_SETTINGS.json (skips re-discovery).',
      tier: 'write',
      inputSchema: { path: z.string() },
      handler: async (args) => {
        const raw = JSON.parse(readFileSync(resolve(String(args.path)), 'utf8'));
        settings.save(raw);
        return { text: `Imported settings from ${args.path} into ${settings.location()}.` };
      },
    },
    {
      name: 'project_check',
      title: 'Check project readiness',
      description:
        'Read PROJECT_CONFIG.md in a project folder and check its needs against the discovered environment. Reports gaps, does not fix them.',
      tier: 'read',
      inputSchema: { dir: z.string().describe('Project folder containing PROJECT_CONFIG.md') },
      handler: async (args) => {
        const dir = resolve(String(args.dir));
        const configPath = join(dir, 'PROJECT_CONFIG.md');
        if (!existsSync(configPath)) {
          return { text: `No PROJECT_CONFIG.md in ${dir} — run the scaffold first.`, isError: true };
        }
        const config = parseProjectConfig(readFileSync(configPath, 'utf8'));
        if (!config) {
          return { text: 'PROJECT_CONFIG.md has no valid vo-config marker.', isError: true };
        }
        const d = settings.get().discovery;
        if (!d) {
          return { text: 'No cached discovery — run env_discover first.', isError: true };
        }
        const gaps: string[] = [];
        const oks: string[] = [];
        const { answers } = config;

        const langRuntime: Record<string, string> = {
          javascript: 'node', python: 'python', rust: 'cargo', go: 'go', java: 'java',
        };
        const needed = langRuntime[answers.language];
        if (needed) {
          const found = d.runtimes.find((r) => r.name === needed);
          if (found) oks.push(`${answers.language} runtime present (${found.version})`);
          else gaps.push(`${answers.language} runtime missing — install ${needed}`);
        }
        if (answers.virtualization === 'docker') {
          if (d.containers.docker) oks.push(`docker ${d.containers.docker}`);
          else gaps.push('project expects Docker but no running daemon was found');
        }
        if (answers.virtualization === 'hypervisor') {
          const reachable = d.hypervisors.filter((h) => h.reachable && h.connection !== '(local)');
          if (reachable.length) {
            oks.push(`hypervisor reachable: ${reachable.map((h) => h.connection).join(', ')}`);
          } else {
            gaps.push(
              'project expects a hypervisor but no configured connection is reachable — use connection_add, then env_discover',
            );
          }
        }
        const gitFound = d.runtimes.some((r) => r.name === 'git');
        if (gitFound) oks.push('git present');
        else gaps.push('git missing');

        const verdict = gaps.length === 0 ? 'READY' : 'GAPS FOUND';
        return {
          text: `${verdict} for "${answers.description}"\n\nOK:\n${oks.map((s) => `  ✓ ${s}`).join('\n') || '  (none)'}\n\nGaps:\n${gaps.map((s) => `  ✗ ${s}`).join('\n') || '  (none)'}`,
          data: { ready: gaps.length === 0, oks, gaps, answers },
        };
      },
    },
    {
      name: 'scaffold_write',
      title: 'Write scaffolding files',
      description:
        'Write project files (folder structure, starter files) into a project directory. Refuses paths that escape the directory; skips existing files unless overwrite is true.',
      tier: 'write',
      inputSchema: {
        dir: z.string(),
        files: z.array(z.object({ path: z.string(), content: z.string() })),
        overwrite: z.boolean().optional(),
      },
      handler: async (args) => {
        const dir = resolve(String(args.dir));
        const files = args.files as Array<{ path: string; content: string }>;
        const written: string[] = [];
        const skipped: string[] = [];
        for (const file of files) {
          const target = resolve(dir, file.path);
          const rel = relative(dir, target);
          if (rel.startsWith('..') || isAbsolute(rel)) {
            return { text: `Refused: "${file.path}" escapes the project directory.`, isError: true };
          }
          if (existsSync(target) && args.overwrite !== true) {
            skipped.push(file.path);
            continue;
          }
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, file.content, 'utf8');
          written.push(file.path);
        }
        return {
          text: `Wrote ${written.length} file(s)${skipped.length ? `, skipped ${skipped.length} existing` : ''}.`,
          data: { written, skipped },
        };
      },
    },
    {
      name: 'run_install',
      title: 'Run install command',
      description:
        `Run a dependency-install command in a project directory. Allowed commands start with: ${INSTALL_ALLOWLIST.join(', ')}. Dev-environment readiness only — this is not a general shell.`,
      tier: 'write',
      inputSchema: {
        dir: z.string(),
        command: z.string().describe('e.g. "npm install" or "pip install -r requirements.txt"'),
      },
      handler: async (args) => {
        const command = String(args.command).trim();
        const first = command.split(/\s+/)[0]?.toLowerCase() ?? '';
        if (!INSTALL_ALLOWLIST.includes(first)) {
          return {
            text: `Refused: "${first}" is not an allowed installer. Allowed: ${INSTALL_ALLOWLIST.join(', ')}.`,
            isError: true,
          };
        }
        const dir = resolve(String(args.dir));
        if (!existsSync(dir)) {
          return { text: `Directory does not exist: ${dir}`, isError: true };
        }
        const { code, output } = await runShell(command, dir);
        const tail = output.length > 4000 ? `…${output.slice(-4000)}` : output;
        return {
          text: `\`${command}\` exited with code ${code}.\n\n${tail}`,
          data: { code, outputTail: tail },
          isError: code !== 0,
        };
      },
    },
  ];
}
