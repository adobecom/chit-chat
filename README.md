# Chit Chat

Chrome extension that brings the Milo page-commenter annotation tool into the browser's **native side panel** — no bookmarklet needed.

Click the Chit Chat toolbar icon on any AEM / DA Live page to open the panel and inject the annotation overlay.

## What it does

- **Side panel** — threads list, thread detail, comment compose, status management, votes, export. The browser docks and resizes the panel; no custom drag/snap UI.
- **On-page overlay** — dot markers and shape markers positioned over the live DOM; element-picker mode, rectangle/ellipse shape mode, text-selection "+Comment" button.
- **Backend** — `https://forge.adobe.io/annotations` (the same Milo API as the bookmarklet, same anchor format, same stored data). `milo-core-prod.adobe.io` is the same service under a permanent alias and still works; see "Environment" below.
- **Auth** — Adobe IMS via `chrome.identity.launchWebAuthFlow` (implicit grant). The redirect URI `https://<ext-id>.chromiumapp.org/` must be registered on the IMS client for the target environment.

## Load the extension (Developer mode)

1. Build it (once): `npm install && npm run build`
2. Open **`chrome://extensions`**
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select the `chit-chat` directory
5. The Chit Chat icon appears in the toolbar

Re-run `npm run build` after any code change, then click the reload icon on `chrome://extensions`.

For live development: `npm run watch` rebuilds on every change.

⚠️ **The loaded extension talks to whichever environment `ENV` in `src/background.js`
names, and that defaults to `prod`** — so exercising it writes REAL comments onto real
pages. Flip that one constant to `'stage'` before testing anything you don't want
persisted; `host_permissions` already covers both hosts.

### Testing the panel without a real backend

`harness.html` loads the real built `dist/sidepanel.js` against a stubbed `chrome.*`
surface and a fake service worker — no sign-in, no network:

```bash
npm run build
python3 -m http.server 7892 --directory .   # → http://localhost:7892/harness.html
```

It exposes hooks for the paths that are otherwise impractical to reach by hand:
`__cc.pushStream(threads)` delivers an SSE frame at a chosen instant (the only way to
exercise the optimistic-mutation guard), `__cc.reportResolution(map)` stands in for the
content script's resolution report (driving the orphan lifecycle), and `__cc.patches`
records every PATCH sent. Panel only — no on-page markers, since no content script runs.

This is what `scripts/annotations-browser-check-extension.mjs` in the `milo-logs-deploy`
repo drives (9 checks). Worth running after any change to the panel or to
`@adobe/annotations-core`: it caught a dual-React bug that crashed every symlinked build
and that no unit suite could see.

## Which pages does it work on?

The overlay and API both work on **any page** — the extension uses `host_permissions` for the API host so fetches from the service worker bypass CORS entirely (unlike the bookmarklet, which is gated to CORS-allowlisted origins). However, the page's Content-Security-Policy may still block the content script from running on some pages.

`host_permissions` lists **all four** API hosts (`forge{,-stage}` and `milo-core-{prod,stage}`) so either name works without a manifest edit. A missing entry here is a hard failure, not a degraded one — the fetch is blocked outright.

## Auth handshake

Sign-in uses `chrome.identity.launchWebAuthFlow` — no relay page required. The flow:
1. The service worker builds an IMS implicit-grant authorize URL (`response_type=token`) for client `milo-logs-claude-mcp`.
2. Chrome opens the IMS login UI. On success, IMS redirects to `https://<ext-id>.chromiumapp.org/#access_token=...`.
3. Chrome intercepts the redirect and returns the URL to the service worker, which parses the token from the hash.
4. The token is stored in `chrome.storage.session`.

**Setup:** the redirect URI `https://<ext-id>.chromiumapp.org/` must be registered on the IMS client. The extension ID is stable because the manifest includes a `key`. To find the exact redirect URI, open the service worker console and run `chrome.identity.getRedirectURL()`.

**Environment (`ENV` constant in `background.js`):** `'stage'` points at
`ims-na1-stg1.adobelogin.com` + `forge-stage.adobe.io`; `'prod'` points at
`ims-na1.adobelogin.com` + `forge.adobe.io`. Keep them in sync — a stage token is
rejected by the prod API, which is exactly why they live in one `HOSTS` table and flip
together. `ENV = 'prod'` stays committed; a stage flip is a local edit only.

| `ENV` | API | IMS | milo-logs-deploy branch |
|---|---|---|---|
| `'stage'` | `https://forge-stage.adobe.io/annotations` | `https://ims-na1-stg1.adobelogin.com` | `stage` |
| `'prod'` | `https://forge.adobe.io/annotations` | `https://ims-na1.adobelogin.com` | `main` |

The older `milo-core-{prod,stage}.adobe.io` names are the **same Ethos service** — one
deploy, two FQDNs, byte-identical bundle per environment. They remain a permanent alias
and stay in `host_permissions`, so swapping a `HOSTS` entry back needs no manifest change.
The `forge` names are preferred because `forge-stage` maps cleanly onto the `stage`
branch lane, which is what makes verifying a change on stage possible at all.

⚠️ **Do not touch the manifest `key`.** It pins the extension ID to
`nafgnogpgkcheonjkjjdfjjhnhllbkdh`, which is what keeps the `chromiumapp.org` redirect
URI stable across the stage and prod IMS clients. Changing it breaks sign-in in a way
that looks like an IMS outage.

## Anchor format compatibility

`captureAnchor` / `resolveAnchor` come from `@adobe/annotations-core`, shared with the milo-logs-deploy page-commenter bundle, so both clients agree on the anchor JSON shape (`cssSelector`, `xpath`, `textContent`, `boundingRect`, `tagName`, `textSelectionStart/End`) and the resolution cascade's confidence thresholds. Shape anchors use `{ type:'shape', shape:'rect'|'ellipse', left, top, width, height }` (absolute document coordinates, not `x`/`y`). Both element/text and shape anchors also carry `viewportWidth` (and shape anchors `scrollY`), added at save time via the package's `finalizeAnchorForSave`. Threads created by either client are interoperable.

## Architecture

```
background.js (service worker)
  ├─ owns IMS token (chrome.storage.session)
  ├─ proxies all /annotations API calls (host_permissions → no CORS)
  └─ brokers messages between content ↔ side panel

content.js (injected into host page, ISOLATED world — Chrome's default)
  ├─ overlay: dot markers, shape markers
  ├─ element-picker, shape-draw, text-selection modes
  ├─ anchor capture + resolution cascade
  ├─ scroll-to-thread, flash
  └─ SPA navigation hooks, MutationObserver

sidepanel.html + dist/sidepanel.js (extension origin, React 19 + React Spectrum S2)
  ├─ thread list (search + filter)
  ├─ thread detail (status, comments, reply, delete)
  ├─ comment item (edit, vote)
  └─ identity bar, theme toggle, export JSON
```

## Icons

`icons/` contains solid-red placeholder PNGs generated by `scripts/make-icons-fallback.mjs`. Replace them with a real chat-bubble / comment glyph before publishing.
