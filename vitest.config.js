import { defineConfig } from 'vitest/config';

// jsdom, because everything worth testing here touches the DOM (mention
// highlighting walks a parsed document, sanitize drives DOMPurify).
//
// `css: false` + the S2/Quill CSS stubs below are load-bearing: sidepanel.jsx
// imports `@react-spectrum/s2/page.css` and S2's component modules pull in
// dozens of their own .css files, which Node cannot load as ES modules
// (verified: `TypeError: Unknown file extension ".css"`). The real build handles
// this through build.mjs's esbuild loaders; under vitest we stub them out, since
// no test here asserts anything about styling.
export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['test/**/*.test.{js,jsx}'],
    setupFiles: ['./test/setup.js'],
    css: false,
    server: {
      deps: {
        // Force S2 + Quill through vite's transform pipeline (rather than Node's
        // native ESM loader) so their CSS imports hit the `css: false` stub.
        inline: [/@react-spectrum\/s2/, /^quill$/],
      },
    },
  },
  // vitest 4 transforms with oxc; setting `esbuild` here is ignored with a
  // warning. JSX is automatic by default for .jsx files, so no config needed.
});
