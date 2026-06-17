/**
 * build.mjs — esbuild config for chit-chat.
 *
 * Outputs three bundles into dist/:
 *   background.js  — MV3 service worker (ESM, no DOM)
 *   content.js     — injected into the host page (IIFE, no external deps)
 *   sidepanel.js   — the side-panel React app (ESM)
 *
 * Usage:
 *   node build.mjs           # one-shot build (minified)
 *   node build.mjs --watch   # watch mode (unminified)
 */

import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';

const watch = process.argv.includes('--watch');
const minify = !watch;

const shared = {
  bundle: true,
  minify,
  logLevel: 'info',
  loader: { '.css': 'text' },
};

const configs = [
  // Service worker — ESM; no DOM globals
  {
    ...shared,
    entryPoints: ['src/background.js'],
    outfile: 'dist/background.js',
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
  },
  // Content script — IIFE; runs in the host page's main world
  {
    ...shared,
    entryPoints: ['src/content.js'],
    outfile: 'dist/content.js',
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    globalName: 'ChitChatContent',
    banner: { js: '/* chit-chat content script */' },
  },
  // Side panel — ESM React app
  {
    ...shared,
    entryPoints: ['src/sidepanel.js'],
    outfile: 'dist/sidepanel.js',
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    loader: { ...shared.loader, '.js': 'jsx' },
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
];

if (watch) {
  const ctxs = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(ctxs.map((ctx) => ctx.watch()));
  console.log('watching…');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
