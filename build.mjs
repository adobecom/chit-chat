/**
 * build.mjs — esbuild config for chit-chat.
 *
 * Outputs three bundles into dist/:
 *   background.js  — MV3 service worker (ESM, no DOM)
 *   content.js     — injected into the host page (IIFE, no external deps)
 *   sidepanel.js   — the side-panel React + S2 app (ESM)
 *
 * Usage:
 *   node build.mjs           # one-shot build (minified)
 *   node build.mjs --watch   # watch mode (unminified)
 */

import * as esbuild from 'esbuild';
import macros from 'unplugin-parcel-macros';

const watch = process.argv.includes('--watch');
const minify = !watch;

// Instantiate once; reused for both build and watch contexts.
const macroPlugin = macros.esbuild();

// Native esbuild locale-trimming plugin.
// Replaces @react-aria/optimize-locales-plugin (which uses the unplugin adapter and
// creates virtual namespace paths that esbuild can't resolve without a matching load hook).
// Any locale import that is NOT en-US inside a react-aria/react-spectrum package
// is redirected to an empty module, cutting significant bundle size.
const LOCALE_RE = /[a-z]{2}-[A-Z]{2}/;
const ARIA_PKG_RE = /@react-(aria|spectrum|stately)|react-aria-components|react-stately/;
const localePlugin = {
  name: 'optimize-locales',
  setup(build) {
    build.onResolve({ filter: LOCALE_RE }, (args) => {
      if (!ARIA_PKG_RE.test(args.resolveDir)) return null;
      const m = args.path.match(LOCALE_RE);
      if (m && m[0] !== 'en-US') {
        return { path: args.path, namespace: 'empty-locale' };
      }
      return null;
    });
    build.onLoad({ filter: /.*/, namespace: 'empty-locale' }, () => ({
      contents: 'export default {}',
      loader: 'js',
    }));
  },
};

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
  // Side panel — ESM React + S2 app.
  // - entry is .jsx so the macro plugin and esbuild both agree on the JSX loader.
  // - loader does NOT inherit shared '.css':'text' so page.css is emitted as a real stylesheet.
  // - macroPlugin must be first so style() macro calls resolve before bundling.
  {
    ...shared,
    entryPoints: ['src/sidepanel.jsx'],
    outfile: 'dist/sidepanel.js',
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    loader: { '.jsx': 'jsx' },
    jsx: 'automatic',
    jsxImportSource: 'react',
    plugins: [macroPlugin, localePlugin],
    // S2's vendored TableView.css ships an empty `:has()` selector that esbuild
    // flags as a CSS syntax error (still present as of S2 1.5.1). It's in a
    // component we don't use and can't be patched in node_modules — silence just
    // this warning for this build.
    logOverride: { 'css-syntax-error': 'silent' },
  },
];

if (watch) {
  const ctxs = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(ctxs.map((ctx) => ctx.watch()));
  console.log('watching…');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
