import type { VoApi } from '../../shared/ipc-contract';

declare global {
  interface Window {
    vo: VoApi;
  }
}

export {};
