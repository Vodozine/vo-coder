/**
 * What belongs to which edition. One definition, used by every guard:
 *
 *   scripts/sync-free.mjs        refuses to replay a disqualifying commit
 *   scripts/check-no-design.mjs  the push hook and the public repo's CI
 *
 * This file is shared code — it travels to the Free edition with everything
 * else, which is why the CI check running there can be sure it is enforcing the
 * same rules Pro is.
 */

/** Files that exist only in the Pro edition. */
export const DESIGN_PATHS =
  /^apps\/desktop\/src\/renderer\/src\/design\/|^apps\/desktop\/src\/renderer\/src\/views\/Design\.tsx$|^apps\/desktop\/src\/renderer\/src\/design-mockup-dieline\.css$|^apps\/desktop\/src\/main\/(design-tools|design-scene-store|html-to-design|html-dom-edit|html-dom-write|html-text-rewrite|live-edit-overlay|web-project|image-size)\.ts$|^apps\/desktop\/src\/shared\/design-document\.ts$|^apps\/desktop\/scripts\/test-(html-dom-edit|inpaint-mask|dom-write|html-text-rewrite|web-scaffold)\.|^apps\/desktop\/scripts\/(_patch-design|patch-design|patch-html-live|patch-text-sync|fix-dom-write|fix-panel-sourcesrc|fix-sync-sourcesrc|verify-wiring)/;

/**
 * Files carrying an EDITION's own identity. Replaying these would rename the
 * Free app "Vo-Coder Pro", point its updater at the private feed, or drag Pro's
 * version line across. They differ between editions on purpose.
 */
export const IDENTITY_PATHS =
  /^apps\/desktop\/package\.json$|^apps\/desktop\/electron-builder\.yml$|^apps\/desktop\/src\/renderer\/index\.html$|^package\.json$|^LICENSE$|^README\.md$/;

/**
 * Design that lives INSIDE shared files, where a path check sees nothing wrong —
 * ipc.ts alone holds roughly 2,000 lines of it.
 */
export const DESIGN_MARKERS =
  /DesignHub|designHub|IPC\.design|design:[a-zA-Z]|LIVE_EDIT_OVERLAY|live-edit-overlay|design-tools|DESIGN_SYSTEM_PROMPT|vo-edit=1/;

/**
 * The guards themselves name every Design module, so a naive content scan would
 * flag them forever. They are exempt from the MARKER check only — the path
 * check still applies, and these paths are not Design paths.
 */
export const MARKER_EXEMPT =
  /^scripts\/(edition-patterns|check-no-design|sync-free)\.mjs$|^\.githooks\/|^docs\/EDITIONS\.md$|^\.github\/workflows\/no-design\.yml$/;

/**
 * First reason this CHANGE cannot go to the Free edition, or null. Identity
 * belongs here — replaying an identity diff would rebrand the Free app — but
 * NOT in whole-tree checks: identity files exist in both editions on purpose.
 */
export function disqualifyPath(file) {
  if (DESIGN_PATHS.test(file)) return `Design file: ${file}`;
  if (IDENTITY_PATHS.test(file)) return `edition identity: ${file}`;
  return null;
}

/** Whole-tree rule: only Design may not EXIST in the Free edition. */
export function disqualifyTreePath(file) {
  return DESIGN_PATHS.test(file) ? `Design file: ${file}` : null;
}

/** Scan added lines for Design code hidden in an otherwise shared file. */
export function disqualifyContent(file, addedLines) {
  if (MARKER_EXEMPT.test(file)) return null;
  const hit = addedLines.find((l) => DESIGN_MARKERS.test(l));
  return hit ? `Design code in ${file}: ${hit.trim().slice(0, 70)}` : null;
}
