/**
 * Test-environment setup.
 *
 * sidepanel.jsx ends with a module-scope bootstrap:
 *   createRoot(document.getElementById('root')).render(<App />)
 * That is correct for the real side panel (the module IS the entry point), but
 * it means merely importing the file to reach an exported helper mounts the
 * whole app — and throws "Target container is not a DOM element" when #root
 * doesn't exist.
 *
 * Providing #root here lets the bootstrap succeed harmlessly instead of
 * restructuring shipped code purely for testability. The mounted App renders
 * into a detached container no test asserts against; tests target the exported
 * helpers.
 *
 * Also stubs the `chrome.*` extension APIs, which don't exist outside an
 * extension context. App's effects call chrome.tabs.query / chrome.storage on
 * mount, so without these the bootstrap throws for a different reason.
 */

if (!document.getElementById('root')) {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
}

// Minimal no-op chrome surface: every method the side panel touches on mount,
// shaped so callbacks fire with empty results rather than being left pending.
const noop = () => {};
const listener = { addListener: noop, removeListener: noop };

globalThis.chrome = {
  runtime: {
    sendMessage: (_msg, cb) => { cb?.({ ok: true, result: null }); },
    onMessage: listener,
  },
  tabs: {
    query: (_q, cb) => cb?.([]),
    get: (_id, cb) => cb?.(undefined),
    sendMessage: () => Promise.resolve(null),
    onActivated: listener,
    onUpdated: listener,
  },
  storage: {
    session: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
    // sidepanel.jsx's `storage` helper wraps chrome.storage.SYNC (theme
    // persistence follows the signed-in profile across machines), not .local.
    sync: {
      get: (_k, cb) => (cb ? cb({}) : Promise.resolve({})),
      set: (_v, cb) => (cb ? cb() : Promise.resolve()),
      remove: (_k, cb) => (cb ? cb() : Promise.resolve()),
    },
    local: {
      get: (_k, cb) => (cb ? cb({}) : Promise.resolve({})),
      set: (_v, cb) => (cb ? cb() : Promise.resolve()),
      remove: (_k, cb) => (cb ? cb() : Promise.resolve()),
    },
  },
  identity: {
    getRedirectURL: () => 'https://test.chromiumapp.org/',
    launchWebAuthFlow: () => Promise.resolve(''),
  },
  sidePanel: { open: () => Promise.resolve() },
  scripting: { executeScript: () => Promise.resolve([]) },
  action: { onClicked: listener },
};
