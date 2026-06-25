/**
 * background.js — Chit Chat MV3 service worker.
 *
 * Responsibilities:
 *   1. Action click → open side panel + inject content script into the active tab.
 *   2. IMS auth via chrome.identity.launchWebAuthFlow (implicit grant, response_type=token).
 *      The manifest "key" pins the extension ID to nafgnogpgkcheonjkjjdfjjhnhllbkdh so
 *      the chromiumapp.org redirect URI stays stable. Currently registered for stage IMS
 *      only; prod requires the same redirect URI to be registered with Adobe IMS first.
 *   3. All /annotations network requests (host_permissions bypass CORS here).
 *   4. Message broker between the side panel and the active tab's content script.
 */

// ── Constants ──────────────────────────────────────────────────────────────

// Toggle 'stage' ↔ 'prod' to switch both the IMS host and API together.
const ENV = 'stage'; // 'stage' | 'prod'
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
const SCOPES     = 'AdobeID,openid,profile,email';
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

/** Fetch the user profile from the IMS userinfo endpoint. Returns { name, email } or null. */
async function fetchUserProfile(token) {
  try {
    const res = await fetch(`${IMS_ORIGIN}/ims/userinfo/v2`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      name: data.name ?? data.given_name ?? null,
      email: data.email ?? null,
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

      // Token lives in the URL fragment: …#access_token=xxx&expires_in=yyy&…
      const hashIdx = redirectUrl.indexOf('#');
      if (hashIdx === -1) throw new Error('No fragment in redirect URL');
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

/** Get a valid token, prompting sign-in if needed. */
async function ensureToken() {
  let token = await getToken();
  if (!token) {
    token = await acquireToken();
    await setToken(token);
  }
  return token;
}

// ── Network helpers ────────────────────────────────────────────────────────

async function apiRequest(path, opts = {}, retry = true) {
  const token = await ensureToken();
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
  } finally {
    clearTimeout(tid);
  }

  if (res.status === 401 && retry) {
    // Token expired — clear and retry once
    await clearToken();
    return apiRequest(path, opts, false);
  }

  if (res.status === 204) return null;
  if (!res.ok) {
    let body;
    try { body = await res.json(); } catch { body = null; }
    const err = new Error(body?.error ?? `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
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
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // keep channel open for async response
});

async function handleMessage(msg, sender) {
  const { type } = msg;

  // ── API proxy ───────────────────────────────────────────────────────────
  if (type === 'cc:api:fetchThreads') {
    return apiRequest(`/threads?page_url=${encodeURIComponent(msg.pageUrl)}`);
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
      body: JSON.stringify({ thread_id: msg.threadId, body: msg.body }),
    });
  }
  if (type === 'cc:api:patchComment') {
    return apiRequest(`/comments/${msg.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: msg.body }),
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
    return chrome.tabs.sendMessage(msg.tabId, msg.payload);
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

// ── Action click ───────────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  // Open the native side panel for this tab
  await chrome.sidePanel.open({ tabId: tab.id });

  // Inject the content script if it isn't already running.
  // executeScript throws on chrome://, about:, or extension pages — swallow those.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['dist/content.js'],
      world: 'MAIN', // needs page-world access (getBoundingClientRect, etc.)
    });
  } catch (err) {
    // Not injectable (chrome:// page, etc.) — side panel still opens, content features
    // will be unavailable. Log to service-worker console only.
    console.warn('[chit-chat] could not inject content script:', err.message);
  }
});
