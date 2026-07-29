#!/usr/bin/env node
/**
 * Launch the real Vo-Coder Electron desktop shell for interactive preview.
 *
 * This is the ONLY supported "start a preview" path for the Vo-Coder app itself.
 * Do NOT start a browser-only Vite server of the renderer — that is not the app
 * (no main process, no IPC, no preload) and will look like a broken web page.
 *
 * Usage (from repo root):
 *   npm run preview              # isolated profile (safe next to installed app)
 *   npm run preview -- --real    # normal userData (fails if another instance holds the lock)
 *   npm run preview -- --stop    # stop a previous agent-started preview, then exit
 *   npm run preview -- --restart # stop previous, then start fresh
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const isWin = platform() === 'win32';
const STATE_DIR = join(tmpdir(), 'vo-coder-dev-preview');
const PID_FILE = join(STATE_DIR, 'preview.pid');
const LOG_FILE = join(STATE_DIR, 'preview.log');
const USERDATA_DIR = join(STATE_DIR, 'userdata');

const args = new Set(process.argv.slice(2));
const wantStop = args.has('--stop') || args.has('--restart');
const wantStart = !args.has('--stop');
const realProfile = args.has('--real');

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function stopPrevious() {
  // Prefer the pid we recorded for an agent-started preview.
  if (existsSync(PID_FILE)) {
    try {
      const raw = readFileSync(PID_FILE, 'utf8').trim();
      const pid = Number(raw);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          if (isWin) {
            execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
          } else {
            process.kill(pid, 'SIGTERM');
          }
          log(`Stopped previous preview (pid ${pid}).`);
        } catch {
          // already dead
        }
      }
    } catch {
      // ignore
    }
    try {
      unlinkSync(PID_FILE);
    } catch {
      // ignore
    }
  }

  // Also sweep leftover electron-vite / mistaken browser-only vite.preview runs
  // that agents started in earlier sessions (Windows).
  if (isWin) {
    try {
      execSync(
        `powershell -NoProfile -Command "` +
          `$p = Get-CimInstance Win32_Process | Where-Object { ` +
          `$_.CommandLine -and ( ` +
          `$_.CommandLine -match 'electron-vite' -or ` +
          `$_.CommandLine -match 'vite\\.preview\\.config' -or ` +
          `($_.CommandLine -match 'vo-coder-dev-preview' -and $_.Name -match 'node|electron') ` +
          `) }; ` +
          `foreach ($x in $p) { try { Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }` +
          `"`,
        { stdio: 'ignore' },
      );
    } catch {
      // ignore sweep failures
    }
  }
}

function start() {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(USERDATA_DIR, { recursive: true });

  const env = { ...process.env };
  if (!realProfile) {
    env.VO_USERDATA = USERDATA_DIR;
    log(`VO_USERDATA=${USERDATA_DIR}`);
    log('(isolated profile — use --real for your normal app data)');
  } else {
    log('Using normal Electron userData (single-instance lock applies).');
  }

  // Detach so this script can exit and leave the Electron shell running.
  // On Windows, shell:true + npm.cmd is the reliable path for workspace scripts.
  const npmCmd = isWin ? 'npm.cmd' : 'npm';
  const child = spawn(npmCmd, ['run', 'dev'], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
    shell: isWin,
  });

  const logStreamHints = [];
  const onChunk = (buf) => {
    const s = buf.toString();
    logStreamHints.push(s);
    try {
      writeFileSync(LOG_FILE, logStreamHints.join(''), { flag: 'a' });
    } catch {
      // ignore
    }
  };
  // Truncate log for this run
  try {
    writeFileSync(LOG_FILE, '');
  } catch {
    // ignore
  }
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);

  writeFileSync(PID_FILE, String(child.pid ?? ''), 'utf8');
  child.unref();

  log(`Started Vo-Coder Electron shell (npm run dev), pid ${child.pid}.`);
  log(`Log: ${LOG_FILE}`);
  log('A native desktop window should open — not a browser tab.');
}

if (wantStop) stopPrevious();
if (wantStart) start();
if (!wantStart && !wantStop) {
  log('Nothing to do. Pass nothing (start), --stop, or --restart.');
  process.exit(1);
}
