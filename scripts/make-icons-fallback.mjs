/**
 * make-icons-fallback.mjs — generate placeholder PNGs (solid Adobe-red squares)
 * using only Node.js built-ins + hand-crafted PNG bytes.
 *
 * Each PNG is a minimal RGBA image. The pixel data is a flat red (#FA0F00) fill.
 * Replace these with real icons using any image editor before publishing.
 *
 * Run: node scripts/make-icons-fallback.mjs
 */

import { writeFileSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import zlib from 'zlib';

const SIZES = [16, 32, 48, 128];

mkdirSync('icons', { recursive: true });

function crc32(buf) {
  let crc = 0xffffffff;
  const table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeB = Buffer.from(type, 'ascii');
  const lenB = Buffer.alloc(4); lenB.writeUInt32BE(data.length);
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
  return Buffer.concat([lenB, typeB, data, crcB]);
}

function makePng(size) {
  // PNG signature
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR: width, height, bit depth=8, color type=2 (RGB)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

  // Raw pixel rows: each row prefixed with filter byte 0x00
  // Adobe red = R=0xfa G=0x0f B=0x00
  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(size * rowLen, 0);
  for (let y = 0; y < size; y++) {
    const base = y * rowLen;
    raw[base] = 0x00; // filter None
    for (let x = 0; x < size; x++) {
      const p = base + 1 + x * 3;
      raw[p] = 0xfa; raw[p + 1] = 0x0f; raw[p + 2] = 0x00;
    }
  }
  const compressed = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of SIZES) {
  const out = `icons/icon${size}.png`;
  writeFileSync(out, makePng(size));
  console.log(`${out}  (${size}×${size} solid red placeholder)`);
}
console.log('Done. Replace with real icons before publishing.');
