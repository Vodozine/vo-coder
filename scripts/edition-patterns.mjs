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
  /^apps\/desktop\/src\/main\/claude-sub-provider\.ts$|^apps\/desktop\/fonts\/|^apps\/desktop\/src\/renderer\/src\/design\/|^apps\/desktop\/src\/renderer\/src\/views\/Design\.tsx$|^apps\/desktop\/src\/renderer\/src\/design-mockup-dieline\.css$|^apps\/desktop\/src\/main\/(design-tools|design-scene-store|html-to-design|html-dom-edit|html-dom-write|html-text-rewrite|live-edit-overlay|web-project|image-size)\.ts$|^apps\/desktop\/src\/shared\/design-document\.ts$|^apps\/desktop\/scripts\/test-(html-dom-edit|inpaint-mask|dom-write|html-text-rewrite|web-scaffold)\.|^apps\/desktop\/scripts\/(_patch-design|patch-design|patch-html-live|patch-text-sync|fix-dom-write|fix-panel-sourcesrc|fix-sync-sourcesrc|verify-wiring)/;

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
 *
 * The CONTRACT TYPES belong here as much as the runtime does. Without them a
 * commit that merely imports DesignDocument into ipc-contract.ts read as
 * shared, conflicted on every single sync against a base that has no
 * design-document module, and had to be hand-skipped each time.
 */
export const DESIGN_MARKERS =
  /DesignHub|designHub|IPC\.design|design:[a-zA-Z]|LIVE_EDIT_OVERLAY|live-edit-overlay|design-tools|DESIGN_SYSTEM_PROMPT|vo-edit=1|CLAUDE_SUB_PERSONAL|ClaudeSubscriptionProvider|claude-sub|design-document|Design(Document|Object|Op|SuiteMode)\b/;

/**
 * The guards themselves name every Design module, so a naive content scan would
 * flag them forever. They are exempt from the MARKER check only — the path
 * check still applies, and these paths are not Design paths.
 */
export const MARKER_EXEMPT =
  /^scripts\/(edition-patterns|check-no-design|sync-free)\.mjs$|^\.githooks\/|^docs\/EDITIONS\.md$|^\.github\/workflows\/no-design\.yml$/;

/**
 * Pro-side workflow tooling. The Free edition neither has nor needs these:
 * sync-free replays FROM Pro, and EDITIONS.md documents the Pro clone's
 * workflow. Replaying edits to files base does not have conflicts every time.
 */
export const PRO_TOOLING_PATHS = /^scripts\/sync-free\.mjs$|^docs\/EDITIONS\.md$/;

/**
 * Pro-only FEATURES: shipped here, deliberately not in the Free edition.
 * Unlike Design this is not a licensing line — the engine bridges are one-click
 * installers for two third-party MIT MCP servers, and anyone on Free can add
 * those by hand through the ordinary MCP list. Keeping them out is a decision
 * about what the Free edition carries, so the guard has to hold it: without
 * this the next sync would helpfully put them back.
 */
export const PRO_ONLY_PATHS =
  /^apps\/mobile\/|^apps\/desktop\/src\/main\/engine-bridges\.ts$|^apps\/desktop\/src\/main\/video-(hub|render|project-store|ffmpeg)\.ts$|^apps\/desktop\/src\/shared\/video-document\.ts$|^apps\/desktop\/src\/renderer\/src\/video\/|^apps\/desktop\/src\/renderer\/src\/video-editor\.css$/;
/**
 * The video EDITOR is Pro-only (timeline, mp4 render, continuation, mixer).
 * Note what is deliberately NOT here: video-gen.ts and IPC.videoRead are the
 * shared chat-side video_generate tool and its inline player, which the Free
 * edition has and keeps. The channel/tool names are therefore listed one by
 * one rather than as `IPC\.video` — a blanket match would block every future
 * shared change that merely touches videoRead.
 */
export const PRO_ONLY_MARKERS =
  /bridgeInstall|bridgeInstalled|bridgeConfig|ENGINE_BRIDGES|EngineBridgeCard|IPC\.bridge|bridges:(status|install|bind)|VideoHub|videoHub|VIDEO_SYSTEM_PROMPT|video-document|Video(Project|Clip|Track|Op|Editor|Timeline|Preview|Properties|Mixer|Start|EventPayload|ImportedFile|RenderProgress|SceneState|ProjectStore)\b|isVideoSession|video-(hub|render|project-store|ffmpeg)|renderVideoProject|compositeOnFrame|probeImageSize|extractFrame|supportsSeedImage|seedFrame|seedImage|video_(get_timeline|generate_clip|continue_clip|generate_story|add_text|update_clip|remove_clip|set_output|look_at_clip|place_product)|video(Sync|Restore|Flush|New|SaveAs|OpenPath|EnsureProject|ImportPaths|Render|RenderCancel|RenderProgress|ContinueClip|CanContinue|PickFolder|DefaultRoot|RevealPath|Event|List)\b|video:(sync|restore|flush|new|save|saveAs|open|openPath|list|ensureProject|import|importPaths|render|renderCancel|renderProgress|continueClip|canContinue|pickFolder|defaultRoot|revealPath|event|pathForFile)/;

/**
 * First reason this CHANGE cannot go to the Free edition, or null. Identity
 * belongs here — replaying an identity diff would rebrand the Free app — but
 * NOT in whole-tree checks: identity files exist in both editions on purpose.
 */
export function disqualifyPath(file) {
  if (DESIGN_PATHS.test(file)) return `Design file: ${file}`;
  if (IDENTITY_PATHS.test(file)) return `edition identity: ${file}`;
  if (PRO_TOOLING_PATHS.test(file)) return `Pro-side tooling: ${file}`;
  if (PRO_ONLY_PATHS.test(file)) return `Pro-only feature: ${file}`;
  return null;
}

/** Whole-tree rule: only Design may not EXIST in the Free edition. */
export function disqualifyTreePath(file) {
  if (DESIGN_PATHS.test(file)) return `Design file: ${file}`;
  // The companion app is a PAID product on the Play Store. Its source may not
  // exist in the public tree at all — it once synced through because no rule
  // named it, and shipped.
  if (/^apps\/mobile\//.test(file)) return `Paid app source: ${file}`;
  return null;
}

/** Scan added lines for Design code hidden in an otherwise shared file. */
export function disqualifyContent(file, addedLines) {
  if (MARKER_EXEMPT.test(file)) return null;
  const hit = addedLines.find((l) => DESIGN_MARKERS.test(l));
  if (hit) return `Design code in ${file}: ${hit.trim().slice(0, 70)}`;
  // Pro-only features hide in shared files the same way Design does — the
  // bridge IPC handlers live in ipc.ts, the card in Settings.tsx.
  const proOnly = addedLines.find((l) => PRO_ONLY_MARKERS.test(l));
  return proOnly ? `Pro-only feature in ${file}: ${proOnly.trim().slice(0, 70)}` : null;
}
