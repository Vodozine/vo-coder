/**
 * Procedural moon / planet / sun meshes for the Memory 3D graph.
 *
 * Size is relative to the *current* graph: glow = nodeVal / maxVal, and class
 * is moon / planet / sun vs the live mean and max. No hard radius cap — a
 * later, larger hub becomes the new sunniest on the next graph load.
 *
 * Textures, geometries, and base materials are cached (type + class + live).
 * Glow is a billboard sprite (no per-node lights) so 200–800 nodes stay cheap.
 */
import * as THREE from 'three';
import SpriteText from 'three-spritetext';

export type BodyClass = 'moon' | 'planet' | 'sun';

/** Same as the graph's nodeVal — degree 0 is still a visible body. */
export const nodeValOf = (degree: number): number => 1 + degree;

/** Matches react-force-graph's default sphere sizing (radius ∝ cbrt(val), rel 4). */
export const bodyRadius = (degree: number): number => Math.cbrt(1 + degree) * 4;

export function classifyBody(size: number, mean: number, max: number): BodyClass {
  const relMean = size / Math.max(mean, 1e-6);
  const relMax = size / Math.max(max, 1e-6);
  // Small vs the pack → rocky moon. Peak + well above the pack → sun.
  // A flat graph (everyone near the mean) stays planets, even if they tie for max.
  if (relMean < 0.6) return 'moon';
  if (relMax >= 0.88 && relMean >= 1.15) return 'sun';
  if (relMean >= 1.8) return 'sun';
  return 'planet';
}

/** 0..1 on this map; the current biggest node is 1. No cap if a later node exceeds. */
export const glowOf = (size: number, max: number): number => size / Math.max(max, 1e-6);

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0').slice(0, 6);
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n)) return [139, 148, 158];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

const TEX_SIZE = 128;
const textureCache = new Map<string, THREE.CanvasTexture>();
const materialCache = new Map<string, THREE.Material>();
let glowMap: THREE.CanvasTexture | null = null;
let moonGeo: THREE.SphereGeometry | null = null;
let planetGeo: THREE.SphereGeometry | null = null;
let sunGeo: THREE.SphereGeometry | null = null;

function getGeos(): {
  moon: THREE.SphereGeometry;
  planet: THREE.SphereGeometry;
  sun: THREE.SphereGeometry;
} {
  moonGeo ??= new THREE.SphereGeometry(1, 12, 10);
  planetGeo ??= new THREE.SphereGeometry(1, 16, 12);
  sunGeo ??= new THREE.SphereGeometry(1, 20, 16);
  return { moon: moonGeo, planet: planetGeo, sun: sunGeo };
}

function canvasTexture(draw: (ctx: CanvasRenderingContext2D, size: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = TEX_SIZE;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Memory graph: 2D canvas unavailable');
  draw(ctx, TEX_SIZE);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function paintMoon(ctx: CanvasRenderingContext2D, size: number, rgb: [number, number, number], live: boolean, seed: number): void {
  const rnd = mulberry32(seed);
  const dim = live ? 1 : 0.55;
  const [br, bg, bb] = rgb;
  const img = ctx.createImageData(size, size);
  const data = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = (rnd() * 0.22 + ((x * 17 + y * 31) % 13) / 60) * dim;
      const i = (y * size + x) * 4;
      data[i] = clampByte((br * 0.38 + 28) * dim + n * 90);
      data[i + 1] = clampByte((bg * 0.38 + 28) * dim + n * 90);
      data[i + 2] = clampByte((bb * 0.38 + 28) * dim + n * 90);
      data[i + 3] = 255;
    }
  }
  const craters = 14 + Math.floor(rnd() * 10);
  for (let c = 0; c < craters; c++) {
    const cx = rnd() * size;
    const cy = rnd() * size;
    const r = 2.2 + rnd() * 9;
    const dark = 0.55 + rnd() * 0.2;
    const r2 = r * r;
    const rim = (r + 1.15) * (r + 1.15);
    for (let y = Math.max(0, Math.floor(cy - r - 2)); y < Math.min(size, Math.ceil(cy + r + 2)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r - 2)); x < Math.min(size, Math.ceil(cx + r + 2)); x++) {
        const dx = x - cx;
        const dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > rim) continue;
        const i = (y * size + x) * 4;
        if (d2 >= r2) {
          data[i] = clampByte(data[i] + 28 * dim);
          data[i + 1] = clampByte(data[i + 1] + 28 * dim);
          data[i + 2] = clampByte(data[i + 2] + 28 * dim);
        } else {
          const shade = 1 - (1 - dark) * (1 - d2 / r2);
          data[i] = clampByte(data[i] * shade);
          data[i + 1] = clampByte(data[i + 1] * shade);
          data[i + 2] = clampByte(data[i + 2] * shade);
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

function paintPlanet(ctx: CanvasRenderingContext2D, size: number, rgb: [number, number, number], live: boolean, seed: number): void {
  const rnd = mulberry32(seed);
  const dim = live ? 1 : 0.5;
  const [br, bg, bb] = rgb;
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const freq = 5.5 + rnd() * 4;
  const phase = rnd() * Math.PI * 2;
  const warp = 0.35 + rnd() * 0.45;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    const band = Math.sin(v * Math.PI * freq + phase);
    const polar = Math.pow(Math.abs(v - 0.5) * 2, 1.6);
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const w = Math.sin((u + v * 0.35) * Math.PI * 2) * warp;
      const t = 0.5 + 0.5 * Math.sin(v * Math.PI * freq + phase + w);
      const grain = ((x * 13 + y * 29 + (seed & 255)) % 11) / 40;
      const lift = (0.42 + t * 0.7 + band * 0.08 + grain) * (1 - polar * 0.28);
      const i = (y * size + x) * 4;
      data[i] = clampByte((br * 0.55 + 40) * lift * dim);
      data[i + 1] = clampByte((bg * 0.55 + 40) * lift * dim);
      data[i + 2] = clampByte((bb * 0.55 + 40) * lift * dim);
      data[i + 3] = 255;
    }
  }
  // One storm / spot so the body reads as a planet, not a striped ball.
  const sx = size * (0.3 + rnd() * 0.4);
  const sy = size * (0.35 + rnd() * 0.3);
  const srx = 6 + rnd() * 10;
  const sry = 3 + rnd() * 5;
  for (let y = Math.max(0, Math.floor(sy - sry - 1)); y < Math.min(size, Math.ceil(sy + sry + 1)); y++) {
    for (let x = Math.max(0, Math.floor(sx - srx - 1)); x < Math.min(size, Math.ceil(sx + srx + 1)); x++) {
      const e = ((x - sx) / srx) ** 2 + ((y - sy) / sry) ** 2;
      if (e > 1) continue;
      const i = (y * size + x) * 4;
      const k = 0.72 + e * 0.15;
      data[i] = clampByte(data[i] * k + br * 0.12);
      data[i + 1] = clampByte(data[i + 1] * k + bg * 0.12);
      data[i + 2] = clampByte(data[i + 2] * k + bb * 0.12);
    }
  }
  ctx.putImageData(img, 0, 0);
}

function paintSun(ctx: CanvasRenderingContext2D, size: number, rgb: [number, number, number], live: boolean, seed: number): void {
  const rnd = mulberry32(seed);
  const dim = live ? 1 : 0.62;
  const [br, bg, bb] = rgb;
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const cx = size / 2;
  const cy = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - cx) / cx;
      const dy = (y - cy) / cy;
      const d = Math.min(1, Math.hypot(dx, dy));
      const gran = 0.85 + 0.15 * Math.sin(x * 0.55 + seed) * Math.cos(y * 0.47);
      const n = 0.88 + rnd() * 0.12;
      const core = Math.pow(1 - d, 1.35);
      const r = (255 * (0.55 + 0.45 * core) + br * (1 - core) * 0.65) * gran * n * dim;
      const g = (240 * (0.4 + 0.6 * core) + bg * (1 - core) * 0.55) * gran * n * dim;
      const b = (180 * core * 0.55 + bb * (0.35 + 0.65 * (1 - core))) * gran * n * dim;
      const i = (y * size + x) * 4;
      data[i] = clampByte(r);
      data[i + 1] = clampByte(g);
      data[i + 2] = clampByte(b);
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function bodyTexture(kind: BodyClass, type: string, color: string, live: boolean): THREE.CanvasTexture {
  const key = `${kind}:${type}:${live ? 'live' : 'dim'}:${color}`;
  const hit = textureCache.get(key);
  if (hit) return hit;
  const rgb = hexToRgb(color);
  const seed = hashStr(key);
  const tex = canvasTexture((ctx, size) => {
    if (kind === 'moon') paintMoon(ctx, size, rgb, live, seed);
    else if (kind === 'planet') paintPlanet(ctx, size, rgb, live, seed);
    else paintSun(ctx, size, rgb, live, seed);
  });
  textureCache.set(key, tex);
  return tex;
}

function getGlowMap(): THREE.CanvasTexture {
  if (glowMap) return glowMap;
  glowMap = canvasTexture((ctx, size) => {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.62)');
    g.addColorStop(0.42, 'rgba(255,255,255,0.2)');
    g.addColorStop(0.72, 'rgba(255,255,255,0.05)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  });
  return glowMap;
}

function bodyMaterial(kind: BodyClass, type: string, color: string, live: boolean, glow: number): THREE.Material {
  const bucket = Math.round(Math.min(glow, 1.25) * 8) / 8;
  const key = `${kind}:${type}:${live ? 'live' : 'dim'}:${color}:${bucket}`;
  const hit = materialCache.get(key);
  if (hit) return hit;
  const map = bodyTexture(kind, type, color, live);
  const col = new THREE.Color(color);
  let mat: THREE.Material;
  if (kind === 'sun') {
    mat = new THREE.MeshBasicMaterial({
      map,
      color: new THREE.Color(1, 1, 1),
      toneMapped: false,
    });
  } else if (kind === 'planet') {
    mat = new THREE.MeshPhongMaterial({
      map,
      color: new THREE.Color(1, 1, 1),
      emissive: col,
      emissiveIntensity: (live ? 0.18 : 0.06) + 0.28 * bucket,
      shininess: 22,
      specular: new THREE.Color(0x3a3a3a),
    });
  } else {
    mat = new THREE.MeshLambertMaterial({
      map,
      color: new THREE.Color(1, 1, 1),
      emissive: col,
      emissiveIntensity: (live ? 0.05 : 0.02) + 0.12 * bucket,
    });
  }
  materialCache.set(key, mat);
  return mat;
}

function makeGlowSprite(color: string, scale: number, opacity: number, wash = 0): THREE.Sprite {
  const tint = new THREE.Color(color).lerp(new THREE.Color(0xfff4d2), wash);
  const mat = new THREE.SpriteMaterial({
    map: getGlowMap(),
    color: tint,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(scale, scale, 1);
  sprite.raycast = () => {};
  return sprite;
}

export function createCelestialNode(opts: {
  title: string;
  type: string;
  degree: number;
  color: string;
  live: boolean;
  mean: number;
  max: number;
  labelColor: string;
}): THREE.Group {
  const size = nodeValOf(opts.degree);
  const kind = classifyBody(size, opts.mean, opts.max);
  const glow = glowOf(size, opts.max);
  const radius = bodyRadius(opts.degree);
  const geos = getGeos();
  const geo = kind === 'sun' ? geos.sun : kind === 'planet' ? geos.planet : geos.moon;
  const mat = bodyMaterial(kind, opts.type, opts.color, opts.live, glow);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.setScalar(radius);
  const spin = hashStr(`${opts.type}:${opts.title}`) / 4294967296;
  mesh.rotation.set(spin * 5.1, spin * 3.7, spin * 2.3);

  const group = new THREE.Group();
  group.add(mesh);

  const liveK = opts.live ? 1 : 0.45;
  if (kind === 'moon') {
    group.add(makeGlowSprite(opts.color, radius * (2.1 + 1.1 * glow), (0.16 + 0.2 * glow) * liveK, 0.05));
  } else if (kind === 'planet') {
    group.add(makeGlowSprite(opts.color, radius * (2.7 + 1.5 * glow), (0.26 + 0.32 * glow) * liveK, 0.12));
  } else {
    group.add(makeGlowSprite(opts.color, radius * (4.4 + 3.2 * glow), (0.5 + 0.45 * glow) * liveK, 0.2));
    group.add(makeGlowSprite('#fff6d0', radius * (2.05 + 1.05 * glow), (0.62 + 0.3 * glow) * liveK, 0.55));
  }

  const text = opts.title.length > 42 ? `${opts.title.slice(0, 42)}…` : opts.title;
  const label = new SpriteText(text);
  label.color = opts.labelColor;
  label.textHeight = 2.6;
  label.fontFace = 'system-ui, sans-serif';
  label.position.set(0, radius + 2.5, 0);
  label.raycast = () => {};
  group.add(label);

  return group;
}
