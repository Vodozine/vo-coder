import { useStore } from '../state/store';

/** Vodo's operating mode — Auto (autonomous) / Plan (read-only) / Manual. */
export function ModeToggle() {
  const mode = useStore((s) => s.config?.approvalMode ?? 'manual');
  const saveConfig = useStore((s) => s.saveConfig);
  return (
    <span
      className="mode-toggle"
      title="Auto: autonomous — agents act, no prompts. Plan: read-only — Vodo proposes a plan, changes nothing. Manual: approve every write/run. (Destructive infra tools always require confirmation.)"
    >
      <button
        className={`m-auto ${mode === 'auto' ? 'on' : ''}`}
        onClick={() => void saveConfig({ approvalMode: 'auto' })}
      >
        Auto
      </button>
      <button
        className={`m-plan ${mode === 'plan' ? 'on' : ''}`}
        onClick={() => void saveConfig({ approvalMode: 'plan' })}
      >
        Plan
      </button>
      <button
        className={`m-manual ${mode === 'manual' ? 'on' : ''}`}
        onClick={() => void saveConfig({ approvalMode: 'manual' })}
      >
        Manual
      </button>
    </span>
  );
}
