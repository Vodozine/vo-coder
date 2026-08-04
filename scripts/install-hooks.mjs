/**
 * Install the push guard into .git/hooks so it survives a branch switch.
 *
 * The guard cannot live at core.hooksPath=.githooks: that path is INSIDE the
 * working tree, so checking out `base` — the Free edition, which has no
 * .githooks directory — removes the hook entirely. That is exactly the branch
 * you push to the public repo from, so the guard would vanish at the one moment
 * it is needed.
 *
 * .git/hooks is outside the tree and therefore branch-independent. It is also
 * not carried by `git clone`, which is why this script exists and why the
 * onboarding step is to run it.
 *
 *   node scripts/install-hooks.mjs
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).trim();
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const src = join(root, '.githooks');
const dest = join(gitDir, 'hooks');

if (!existsSync(src)) {
  console.error(`No .githooks directory at ${src} — run this from the Pro branch.`);
  process.exit(1);
}
mkdirSync(dest, { recursive: true });

// core.hooksPath would override .git/hooks entirely, so clear it if set.
try {
  const current = execFileSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim();
  if (current) {
    execFileSync('git', ['config', '--unset', 'core.hooksPath']);
    console.log(`Cleared core.hooksPath (was "${current}") — it hides .git/hooks.`);
  }
} catch {
  /* not set, which is what we want */
}

for (const name of readdirSync(src)) {
  const target = join(dest, name);
  copyFileSync(join(src, name), target);
  try {
    chmodSync(target, 0o755);
  } catch {
    /* Windows ignores the mode; git for Windows runs the hook regardless */
  }
  console.log(`Installed ${name} -> ${target}`);
}

console.log('\nThe push guard is active on every branch of this clone.');
console.log('Re-run this after changing .githooks/, and once per fresh clone.');
