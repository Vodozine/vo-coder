import { useMemo } from 'react';
import QRCode from 'qrcode';

/**
 * The address and the key, as something a phone can read off the screen.
 *
 * Typing a 32-character key into a phone is miserable and error-prone, and the
 * error it produces — a refused key — looks exactly like a wrong key rather
 * than a mistyped one. A camera does it in a second and cannot fat-finger it.
 *
 * Drawn as an SVG rather than a canvas because it has to stay crisp at
 * whatever size the panel gives it, and because an SVG needs no ref, no
 * effect, and no second render pass to appear.
 */

/** What the phone reads. Kept short — every character costs QR density. */
export function pairingPayload(address: string, key: string, tls: boolean): string {
  const q = new URLSearchParams({ a: address, k: key });
  // Only stated when it is on, since off is what a phone can actually use and
  // the common case should not cost bytes.
  if (tls) q.set('tls', '1');
  return `vodo://pair?${q.toString()}`;
}

export function PairingCode({
  address,
  token,
  tls,
  size = 200,
}: {
  address: string;
  token: string;
  tls: boolean;
  size?: number;
}) {
  const path = useMemo(() => {
    if (!address || !token) return null;
    try {
      // Q rather than M: this gets read off a glossy screen, often at an
      // angle, sometimes with a reflection across it. The extra redundancy
      // costs a slightly denser code and buys a scan that works first time.
      const qr = QRCode.create(pairingPayload(address, token, tls), {
        errorCorrectionLevel: 'Q',
      });
      const n = qr.modules.size;
      const data = qr.modules.data;
      // One path of many little squares beats one <rect> per module: a 41x41
      // code is 1,681 elements, and the browser lays out every one of them.
      let d = '';
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          if (data[y * n + x]) d += `M${x} ${y}h1v1h-1z`;
        }
      }
      return { d, n };
    } catch {
      // A payload too long for any QR version. Nothing to draw, and the
      // caller shows the fields instead — which still work.
      return null;
    }
  }, [address, token, tls]);

  if (!path) return null;

  const QUIET = 2;
  const span = path.n + QUIET * 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${span} ${span}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`Pairing code for ${address}`}
      style={{ borderRadius: 8, display: 'block' }}
    >
      {/* White plate, not transparent: a dark-themed panel behind a QR makes
          the quiet zone vanish, and a scanner needs that margin to find the
          code at all. */}
      <rect width={span} height={span} fill="#ffffff" />
      <g transform={`translate(${QUIET} ${QUIET})`}>
        <path d={path.d} fill="#000000" />
      </g>
    </svg>
  );
}
