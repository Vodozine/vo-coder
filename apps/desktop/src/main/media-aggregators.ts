/**
 * fal.ai and Replicate — model aggregators. One integration each unlocks dozens
 * of IMAGE and VIDEO models (FLUX, SDXL, Kling, Luma, Hunyuan, Wan, Pika…),
 * because video has no cross-provider standard to hang a plain endpoint off.
 *
 * Both are submit-job-then-poll. Each helper takes a model id + a prompt-shaped
 * input and returns the finished media as bytes, so image-gen and video-gen can
 * share them and only differ in the model id they pass.
 */

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('Cancelled.'));
      },
      { once: true },
    );
  });

type Json = Record<string, unknown>;

function asObj(v: unknown): Json | undefined {
  return v && typeof v === 'object' ? (v as Json) : undefined;
}

/** Dig a media URL out of the many shapes these APIs return. */
function firstMediaUrl(v: unknown): string | undefined {
  if (typeof v === 'string') return /^https?:\/\//.test(v) ? v : undefined;
  if (Array.isArray(v)) {
    for (const item of v) {
      const u = firstMediaUrl(item);
      if (u) return u;
    }
    return undefined;
  }
  const o = asObj(v);
  if (!o) return undefined;
  if (typeof o.url === 'string') return o.url;
  for (const key of ['video', 'image', 'images', 'output', 'data', 'artifacts', 'assets']) {
    if (key in o) {
      const u = firstMediaUrl(o[key]);
      if (u) return u;
    }
  }
  return undefined;
}

async function download(url: string, signal: AbortSignal): Promise<Buffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`downloading the result returned ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * fal.ai queue: POST https://queue.fal.run/{model} → {request_id, status_url,
 * response_url}; poll status_url until COMPLETED; read response_url for the URL.
 */
export async function falRun(
  model: string,
  input: Json,
  key: string,
  signal: AbortSignal,
  pollMs = 4000,
): Promise<Buffer> {
  const submit = await fetch(`https://queue.fal.run/${model}`, {
    method: 'POST',
    headers: { authorization: `Key ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  if (!submit.ok) {
    throw new Error(`fal.ai returned ${submit.status}: ${(await submit.text().catch(() => '')).slice(0, 200)}`);
  }
  const q = (await submit.json()) as {
    request_id?: string;
    status_url?: string;
    response_url?: string;
  };
  const statusUrl = q.status_url ?? `https://queue.fal.run/${model}/requests/${q.request_id}/status`;
  const responseUrl = q.response_url ?? `https://queue.fal.run/${model}/requests/${q.request_id}`;
  const auth = { authorization: `Key ${key}` };
  for (;;) {
    await sleep(pollMs, signal);
    const st = await fetch(statusUrl, { headers: auth, signal });
    if (!st.ok) throw new Error(`fal.ai status returned ${st.status}`);
    const sj = (await st.json()) as { status?: string };
    if (sj.status === 'COMPLETED') break;
    if (sj.status === 'FAILED' || sj.status === 'ERROR') throw new Error('fal.ai job failed.');
  }
  const res = await fetch(responseUrl, { headers: auth, signal });
  const url = firstMediaUrl(await res.json().catch(() => ({})));
  if (!url) throw new Error('fal.ai finished but returned no media URL.');
  return download(url, signal);
}

/**
 * Replicate: POST /v1/models/{owner}/{name}/predictions (or /v1/predictions with
 * a version when the model id is "owner/name:version"). `Prefer: wait` returns
 * the finished prediction when it's quick; otherwise poll urls.get.
 */
export async function replicateRun(
  model: string,
  input: Json,
  key: string,
  signal: AbortSignal,
  pollMs = 4000,
): Promise<Buffer> {
  const versioned = model.includes(':');
  const createUrl = versioned
    ? 'https://api.replicate.com/v1/predictions'
    : `https://api.replicate.com/v1/models/${model}/predictions`;
  const body: Json = versioned ? { version: model.split(':')[1], input } : { input };
  const submit = await fetch(createUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', prefer: 'wait' },
    body: JSON.stringify(body),
    signal,
  });
  if (!submit.ok) {
    throw new Error(
      `Replicate returned ${submit.status}: ${(await submit.text().catch(() => '')).slice(0, 200)}`,
    );
  }
  let pred = (await submit.json()) as {
    id?: string;
    status?: string;
    output?: unknown;
    urls?: { get?: string };
    error?: unknown;
  };
  const done = new Set(['succeeded', 'failed', 'canceled']);
  while (pred.status && !done.has(pred.status)) {
    await sleep(pollMs, signal);
    const getUrl = pred.urls?.get ?? `https://api.replicate.com/v1/predictions/${pred.id}`;
    const r = await fetch(getUrl, { headers: { authorization: `Bearer ${key}` }, signal });
    if (!r.ok) throw new Error(`Replicate poll returned ${r.status}`);
    pred = await r.json();
  }
  if (pred.status !== 'succeeded') {
    throw new Error(`Replicate ${pred.status ?? 'error'}${pred.error ? `: ${String(pred.error)}` : ''}`);
  }
  const url = firstMediaUrl(pred.output);
  if (!url) throw new Error('Replicate finished but returned no output URL.');
  return download(url, signal);
}
