import { clampUiZoom, UI_ZOOM_MAX, UI_ZOOM_MIN, UI_ZOOM_STEP } from '../../../shared/ipc-contract';
import { applyUiZoom, useStore } from '../state/store';

/**
 * The two ± buttons that scale the whole UI — instant via webFrame, then
 * persisted so the next boot comes back at the same size. Lives in the chat
 * header (next to the provider picks) and in Settings → Display.
 */
export function ZoomButtons({ showValue = false }: { showValue?: boolean }) {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  if (!config) return null;
  const zoom = clampUiZoom(config.uiZoom);
  const step = (dir: 1 | -1) => {
    const next = clampUiZoom(zoom + dir * UI_ZOOM_STEP);
    applyUiZoom(next); // see it immediately…
    void saveConfig({ uiZoom: next }); // …then remember it
  };
  return (
    <>
      <button
        className="ghost"
        title={`Zoom the whole UI out (now ${Math.round(zoom * 100)}%)`}
        disabled={zoom <= UI_ZOOM_MIN}
        onClick={() => step(-1)}
      >
        −
      </button>
      {showValue && <span className="meta">{Math.round(zoom * 100)}%</span>}
      <button
        className="ghost"
        title={`Zoom the whole UI in (now ${Math.round(zoom * 100)}%)`}
        disabled={zoom >= UI_ZOOM_MAX}
        onClick={() => step(1)}
      >
        +
      </button>
    </>
  );
}
