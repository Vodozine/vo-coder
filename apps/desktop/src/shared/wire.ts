/**
 * Bytes over a JSON protocol.
 *
 * Several channels carry raw bytes rather than text — spoken audio out,
 * recorded audio in, font files, a clip to play. JSON has no way to say
 * "these are bytes": `JSON.stringify(new ArrayBuffer(8))` is `{}`, silently
 * and without error. A remote front end would get an empty object where it
 * expected audio, and the failure would look like a broken feature rather
 * than a broken wire.
 *
 * So anything binary is wrapped on the way out and unwrapped on the way in.
 * Done generically rather than channel by channel, because the next binary
 * channel somebody adds should not have to know this file exists.
 */

/** Marker shape. Deliberately odd so it cannot collide with real app data. */
interface WireBinary {
  __wireBinary: true;
  base64: string;
}

/**
 * Base64 costs a third more than the bytes it carries, and the whole message
 * is buffered at both ends. Fine for a spoken sentence or a font; not for a
 * film. Anything larger belongs on the HTTP side-channel, where it can be
 * streamed and seeked instead of swallowed whole.
 */
export const MAX_INLINE_BINARY = 8 * 1024 * 1024;

export class PayloadTooLarge extends Error {
  constructor(bytes: number) {
    super(
      `Payload of ${Math.round(bytes / 1024 / 1024)} MB is too large to send inline — ` +
        `it needs the media URL instead.`,
    );
    this.name = 'PayloadTooLarge';
  }
}

function isBinaryMarker(v: unknown): v is WireBinary {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>)['__wireBinary'] === true &&
    typeof (v as Record<string, unknown>)['base64'] === 'string'
  );
}

/** Replace every ArrayBuffer / typed array with something JSON can carry. */
export function encodeWire(value: unknown): unknown {
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > MAX_INLINE_BINARY) throw new PayloadTooLarge(value.byteLength);
    return {
      __wireBinary: true,
      base64: Buffer.from(new Uint8Array(value)).toString('base64'),
    } satisfies WireBinary;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    if (view.byteLength > MAX_INLINE_BINARY) throw new PayloadTooLarge(view.byteLength);
    return {
      __wireBinary: true,
      base64: Buffer.from(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      ).toString('base64'),
    } satisfies WireBinary;
  }
  if (Array.isArray(value)) return value.map(encodeWire);
  if (value && typeof value === 'object') {
    // Plain objects only. A Date or a class instance would not survive JSON
    // anyway, and rebuilding one here would be a lie about what arrived.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = encodeWire(v);
    return out;
  }
  return value;
}

/** Put the bytes back, so the far side sees what the near side sent. */
export function decodeWire(value: unknown): unknown {
  if (isBinaryMarker(value)) {
    const buf = Buffer.from(value.base64, 'base64');
    // A fresh copy, not a view into a pooled Buffer: Node reuses allocation
    // slabs, so handing back `buf.buffer` would expose unrelated memory and
    // give a length nobody asked for.
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  if (Array.isArray(value)) return value.map(decodeWire);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = decodeWire(v);
    return out;
  }
  return value;
}
