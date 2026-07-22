import { execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { app } from 'electron';

const pExecFile = promisify(execFile);

/** Multilingual base model (~142 MB) — good accuracy/speed balance on CPU. */
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
const RELEASE_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest';

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
  await pipeline(
    Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(dest),
  );
}

function findWhisperExe(dir: string): string | null {
  const names = ['whisper-cli.exe', 'main.exe', 'whisper-cli', 'main'];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (names.includes(entry.name.toLowerCase())) return path;
    }
  }
  return null;
}

/**
 * One-click whisper.cpp setup: official prebuilt Windows binary from the
 * latest release + the ggml-base model, into userData/whisper. Everything is
 * a spawned external binary — never a native Node module.
 */
export async function setupWhisper(): Promise<{ binaryPath: string; modelPath: string }> {
  const dir = join(app.getPath('userData'), 'whisper');
  mkdirSync(dir, { recursive: true });

  const modelPath = join(dir, 'ggml-base.bin');
  if (!existsSync(modelPath) || statSync(modelPath).size < 100_000_000) {
    await download(MODEL_URL, modelPath);
  }

  let binaryPath = findWhisperExe(dir);
  if (!binaryPath) {
    if (process.platform === 'win32') {
      const release = await fetch(RELEASE_API, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'vo-coder' },
      });
      if (!release.ok) {
        throw new Error(`GitHub API ${release.status} while looking up the whisper.cpp release.`);
      }
      const json = (await release.json()) as {
        assets?: Array<{ name: string; browser_download_url: string }>;
      };
      const asset =
        json.assets?.find((a) => /whisper-bin-x64\.zip$/i.test(a.name)) ??
        json.assets?.find((a) => /bin.*x64.*\.zip$/i.test(a.name));
      if (!asset) {
        throw new Error(
          'No Windows binary in the latest whisper.cpp release — install it manually and set the path in Settings → Voice.',
        );
      }
      const zipPath = join(dir, 'whisper.zip');
      await download(asset.browser_download_url, zipPath);
      await pExecFile(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${dir}" -Force`,
        ],
        { windowsHide: true, timeout: 180_000 },
      );
      binaryPath = findWhisperExe(dir);
      if (!binaryPath) throw new Error('Extracted whisper.cpp but found no CLI executable.');
    } else {
      try {
        const { stdout } = await pExecFile('which', ['whisper-cli']);
        binaryPath = stdout.trim().split('\n')[0] || null;
      } catch {
        /* not on PATH */
      }
      if (!binaryPath) {
        throw new Error(
          'Install whisper.cpp first (e.g. brew install whisper-cpp), then set the binary path in Settings → Voice.',
        );
      }
    }
  }
  return { binaryPath, modelPath };
}
