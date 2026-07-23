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
}

export interface RankedModel {
  model: ModelRecord;
  estCostPerExchange: number;
  rationale: string;
}
