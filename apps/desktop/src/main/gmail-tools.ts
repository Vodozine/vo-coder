import type { ToolSpec } from '@vo-coder/providers';

/**
 * Built-in Gmail tools for every agent — real Gmail API calls, gated on the
 * user having connected their account (Settings → Gmail, google-oauth.ts). No
 * MCP server: the access token comes from GoogleOAuth.accessToken() and each
 * call hits gmail.googleapis.com directly.
 */

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_LIST = 20;
const MAX_HYDRATE = 10; // how many search hits we fetch headers/snippets for

export const GMAIL_TOOL_NAMES = new Set([
  'gmail_search',
  'gmail_read',
  'gmail_send',
  'gmail_list_labels',
]);

export function gmailToolSpecs(): ToolSpec[] {
  return [
    {
      name: 'gmail_search',
      description:
        "Search the signed-in user's Gmail. Uses Gmail search syntax " +
        "(e.g. 'from:alice@x.com', 'subject:invoice', 'is:unread', 'has:attachment', " +
        "'newer_than:7d', 'label:work'). Returns matching messages with sender, subject, " +
        'date, snippet, and an id to pass to gmail_read.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: "Gmail search query, e.g. 'is:unread from:boss'" },
          maxResults: { type: 'number', description: `1–${MAX_LIST} (default 10)` },
        },
        required: ['query'],
      },
    },
    {
      name: 'gmail_read',
      description: 'Read one email in full by its id (from gmail_search): headers and body text.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The message id from gmail_search' } },
        required: ['id'],
      },
    },
    {
      name: 'gmail_send',
      description:
        "Send an email from the signed-in user's Gmail account. Plain-text body. " +
        'This actually sends — confirm the recipient and content with the user first unless ' +
        'they clearly asked to send now.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient(s), comma-separated' },
          subject: { type: 'string' },
          body: { type: 'string', description: 'Plain-text message body' },
          cc: { type: 'string', description: 'Optional Cc, comma-separated' },
          bcc: { type: 'string', description: 'Optional Bcc, comma-separated' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
    {
      name: 'gmail_list_labels',
      description: 'List the account’s Gmail labels (INBOX, SENT, custom labels) with their ids.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

function b64urlDecode(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** RFC 2047 encode a header value only if it has non-ASCII characters. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
  headers?: Array<{ name: string; value: string }>;
}

function headerOf(headers: Array<{ name: string; value: string }> | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

/** Walk a Gmail payload for the best readable body (text/plain, then stripped html). */
function extractBody(payload: GmailPart | undefined): string {
  if (!payload) return '';
  const plain = findPart(payload, 'text/plain');
  if (plain?.body?.data) return b64urlDecode(plain.body.data);
  const html = findPart(payload, 'text/html');
  if (html?.body?.data) {
    return b64urlDecode(html.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (payload.body?.data) return b64urlDecode(payload.body.data);
  return '';
}

function findPart(part: GmailPart, mime: string): GmailPart | undefined {
  if (part.mimeType === mime && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child, mime);
    if (hit) return hit;
  }
  return undefined;
}

export async function executeGmailTool(
  name: string,
  args: unknown,
  deps: { token: () => Promise<string | null> },
): Promise<{ content: string; isError?: boolean }> {
  const token = await deps.token();
  if (!token) {
    return {
      content: 'Gmail is not connected. Open Settings → Gmail and click Connect, then try again.',
      isError: true,
    };
  }
  const a = (args ?? {}) as Record<string, unknown>;
  const api = async (
    path: string,
    init?: RequestInit,
  ): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, json };
  };

  try {
    switch (name) {
      case 'gmail_search': {
        const query = String(a.query ?? '').trim();
        if (!query) return { content: 'No query given.', isError: true };
        const max = Math.min(Math.max(Number(a.maxResults) || 10, 1), MAX_LIST);
        const list = await api(
          `/messages?q=${encodeURIComponent(query)}&maxResults=${max}`,
        );
        if (!list.ok) return { content: apiError(list.status, list.json), isError: true };
        const messages = (list.json.messages as Array<{ id: string }> | undefined) ?? [];
        if (messages.length === 0) return { content: `No messages match "${query}".` };
        const hydrate = messages.slice(0, MAX_HYDRATE);
        const rows = await Promise.all(
          hydrate.map(async (m) => {
            const full = await api(
              `/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
            );
            const headers = (full.json.payload as GmailPart | undefined)?.headers;
            const snippet = String(full.json.snippet ?? '');
            return (
              `• ${headerOf(headers, 'Subject') || '(no subject)'}\n` +
              `  from ${headerOf(headers, 'From')} · ${headerOf(headers, 'Date')}\n` +
              `  id: ${m.id}${snippet ? `\n  ${snippet}` : ''}`
            );
          }),
        );
        const more =
          messages.length > hydrate.length
            ? `\n\n(+${messages.length - hydrate.length} more match — narrow the query to see them)`
            : '';
        return { content: rows.join('\n\n') + more };
      }

      case 'gmail_read': {
        const id = String(a.id ?? '').trim();
        if (!id) return { content: 'No message id given.', isError: true };
        const msg = await api(`/messages/${id}?format=full`);
        if (!msg.ok) return { content: apiError(msg.status, msg.json), isError: true };
        const payload = msg.json.payload as GmailPart | undefined;
        const h = payload?.headers;
        const body = extractBody(payload) || String(msg.json.snippet ?? '(no readable body)');
        return {
          content:
            `From: ${headerOf(h, 'From')}\n` +
            `To: ${headerOf(h, 'To')}\n` +
            (headerOf(h, 'Cc') ? `Cc: ${headerOf(h, 'Cc')}\n` : '') +
            `Date: ${headerOf(h, 'Date')}\n` +
            `Subject: ${headerOf(h, 'Subject')}\n\n` +
            body,
        };
      }

      case 'gmail_send': {
        const to = String(a.to ?? '').trim();
        const subject = String(a.subject ?? '');
        const body = String(a.body ?? '');
        if (!to || !body) return { content: 'Need at least "to" and "body".', isError: true };
        const lines = [
          `To: ${to}`,
          a.cc ? `Cc: ${String(a.cc)}` : '',
          a.bcc ? `Bcc: ${String(a.bcc)}` : '',
          `Subject: ${encodeHeader(subject)}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset="UTF-8"',
          '',
          body,
        ].filter((l) => l !== '');
        const raw = b64urlEncode(lines.join('\r\n'));
        const sent = await api('/messages/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ raw }),
        });
        if (!sent.ok) return { content: apiError(sent.status, sent.json), isError: true };
        return { content: `Sent to ${to} (message id ${String(sent.json.id ?? '?')}).` };
      }

      case 'gmail_list_labels': {
        const res = await api('/labels');
        if (!res.ok) return { content: apiError(res.status, res.json), isError: true };
        const labels = (res.json.labels as Array<{ id: string; name: string }> | undefined) ?? [];
        return {
          content: labels.map((l) => `${l.name} (${l.id})`).join('\n') || '(no labels)',
        };
      }

      default:
        return { content: `Unknown Gmail tool "${name}".`, isError: true };
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}

function apiError(status: number, json: Record<string, unknown>): string {
  const msg = (json.error as { message?: string } | undefined)?.message ?? '';
  if (status === 401 || status === 403) {
    return `Gmail rejected the request (${status})${msg ? `: ${msg}` : ''}. Reconnect in Settings → Gmail.`;
  }
  return `Gmail API error ${status}${msg ? `: ${msg}` : ''}.`;
}
