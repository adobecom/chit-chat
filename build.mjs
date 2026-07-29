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
    // Pin react/react-dom to THIS package's copy.
    //
    // @adobe/annotations-core declares them as peerDependencies, but its own
    // devDependencies (@testing-library/react, for its vitest suite) install a
    // second copy under packages/annotations-core/node_modules/. That copy is
    // invisible when the core is installed as a published tarball, and very
    // visible when it is SYMLINKED for local development via
    // scripts/link-annotations-core.sh — esbuild then resolves the core's `react`
    // import from the nested copy and bundles BOTH.
    //
    // The failure is not subtle but it is easy to misattribute: two Reacts share
    // one component tree, so a component imported from the core (QuillEditor)
    // renders against a null dispatcher and throws "Cannot read properties of
    // null (reading 'useRef')" the moment a thread detail view mounts — with no
    // mention of React or the core in the message. milo's gulpfile.mjs has
    // carried this same alias for the same reason; this build had no equivalent,
    // so every LINKED build was broken while the published one worked, which is
    // the worst possible split for a pre-publish verification step.
    alias: {
      react: 'react',
      'react-dom': 'react-dom',
    },
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
