import { readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { AgentSpec, ToolSpec } from '@vo-coder/providers';
import type { ConfigStore } from './config';
import type { ProviderHub } from './providers';

/**
 * look_at_image: eyes-as-a-service. Tool results are text in every provider's
 * wire format, so a blind model can never receive pixels back from a tool —
 * instead this tool runs the image file through the configured VISION model
 * and returns its description as text. Any agent (sighted or not) can catalog
 * a folder of photos, read a screenshot, or review a design; the image itself
 * reaches the UI through the imagePath side-channel so the user watches the
 * photos scroll by next to their descriptions.
 */

const TIMEOUT_MS = 90_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** RAW containers can be huge (medium format) — only the preview is sent on. */
const MAX_RAW_BYTES = 120 * 1024 * 1024;
const MIN_PREVIEW_BYTES = 30_000;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Camera RAW dialects look_at_image can open via their embedded JPEG preview. */
export const RAW_EXTS = new Set([
  '.nef', '.nrw', '.cr2', '.cr3', '.crw', '.arw', '.srf', '.sr2', '.raf', '.orf',
  '.rw2', '.dng', '.pef', '.x3f', '.srw', '.3fr', '.fff', '.iiq', '.gpr', '.mrw',
  '.rwl', '.erf', '.kdc', '.dcr', '.mos', '.mef', '.raw',
]);

/**
 * Nearly every RAW file carries one or more complete JPEGs inside (EXIF thumb
 * + a big preview, often full-size). Scan for SOI/EOI marker pairs and keep
 * the largest plausible one — format-agnostic, no native RAW decoder needed.
 */
export function extractJpegPreview(buf: Buffer): Buffer | null {
  const SOI = Buffer.from([0xff, 0xd8, 0xff]);
  const EOI = Buffer.from([0xff, 0xd9]);
  let best: Buffer | null = null;
  let from = 0;
  for (let i = 0; i < 12; i++) {
    const start = buf.indexOf(SOI, from);
    if (start === -1) break;
    const end = buf.indexOf(EOI, start + 3);
    if (end !== -1) {
      const candidate = buf.subarray(start, end + 2);
      if (!best || candidate.length > best.length) best = candidate;
    }
    from = start + 3;
  }
  return best && best.length >= MIN_PREVIEW_BYTES ? best : null;
}

const DEFAULT_QUESTION =
  'Describe this image for a searchable catalog: subject, setting, lighting, colors, ' +
  'composition, and above all the mood/feel (moody, sunny, calm, chaotic…). Include any ' +
  'readable text. 2–4 dense sentences, no preamble.';

export function lookToolSpecs(): ToolSpec[] {
  return [
    {
      name: 'look_at_image',
      description:
        'SEE an image file from the attached folder through the vision model and get a detailed ' +
        'text description back. Works for any agent, even on a text-only model. Use it to ' +
        'catalog photos (describe each, then ws_write the catalog), read screenshots, or review ' +
        'designs. The image also shows inline in chat.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path of the image inside the folder, e.g. photos/IMG_0142.jpg',
          },
          question: {
            type: 'string',
            description:
              'Optional: what to look for (default: a rich catalog description — subject, light, colors, mood)',
          },
        },
        required: ['path'],
      },
    },
  ];
}

function guarded(dir: string, relPath: string): string {
  const target = resolve(dir, relPath);
  const rel = relative(dir, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path "${relPath}" escapes the attached folder.`);
  }
  return target;
}

export async function executeLookTool(
  args: unknown,
  deps: { config: ConfigStore; hub: ProviderHub },
  dir: string | undefined,
): Promise<{ content: string; isError?: boolean; imagePath?: string }> {
  const a = (args ?? {}) as Record<string, unknown>;
  const relPath = String(a.path ?? '').trim();
  if (!relPath) return { content: 'No image path given.', isError: true };
  if (!dir) {
    return {
      content:
        'This chat has no folder — attach one with the folder button in the chat bar (or use a ' +
        'project that has a folder), then try again.',
      isError: true,
    };
  }

  let target: string;
  try {
    target = guarded(dir, relPath);
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
  const ext = extname(target).toLowerCase();
  const isRaw = RAW_EXTS.has(ext);
  const mediaType = isRaw ? 'image/jpeg' : IMAGE_MIME[ext];
  if (!mediaType) {
    return {
      content:
        ext === '.heic' || ext === '.heif'
          ? `"${relPath}" is HEIC — vision APIs do not accept it; convert to JPEG first ` +
            '(camera RAW files DO work: their embedded JPEG preview is used).'
          : `"${relPath}" is not a supported image (png, jpg, jpeg, webp, gif — plus camera RAW ` +
            'formats like NEF/CR2/CR3/ARW/RAF/ORF/RW2/DNG via their embedded preview).',
      isError: true,
    };
  }
  let size: number;
  try {
    size = statSync(target).size;
  } catch {
    return { content: `No such file: ${relPath}`, isError: true };
  }
  if (size > (isRaw ? MAX_RAW_BYTES : MAX_IMAGE_BYTES)) {
    return {
      content: `${relPath} is ${(size / 1024 / 1024).toFixed(1)} MB — over the look cap.`,
      isError: true,
    };
  }

  const cfg = deps.config.get();
  const pointer = cfg.visionModel;
  if (!pointer) {
    return {
      content:
        'No vision model configured — set one under Settings → Vision model, then look again.',
      isError: true,
    };
  }
  const bound = (() => {
    try {
      return deps.hub.registry().resolve(
        { provider: pointer.provider as AgentSpec['provider'], model: pointer.model },
        { provider: cfg.defaultProvider, model: cfg.defaultModel },
      );
    } catch {
      return null;
    }
  })();
  if (!bound) {
    return {
      content: `Vision provider "${pointer.provider}" is not configured — add its API key in Settings.`,
      isError: true,
    };
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let bytes: Buffer = readFileSync(target);
    let rawNote = '';
    if (isRaw) {
      const preview = extractJpegPreview(bytes);
      if (!preview) {
        return {
          content:
            `${relPath}: no usable embedded JPEG preview found in this RAW file — convert it to ` +
            'JPEG first, or look at the JPEG twin if the camera saved RAW+JPEG pairs.',
          isError: true,
        };
      }
      if (preview.length > MAX_IMAGE_BYTES) {
        return {
          content: `${relPath}: the RAW's embedded preview is over the 10 MB look cap.`,
          isError: true,
        };
      }
      bytes = preview;
      rawNote = ' (described from the RAW file’s embedded JPEG preview)';
    }
    const data = bytes.toString('base64');
    const question = String(a.question ?? '').trim() || DEFAULT_QUESTION;
    let out = '';
    let errMsg: string | undefined;
    for await (const event of bound.provider.stream(
      {
        model: bound.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', mediaType, data },
              { type: 'text', text: question },
            ],
          },
        ],
      },
      { signal: ctl.signal },
    )) {
      if (event.type === 'text_delta') out += event.text;
      else if (event.type === 'error') errMsg = event.error.message;
    }
    if (!out.trim()) {
      return {
        content: `The vision model returned nothing${errMsg ? ` (${errMsg})` : ''} — is "${bound.model}" actually vision-capable?`,
        isError: true,
      };
    }
    // RAW paths render too: IPC.imageRead extracts the same embedded preview.
    return { content: `${relPath}${rawNote}:\n${out.trim()}`, imagePath: target };
  } catch (err) {
    return {
      content: `look_at_image failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  } finally {
    clearTimeout(timer);
  }
}
