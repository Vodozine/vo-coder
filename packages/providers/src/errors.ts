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

/**
 * Turn a provider's raw error body into something a human can read: pull the
 * message out of the common JSON shapes, redact leaked account/function ids
 * (NVIDIA puts them in 404 text), and add a hint for the frequent cases.
 */
export function humanizeErrorBody(status: number | undefined, body: string): string {
  let msg = (body ?? '').trim();
  try {
    const j = JSON.parse(msg) as {
      detail?: string;
      title?: string;
      message?: string;
      error?: { message?: string } | string;
    };
    msg =
      j.detail ??
      (typeof j.error === 'string' ? j.error : j.error?.message) ??
      j.message ??
      j.title ??
      msg;
  } catch {
    /* not JSON — use as-is */
  }
  msg = msg
    .replace(/for account '[^']*'/gi, 'for your account')
    .replace(/Function '[0-9a-f-]{6,}'/gi, 'This model');
  if (status === 404 || /not found/i.test(msg)) {
    return `Model not available on this endpoint (${msg}). Pick a different model.`;
  }
  if (/resource ?exhausted|too many requests|rate.?limit|quota/i.test(msg)) {
    return `Endpoint is rate-limited right now (${msg}). Try again shortly or switch models.`;
  }
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg || 'Request failed.';
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
