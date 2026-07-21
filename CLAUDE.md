# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build       # one-shot production build (minified)
npm run watch       # development watch mode (unminified, rebuilds on change)
npm run icons       # regenerate icon PNGs
```

There is no test runner or linter configured.

After building, reload the unpacked extension at `chrome://extensions` to pick up changes.

## Architecture

Chit Chat is a Chrome MV3 extension with three independently-bundled JS contexts:

| Bundle | Source | Context |
|---|---|---|
| `dist/background.js` | `src/background.js` | Service worker (ESM) |
| `dist/content.js` | `src/content.js` | Content script injected into host page (IIFE) |
| `dist/sidepanel.js` | `src/sidepanel.jsx` | Side panel React + S2 UI (ESM) |

All cross-context communication goes through `chrome.runtime.sendMessage`. Message types follow the convention `cc:<target>:<action>` (e.g. `cc:api:fetch`, `cc:content:threads`, `cc:panel:anchorCaptured`).

### background.js — Service Worker

Central message router and API proxy. Key responsibilities:
- **IMS auth**: uses `chrome.identity.launchWebAuthFlow` with an IMS implicit grant (`response_type=token`). The authorize URL targets `${IMS_ORIGIN}/ims/authorize/v2`; Chrome intercepts the `chromiumapp.org` redirect and hands the URL fragment (containing `access_token`) back to the service worker. Token stored in `chrome.storage.session`. A top-of-file `ENV = 'stage' | 'prod'` constant selects both the IMS host and the API host together. The manifest `key` pins the extension ID to `nafgnogpgkcheonjkjjdfjjhnhllbkdh` so the registered redirect URI (`https://nafgnogpgkcheonjkjjdfjjhnhllbkdh.chromiumapp.org/`) never changes across reloads. Registered on both the stage and prod IMS clients.
- **API proxy**: all `/annotations` requests go through here (host_permissions bypass CORS); includes Bearer auth, 30s timeout, and automatic token re-acquisition on 401
- **Tab management**: opens the side panel on toolbar click; injects content.js into the active tab

### content.js — Page Overlay

Runs in the `MAIN` world so it has live DOM access. Key responsibilities:
- **Annotation modes**: element-picker (click-to-comment), rect-draw, ellipse-draw, text-selection "+Comment" button
- **Anchor capture**: `captureAnchor()` (from `@adobe/annotations-core/anchor`) records CSS selector, XPath, text content, bounding rect, tag, alt, src
- **Anchor resolution**: `resolveAnchor()` (same package) cascade — CSS selector → XPath → fuzzy Levenshtein text match
- **Overlay markers**: dot markers pinned over resolved elements; shape markers (rect/ellipse) for region annotations
- **SPA navigation**: patches `history.pushState/replaceState` and listens to `popstate`/`hashchange`; debounced `MutationObserver` re-resolves orphaned anchors after DOM mutations

Guard `window.__chitChatLoaded` prevents double-injection.

### sidepanel.jsx — React + React Spectrum S2 UI

Single-page React 19 app using **React Spectrum S2** (`@react-spectrum/s2` v1.4.0). Two views: `ThreadList` and `ThreadDetail`. State lives in the root `<App>` component, wrapped in S2 `<Provider colorScheme={theme}>`:
- `threads` — fetched from API, polled every 10s (paused when tab is hidden)
- `resolution` — per-thread anchor resolution status (`resolved` / `approximate` / `unanchored`) reported by content.js
- `mode` — active annotation mode (`null` | `'element'` | `'rect'` | `'ellipse'`)
- `auth` — sign-in state; theme (light/dark) persisted to `chrome.storage.sync`
- Comment votes are cached locally in `chrome.storage.sync` (API has no vote endpoints)

Comment bodies are rendered as React text children (auto-escaped); no XSS risk from server content.

Delete-thread confirmation uses S2 `AlertDialog` (async) rather than `window.confirm`.

### Build

`build.mjs` uses esbuild with three separate entry points. Only the side-panel bundle uses React/S2:
- Entry is `src/sidepanel.jsx` (`.jsx` extension required — esbuild and unplugin-parcel-macros both map `.jsx → jsx` loader, while `.js` maps to plain `js`)
- `jsxImportSource: 'react'`, `jsx: 'automatic'`
- `plugins: [macros.esbuild(), localePlugin]` where `localePlugin` is a native esbuild plugin that stubs out non-`en-US` locale imports inside `@react-aria`/`@react-spectrum` packages
- `loader: { '.jsx': 'jsx' }` — does NOT inherit `shared.loader`'s `'.css': 'text'` so S2's `page.css` import is emitted as a real CSS asset (`dist/sidepanel.css`)
- Watch mode disables minification; background/content bundles use plain esbuild with no plugins

S2's `style()` macro (`@react-spectrum/s2/style` with `{ type: 'macro' }`) is available if needed — `unplugin-parcel-macros` is wired in. Currently not used; the app relies on S2 component composition and a thin `sidepanel.css` for structural layout.

### Styling

`sidepanel.css` provides structural layout only (flex columns, scrollable areas, thread-card button reset). All theming, colors, and component styles come from React Spectrum S2 via `dist/sidepanel.css` (generated at build time from S2's `page.css` + any `style()` macro output). Light/dark theming is handled by S2's `Provider` `colorScheme` prop — no manual CSS variable toggling needed.

## Key Constants

- `ENV = 'prod'` — controls both IMS host and API host; flip to `'stage'` for stage testing
- `API_BASE = HOSTS[ENV].api` (prod: `https://milo-core-prod.adobe.io/annotations`)
- `CLIENT_ID = 'milo-logs-claude-mcp'`
- `SCOPES = 'AdobeID,openid,profile,email'`
- Extension ID: `nafgnogpgkcheonjkjjdfjjhnhllbkdh` (pinned by manifest `key`)
- Anchor capture/resolution, HTML sanitization, and the `/annotations` endpoint contract come from `@adobe/annotations-core` (an npm dependency whose source of truth is `milo-logs-deploy`'s `packages/annotations-core`), shared with the milo-logs-deploy page-commenter bundle — not hand-kept-in-sync, so anchor format compatibility is structural rather than a convention to maintain
