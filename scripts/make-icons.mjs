/**
 * make-icons.mjs — generate PNG icons for the Chit Chat extension.
 *
 * Renders a red chat-bubble glyph with a white outline (see icons/icon.svg for
 * the vector source — both are generated from the same path formulas). Uses a
 * hand-rolled scanline polygon rasterizer with supersampled anti-aliasing so
 * there's no dependency on node-canvas or any native image library.
 *
 * Run: node scripts/make-icons.mjs
 * Produces: icons/icon16.png, icon32.png, icon48.png, icon128.png
 */

import { writeFileSync, mkdirSync } from 'fs';
import zlib from 'zlib';

const SIZES = [16, 32, 48, 128];
const RED = [0xfa, 0x0f, 0x00, 255];
const WHITE = [0xff, 0xff, 0xff, 255];
const SUPERSAMPLE = 4;

mkdirSync('icons', { recursive: true });

// ── Geometry: rounded-rect chat bubble with a tail, tessellated into a polygon ──

function arcPoints(cx, cy, r, startAngle, endAngle, segments = 8) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const a = startAngle + (endAngle - startAngle) * (i / segments);
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

// bx,by,bw,bh,br describe the rounded-rect body; the tail is a small triangle
// hanging off the bottom edge between tailLeftX and tailRightX.
function bubblePolygon({ bx, by, bw, bh, br, tailLeftX, tailRightX, tailTipY }) {
  const pts = [];
  pts.push([bx + br, by]);
  pts.push([bx + bw - br, by]);
  pts.push(...arcPoints(bx + bw - br, by + br, br, -Math.PI / 2, 0));
  pts.push([bx + bw, by + bh - br]);
  pts.push(...arcPoints(bx + bw - br, by + bh - br, br, 0, Math.PI / 2));
  pts.push([tailRightX, by + bh]);
  pts.push([tailLeftX, tailTipY]);
  pts.push([tailLeftX, by + bh]);
  pts.push([bx + br, by + bh]);
  pts.push(...arcPoints(bx + br, by + bh - br, br, Math.PI / 2, Math.PI));
  pts.push([bx, by + br]);
  pts.push(...arcPoints(bx + br, by + br, br, Math.PI, (3 * Math.PI) / 2));
  return pts;
}

// Base (red) geometry, and an outward-offset (white) version underneath it —
// offsetting a rounded rect by t just grows the radius by t and pushes each
// edge out by t, so the visible ring between the two polygons is the outline.
function bubbleShapes(size, strokeWidth) {
  const pad = size * 0.15;
  const bw = size - pad * 2;
  const bh = size * 0.55;
  const br = size * 0.12;
  const bx = pad;
  const by = size * 0.12;
  const tailLeftX = bx + size * 0.25;
  const tailRightX = bx + size * 0.45;
  const tailTipY = by + bh + size * 0.2;

  const inner = bubblePolygon({ bx, by, bw, bh, br, tailLeftX, tailRightX, tailTipY });

  const t = strokeWidth;
  const outer = bubblePolygon({
    bx: bx - t,
    by: by - t,
    bw: bw + 2 * t,
    bh: bh + 2 * t,
    br: br + t,
    tailLeftX: tailLeftX - t * 0.3,
    tailRightX: tailRightX + t * 0.6,
    tailTipY: tailTipY + t,
  });

  return { inner, outer };
}

// ── Rasterizer: supersampled scanline point-in-polygon fill ──

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function fillPolygon(buf, size, poly, [r, g, b, a]) {
  const alphaScale = a / 255;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = px + (sx + 0.5) / SUPERSAMPLE;
          const y = py + (sy + 0.5) / SUPERSAMPLE;
          if (pointInPolygon(x, y, poly)) hits++;
        }
      }
      const coverage = hits / (SUPERSAMPLE * SUPERSAMPLE);
      if (coverage === 0) continue;
      const alpha = coverage * alphaScale;
      const idx = (py * size + px) * 4;
      const dstA = buf[idx + 3] / 255;
      const outA = alpha + dstA * (1 - alpha);
      for (let c = 0; c < 3; c++) {
        const src = [r, g, b][c];
        const dst = buf[idx + c];
        buf[idx + c] = outA === 0 ? 0 : (src * alpha + dst * dstA * (1 - alpha)) / outA;
      }
      buf[idx + 3] = outA * 255;
    }
  }
}

// ── PNG encoding (RGBA, 8-bit) using zlib for the IDAT compressed stream ──

function crc32(buf) {
  let crc = 0xffffffff;
  const table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeB = Buffer.from(type, 'ascii');
  const lenB = Buffer.alloc(4);
  lenB.writeUInt32BE(data.length);
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
  return Buffer.concat([lenB, typeB, data, crcB]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA

  const rowLen = 1 + size * 4;
  const raw = Buffer.alloc(size * rowLen);
  for (let y = 0; y < size; y++) {
    const base = y * rowLen;
    raw[base] = 0; // filter: none
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), base + 1);
  }
  const compressed = zlib.deflateSync(raw);

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

// ── Generate ──

for (const size of SIZES) {
  const strokeWidth = Math.max(1, Math.round(size * 0.07));
  const { inner, outer } = bubbleShapes(size, strokeWidth);

  const buf = new Float64Array(size * size * 4); // transparent RGBA, higher precision for blending
  fillPolygon(buf, size, outer, WHITE);
  fillPolygon(buf, size, inner, RED);

  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = Math.round(Math.min(255, Math.max(0, buf[i])));

  writeFileSync(`icons/icon${size}.png`, encodePng(size, rgba));
  console.log(`icons/icon${size}.png`);
}

console.log('icons generated.');
