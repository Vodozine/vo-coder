import os from 'node:os';
import type { FitVerdict, HardwareProfile, ModelRecord } from './types.js';

/** GPU/VRAM detection is a later refinement; RAM is the binding constraint for
 *  CPU-offloaded local inference and a safe lower bound with a GPU. */
export function profileHardware(): HardwareProfile {
  return {
    totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    freeMemGb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0]?.model.trim() ?? 'unknown',
  };
}

/** Fit rule v1: estimated footprint must stay under ~60% of total RAM. */
export const FIT_RATIO = 0.6;

export function checkFit(model: ModelRecord, hw: HardwareProfile): FitVerdict {
  if (model.estMemGb === undefined) {
    return { fits: true, reason: 'cloud model — no local footprint' };
  }
  const budget = hw.totalMemGb * FIT_RATIO;
  if (model.estMemGb <= budget) {
    return {
      fits: true,
      reason: `needs ~${model.estMemGb} GB, within ${budget.toFixed(0)} GB budget (${FIT_RATIO * 100}% of ${hw.totalMemGb} GB)`,
    };
  }
  return {
    fits: false,
    reason: `needs ~${model.estMemGb} GB but only ~${budget.toFixed(0)} GB is usable on this ${hw.totalMemGb} GB machine`,
  };
}
