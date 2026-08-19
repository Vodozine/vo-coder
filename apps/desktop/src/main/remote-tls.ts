import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import selfsigned from 'selfsigned';
import { userDataDir } from './paths';

/**
 * A certificate for the link, and a fingerprint to check it by.
 *
 * The key alone stops anyone without it from USING this machine. It does not
 * stop anyone from reading the traffic — and since the key is the first thing
 * sent, somebody watching the network could lift it and then have everything.
 * On a home LAN that means being on the wire already; it is still the whole
 * of the protection, and worth not resting on.
 *
 * No public certificate authority will vouch for "the desktop in the corner",
 * so the host signs its own and the front end pins it. That is stronger here
 * than a CA would be: the front end is not asking "is this certificate valid
 * in general" but "is this the exact machine I paired with", which is the
 * actual question. The fingerprint is shown beside the key in Settings so the
 * two can be compared by eye the first time.
 */

export interface HostCert {
  cert: string;
  key: string;
  /** SHA-256 of the DER certificate, uppercase hex pairs — what Electron reports. */
  fingerprint: string;
}

function certPath(): string {
  return join(userDataDir(), 'remote', 'host-cert.json');
}

/** Colon-separated uppercase hex, the form every tool prints fingerprints in. */
export function fingerprintOf(pem: string): string {
  const der = Buffer.from(
    pem
      .replace(/-----BEGIN CERTIFICATE-----/, '')
      .replace(/-----END CERTIFICATE-----/, '')
      .replace(/\s+/g, ''),
    'base64',
  );
  return (
    createHash('sha256')
      .update(der)
      .digest('hex')
      .toUpperCase()
      .match(/.{2}/g) ?? []
  ).join(':');
}

/**
 * The host's certificate, made once and kept.
 *
 * Kept, not regenerated: a front end pins the fingerprint, so a new
 * certificate every start would look exactly like somebody impersonating the
 * host, and the user would learn to click through the warning — which is the
 * warning being worth nothing.
 */
export async function hostCert(): Promise<HostCert> {
  const path = certPath();
  if (existsSync(path)) {
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8')) as HostCert;
      if (saved.cert && saved.key) return saved;
    } catch {
      /* unreadable — make a new one below */
    }
  }
  // Ten years. This is trusted by fingerprint, not by date, so an expiry that
  // silently breaks a working link years from now would be all cost.
  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate.getTime() + 3650 * 24 * 60 * 60 * 1000);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'vo-coder-host' }], {
    notBeforeDate,
    notAfterDate,
    keySize: 2048,
  });
  const made: HostCert = {
    cert: pems.cert,
    key: pems.private,
    fingerprint: fingerprintOf(pems.cert),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(made, null, 2), 'utf8');
  return made;
}
