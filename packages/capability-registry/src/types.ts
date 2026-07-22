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
  /** Coarse capability rank 1–10 (curated seed is ground truth). */
  quality?: number;
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
