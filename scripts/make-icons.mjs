/**
 * make-icons.mjs — generate the extension's PNG icons from favicon.png.
 *
 * Run: node scripts/make-icons.mjs  (or: npm run icons)
 *
 * Produces icons/icon{16,32,48,128}.png by downscaling the source favicon.
 * Uses macOS's built-in `sips` so there are no npm dependencies. If you're on a
 * platform without `sips`, resize favicon.png into the four sizes with any image
 * tool instead.
 */

import { mkdirSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';

const SOURCE = 'favicon.png';
const SIZES = [16, 32, 48, 128];

if (!existsSync(SOURCE)) {
  console.error(`${SOURCE} not found — place the source icon there first.`);
  process.exit(1);
}

mkdirSync('icons', { recursive: true });

for (const size of SIZES) {
  const out = `icons/icon${size}.png`;
  try {
    execFileSync('sips', ['-z', String(size), String(size), SOURCE, '--out', out], {
      stdio: 'ignore',
    });
  } catch (err) {
    console.error(`Failed to generate ${out}: ${err.message}`);
    console.error('This script requires macOS `sips`. Resize favicon.png manually on other platforms.');
    process.exit(1);
  }
  console.log(out);
}

console.log('icons generated.');
