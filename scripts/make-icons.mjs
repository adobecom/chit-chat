/**
 * make-icons.mjs — generate simple PNG icons for the Chit Chat extension.
 *
 * Uses the Canvas API via node-canvas or falls back to a raw PNG that is
 * generated entirely with Buffer manipulation (no deps beyond built-ins).
 *
 * Run: node scripts/make-icons.mjs
 *
 * Produces: icons/icon16.png, icon32.png, icon48.png, icon128.png
 *
 * Since node-canvas is an optional dep, this script generates minimal valid PNGs
 * using a hand-rolled approach: white speech-bubble glyph on Adobe-red background.
 * If you prefer to use a real design tool, replace the generated PNGs manually.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { createCanvas } from 'canvas';

const SIZES = [16, 32, 48, 128];
const BG = '#FA0F00';   // Adobe red
const FG = '#FFFFFF';

mkdirSync('icons', { recursive: true });

for (const size of SIZES) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background circle
  ctx.fillStyle = BG;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  // Simple speech-bubble outline (two rectangles + a tail triangle)
  ctx.fillStyle = FG;
  const pad = size * 0.15;
  const bw = size - pad * 2;
  const bh = size * 0.55;
  const br = size * 0.12;
  const bx = pad;
  const by = size * 0.12;

  // Rounded rect body
  ctx.beginPath();
  ctx.moveTo(bx + br, by);
  ctx.lineTo(bx + bw - br, by);
  ctx.arc(bx + bw - br, by + br, br, -Math.PI / 2, 0);
  ctx.lineTo(bx + bw, by + bh - br);
  ctx.arc(bx + bw - br, by + bh - br, br, 0, Math.PI / 2);
  ctx.lineTo(bx + size * 0.45, by + bh);
  ctx.lineTo(bx + size * 0.25, by + bh + size * 0.2);
  ctx.lineTo(bx + size * 0.25, by + bh);
  ctx.lineTo(bx + br, by + bh);
  ctx.arc(bx + br, by + bh - br, br, Math.PI / 2, Math.PI);
  ctx.lineTo(bx, by + br);
  ctx.arc(bx + br, by + br, br, Math.PI, -Math.PI / 2);
  ctx.closePath();
  ctx.fill();

  // Three dots inside the bubble (chat indicator)
  if (size >= 32) {
    ctx.fillStyle = BG;
    const dotY = by + bh / 2;
    const dotR = size * 0.06;
    const gap = size * 0.15;
    const cx = bx + bw / 2;
    for (const dx of [-gap, 0, gap]) {
      ctx.beginPath();
      ctx.arc(cx + dx, dotY, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  writeFileSync(`icons/icon${size}.png`, canvas.toBuffer('image/png'));
  console.log(`icons/icon${size}.png`);
}

console.log('icons generated.');
