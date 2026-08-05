import { readFileSync, writeFileSync } from 'node:fs';
import { fitContextWindow, type EndpointMeasurement } from '@vo-coder/providers';

/**
 * What we have learned about each local model, so the context window can be
 * chosen by arithmetic instead of by the user guessing from a dropdown.
 *
 * Guessing is expensive here: measured on real hardware, a 27B pinned to 128k
 * needed 26.81G against a 22.5G card, pushed 5G onto the CPU, and generation
 * fell from 12 tok/s to 0.6. The cliff is invisible — Ollama says nothing — so
 * the app has to measure and stay under it.
 *
 * Cached on disk because a measurement is only free when the model happens to
 * be resident, and a cold load costs 36-93s on these boxes.
 */
export interface ModelFit {
  /** Which server this was measured on — a name repointed elsewhere invalidates it. */
  url: string;
  quantization?: string;
  weightsBytes?: number;
  bytesPerToken?: number;
  trainedContext?: number;
  /** The window we chose, or null when the box has not told us enough. */
  chosen?: number | null;
  spilled?: boolean;
  at: number;
}

/**
 * A card's usable VRAM. Learned rather than assumed: a loaded instance's
 * size_vram is a lower bound, but a SPILLED instance's size_vram is what
 * actually fit, which is very close to the true ceiling — so a spill teaches
 * us the number precisely.
 */
interface VramBudget {
  bytes: number;
  /** Set once a spill has revealed the real ceiling; before that it is a floor. */
  confident: boolean;
}

interface FitData {
  models: Record<string, ModelFit>;
  vram: Record<string, VramBudget>;
}

export class ContextFitStore {
  private data: FitData = { models: {}, vram: {} };

  constructor(private path: string) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FitData>;
      this.data = { models: raw.models ?? {}, vram: raw.vram ?? {} };
    } catch {
      /* first run */
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      /* best-effort — a lost cache costs a re-measure, nothing more */
    }
  }

  /**
   * The window to use for a model, or undefined to keep sizing per request.
   * `url` guards against an endpoint name being repointed at a different box.
   */
  windowFor(modelId: string, url: string): number | undefined {
    const fit = this.data.models[modelId];
    if (!fit || fit.url !== url) return undefined;
    return fit.chosen ?? undefined;
  }

  fit(modelId: string): ModelFit | undefined {
    return this.data.models[modelId];
  }

  vramBudget(url: string): VramBudget | undefined {
    return this.data.vram[url];
  }

  /**
   * Fold a fresh measurement in and re-choose. Returns the chosen window.
   *
   * A spill is not a failure to hide — it is the most informative reading we
   * ever get, because size_vram then equals what actually fit on the card.
   *
   * `userVramBytes` is the endpoint's stated VRAM. It matters because Ollama's
   * API never reports a card's TOTAL memory: without a spill all we can infer
   * is a floor, and a floor taken from a small model loaded at a small window
   * would badly understate a large card. One number the user already knows
   * beats an inference we cannot soundly make.
   */
  record(
    modelId: string,
    url: string,
    m: EndpointMeasurement,
    at: number,
    userVramBytes?: number,
  ): number | null {
    if (m.vramBytes) {
      const known = this.data.vram[url];
      if (m.spilled) {
        // What fit IS the ceiling. Always trust this over an earlier floor.
        this.data.vram[url] = { bytes: m.vramBytes, confident: true };
      } else if (!known?.confident && m.vramBytes > (known?.bytes ?? 0)) {
        // Everything fit, so the card holds at least this much — a floor only.
        this.data.vram[url] = { bytes: m.vramBytes, confident: false };
      }
    }
    const known = this.data.vram[url];
    // A measured ceiling wins; otherwise the user's figure; a bare floor is
    // never used to size a window — it would only shrink one that already fits.
    const budget = known?.confident ? known.bytes : userVramBytes;
    const chosen = fitContextWindow(m, budget);
    this.data.models[modelId] = {
      url,
      quantization: m.quantization,
      weightsBytes: m.weightsBytes,
      bytesPerToken: m.bytesPerToken,
      trainedContext: m.trainedContext,
      chosen,
      spilled: m.spilled,
      at,
    };
    this.persist();
    return chosen;
  }

  /** Every model measured on a server, newest first — for the Settings row. */
  forUrl(url: string): Array<ModelFit & { model: string }> {
    return Object.entries(this.data.models)
      .filter(([, f]) => f.url === url)
      .map(([model, f]) => ({ ...f, model }))
      .sort((a, b) => b.at - a.at);
  }
}
