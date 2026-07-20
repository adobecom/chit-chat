/**
 * background.js — Chit Chat MV3 service worker.
 *
 * Responsibilities:
 *   1. Action click → open side panel + inject content script into the active tab.
 *   2. IMS auth via chrome.identity.launchWebAuthFlow (implicit grant, response_type=token).
 *      The manifest "key" pins the extension ID to nafgnogpgkcheonjkjjdfjjhnhllbkdh so
 *      the chromiumapp.org redirect URI stays stable across stage and prod IMS clients.
 *   3. All /annotations network requests (host_permissions bypass CORS here).
 *   4. Message broker between the side panel and the active tab's content script.
 */

// ── Constants ──────────────────────────────────────────────────────────────

// Toggle 'stage' ↔ 'prod' to switch both the IMS host and API together.
const ENV = 'prod'; // 'stage' | 'prod'
const HOSTS = {
  stage: {
    api: 'https://milo-core-stage.adobe.io/annotations',
    ims: 'https://ims-na1-stg1.adobelogin.com',
  },
  prod: {
    api: 'https://milo-core-prod.adobe.io/annotations',
    ims: 'https://ims-na1.adobelogin.com',
  },
};
const API_BASE   = HOSTS[ENV].api;
const IMS_ORIGIN = HOSTS[ENV].ims;
const CLIENT_ID  = 'milo-logs-claude-mcp';
const SCOPES     = 'AdobeID,email,openid';
const REQUEST_TIMEOUT_MS = 30_000;

// ── Auth ───────────────────────────────────────────────────────────────────

/** Retrieve the cached IMS token, or null. */
async function getToken() {
  const s = await chrome.storage.session.get('imsToken');
  return s.imsToken ?? null;
}

/** Store the IMS token. */
async function setToken(token) {
  await chrome.storage.session.set({ imsToken: token });
}

/** Clear the IMS token (e.g. after a 401). */
async function clearToken() {
  await chrome.storage.session.remove('imsToken');
}

/** Retrieve the cached IMS profile, or null. */
async function getProfile() {
  const s = await chrome.storage.session.get('imsProfile');
  return s.imsProfile ?? null;
}

/**
 * Fetch the user profile from Adobe IMS.
 * Returns { name, first, last, email, avatar } or null.
 *
 * Uses /ims/profile/v1 — unlike the OIDC /userinfo endpoint it returns the
 * name fields (displayName / first_name / last_name) with only the AdobeID
 * scope, so we don't need the `profile` scope (which milo-logs-claude-mcp
 * isn't provisioned for — requesting it fails with invalid_scope).
 */
async function fetchUserProfile(token) {
  try {
    const res = await fetch(`${IMS_ORIGIN}/ims/profile/v1?client_id=${CLIENT_ID}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const d = await res.json();
    // Adobe IMS uses first_name/last_name/displayName; fall back to OIDC-style
    // fields just in case, then the email local part.
    const first = d.first_name ?? d.given_name ?? null;
    const last = d.last_name ?? d.family_name ?? null;
    const name = d.displayName
      || d.name
      || `${first || ''} ${last || ''}`.trim()
      || d.email
      || null;
    if (!name && !d.email) return null;
    return {
      name,
      // Structured parts let the panel build first+last initials directly.
      first,
      last,
      email: d.email ?? null,
      avatar: d.account?.avatar ?? d.avatar ?? null,
    };
  } catch { return null; }
}

// Deduplicates concurrent sign-in requests so a double-click doesn't open two popups.
let pendingAuthPromise = null;

/**
 * Launch the Adobe IMS authorize page via chrome.identity.launchWebAuthFlow
 * (implicit grant, response_type=token) and extract the access_token from the
 * redirect URL fragment that Chrome intercepts.
 *
 * The manifest "key" stabilises the extension ID so the registered
 * chromiumapp.org redirect URI never changes across reloads.
 */
async function acquireToken() {
  if (pendingAuthPromise) return pendingAuthPromise;

  pendingAuthPromise = (async () => {
    try {
      const redirectUri = chrome.identity.getRedirectURL();
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        scope: SCOPES,
        response_type: 'token',
        redirect_uri: redirectUri,
      });
      const authorizeUrl = `${IMS_ORIGIN}/ims/authorize/v2?${params}`;

      const redirectUrl = await chrome.identity.launchWebAuthFlow({
        url: authorizeUrl,
        interactive: true,
      });

      if (!redirectUrl) throw new Error('Sign-in cancelled');

      // IMS may put errors in the query string (e.g. ?error=redirect_uri_mismatch)
      // rather than the fragment in some failure modes.
      const qIdx = redirectUrl.indexOf('?');
      const hashIdx = redirectUrl.indexOf('#');
      if (hashIdx === -1) {
        if (qIdx !== -1) {
          const query = new URLSearchParams(redirectUrl.slice(qIdx + 1));
          const qError = query.get('error');
          if (qError) {
            const desc = query.get('error_description') ?? 'no description';
            throw new Error(`IMS auth error: ${qError} — ${desc}`);
          }
        }
        throw new Error(`No fragment in redirect URL — check SW console for the full redirect URL`);
      }

      // Token lives in the URL fragment: …#access_token=xxx&expires_in=yyy&…
      const fragment = new URLSearchParams(redirectUrl.slice(hashIdx + 1));
      const imsError = fragment.get('error');
      if (imsError) {
        const desc = fragment.get('error_description') ?? 'no description';
        throw new Error(`IMS auth error: ${imsError} — ${desc}`);
      }
      const accessToken = fragment.get('access_token');
      if (!accessToken) throw new Error('No access_token in redirect fragment');

      return accessToken;
    } finally {
      pendingAuthPromise = null;
    }
  })();

  return pendingAuthPromise;
}

/**
 * Get a valid token. For user-initiated requests (interactive = true) this
 * prompts sign-in when there's no token. For background requests (polling) we
 * must NOT open an auth popup unprompted, so throw a distinguishable
 * SESSION_EXPIRED error instead and let the panel show a re-sign-in banner.
 */
async function ensureToken(interactive = true) {
  let token = await getToken();
  if (!token) {
    if (!interactive) {
      const err = new Error('SESSION_EXPIRED');
      err.code = 'SESSION_EXPIRED';
      throw err;
    }
    token = await acquireToken();
    await setToken(token);
  }
  return token;
}

// ── Network helpers ────────────────────────────────────────────────────────

async function apiRequest(path, opts = {}, retry = true, { interactive = true } = {}) {
  const token = await ensureToken(interactive);
  const sep = path.includes('?') ? '&' : '?';
  const url = `${API_BASE}${path}${sep}clientId=${CLIENT_ID}`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(opts.headers ?? {}),
      },
    });
  } catch (err) {
    // Distinguish our 30s timeout from a generic network failure so the panel
    // can show a meaningful message rather than "The operation was aborted".
    if (err?.name === 'AbortError') throw new Error('Request timed out');
    throw err;
  } finally {
    clearTimeout(tid);
  }

  if (res.status === 401 && retry) {
    // Token expired — clear and retry once. Preserve the interactive flag so a
    // background poll re-acquiring a token stays silent (→ SESSION_EXPIRED)
    // rather than popping an auth window. Only clear if the token that 401'd is
    // still the current one: a concurrent request may have already acquired a
    // fresh token, and blindly clearing would wipe it (→ spurious re-sign-in).
    if (await getToken() === token) await clearToken();
    return apiRequest(path, opts, false, { interactive });
  }

  if (res.status === 204) return null;
  if (!res.ok) {
    let body;
    try { body = await res.json(); } catch { body = null; }
    const err = new Error(body?.error ?? `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  // Tolerate empty/non-JSON success bodies (e.g. a 200 PATCH with no body) —
  // res.json() would otherwise throw "Unexpected end of JSON input".
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ── Message handler ────────────────────────────────────────────────────────

/**
 * Central message dispatcher. Messages arrive from:
 *   - content.js (via chrome.runtime.sendMessage)
 *   - sidepanel.js (via chrome.runtime.sendMessage)
 *
 * Naming convention:
 *   cc:api:*        — proxy network request, response is the API result
 *   cc:auth:signIn  — trigger sign-in flow
 *   cc:auth:signOut — clear stored token
 *   cc:auth:status  — report signed-in state + profile
 *   cc:tab:*        — forward to the content script of the specified tab
 *   cc:panel:*      — forward to the side panel (via content→SW→panel routing)
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((result) => sendResponse({ ok: true, result }))
    // Coerce defensively: if a non-Error is ever thrown, `err.message` would
    // throw here and sendResponse would never fire, closing the port with an
    // opaque "message channel closed" error instead of a useful one.
    .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
  return true; // keep channel open for async response
});

async function handleMessage(msg, sender) {
  const { type } = msg;

  // ── API proxy ───────────────────────────────────────────────────────────
  if (type === 'cc:api:fetchThreads') {
    // Background polls set msg.background so an expired token surfaces as
    // SESSION_EXPIRED instead of triggering an unprompted interactive sign-in.
    return apiRequest(
      `/threads?page_url=${encodeURIComponent(msg.pageUrl)}`,
      {}, true, { interactive: !msg.background },
    );
  }
  if (type === 'cc:api:createThread') {
    return apiRequest('/threads', {
      method: 'POST',
      body: JSON.stringify({ page_url: msg.pageUrl, anchor: msg.anchor }),
    });
  }
  if (type === 'cc:api:patchThread') {
    return apiRequest(`/threads/${msg.id}`, {
      method: 'PATCH',
      body: JSON.stringify(msg.data),
    });
  }
  if (type === 'cc:api:deleteThread') {
    return apiRequest(`/threads/${msg.id}`, { method: 'DELETE' });
  }
  if (type === 'cc:api:createComment') {
    return apiRequest('/comments', {
      method: 'POST',
      body: JSON.stringify({
        thread_id: msg.threadId, body: msg.body, author_name: msg.authorName, mentions: msg.mentions ?? [],
      }),
    });
  }
  if (type === 'cc:api:patchComment') {
    // mentions is omitted (not sent as []) unless the caller explicitly
    // provides it — the backend treats "field absent" as "leave unchanged"
    // vs. "field present" as "replace" (see updateComment in milo-logs-deploy's
    // comments.js; the current caller always sends it, but a future caller
    // that only edits the body shouldn't have to resend the mention list).
    const body = { body: msg.body };
    if (msg.mentions !== undefined) body.mentions = msg.mentions;
    return apiRequest(`/comments/${msg.id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }
  if (type === 'cc:api:deleteComment') {
    return apiRequest(`/comments/${msg.id}`, { method: 'DELETE' });
  }
  if (type === 'cc:api:voteComment') {
    return apiRequest(`/comments/${msg.id}/vote`, {
      method: 'POST',
      body: JSON.stringify({ upvoteDelta: msg.upvoteDelta ?? 0, downvoteDelta: msg.downvoteDelta ?? 0 }),
    });
  }
  // @-mention / assignee people-picker autocomplete — backed by the Slack
  // workspace directory on the backend (see milo-logs-deploy/src/annotations/people.js).
  // Fires on every keystroke (debounced) as an incidental part of typing, not
  // a deliberate action — so like the background poll above, a stale token
  // here should fail quietly (SESSION_EXPIRED) rather than pop an interactive
  // sign-in window mid-keystroke.
  if (type === 'cc:api:searchPeople') {
    return apiRequest(`/people?q=${encodeURIComponent(msg.q ?? '')}`, {}, true, { interactive: false });
  }

  // ── Auth ────────────────────────────────────────────────────────────────
  if (type === 'cc:auth:signIn') {
    const token = await acquireToken();
    await setToken(token);
    const profile = await fetchUserProfile(token);
    await chrome.storage.session.set({ imsProfile: profile });
    return { signedIn: true };
  }
  if (type === 'cc:auth:signOut') {
    await chrome.storage.session.remove(['imsToken', 'imsProfile']);
    return { signedIn: false };
  }
  if (type === 'cc:auth:status') {
    const token = await getToken();
    if (!token) return { signedIn: false };
    return { signedIn: true, profile: await getProfile() };
  }

  // ── Forward from panel → content script of a tab ──────────────────────
  // The side panel passes msg.tabId for routing.
  if (type === 'cc:tab:forward') {
    try {
      return await chrome.tabs.sendMessage(msg.tabId, msg.payload);
    } catch {
      // No content script in this tab yet — this happens when the panel follows
      // a tab switch (content.js was only injected into the originally-clicked
      // tab) or the tab reloaded. Inject on demand and retry once. Lazy so we
      // only ever inject into tabs the open panel is actively driving, rather
      // than proactively into every page the user browses.
      try {
        await injectContentScriptOnce(msg.tabId);
        return await chrome.tabs.sendMessage(msg.tabId, msg.payload);
      } catch {
        return null; // non-injectable page (chrome://, etc.) or still unavailable
      }
    }
  }

  // ── Forward from content → side panel (broadcast to extension pages) ──
  // Used for: page URL changed, anchor re-resolution results.
  if (type === 'cc:panel:forward') {
    // Side panel listens for chrome.runtime.onMessage so it receives this too.
    // Just return — the panel already picked it up through the onMessage listener
    // (service worker can't directly target the side panel, but it arrives there
    // because onMessage fires in all extension contexts including the side panel).
    return null;
  }

  throw new Error(`unknown message type: ${type}`);
}

// ── Content script injection ───────────────────────────────────────────────

// Tracks which tab the side panel is currently attached to, so we can
// re-inject content.js when that tab navigates to a new page.
let panelTabId = null;

function navShimFn() {
  if (window.__chitChatNavShim) return;
  window.__chitChatNavShim = true;
  const fire = () => window.dispatchEvent(new CustomEvent('cc:navigated'));
  const op = history.pushState.bind(history);
  const or = history.replaceState.bind(history);
  history.pushState = function (...a) { const r = op(...a); fire(); return r; };
  history.replaceState = function (...a) { const r = or(...a); fire(); return r; };
}

async function injectContentScript(tabId) {
  // content.js runs in the ISOLATED world (default) so chrome.runtime messaging works.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['dist/content.js'],
  });
  // MAIN-world shim re-dispatches history.pushState/replaceState as the 'cc:navigated'
  // CustomEvent so the ISOLATED-world content script can detect SPA navigations.
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: navShimFn,
  });
}

// Dedup concurrent injections into the same tab: the panel can fire several
// forwards at once on a tab switch, and two overlapping executeScript calls
// could both run content.js before its __chitChatLoaded guard is set, wiring up
// duplicate listeners/overlays. Collapse them into one in-flight promise.
const _injecting = new Map(); // tabId -> Promise
function injectContentScriptOnce(tabId) {
  if (_injecting.has(tabId)) return _injecting.get(tabId);
  const p = injectContentScript(tabId).finally(() => _injecting.delete(tabId));
  _injecting.set(tabId, p);
  return p;
}

// Re-inject content.js when the panel's tab navigates to a new page.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (tabId !== panelTabId || info.status !== 'complete') return;
  try {
    await injectContentScriptOnce(tabId);
  } catch {
    // Non-injectable page (chrome://, about:, etc.) — ignore.
  }
});

// ── Action click ───────────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  panelTabId = tab.id;

  // Open the native side panel for this tab
  await chrome.sidePanel.open({ tabId: tab.id });

  // Inject the content script if it isn't already running.
  // executeScript throws on chrome://, about:, or extension pages — swallow those.
  try {
    await injectContentScriptOnce(tab.id);
  } catch (err) {
    // Not injectable (chrome:// page, etc.) — side panel still opens, content features
    // will be unavailable. Log to service-worker console only.
    console.warn('[chit-chat] could not inject content script:', err.message);
  }
});
