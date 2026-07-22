import type { ProviderErrorInfo, ProviderErrorKind } from './types.js';

export function errorFromStatus(status: number | undefined, message: string): ProviderErrorInfo {
  let kind: ProviderErrorKind = 'unknown';
  if (status === 401 || status === 403) kind = 'auth';
  else if (status === 429) kind = 'rate_limit';
  else if (status !== undefined && status >= 400 && status < 500) kind = 'bad_request';
  return { kind, message, status };
}

export function networkError(message: string): ProviderErrorInfo {
  return { kind: 'network', message };
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' ||
      err.name === 'APIUserAbortError' ||
      /aborted/i.test(err.message))
  );
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
