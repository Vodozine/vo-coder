/** Packs build/icon-<size>.png (from icons-from-image.ps1) into build/icon.ico. */
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngToIco from 'png-to-ico';

const build = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop', 'build');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => readFileSync(join(build, `icon-${s}.png`)));
writeFileSync(join(build, 'icon.ico'), await pngToIco(pngs));
for (const s of sizes) rmSync(join(build, `icon-${s}.png`), { force: true });
console.log('wrote build/icon.ico');
