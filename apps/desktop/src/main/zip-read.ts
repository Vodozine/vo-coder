import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP reading — enough to pull named files out of a chat-export
 * archive (ChatGPT, Claude, Google Takeout all ship .zip). Aligned with the
 * no-native-modules policy: central directory walked by hand, entries
 * inflated with node:zlib. Whole-file Buffer in memory — export archives are
 * tens to a few hundred MB, and the reader is used once per import, not on a
 * hot path.
 */

export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  method: number;
  localOffset: number;
}

const EOCD_SIG = 0x06054b50;
const EOCD64_LOC_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

interface ZipIndex {
  buf: Buffer;
  entries: ZipEntry[];
}

export function openZip(file: string): ZipIndex {
  const buf = readFileSync(file);
  // End-of-central-directory: scan back through the max comment length.
  const scanFrom = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP file (no end-of-central-directory)');
  let count: number = buf.readUInt16LE(eocd + 10);
  let cdOffset: number = buf.readUInt32LE(eocd + 16);
  // ZIP64: the classic fields max out and the real ones live in a second EOCD.
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const locAt = eocd - 20;
    if (locAt >= 0 && buf.readUInt32LE(locAt) === EOCD64_LOC_SIG) {
      const eocd64 = Number(buf.readBigUInt64LE(locAt + 8));
      if (buf.readUInt32LE(eocd64) !== EOCD64_SIG) throw new Error('corrupt ZIP64 directory');
      count = Number(buf.readBigUInt64LE(eocd64 + 32));
      cdOffset = Number(buf.readBigUInt64LE(eocd64 + 48));
    }
  }
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    let compressedSize: number = buf.readUInt32LE(p + 20);
    let size: number = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset: number = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // ZIP64 extra field: 64-bit values, present in this order for whichever
    // of the classic fields overflowed.
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let e = p + 46 + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const id = buf.readUInt16LE(e);
        const len = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let f = e + 4;
          if (size === 0xffffffff) {
            size = Number(buf.readBigUInt64LE(f));
            f += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(buf.readBigUInt64LE(f));
            f += 8;
          }
          if (localOffset === 0xffffffff) localOffset = Number(buf.readBigUInt64LE(f));
          break;
        }
        e += 4 + len;
      }
    }
    entries.push({ name, size, compressedSize, method, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, entries };
}

/** Inflate one entry to a UTF-8 string. */
export function readZipText(zip: ZipIndex, entry: ZipEntry): string {
  const { buf } = zip;
  if (buf.readUInt32LE(entry.localOffset) !== LOC_SIG) {
    throw new Error(`corrupt local header for "${entry.name}"`);
  }
  const nameLen = buf.readUInt16LE(entry.localOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw.toString('utf8');
  if (entry.method === 8) return inflateRawSync(raw).toString('utf8');
  throw new Error(`unsupported compression method ${entry.method} in "${entry.name}"`);
}
