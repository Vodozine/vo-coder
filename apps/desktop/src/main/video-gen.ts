import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import type { ToolSpec } from '@vo-coder/providers';
import type { ConfigStore } from './config';
import type { SecretStore } from './secrets';
import { guardedTarget } from './image-gen';

/**
 * video_generate — the moving-picture sibling of image_generate, and the same
 * bargain: the mp4 lands on disk, only the PATH travels through the
 * conversation, and the bytes reach the UI by side-channel.
 *
 * What makes video different from images is that nobody answers immediately.
 * Both providers take a prompt, hand back a job id, and finish minutes later,
 * so this is create → poll → fetch rather than one request:
 *
 *   xai    POST /v1/videos/generations  → {request_id}
 *          GET  /v1/videos/{id}         → {status, video:{url}}   then download
 *   openai POST /v1/videos              → {id, status}
 *          GET  /v1/videos/{id}         → {status, progress}
 *          GET  /v1/videos/{id}/content → the mp4 itself
 */

/** Long enough for a 15s clip on a busy day; the tool reports back either way. */
const DEADLINE_MS = 10 * 60_000;
const POLL_MS = 4_000;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

export function videoToolSpecs(): ToolSpec[] {
  return [
    {
      name: 'video_generate',
      description:
        'Generate a short video with the configured video model (Settings → Video model). Takes ' +
        'minutes, not seconds. Saves an .mp4 into the project folder and shows it in chat. Use for ' +
        'clips, animated mockups, motion tests — not for stills (use image_generate).',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'What happens in the shot — describe motion, camera and subject',
          },
          save_as: {
            type: 'string',
            description: 'Relative path, e.g. designs/intro.mp4 (default: designs/vid-<time>.mp4)',
          },
          seconds: { type: 'number', description: 'Clip length in seconds (default 6)' },
          aspect_ratio: {
            type: 'string',
            description: '16:9 (default), 9:16, 1:1, 4:3, 3:4, 3:2 or 2:3',
          },
          resolution: { type: 'string', description: '480p, 720p (default) or 1080p' },
        },
        required: ['prompt'],
      },
    },
  ];
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('Cancelled.'));
      },
      { once: true },
    );
  });

/** xAI wants "16:9"; OpenAI wants pixels. One knob, two dialects. */
function openAiSize(aspect: string, resolution: string): string {
  const short = resolution === '1080p' ? 1080 : resolution === '480p' ? 480 : 720;
  const [w, h] = aspect.split(':').map(Number);
  if (!w || !h) return `${Math.round((short * 16) / 9)}x${short}`;
  return w >= h
    ? `${Math.round((short * w) / h)}x${short}`
    : `${short}x${Math.round((short * h) / w)}`;
}

export interface VideoToolAuth {
  /** xAI OAuth bearer (SuperGrok) — preferred over the API key when present. */
  xaiToken?: () => string | null;
}

export async function executeVideoTool(
  args: unknown,
  config: ConfigStore,
  secrets: SecretStore,
  projectDir: string | undefined,
  auth: VideoToolAuth = {},
  signal?: AbortSignal,
): Promise<{ content: string; isError?: boolean; videoPath?: string }> {
  const a = (args ?? {}) as Record<string, unknown>;
  const prompt = String(a.prompt ?? '').trim();
  if (!prompt) return { content: 'No prompt given.', isError: true };

  const pointer = config.get().videoModel;
  if (!pointer) {
    return {
      content:
        'No video model configured — set one under Settings → Video model (xAI Grok Imagine or ' +
        'OpenAI Sora).',
      isError: true,
    };
  }
  const provider = pointer.provider;
  const key =
    provider === 'xai' ? (auth.xaiToken?.() ?? secrets.get('xai')) : secrets.get(provider);
  if (!key) {
    return {
      content:
        provider === 'xai'
          ? 'No xAI credentials — add an API key or sign in with X under Settings.'
          : `No API key saved for ${provider}.`,
      isError: true,
    };
  }

  const seconds = Math.max(1, Math.min(20, Math.round(Number(a.seconds) || 6)));
  const aspect = String(a.aspect_ratio ?? '16:9');
  const resolution = String(a.resolution ?? '720p');
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

  // The caller's Stop must reach a job that is minutes long, and the deadline
  // must not outlive it either — one controller does both.
  const ctl = new AbortController();
  const onOuterAbort = () => ctl.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  const deadline = setTimeout(() => ctl.abort(), DEADLINE_MS);

  const failed = (why: string) => ({ content: why, isError: true });
  // Hoisted so the catch can say what the job was doing when time ran out.
  let lastStatus = '';

  try {
    const base = provider === 'xai' ? 'https://api.x.ai/v1' : 'https://api.openai.com/v1';
    const createUrl = provider === 'xai' ? `${base}/videos/generations` : `${base}/videos`;
    const body =
      provider === 'xai'
        ? { model: pointer.model, prompt, duration: seconds, aspect_ratio: aspect, resolution }
        : {
            model: pointer.model,
            prompt,
            seconds: String(seconds),
            size: openAiSize(aspect, resolution),
          };

    const created = await fetch(createUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!created.ok) {
      const detail = await created.text().catch(() => '');
      return failed(`Video model returned ${created.status}: ${detail.slice(0, 300)}`);
    }
    const job = (await created.json()) as { request_id?: string; id?: string; error?: unknown };
    const jobId = job.request_id ?? job.id;
    if (!jobId) return failed(`"${pointer.model}" returned no job id — is it a video model?`);

    // Poll. Both APIs answer with a status word; only the vocabulary differs.
    let mp4: Buffer | null = null;
    for (;;) {
      await sleep(POLL_MS, ctl.signal);
      const res = await fetch(`${base}/videos/${jobId}`, { headers, signal: ctl.signal });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return failed(`Polling the job returned ${res.status}: ${detail.slice(0, 200)}`);
      }
      const state = (await res.json()) as {
        status?: string;
        progress?: number;
        video?: { url?: string };
        error?: { message?: string };
      };
      lastStatus = String(state.status ?? '');
      if (lastStatus === 'failed' || lastStatus === 'expired') {
        return failed(
          `Generation ${lastStatus}${state.error?.message ? `: ${state.error.message}` : '.'}`,
        );
      }
      if (lastStatus === 'done' || lastStatus === 'completed') {
        // xAI hands back a temporary URL; OpenAI serves the bytes itself.
        const from =
          state.video?.url ??
          (provider === 'openai' ? `${base}/videos/${jobId}/content` : undefined);
        if (!from) return failed('The job finished but carried no video.');
        const dl = await fetch(from, {
          headers: from.startsWith(base) ? headers : {},
          signal: ctl.signal,
        });
        if (!dl.ok) return failed(`Downloading the video returned ${dl.status}.`);
        mp4 = Buffer.from(await dl.arrayBuffer());
        break;
      }
    }

    if (!mp4?.length) return failed('The video came back empty.');
    if (mp4.length > MAX_VIDEO_BYTES) return failed('Generated video exceeds the 200 MB cap.');

    const target = guardedTarget(
      projectDir,
      a.save_as ? String(a.save_as) : undefined,
      'mp4',
      'vid',
    );
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, mp4);
    const where = projectDir ? relative(projectDir, target) : target;
    return {
      content:
        `Video generated (${seconds}s, ` +
        `${mp4.length >= 1024 * 1024 ? `${(mp4.length / 1024 / 1024).toFixed(1)} MB` : `${Math.round(mp4.length / 1024)} KB`})` +
        ` and saved to ${where}.`,
      videoPath: target,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // An abort here is either the user's Stop or the deadline — say which.
    if (/abort|cancel/i.test(msg)) {
      return failed(
        signal?.aborted
          ? 'Video generation cancelled.'
          : `Gave up waiting after ${DEADLINE_MS / 60_000} minutes` +
              `${lastStatus ? ` — the job was still "${lastStatus}"` : ''}. It may still finish on the provider's side.`,
      );
    }
    return failed(`Video generation failed: ${msg}`);
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}
