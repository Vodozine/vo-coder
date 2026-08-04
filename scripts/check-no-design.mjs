/**
 * Refuse Design code that is heading somewhere it must not go.
 *
 *   node scripts/check-no-design.mjs <base-ref> <head-ref>   a range (CI)
 *   node scripts/check-no-design.mjs --tree <ref>            a whole tree
 *
 * Used twice, deliberately:
 *   - .githooks/pre-push, so a mistake is stopped on the machine that made it
 *   - the public repo's CI, which cannot be bypassed by a clone that never ran
 *     `git config core.hooksPath` — the case that matters once more than one
 *     person holds the Pro repo
 *
 * Exit 0 = clean. Exit 1 = refused, with the file or line named.
 */
import { execFileSync } from 'node:child_process';
import { disqualifyContent, disqualifyTreePath } from './edition-patterns.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function fail(reasons) {
  console.error('\nBLOCKED: this carries the closed Design suite.\n');
  for (const r of reasons.slice(0, 10)) console.error(`  - ${r}`);
  if (reasons.length > 10) console.error(`  …and ${reasons.length - 10} more`);
  console.error(
    '\nThe Free edition must never contain Design code. Move the change to the\n' +
      'Pro repo, or split the shared part into its own commit.\n',
  );
  process.exit(1);
}

const reasons = [];

if (process.argv[2] === '--tree') {
  const ref = process.argv[3] || 'HEAD';
  for (const file of git('ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean)) {
    const why = disqualifyTreePath(file);
    if (why) reasons.push(why);
  }
} else {
  const base = process.argv[2];
  const head = process.argv[3] || 'HEAD';
  if (!base) {
    console.error('Usage: check-no-design.mjs <base-ref> [head-ref] | --tree <ref>');
    process.exit(2);
  }

  const files = git('diff', '--name-only', `${base}..${head}`).split('\n').filter(Boolean);
  for (const file of files) {
    // Design only. The identity/tooling fences belong to the SYNC classifier —
    // they stop replays from Pro, but base legitimately edits its own
    // package.json, README and LICENSE (its version bumps live there).
    const why = disqualifyTreePath(file);
    if (why) {
      reasons.push(why);
      continue;
    }
    // Added lines only: shared files legitimately differ between the editions,
    // so what matters is what this change INTRODUCES.
    const added = git('diff', '--unified=0', `${base}..${head}`, '--', file)
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    const content = disqualifyContent(file, added);
    if (content) reasons.push(content);
  }
}

if (reasons.length) fail(reasons);
console.log('No Design code in this change.');
