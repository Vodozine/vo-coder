import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { app } from 'electron';
import type { ToolSpec } from '@vo-coder/providers';
import type { ConfigStore } from './config';
import type { SecretStore } from './secrets';

/**
 * image_generate: the door back in for image-OUTPUT models (which routing
 * rightly refuses to give chat turns to). The designated image model renders
 * the prompt; the PNG lands on disk — in the project's designs/ folder when
 * the session has one — and only the PATH travels through the conversation.
 * The pixels reach the UI via the imagePath side-channel, never the token
 * stream.
 *
 * Providers:
 *   openrouter / openai — chat/completions with modalities: ['image','text']
 *   xai                 — OpenAI-style /images/generations (Grok Imagine)
 */

const TIMEOUT_MS = 120_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function imageToolSpecs(): ToolSpec[] {
  return [
    {
      name: 'image_generate',
      description:
        'Generate an image with the configured image model (Settings → Image model). Saves into ' +
        "the project's designs/ folder (or a scratch folder without a project) and shows inline " +
        'in chat. Use for mockups, art, icons, textures, illustrations.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What to render — be visual and specific' },
          save_as: {
            type: 'string',
            description: 'Relative file path, e.g. designs/hero.png (default: designs/img-<time>.png)',
          },
        },
        required: ['prompt'],
      },
    },
  ];
}

/** Shared with video_generate: one place decides where generated media may land. */
export function guardedTarget(
  dir: string | undefined,
  saveAs: string | undefined,
  ext = 'png',
  prefix = 'img',
): string {
  const base = dir ?? join(app.getPath('userData'), 'generated');
  const rel = (saveAs?.trim() || `designs/${prefix}-${Date.now().toString(36)}.${ext}`).replace(
    /^[/\\]+/,
    '',
  );
  const target = resolve(base, rel);
  const back = relative(base, target);
  if (back.startsWith('..') || isAbsolute(back)) {
    throw new Error(`save_as "${saveAs}" escapes the project folder.`);
  }
  return target;
}

/** Pull image bytes out of chat/completions (OpenRouter image-output) shapes. */
function extractChatImage(json: unknown): { data: Buffer; note: string } | null {
  const msg = (json as { choices?: Array<{ message?: Record<string, unknown> }> }).choices?.[0]
    ?.message;
  if (!msg) return null;
  const note = typeof msg.content === 'string' ? msg.content.trim() : '';
  const images = msg.images as
    | Array<{ image_url?: { url?: string }; b64_json?: string }>
    | undefined;
  const url = images?.[0]?.image_url?.url ?? images?.[0]?.b64_json;
  if (!url) return null;
  return decodeImagePayload(url, note);
}

/** Pull image bytes from OpenAI/xAI /images/generations responses. */
function extractImagesApi(json: unknown): { data: Buffer; note: string } | null {
  const data = (json as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> })
    .data?.[0];
  if (!data) return null;
  const note = typeof data.revised_prompt === 'string' ? data.revised_prompt.trim() : '';
  if (data.b64_json) return decodeImagePayload(data.b64_json, note);
  if (data.url) return null; // caller downloads URL
  return null;
}

function decodeImagePayload(urlOrB64: string, note: string): { data: Buffer; note: string } | null {
  const b64 = urlOrB64.startsWith('data:') ? urlOrB64.slice(urlOrB64.indexOf(',') + 1) : urlOrB64;
  try {
    return { data: Buffer.from(b64, 'base64'), note };
  } catch {
    return null;
  }
}

async function downloadUrl(url: string, signal: AbortSignal): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

export interface ImageToolAuth {
  /** xAI OAuth bearer (SuperGrok) — preferred over the API key when present. */
  xaiToken?: () => string | null;
}

export async function executeImageTool(
  args: unknown,
  config: ConfigStore,
  secrets: SecretStore,
  projectDir: string | undefined,
  auth: ImageToolAuth = {},
): Promise<{ content: string; isError?: boolean; imagePath?: string }> {
  const a = (args ?? {}) as Record<string, unknown>;
  const prompt = String(a.prompt ?? '').trim();
  if (!prompt) return { content: 'No prompt given.', isError: true };

  const pointer = config.get().imageModel;
  if (!pointer) {
    return {
      content:
        'No image model configured — set one under Settings → Image model (an image-output model, ' +
        'e.g. xAI Grok Imagine or an OpenRouter image model).',
      isError: true,
    };
  }

  const provider = pointer.provider;
  const key =
    provider === 'xai'
      ? (auth.xaiToken?.() ?? secrets.get('xai'))
      : secrets.get(provider);
  if (!key) {
    return {
      content:
        provider === 'xai'
          ? 'No xAI credentials — add an API key or sign in with X under Settings.'
          : `No API key saved for ${provider}.`,
      isError: true,
    };
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let image: { data: Buffer; note: string } | null = null;

    if (provider === 'xai') {
      // Grok Imagine uses the classic images API, not chat modalities.
      const res = await fetch('https://api.x.ai/v1/images/generations', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: pointer.model,
          prompt,
          response_format: 'b64_json',
          n: 1,
        }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { content: `Image model returned ${res.status}: ${detail.slice(0, 300)}`, isError: true };
      }
      const json = await res.json();
      image = extractImagesApi(json);
      if (!image) {
        // Some responses return a temporary URL instead of b64.
        const url = (json as { data?: Array<{ url?: string }> }).data?.[0]?.url;
        if (url) {
          const buf = await downloadUrl(url, ctl.signal);
          if (buf) image = { data: buf, note: '' };
        }
      }
    } else if (provider === 'openrouter' || provider === 'openai') {
      const baseUrl =
        provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1';
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: pointer.model,
          messages: [{ role: 'user', content: prompt }],
          modalities: ['image', 'text'],
        }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { content: `Image model returned ${res.status}: ${detail.slice(0, 300)}`, isError: true };
      }
      image = extractChatImage(await res.json());
    } else {
      return {
        content: `Image generation via "${provider}" is not supported yet — use xai, openrouter, or openai.`,
        isError: true,
      };
    }

    if (!image) {
      return {
        content: `"${pointer.model}" returned no image — is it actually an image-generation model?`,
        isError: true,
      };
    }
    if (image.data.length > MAX_IMAGE_BYTES) {
      return { content: 'Generated image exceeds the 20 MB cap.', isError: true };
    }
    const target = guardedTarget(projectDir, a.save_as ? String(a.save_as) : undefined);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, image.data);
    const where = projectDir ? relative(projectDir, target) : target;
    return {
      content:
        `Image generated (${Math.round(image.data.length / 1024)} KB) and saved to ${where}.` +
        (image.note ? ` Model note: ${image.note.slice(0, 200)}` : ''),
      imagePath: target,
    };
  } catch (err) {
    return {
      content: `Image generation failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  } finally {
    clearTimeout(timer);
  }
}
