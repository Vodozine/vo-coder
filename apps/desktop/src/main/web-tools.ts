import type { ToolSpec } from '@vo-coder/providers';

/**
 * Built-in web access for every agent session — no API key, no MCP server.
 * web_search scrapes DuckDuckGo's HTML endpoint (keyless); web_fetch reads a
 * page and strips it to text. Both are read-only and auto-approved.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Vo-Coder/1.0';
const FETCH_TIMEOUT_MS = 20_000;
const MAX_PAGE_CHARS = 40_000;
const MAX_RESULTS = 8;

export function webToolSpecs(): ToolSpec[] {
  return [
    {
      name: 'web_search',
      description:
        'Search the web (DuckDuckGo). Returns titles, URLs, and snippets. Use web_fetch to read a result in full.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          maxResults: { type: 'number', description: `1–${MAX_RESULTS} (default 6)` },
        },
        required: ['query'],
      },
    },
    {
      name: 'web_fetch',
      description:
        'Fetch a URL and return its readable text (HTML stripped, long pages truncated). http/https only.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Absolute http(s) URL' } },
        required: ['url'],
      },
    },
  ];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

async function timedFetch(url: string, accept: string): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { 'user-agent': UA, accept },
      redirect: 'follow',
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function search(query: string, maxResults: number): Promise<string> {
  const res = await timedFetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    'text/html',
  );
  if (!res.ok) throw new Error(`Search returned HTTP ${res.status}.`);
  const html = await res.text();

  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/g;
  const snippets: string[] = [];
  for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) {
    snippets.push(stripTags(m[1] ?? ''));
  }
  for (let m = linkRe.exec(html); m && results.length < maxResults; m = linkRe.exec(html)) {
    let url = decodeEntities(m[1] ?? '');
    // DDG wraps targets in a redirect: //duckduckgo.com/l/?uddg=<encoded>&rut=…
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg?.[1]) url = decodeURIComponent(uddg[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      title: stripTags(m[2] ?? '') || url,
      url,
      snippet: snippets[results.length] ?? '',
    });
  }
  if (results.length === 0) {
    return `No results for "${query}". The search endpoint may be rate-limiting — try a different query, or web_fetch a URL you already know.`;
  }
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
    .join('\n\n');
}

async function fetchPage(rawUrl: string): Promise<string> {
  const url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are supported.');
  const res = await timedFetch(url, 'text/html,application/json,text/plain,*/*');
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const body = await res.text();

  let text: string;
  if (type.includes('html')) {
    text = stripTags(
      body
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' '),
    );
  } else if (type.includes('json')) {
    try {
      text = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      text = body;
    }
  } else {
    text = body;
  }
  if (text.length > MAX_PAGE_CHARS) {
    text = `${text.slice(0, MAX_PAGE_CHARS)}\n…(truncated, ${text.length} chars total)`;
  }
  return text || '(page had no readable text)';
}

export async function executeWebTool(
  name: string,
  args: unknown,
): Promise<{ content: string; isError?: boolean }> {
  const a = (args ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'web_search': {
        const query = String(a.query ?? '').trim();
        if (!query) return { content: 'No query given.', isError: true };
        const max = Math.min(Math.max(Number(a.maxResults) || 6, 1), MAX_RESULTS);
        return { content: await search(query, max) };
      }
      case 'web_fetch':
        return { content: await fetchPage(String(a.url ?? '')) };
      default:
        return { content: `Unknown web tool "${name}".`, isError: true };
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}
