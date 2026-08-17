import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { app } from 'electron';
import type { ToolSpec } from '@vo-coder/providers';
import type { ConfigStore } from './config';
import type { SecretStore } from './secrets';
import { falRun, replicateRun } from './media-aggregators';

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
 *   gemini              — native :generateContent with an IMAGE response
 *                         modality (nano banana / gemini-*-image). The OpenAI
 *                         /images/generations path is Imagen-only and answers
 *                         text-only for these models — the tool "succeeds" but
 *                         no picture comes back — so we call generateContent.
 *
 * Note: Grok Imagine often returns JPEG bytes even when save_as ends in .png.
 * We re-encode to real PNG on save so cutout keying and imageRead work.
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

/** Pull image bytes from a native Gemini :generateContent response. */
function extractGeminiImage(json: unknown): { data: Buffer; note: string } | null {
  const parts =
    (json as { candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }> })
      .candidates?.[0]?.content?.parts ?? [];
  let note = '';
  for (const p of parts) {
    // REST returns camelCase (inlineData); tolerate snake_case just in case.
    const inline = (p.inlineData ?? p.inline_data) as { data?: string } | undefined;
    if (inline?.data) return decodeImagePayload(inline.data, note);
    if (typeof p.text === 'string' && p.text.trim()) note = p.text.trim();
  }
  return null;
}

/**
 * Actionable text for a Gemini image 429. The catch that traps everyone: chat
 * and image quotas are separate buckets, and Nano Banana PRO has a free tier of
 * exactly zero — a free key 429s on the first call, no "credits" ever spent.
 */
function geminiQuotaMessage(modelId: string): string {
  const proImage = /gemini-3.*image|image.*preview/i.test(modelId);
  return proImage
    ? `Gemini returned 429 (quota exceeded). "${modelId}" (Nano Banana Pro) has NO free API ` +
        `tier — a free key gets zero image quota, so it fails on the first call even while ` +
        `Gemini chat still works (separate bucket). In Settings → Image model, switch to ` +
        `Nano Banana (gemini-2.5-flash-image), which has a free daily quota, or enable billing ` +
        `on your Google AI Studio account to use this one (~$0.13/image).`
    : `Gemini returned 429 — the free daily image quota for "${modelId}" is used up. Wait for ` +
        `the daily reset, enable billing, or switch to another image provider (e.g. Grok Imagine).`;
}

/** A human reason when Gemini returns 200 but no image part (safety / text-only). */
function geminiNoImageReason(json: unknown, model: string): string {
  const j = json as {
    candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
    promptFeedback?: { blockReason?: string };
  };
  const cand = j.candidates?.[0];
  const reason = cand?.finishReason ?? j.promptFeedback?.blockReason;
  if (reason && /SAFETY|PROHIBITED|BLOCK/i.test(reason)) {
    return `Gemini blocked that prompt (${reason}). Try rewording it.`;
  }
  const text = cand?.content?.parts?.find((p) => typeof p.text === 'string')?.text;
  return (
    `"${model}" returned no image` +
    (text ? ` — it replied: "${text.slice(0, 200)}"` : '') +
    '. Make sure the Image model is a gemini-*-image model (Nano Banana).'
  );
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
  const needsKey = provider !== 'a1111'; // a local Stable Diffusion server has no auth
  const key =
    provider === 'xai'
      ? (auth.xaiToken?.() ?? secrets.get('xai'))
      : provider === 'custom'
        ? secrets.get('image-custom')
        : secrets.get(provider);
  if (needsKey && !key) {
    return {
      content:
        provider === 'xai'
          ? 'No xAI credentials — add an API key or sign in with X under Settings.'
          : provider === 'custom'
            ? 'No key saved for the custom image endpoint — add it under Settings → Image model.'
            : `No API key saved for ${provider}.`,
      isError: true,
    };
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let image: { data: Buffer; note: string } | null = null;

    if (provider === 'xai') {
      // Grok Imagine serves the classic /images/generations API.
      const res = await fetch('https://api.x.ai/v1/images/generations', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: pointer.model, prompt, response_format: 'b64_json', n: 1 }),
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
    } else if (provider === 'gemini') {
      // Nano banana renders through native :generateContent with an IMAGE
      // response modality — the OpenAI /images path is Imagen-only and answers
      // text-only here. /models lists ids as "models/…"; the call takes the
      // bare id. Both TEXT and IMAGE must be requested or it defaults to text.
      const modelId = pointer.model.replace(/^models\//, '');
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': key ?? '', 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
          }),
          signal: ctl.signal,
        },
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        if (res.status === 429) return { content: geminiQuotaMessage(modelId), isError: true };
        return { content: `Image model returned ${res.status}: ${detail.slice(0, 300)}`, isError: true };
      }
      const json = await res.json();
      image = extractGeminiImage(json);
      if (!image) return { content: geminiNoImageReason(json, pointer.model), isError: true };
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
    } else if (provider === 'custom') {
      // Any OpenAI-images-compatible endpoint (Together, DeepInfra, LocalAI,
      // self-hosted, an OpenAI proxy). Base URL is the ".../v1" root.
      const base = (pointer.baseUrl ?? '').replace(/\/+$/, '');
      if (!base) {
        return { content: 'Set the base URL for the custom image endpoint in Settings.', isError: true };
      }
      const res = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: pointer.model, prompt, response_format: 'b64_json', n: 1 }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { content: `Image endpoint returned ${res.status}: ${detail.slice(0, 300)}`, isError: true };
      }
      const json = await res.json();
      image = extractImagesApi(json);
      if (!image) {
        const url = (json as { data?: Array<{ url?: string }> }).data?.[0]?.url;
        if (url) {
          const buf = await downloadUrl(url, ctl.signal);
          if (buf) image = { data: buf, note: '' };
        }
      }
    } else if (provider === 'a1111') {
      // Local Stable Diffusion — AUTOMATIC1111 / Forge / SD.Next share this API.
      // One synchronous call; the image comes back base64 in images[0].
      const base = (pointer.baseUrl ?? 'http://127.0.0.1:7860').replace(/\/+$/, '');
      const res = await fetch(`${base}/sdapi/v1/txt2img`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt,
          steps: 28,
          ...(pointer.model ? { override_settings: { sd_model_checkpoint: pointer.model } } : {}),
        }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return {
          content: `Local image server returned ${res.status}: ${detail.slice(0, 200)} — is Stable Diffusion running with --api at ${base}?`,
          isError: true,
        };
      }
      const json = (await res.json()) as { images?: string[] };
      const b64 = json.images?.[0];
      if (b64) {
        image = { data: Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64'), note: '' };
      }
    } else if (provider === 'fal') {
      image = { data: await falRun(pointer.model, { prompt }, key ?? '', ctl.signal), note: '' };
    } else if (provider === 'replicate') {
      image = { data: await replicateRun(pointer.model, { prompt }, key ?? '', ctl.signal), note: '' };
    } else {
      return {
        content: `Image generation via "${provider}" is not supported yet — use xai, gemini, openrouter, openai, custom, a1111, fal, or replicate.`,
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

/** Which editing features the configured provider actually offers. */
export function imageEditCapabilities(provider: string): {
  supported: boolean;
  mask: boolean;
  note: string;
} {
  if (provider === 'openai') {
    return {
      supported: true,
      mask: true,
      note: 'Masked inpainting supported. Note that GPT image models treat the mask as a soft hint and re-render the whole frame, so untouched areas can shift slightly.',
    };
  }
  if (provider === 'xai') {
    return {
      supported: true,
      mask: false,
      note: 'Grok Imagine edits by prompt only — describe the change ("remove the typewriter") rather than masking it.',
    };
  }
  if (provider === 'openrouter') {
    return {
      supported: true,
      mask: false,
      note: 'OpenRouter takes the picture as a reference image; describe the change in the prompt.',
    };
  }
  if (provider === 'gemini') {
    return {
      supported: true,
      mask: false,
      note: 'Gemini (nano banana) edits by prompt with your picture as reference — describe the change rather than masking it.',
    };
  }
  return { supported: false, mask: false, note: `Editing via "${provider}" is not supported.` };
}

/** data:...;base64,xxx  ->  { mime, buffer } */
/** Image mime from magic bytes — providers routinely mislabel what they send. */
function sniffImageMime(bytes: Buffer): string {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/png';
}

function splitDataUrl(dataUrl: string): { mime: string; buffer: Buffer } | null {
  const m = /^data:([^;,]+)(?:;base64)?,(.*)$/s.exec(String(dataUrl ?? ''));
  if (!m) return null;
  try {
    return { mime: m[1]!, buffer: Buffer.from(m[2]!, 'base64') };
  } catch {
    return null;
  }
}

export interface ImageEditRequest {
  prompt: string;
  /** The picture to change, as a data URL. */
  imageDataUrl: string;
  /** Optional PNG mask (transparent where the image should change). OpenAI only. */
  maskDataUrl?: string;
}

/**
 * Edit an existing image with the configured image model. Returns the new
 * picture as a data URL — the caller decides where it lands.
 */
export async function editImage(
  req: ImageEditRequest,
  config: ConfigStore,
  secrets: SecretStore,
  auth: ImageToolAuth = {},
): Promise<{ ok: true; dataUrl: string; note?: string } | { ok: false; error: string }> {
  const prompt = String(req.prompt ?? '').trim();
  if (!prompt) return { ok: false, error: 'No prompt given.' };

  const pointer = config.get().imageModel;
  if (!pointer) {
    return {
      ok: false,
      error:
        'No image model configured — set one under Settings → Image model (an image-output model).',
    };
  }
  const provider = pointer.provider;
  const caps = imageEditCapabilities(provider);
  if (!caps.supported) return { ok: false, error: caps.note };

  const key =
    provider === 'xai' ? (auth.xaiToken?.() ?? secrets.get('xai')) : secrets.get(provider);
  if (!key) {
    return {
      ok: false,
      error:
        provider === 'xai'
          ? 'No xAI credentials — add an API key or sign in with X under Settings.'
          : `No API key saved for ${provider}.`,
    };
  }

  const source = splitDataUrl(req.imageDataUrl);
  if (!source) return { ok: false, error: 'The picture could not be read.' };
  if (source.buffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, error: 'Source image exceeds the 20 MB cap.' };
  }
  if (req.maskDataUrl && !caps.mask) {
    return {
      ok: false,
      error: `${provider} cannot use a mask. ${caps.note}`,
    };
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let image: { data: Buffer; note: string } | null = null;

    if (provider === 'openai') {
      // Multipart: the only provider that takes a real inpainting mask.
      const form = new FormData();
      form.set('model', pointer.model);
      form.set('prompt', prompt);
      form.set(
        'image',
        new Blob([new Uint8Array(source.buffer)], { type: source.mime || 'image/png' }),
        'image.png',
      );
      if (req.maskDataUrl) {
        const mask = splitDataUrl(req.maskDataUrl);
        if (!mask) return { ok: false, error: 'The mask could not be read.' };
        form.set(
          'mask',
          new Blob([new Uint8Array(mask.buffer)], { type: 'image/png' }),
          'mask.png',
        );
      }
      const res = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        body: form,
        signal: ctl.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, error: `Image edit returned ${res.status}: ${detail.slice(0, 300)}` };
      }
      const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
      image = extractImagesApi(json);
      // dall-e-2 (and any model configured to return links) answers with a URL.
      if (!image && json.data?.[0]?.url) {
        const bytes = await downloadUrl(json.data[0].url!, ctl.signal);
        if (bytes) image = { data: bytes, note: '' };
      }
    } else if (provider === 'xai') {
      // JSON only — the docs are explicit that multipart is not accepted.
      const res = await fetch('https://api.x.ai/v1/images/edits', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: pointer.model,
          prompt,
          image: { type: 'image_url', url: req.imageDataUrl },
          response_format: 'b64_json',
        }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, error: `Image edit returned ${res.status}: ${detail.slice(0, 300)}` };
      }
      const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
      image = extractImagesApi(json);
      if (!image) {
        const url = json.data?.[0]?.url;
        if (url) {
          const bytes = await downloadUrl(url, ctl.signal);
          if (bytes) image = { data: bytes, note: '' };
        }
      }
    } else if (provider === 'gemini') {
      // Same native :generateContent call as generation, plus the source image
      // as an inlineData part — nano banana treats it as the picture to change.
      const modelId = pointer.model.replace(/^models\//, '');
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': key ?? '', 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  { text: prompt },
                  {
                    inlineData: {
                      mimeType: source.mime || 'image/png',
                      data: source.buffer.toString('base64'),
                    },
                  },
                ],
              },
            ],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
          }),
          signal: ctl.signal,
        },
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, error: `Image edit returned ${res.status}: ${detail.slice(0, 300)}` };
      }
      image = extractGeminiImage(await res.json());
    } else {
      // OpenRouter's images endpoint takes the source as a reference image.
      const res = await fetch('https://openrouter.ai/api/v1/images', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: pointer.model,
          prompt,
          input_references: [
            { type: 'image_url', image_url: { url: req.imageDataUrl } },
          ],
        }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, error: `Image edit returned ${res.status}: ${detail.slice(0, 300)}` };
      }
      const json = (await res.json()) as {
        data?: Array<{ b64_json?: string; media_type?: string; url?: string }>;
      };
      const first = json.data?.[0];
      if (first?.b64_json) {
        image = { data: Buffer.from(first.b64_json, 'base64'), note: '' };
      } else if (first?.url) {
        const bytes = await downloadUrl(first.url, ctl.signal);
        if (bytes) image = { data: bytes, note: '' };
      }
    }

    if (!image) {
      return { ok: false, error: `"${pointer.model}" returned no image for that edit.` };
    }
    if (image.data.length > MAX_IMAGE_BYTES) {
      return { ok: false, error: 'Edited image exceeds the 20 MB cap.' };
    }
    return {
      ok: true,
      // Sniffed, not assumed: Grok returns JPEG bytes for an "edit", and a
      // data URL that lies about its type is rejected by the next provider it
      // is fed back into.
      dataUrl: `data:${sniffImageMime(image.data)};base64,${image.data.toString('base64')}`,
      ...(image.note ? { note: image.note } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: /abort/i.test(msg) ? 'Image edit timed out.' : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}
