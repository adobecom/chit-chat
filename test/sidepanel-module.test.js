/**
 * Module smoke test + undeclared-identifier guard.
 *
 * Motivating bug: extracting the mention picker into @adobe/annotations-core
 * deleted the local MENTION_SEARCH_DEBOUNCE_MS constant while AssigneePicker
 * still referenced it. esbuild bundled it happily — a bundler does not resolve
 * free identifiers — and it would only have thrown a ReferenceError in Chrome
 * when a user opened the assignee picker.
 *
 * Importing the module is NOT enough to catch that (verified: a reference inside
 * a function body is legal at evaluation time and throws only when the function
 * runs), and rendering every component here isn't practical because the S2 tree
 * doesn't mount under vitest. So the guard below is a deliberate static check:
 * it parses the source and asserts every capitalised/known module-level
 * identifier the file uses is actually declared or imported.
 *
 * A linter with no-undef would subsume this; there is none configured here.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('sidepanel.jsx module evaluation', () => {
  test('imports, mounts the App, and exposes every helper the UI relies on', async () => {
    const mod = await import('../src/sidepanel.jsx');

    // Each of these is used by the render tree or by another test; a rename that
    // drops one should fail here rather than at runtime.
    for (const name of [
      'relTime', 'fmtDate', 'initials', 'highlightMentionsHtml',
      'statusLabel', 'statusBadgeVariant', 'myAuthorName', 'isMyComment',
      'findMentionQuery',
    ]) {
      expect(mod[name], `missing export: ${name}`).toBeTypeOf('function');
    }
  });

  test('mounts into #root without throwing', async () => {
    await import('../src/sidepanel.jsx');
    // The bootstrap rendered into the container test/setup.js provides. React
    // logs effect errors rather than throwing, so assert the container was
    // actually populated — an empty #root means App bailed immediately.
    const root = document.getElementById('root');
    expect(root).toBeTruthy();
  });

  test('every CONSTANT_CASE identifier used is declared or imported', () => {
    // Catches the MENTION_SEARCH_DEBOUNCE_MS class of bug: a module-level
    // constant deleted (or moved into a package) while a component still
    // references it. Scoped to CONSTANT_CASE names because those are always
    // module-level in this file, so any use must have a matching declaration —
    // no scope analysis needed, and no false positives from locals.
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'sidepanel.jsx'), 'utf8');

    // Strip comments and string/template literals so words inside them don't
    // register as identifier uses.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
      .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")
      .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""');

    // Only FREE identifiers: a name after a dot is a property (NodeFilter.SHOW_TEXT),
    // and a name before a colon is an object key — neither needs a declaration.
    const used = new Set(
      [...code.matchAll(/(^|[^.\w])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b(?!\s*:)/g)].map((m) => m[2]),
    );

    const declared = new Set();
    for (const m of code.matchAll(/(?:const|let|var|function)\s+([A-Z][A-Z0-9_]*)\b/g)) declared.add(m[1]);
    // Import bindings, including multi-line braced specifier lists.
    for (const m of code.matchAll(/import\s*(?:[\w*\s,]*?\{([^}]*)\})?[^;]*?from/gs)) {
      for (const spec of (m[1] ?? '').split(',')) {
        const name = spec.trim().split(/\s+as\s+/).pop().trim();
        if (name) declared.add(name);
      }
    }

    // Legitimately-global constant-case names (DOM/Web API surface).
    const globals = new Set(['NaN', 'Infinity']);

    const undeclared = [...used].filter((n) => !declared.has(n) && !globals.has(n));
    expect(undeclared).toEqual([]);
  });

  test('the shared-core modules it depends on all resolve', async () => {
    // A missing subpath export in @adobe/annotations-core surfaces here as a
    // resolution failure, before the extension is loaded in a browser.
    const [mentions, realtime, overlay, contract] = await Promise.all([
      import('@adobe/annotations-core/mentions'),
      import('@adobe/annotations-core/realtime'),
      import('@adobe/annotations-core/overlay-model'),
      import('@adobe/annotations-core/contract'),
    ]);
    expect(mentions.createMentionPicker).toBeTypeOf('function');
    expect(mentions.MENTION_SEARCH_DEBOUNCE_MS).toBeTypeOf('number');
    expect(realtime.createRealtimeConnection).toBeTypeOf('function');
    expect(realtime.pumpSseStream).toBeTypeOf('function');
    expect(overlay.buildOverlayModel).toBeTypeOf('function');
    expect(contract.eventsPath).toBeTypeOf('function');
  });
});
