/**
 * How THIS client wires @adobe/annotations-core/thread-store.
 *
 * The store's own behaviour is covered by its suite in milo-logs-deploy. What
 * cannot be tested there — and is what actually broke twice during this
 * migration — is the panel's side of the contract, which is unusual in two ways:
 *
 *   1. `resolveAnchors` is ASYNC and answers from a CACHED REPORT, because the
 *      anchors live in the host page and this context has no page access. The
 *      content script owns resolution and pushes it over
 *      cc:panel:resolutionUpdated. An id the content script has not reported on
 *      yet must read as UNKNOWN, never as unanchored — otherwise every thread is
 *      orphaned (and PATCHed) before the first report lands.
 *   2. There is no `observeDom`. This context has no DOM to observe, so the
 *      content script's report IS the "DOM changed" signal and must call
 *      onDomChanged() to drive the orphan lifecycle.
 *
 * The resolver and the report-handling shape are reconstructed here rather than
 * imported, because they live inside App's body. That is a real limitation — it
 * tests the contract, not the literal call site — so each test states the
 * sidepanel.jsx invariant it stands in for.
 */

import { describe, expect, test, vi } from 'vitest';
import { createThreadStore } from '@adobe/annotations-core/thread-store';

// Mirrors the panel's wiring: a mutable resolution cache, an async resolver that
// reads it, no observeDom, and a refetch routed through a ref.
function panelStore({ patchThread = vi.fn(() => Promise.resolve()), refetch = vi.fn() } = {}) {
  const resolutionRef = { current: {} };
  const store = createThreadStore({
    patchThread,
    resolveAnchors: (candidates) => Promise.resolve(
      Object.fromEntries(candidates
        .map((t) => [t.id, resolutionRef.current[t.id]])
        .filter(([, status]) => status !== undefined)
        .map(([id, status]) => [id, { status }])),
    ),
    refetch,
  });
  // What the cc:panel:resolutionUpdated handler does.
  const report = (resolution) => { resolutionRef.current = resolution; store.onDomChanged(); };
  return { store, resolutionRef, report, patchThread, refetch };
}

/** Flush pending microtasks (the async resolver resolves on one). */
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/**
 * Let the store's DOM-settle debounce fire, then flush the resolution promise it
 * kicked off. Both halves are needed: the sweep is scheduled on a 300ms timer,
 * and its resolver is async, so advancing timers alone leaves the verdict
 * unapplied. Real timers with a real wait would also work but makes the suite
 * slow and flaky.
 */
async function sweep(ms = 400) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

const anchored = (id) => ({ id, anchor: { type: 'text', text: `t${id}` } });

describe('the panel resolver', () => {
  test('a thread the content script has not reported on is NOT orphaned', async () => {
    // The first payload always arrives before the first resolution report. If an
    // absent entry read as unanchored, opening the panel would orphan — and PATCH
    // — every thread on the page.
    const { store, patchThread } = panelStore();
    store.setScope('/page');
    store.applyFetched([anchored(1), anchored(2)], undefined, { scope: '/page' });
    await settle();
    expect(store.getThreads().some((t) => t.is_orphaned)).toBe(false);
    expect(patchThread).not.toHaveBeenCalled();
  });

  test('an "unanchored" report orphans the thread and PATCHes it', async () => {
    vi.useFakeTimers();
    try {
      const { store, report, patchThread } = panelStore();
      store.setScope('/page');
      store.applyFetched([anchored(1)], undefined, { scope: '/page' });
      await settle();
      // ONE report is enough to start it: orphaning is confirmation-gated against
      // a host-page re-render that detaches an element for a frame, and the store
      // schedules the confirming sweep itself rather than waiting for a second
      // report that may never come (a page that mutates once, then goes quiet).
      report({ 1: 'unanchored' });
      await sweep();
      await sweep();
      expect(store.getThreads()[0].is_orphaned).toBe(true);
      expect(patchThread).toHaveBeenCalledWith(1, { is_orphaned: true });
    } finally { vi.useRealTimers(); }
  });

  test('THE GAIN: a recovered anchor is un-orphaned and PATCHed false', async () => {
    // This is the half this extension never had. Without it, content.js could not
    // safely hide orphaned markers (hence buildOverlayModel's hideOrphaned:false),
    // because a hidden marker could never come back.
    vi.useFakeTimers();
    try {
      const { store, report, patchThread } = panelStore();
      store.setScope('/page');
      store.applyFetched([{ ...anchored(1), is_orphaned: true }], undefined, { scope: '/page' });
      await settle();
      report({ 1: 'resolved' });
      await sweep();
      expect(store.getThreads()[0].is_orphaned).toBe(false);
      expect(patchThread).toHaveBeenCalledWith(1, { is_orphaned: false });
    } finally { vi.useRealTimers(); }
  });

  test('an "approximate" resolution is not unanchored — it stays anchored', async () => {
    // The content script reports three states; only 'unanchored' means orphaned.
    vi.useFakeTimers();
    try {
      const { store, report, patchThread } = panelStore();
      store.setScope('/page');
      store.applyFetched([anchored(1)], undefined, { scope: '/page' });
      await settle();
      report({ 1: 'approximate' });
      await sweep();
      await sweep();
      expect(store.getThreads()[0].is_orphaned).toBeUndefined();
      expect(patchThread).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  test('the async resolver does not delay the first paint', async () => {
    // The panel must render threads on the payload, not on a message round trip.
    const seen = [];
    const { store } = panelStore();
    store.subscribe((t) => seen.push(t.length));
    store.setScope('/page');
    store.applyFetched([anchored(1), anchored(2)], undefined, { scope: '/page' });
    expect(seen.at(-1)).toBe(2);   // already emitted, before any await
  });
});

describe('the panel staleness guards (what this client contributed)', () => {
  test('a poll response that lost the race to a local edit is dropped', () => {
    const { store } = panelStore();
    store.setScope('/page');
    store.applyFetched([{ ...anchored(1), status: 'open' }], undefined, { scope: '/page' });
    const token = store.beginFetch();
    store.upsertThread({ ...anchored(1), status: 'resolved' });
    expect(store.applyFetched([{ ...anchored(1), status: 'open' }], token, { scope: '/page' })).toBe(false);
    expect(store.getThreads()[0].status).toBe('resolved');
  });

  test('a stream frame inside the grace window is suppressed, then re-fetched', () => {
    vi.useFakeTimers();
    try {
      const { store, refetch } = panelStore();
      store.setScope('/page');
      store.upsertThread({ ...anchored(1), status: 'resolved' });
      expect(store.applyPushed([{ ...anchored(1), status: 'open' }], { scope: '/page' })).toBe(false);
      expect(store.getThreads()[0].status).toBe('resolved');
      // Dropping without re-fetching would lose the frame for the session: the
      // backend broadcasts only on write and no poll runs while the stream is up.
      expect(refetch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2_000);
      expect(refetch).toHaveBeenCalledWith('/page');
    } finally { vi.useRealTimers(); }
  });

  test('a frame for a page we navigated away from is dropped', () => {
    const { store } = panelStore();
    store.setScope('/b');
    expect(store.applyPushed([anchored(1)], { scope: '/a' })).toBe(false);
    expect(store.getThreads()).toEqual([]);
  });

  test('changing pages clears the list immediately', () => {
    // Otherwise the previous page's threads are briefly pushed onto the new tab
    // as stray markers.
    const { store } = panelStore();
    store.setScope('/a');
    store.applyFetched([anchored(1)], undefined, { scope: '/a' });
    store.setScope('/b');
    expect(store.getThreads()).toEqual([]);
  });
});
