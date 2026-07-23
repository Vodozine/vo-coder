export interface ModelPricing {
  inputPerMTok?: number;
  outputPerMTok?: number;
}

export interface ModelRecord {
  id: string;
  provider?: string;
  displayName?: string;
  contextLength?: number;
  /** USD per million tokens. Absent for local models (cost ≈ 0). */
  pricing?: ModelPricing;
  tags: string[];
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsThinking?: boolean;
  /** Image-GENERATION models (output modality includes image) — never routed
   *  for chat/coding work, still manually selectable. */
  outputsImage?: boolean;
  /** Estimated resident memory for local models at typical quantization. */
  estMemGb?: number;
  /** Capability rank 1–10. Sources layer: curated > arena benchmark > family pattern. */
  quality?: number;
  qualitySource?: 'curated' | 'arena' | 'family';
  /** This model's id on OpenRouter — lets routing reach it through an
   *  OpenRouter key when the native provider isn't configured. */
  openrouterId?: string;
}

export interface HardwareProfile {
  totalMemGb: number;
  freeMemGb: number;
  cpuCount: number;
  cpuModel: string;
}

export interface FitVerdict {
  fits: boolean;
  reason: string;
}

export interface TaskSignal {
  promptChars: number;
  hasCodeFence: boolean;
  needsTools: boolean;
  needsVision: boolean;
  wantsThinking: boolean;
  /**
   * The agent has hands (workspace tools) and is expected to edit files and run
   * commands, not just chat. Forces a higher quality floor: cheap "adequate"
   * models advertise tool support but tend to narrate ("run npm build…")
   * instead of doing the work — an agentic build needs a capable executor.
   */
  agentic?: boolean;
}

export interface RankedModel {
  model: ModelRecord;
  estCostPerExchange: number;
  rationale: string;
}
