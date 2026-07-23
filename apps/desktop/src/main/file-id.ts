import type { ToolSpec } from '@vo-coder/providers';

/**
 * file_identify: deterministic knowledge of the fixed naming schemes camera
 * makers, phones, and apps stamp on files, plus what the extensions mean
 * (RAW dialects included). Pure local pattern matching — no model guesswork,
 * no network — so cataloging can group photos by source and pull shoot dates
 * straight out of the names.
 */

interface NameRule {
  re: RegExp;
  source: string;
}

// Ordered: first match wins, most specific first.
const NAME_RULES: NameRule[] = [
  { re: /^PXL_\d{8}_\d{9}/i, source: 'Google Pixel phone' },
  { re: /^IMG-\d{8}-WA\d+/i, source: 'WhatsApp download' },
  { re: /^IMG_\d{8}_\d{6}/i, source: 'Android phone camera (Samsung and others)' },
  { re: /^VID_\d{8}_\d{6}/i, source: 'Android phone video' },
  { re: /^IMG_E\d{4}/i, source: 'Apple iPhone (edited copy)' },
  { re: /^IMG_\d{4}$/i, source: 'Canon camera or Apple iPhone' },
  { re: /^DSC_\d{4}/i, source: 'Nikon camera' },
  { re: /^_DSC\d{4}/i, source: 'Nikon camera (Adobe RGB color mode)' },
  { re: /^DSCN\d{4}/i, source: 'Nikon Coolpix compact' },
  { re: /^DSCF\d{4}/i, source: 'Fujifilm camera' },
  { re: /^DSC\d{5}/i, source: 'Sony camera' },
  { re: /^DJI_\d{4}/i, source: 'DJI drone or gimbal camera' },
  { re: /^(GOPR|GP\d{2}|GX\d{2}|GH\d{2}|GS__)\d{4}/i, source: 'GoPro action camera' },
  { re: /^MVI_\d{4}/i, source: 'Canon camera video clip' },
  { re: /^MAH\d{5}|^MOV\d{3,5}/i, source: 'camera video clip' },
  { re: /^P\d{7}$/i, source: 'Panasonic Lumix or Olympus camera' },
  { re: /^PANA\d{4}/i, source: 'Panasonic camera' },
  { re: /^SAM_\d{4}/i, source: 'Samsung camera' },
  { re: /^SDC\d{5}/i, source: 'Samsung camera' },
  { re: /^CIMG\d{4}/i, source: 'Casio camera' },
  { re: /^PICT\d{4}/i, source: 'Minolta or Pentax camera' },
  { re: /^IMGP\d{4}/i, source: 'Pentax camera' },
  { re: /^R\d{7}/i, source: 'Ricoh camera' },
  { re: /^L\d{7}/i, source: 'Leica camera' },
  { re: /^SDIM\d{4}/i, source: 'Sigma camera' },
  { re: /^HPIM\d{4}/i, source: 'HP camera' },
  { re: /^KIF_\d{4}/i, source: 'Kyocera camera' },
  { re: /^Screenshot[ _-]/i, source: 'screenshot' },
  { re: /^Screen Shot /i, source: 'macOS screenshot' },
  { re: /^RPReplay/i, source: 'iOS screen recording' },
  { re: /^WIN_\d{8}/i, source: 'Windows Camera app' },
  { re: /^WP_\d{8}/i, source: 'Windows Phone' },
  { re: /^FB_IMG_\d+/i, source: 'Facebook download' },
  { re: /^received_\d+/i, source: 'Facebook Messenger download' },
  { re: /^signal-\d{4}-\d{2}-\d{2}/i, source: 'Signal messenger download' },
  { re: /^photo_\d+@\d{2}-\d{2}-\d{4}/i, source: 'Telegram download' },
  { re: /^\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}/, source: 'Dropbox camera upload' },
  { re: /^image\d{3,}$/i, source: 'generic app export' },
];

interface ExtInfo {
  kind: string;
  raw?: boolean;
}

const EXT_MAP: Record<string, ExtInfo> = {
  // Camera RAW dialects — sensor data, one per manufacturer.
  nef: { kind: 'Nikon RAW', raw: true },
  nrw: { kind: 'Nikon compact RAW', raw: true },
  cr2: { kind: 'Canon RAW', raw: true },
  cr3: { kind: 'Canon RAW (newer bodies)', raw: true },
  crw: { kind: 'Canon RAW (early bodies)', raw: true },
  arw: { kind: 'Sony RAW', raw: true },
  srf: { kind: 'Sony RAW (early)', raw: true },
  sr2: { kind: 'Sony RAW (early)', raw: true },
  raf: { kind: 'Fujifilm RAW', raw: true },
  orf: { kind: 'Olympus/OM System RAW', raw: true },
  rw2: { kind: 'Panasonic RAW', raw: true },
  dng: { kind: 'Adobe universal RAW (Pixel, DJI, Leica, and others)', raw: true },
  pef: { kind: 'Pentax RAW', raw: true },
  x3f: { kind: 'Sigma RAW', raw: true },
  srw: { kind: 'Samsung RAW', raw: true },
  '3fr': { kind: 'Hasselblad RAW', raw: true },
  fff: { kind: 'Hasselblad/Imacon RAW', raw: true },
  iiq: { kind: 'Phase One RAW', raw: true },
  gpr: { kind: 'GoPro RAW', raw: true },
  mrw: { kind: 'Minolta RAW', raw: true },
  rwl: { kind: 'Leica RAW', raw: true },
  erf: { kind: 'Epson RAW', raw: true },
  kdc: { kind: 'Kodak RAW', raw: true },
  dcr: { kind: 'Kodak RAW', raw: true },
  mos: { kind: 'Leaf RAW', raw: true },
  mef: { kind: 'Mamiya RAW', raw: true },
  raw: { kind: 'generic RAW', raw: true },
  // Processed images.
  jpg: { kind: 'JPEG photo' },
  jpeg: { kind: 'JPEG photo' },
  heic: { kind: 'HEIF photo (Apple default since iOS 11)' },
  heif: { kind: 'HEIF photo' },
  png: { kind: 'PNG image (screenshots, graphics)' },
  webp: { kind: 'WebP image (web export)' },
  avif: { kind: 'AVIF image' },
  tif: { kind: 'TIFF image (scans, editing masters)' },
  tiff: { kind: 'TIFF image (scans, editing masters)' },
  bmp: { kind: 'BMP image' },
  gif: { kind: 'GIF animation/image' },
  svg: { kind: 'SVG vector graphic' },
  psd: { kind: 'Photoshop document' },
  // Video.
  mp4: { kind: 'MP4 video' },
  mov: { kind: 'QuickTime video (Apple, many cameras)' },
  avi: { kind: 'AVI video (older cameras)' },
  mkv: { kind: 'Matroska video' },
  mts: { kind: 'AVCHD camcorder video' },
  m2ts: { kind: 'AVCHD camcorder video' },
  '3gp': { kind: 'mobile video (older phones)' },
  webm: { kind: 'WebM video' },
  insv: { kind: 'Insta360 video' },
  '360': { kind: 'GoPro 360 video' },
  lrv: { kind: 'GoPro low-res proxy video' },
  thm: { kind: 'video thumbnail sidecar' },
  // Sidecars and audio.
  xmp: { kind: 'Adobe edit sidecar (settings, not pixels)' },
  aae: { kind: 'Apple edit sidecar (settings, not pixels)' },
  pp3: { kind: 'RawTherapee edit sidecar' },
  dop: { kind: 'DxO edit sidecar' },
  wav: { kind: 'WAV audio' },
  mp3: { kind: 'MP3 audio' },
  m4a: { kind: 'AAC audio' },
  flac: { kind: 'FLAC audio' },
};

/** Pull a shoot date out of the name when the scheme embeds one. */
function dateFromName(base: string): string | undefined {
  let m = /(20\d{2}|19\d{2})[-_.]?(\d{2})[-_.]?(\d{2})[ _-]?(\d{2})?[._]?(\d{2})?[._]?(\d{2})?/.exec(
    base,
  );
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  let out = `${y}-${mo}-${d}`;
  if (h && mi) out += ` ${h}:${mi}${s ? `:${s}` : ''}`;
  return out;
}

export function identifyName(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const parts: string[] = [];
  const rule = NAME_RULES.find((r) => r.re.test(base));
  if (rule) parts.push(rule.source);
  const info = EXT_MAP[ext];
  if (info) parts.push(info.kind + (info.raw ? ' — look_at_image can open it via its embedded preview' : ''));
  else if (ext) parts.push(`.${ext} file`);
  const date = dateFromName(base);
  if (date) parts.push(`dated ${date}`);
  return parts.length ? parts.join('; ') : 'no known naming scheme';
}

export function fileIdToolSpecs(): ToolSpec[] {
  return [
    {
      name: 'file_identify',
      description:
        'Decode file names the way cameras and apps write them: which device/app likely made ' +
        'each file (DSC_→Nikon, PXL_→Pixel, IMG-…-WA→WhatsApp…), what the format is (including ' +
        'every camera RAW dialect), and any date embedded in the name. Deterministic — use it ' +
        'on ws_list output when cataloging a folder.',
      inputSchema: {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'string' },
            description: 'File names (with extension), e.g. from ws_list',
          },
        },
        required: ['names'],
      },
    },
  ];
}

export function executeFileIdTool(args: unknown): { content: string; isError?: boolean } {
  const a = (args ?? {}) as Record<string, unknown>;
  const names = Array.isArray(a.names) ? a.names.map(String).filter(Boolean) : [];
  if (names.length === 0) return { content: 'No file names given.', isError: true };
  const lines = names.slice(0, 300).map((n) => {
    const clean = n.replace(/^.*[\\/]/, '');
    return `${n} — ${identifyName(clean)}`;
  });
  const over = names.length > 300 ? `\n…(${names.length - 300} more not shown)` : '';
  return { content: lines.join('\n') + over };
}
