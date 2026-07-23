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

function guardedTarget(dir: string | undefined, saveAs: string | undefined): string {
  const base = dir ?? join(app.getPath('userData'), 'generated');
  const rel = (saveAs?.trim() || `designs/img-${Date.now().toString(36)}.png`).replace(/^[/\\]+/, '');
  const target = resolve(base, rel);
  const back = relative(base, target);
  if (back.startsWith('..') || isAbsolute(back)) {
    throw new Error(`save_as "${saveAs}" escapes the project folder.`);
  }
  return target;
}

/** Pull image bytes out of the various OpenAI-compatible response shapes. */
function extractImage(json: unknown): { data: Buffer; note: string } | null {
  const msg = (json as { choices?: Array<{ message?: Record<string, unknown> }> }).choices?.[0]
    ?.message;
  if (!msg) return null;
  const note = typeof msg.content === 'string' ? msg.content.trim() : '';
  const images = msg.images as
    | Array<{ image_url?: { url?: string }; b64_json?: string }>
    | undefined;
  const url = images?.[0]?.image_url?.url ?? images?.[0]?.b64_json;
  if (!url) return null;
  const b64 = url.startsWith('data:') ? url.slice(url.indexOf(',') + 1) : url;
  try {
    return { data: Buffer.from(b64, 'base64'), note };
  } catch {
    return null;
  }
}

export async function executeImageTool(
  args: unknown,
  config: ConfigStore,
  secrets: SecretStore,
  projectDir: string | undefined,
): Promise<{ content: string; isError?: boolean; imagePath?: string }> {
  const a = (args ?? {}) as Record<string, unknown>;
  const prompt = String(a.prompt ?? '').trim();
  if (!prompt) return { content: 'No prompt given.', isError: true };

  const pointer = config.get().imageModel;
  if (!pointer) {
    return {
      content:
        'No image model configured — set one under Settings → Image model (an image-output model, ' +
        'e.g. an OpenRouter image model).',
      isError: true,
    };
  }
  const baseUrl =
    pointer.provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1'
      : pointer.provider === 'openai'
        ? 'https://api.openai.com/v1'
        : null;
  const key = secrets.get(pointer.provider);
  if (!baseUrl) {
    return { content: `Image generation via "${pointer.provider}" is not supported yet — use openrouter or openai.`, isError: true };
  }
  if (!key) return { content: `No API key saved for ${pointer.provider}.`, isError: true };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
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
    const image = extractImage(await res.json());
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
