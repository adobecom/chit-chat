/**
 * sidepanel.js — Chit Chat side panel app (React 19 + React Spectrum S2)
 *
 * Runs in the extension's own origin (chrome-extension://…/sidepanel.html).
 * All network I/O is proxied through the service worker via chrome.runtime.sendMessage.
 * All on-page DOM interactions are delegated to the content script via the same channel.
 *
 * State model:
 *   pageUrl    — current active tab's page URL (updated by content script messages)
 *   threads    — fetched from the backend, re-fetched on URL change + every 10s
 *   resolution — { [threadId]: 'resolved'|'approximate'|'unanchored' } from content script
 *   view       — 'list' | 'detail'
 *   activeId   — focused thread id (detail view)
 *   mode       — annotation mode: null|'element'|'rect'|'ellipse'
 *   auth       — { signedIn: bool, profile: { email, name, avatar }|null }
 *   theme      — 'light'|'dark'
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import '@react-spectrum/s2/page.css';
import '../sidepanel.css';
import {
  Provider,
  Button,
  ActionButton,
  ToggleButton,
  ToggleButtonGroup,
  Badge,
  SearchField,
  ProgressCircle,
  InlineAlert,
  Heading,
  Text,
  Divider,
  DialogTrigger,
  AlertDialog,
  TextArea,
} from '@react-spectrum/s2';
import BrightnessContrastIcon from '@react-spectrum/s2/icons/BrightnessContrast';
import ChevronLeftIcon from '@react-spectrum/s2/icons/ChevronLeft';
import CircleIcon from '@react-spectrum/s2/icons/Circle';
import CloseIcon from '@react-spectrum/s2/icons/Close';
import CursorClickIcon from '@react-spectrum/s2/icons/CursorClick';
import DeleteIcon from '@react-spectrum/s2/icons/Delete';
import DownloadIcon from '@react-spectrum/s2/icons/Download';
import EditIcon from '@react-spectrum/s2/icons/Edit';
import SelectRectangleIcon from '@react-spectrum/s2/icons/SelectRectangle';
import TargetIcon from '@react-spectrum/s2/icons/Target';
import ThumbDownIcon from '@react-spectrum/s2/icons/ThumbDown';
import ThumbUpIcon from '@react-spectrum/s2/icons/ThumbUp';

// ── Send to service worker ────────────────────────────────────────────────────

async function sw(type, payload = {}) {
  const resp = await chrome.runtime.sendMessage({ type, ...payload });
  if (!resp?.ok) throw new Error(resp?.error ?? 'SW error');
  return resp.result;
}

// Forward a message to the active tab's content script via the SW
async function toContent(tabId, type, payload = {}) {
  return sw('cc:tab:forward', { tabId, payload: { type, ...payload } });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function relTime(iso) {
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Absolute date-time string, e.g. "Jul 10, 12:45 AM". Used inside a thread
// (comments) where the precise time matters; the list keeps the terse relTime.
function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// Two-letter initials from a profile: first + last name initial
// (e.g. John Doe → "JD"). Prefers structured given/family name parts, then
// falls back to splitting the display name, then the email local part.
function initials(profile) {
  const first = profile?.first?.trim();
  const last = profile?.last?.trim();
  if (first && last) return (first[0] + last[0]).toUpperCase();

  const name = profile?.name?.trim();
  if (name) {
    const parts = name.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  }

  const email = profile?.email;
  if (email) return email.split('@')[0].slice(0, 2).toUpperCase();

  return '?';
}

const storage = {
  async get(key) { return new Promise(r => chrome.storage.sync.get(key, d => r(d[key] ?? null))); },
  async set(key, val) { return new Promise(r => chrome.storage.sync.set({ [key]: val }, r)); },
};

// Tri-state vote: 1 (up), -1 (down), 0 (none) — mirrors milo's localStorage-based model
async function getMyVote(commentId) {
  const v = Number(await storage.get(`vote:${commentId}`));
  return (v === 1 || v === -1) ? v : 0;
}
async function setMyVote(commentId, v) {
  if (v === 0) return storage.set(`vote:${commentId}`, null);
  return storage.set(`vote:${commentId}`, v);
}

// Extract plain text from a (possibly HTML) comment body — milo stores Quill
// rich text, so bodies can contain markup. Parse with DOMParser rather than
// assigning innerHTML on a live-document element: a DOMParser document has no
// browsing context, so embedded resources (e.g. `<img src>`) never load and no
// beacon fires while we're only reading textContent.
function stripHtml(html) {
  if (!html) return '';
  return new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
}

// Human-readable status label. Undefined/null is treated as 'open'.
function statusLabel(status) {
  if (status === 'in_progress') return 'In progress';
  if (status === 'resolved') return 'Resolved';
  return 'Open';
}

// S2 Badge variant per status — colored text/pill with theme-safe contrast
// in both light and dark (S2 owns the fg/bg pairing).
function statusBadgeVariant(status) {
  if (status === 'in_progress') return 'informative';
  if (status === 'resolved') return 'positive';
  return 'notice'; // 'open' or undefined
}

// The author_name we stamp on comments this user creates — single source of
// truth shared by comment creation and the ownership guard below.
function myAuthorName(profile) {
  return profile?.name ?? profile?.email ?? null;
}

// Frontend-only ownership check. The backend stores author_id as NULL and does
// NOT enforce ownership (edit/delete are open to anyone with the id), so this
// is a best-effort UI guard matched on display name: it hides edit/delete for
// comments that aren't the current user's. Limitations: identical display names
// collide, and a changed profile name orphans a user from their old comments.
// This is a courtesy guard, not a security boundary.
function isMyComment(comment, profile) {
  const me = myAuthorName(profile);
  return !!me && comment?.author_name === me;
}

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  const [pageUrl, setPageUrl] = useState('');
  const [tabId, setTabId] = useState(null);
  const [threads, setThreads] = useState([]);
  const [resolution, setResolution] = useState({});
  const [view, setView] = useState('list'); // 'list' | 'detail'
  const [activeId, setActiveId] = useState(null);
  const [mode, setModeState] = useState(null);
  const [auth, setAuth] = useState({ signedIn: false, profile: null });
  const [theme, setTheme] = useState('light');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const pollRef = useRef(null);
  // The message listener is registered once (stable), but handleNewThread closes
  // over auth/state that change across renders. Route through a ref so the
  // listener always calls the latest closure instead of the first render's
  // (whose auth.profile is still null) — otherwise new threads' first comments
  // would be authored as null. See the onMsg effect.
  const handleNewThreadRef = useRef(null);
  // Latest active pageUrl, and the URL the current `threads` were fetched for.
  // Used to drop stale in-flight fetches and to avoid pushing one page's threads
  // onto another page's tab. Kept as refs so the fetch callback (stable) and the
  // push effect can read current values without extra deps.
  const pageUrlRef = useRef('');
  const threadsUrlRef = useRef(null);
  // Bumped on every optimistic local mutation (reply/edit/delete/vote/status).
  // A fetch that started before a bump is dropped on arrival so an older
  // in-flight poll can't clobber the optimistic state.
  const mutationSeqRef = useRef(0);

  // ── Theme ────────────────────────────────────────────────────────────────
  // Guard the persist write so it doesn't fire with the default 'light' before
  // the stored theme has loaded (which would depend on chrome.storage FIFO
  // ordering to not overwrite the user's saved choice).
  const themeHydrated = useRef(false);
  useEffect(() => {
    storage.get('theme').then(t => { if (t) setTheme(t); themeHydrated.current = true; });
  }, []);
  useEffect(() => {
    if (themeHydrated.current) storage.set('theme', theme);
  }, [theme]);

  // ── Auth ─────────────────────────────────────────────────────────────────
  const refreshAuth = useCallback(async () => {
    try {
      const res = await sw('cc:auth:status');
      setAuth({ signedIn: res.signedIn, profile: res.profile ?? null });
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { refreshAuth(); }, []);
  // Reset avatar error state whenever the avatar URL changes (e.g. new sign-in)
  const avatarUrl = auth.profile?.avatar ?? null;
  useEffect(() => { setAvatarFailed(false); }, [avatarUrl]);

  // ── Tab tracking ──────────────────────────────────────────────────────────
  // The content script sends cc:panel:pageUrl on boot, but the panel may load
  // after that message was already sent. Read the tab URL directly so threads
  // load immediately without waiting for the next content-script event.
  //
  // Guard: only accept http(s) URLs and ignore known auth-flow domains
  // (chromiumapp.org, adobelogin.com) so chrome.identity.launchWebAuthFlow
  // doesn't clobber pageUrl when its popup becomes the active tab.
  const panelWindowIdRef = useRef(null);
  useEffect(() => {
    function isPageUrl(tab) {
      if (!tab?.url) return false;
      try {
        const u = new URL(tab.url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        // Reject IMS auth redirect and the authorize page itself
        if (u.hostname === 'chromiumapp.org' || u.hostname.endsWith('.chromiumapp.org')) return false;
        if (u.hostname === 'adobelogin.com' || u.hostname.endsWith('.adobelogin.com')) return false;
        return true;
      } catch { return false; }
    }

    function applyTab(tab) {
      if (!tab || !isPageUrl(tab)) return;
      setTabId(tab.id);
      const u = new URL(tab.url);
      setPageUrl(u.origin + u.pathname);
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        panelWindowIdRef.current = tabs[0].windowId ?? null;
        applyTab(tabs[0]);
      }
    });

    // Named handlers so they can be removed on cleanup (avoids duplicate
    // listeners under React StrictMode's dev double-invoke).
    function onActivated({ tabId: tid, windowId: wid }) {
      // Only track activations in the same window as the side panel
      if (panelWindowIdRef.current !== null && wid !== panelWindowIdRef.current) return;
      chrome.tabs.get(tid, applyTab);
    }
    function onUpdated(tid, info) {
      if (info.status === 'complete' && panelWindowIdRef.current !== null) {
        chrome.tabs.query({ active: true, windowId: panelWindowIdRef.current }, (ts) => {
          if (ts[0]?.id === tid) chrome.tabs.get(tid, applyTab);
        });
      }
    }
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  // ── Fetch threads ─────────────────────────────────────────────────────────
  // background: true marks the 10s poll. It tells the SW not to open an
  // interactive sign-in popup on an expired token — instead the request fails
  // with SESSION_EXPIRED and we show a non-destructive re-sign-in banner,
  // keeping the current view (and any unsent draft) mounted.
  const fetchThreads = useCallback(async (url, { silent = false, background = false } = {}) => {
    if (!url) return;
    const seqAtStart = mutationSeqRef.current;
    if (!silent) { setLoading(true); setError(null); }
    try {
      const data = await sw('cc:api:fetchThreads', { pageUrl: url, background });
      // Ignore a response that lost its race: the active page changed while in
      // flight (a later fetch owns the UI now), or a local mutation landed
      // (don't clobber the optimistic state with a pre-mutation snapshot).
      if (url !== pageUrlRef.current || mutationSeqRef.current !== seqAtStart) return;
      const list = data?.threads ?? data ?? [];
      threadsUrlRef.current = url;
      setThreads(Array.isArray(list) ? list : []);
      setSessionExpired(false); // any successful fetch means the session is healthy again
      if (!silent) refreshAuth(); // sync auth only on user-initiated fetches (not every 10s poll)
    } catch (err) {
      if (err.message === 'SESSION_EXPIRED') {
        // Don't tear down the UI or setError — just surface the banner.
        setSessionExpired(true);
      } else if (err.message?.includes('401') || err.message?.includes('auth')) {
        setAuth({ signedIn: false, profile: null });
      } else if (!silent) {
        setError(err.message);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [refreshAuth]);

  // Drop the previous page's threads the instant the URL changes (tab switch to
  // a different page, or same-tab SPA navigation), so stale threads aren't shown
  // in the list — or pushed onto the new page as stray markers — before the new
  // fetch resolves. Keyed on pageUrl, not tabId: threads are per-URL on the
  // server, so switching between two tabs on the *same* URL must NOT clear (and
  // wouldn't refetch, since the fetch effect is also keyed on pageUrl).
  useEffect(() => {
    pageUrlRef.current = pageUrl;
    setThreads([]); setResolution({});
  }, [pageUrl]);

  // Re-fetch when URL changes or sign-in state changes (so threads load immediately after sign-in)
  useEffect(() => { if (pageUrl && auth.signedIn) fetchThreads(pageUrl); }, [pageUrl, auth.signedIn, fetchThreads]);

  // Poll every 10s (pause when doc hidden or signed out); silent so no spinner flash.
  // Also refresh immediately when the panel becomes visible again, so returning
  // to it doesn't show up-to-10s-stale threads.
  useEffect(() => {
    if (!pageUrl || !auth.signedIn) return;
    const refresh = () => { if (!document.hidden) fetchThreads(pageUrl, { silent: true, background: true }); };
    pollRef.current = setInterval(refresh, 10_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(pollRef.current);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [pageUrl, auth.signedIn, fetchThreads]);

  // ── Push threads to content script overlay ────────────────────────────────
  // Only push when the current threads actually belong to the active page. On a
  // tab switch to a different URL, this effect can run once with the new tabId
  // but the previous page's threads still in state; pushing then would flash the
  // old page's markers on the new tab. threadsUrlRef is set in fetchThreads to
  // the URL the threads were fetched for.
  useEffect(() => {
    if (tabId !== null && threadsUrlRef.current === pageUrl) {
      toContent(tabId, 'cc:content:threads', { threads }).catch(() => {});
    }
  }, [threads, tabId, pageUrl]);

  // ── Incoming messages from content script (via SW broadcast) ─────────────
  useEffect(() => {
    function onMsg(msg) {
      if (msg.type === 'cc:panel:forward') {
        const p = msg.payload ?? {};
        if (p.type === 'cc:panel:pageUrl') {
          setPageUrl(p.pageUrl);
          setView('list'); setActiveId(null); setModeState(null);
        }
        if (p.type === 'cc:panel:dotClicked') {
          setActiveId(p.threadId); setView('detail');
        }
        if (p.type === 'cc:panel:anchorCaptured') {
          handleNewThreadRef.current?.(p.pageUrl, p.anchor, p.body);
        }
        if (p.type === 'cc:panel:resolutionUpdated') {
          setResolution(p.resolution ?? {});
        }
        if (p.type === 'cc:panel:modeCancelled') {
          setModeState(null);
        }
      }
    }
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  // ── ESC cancels the active annotation mode ────────────────────────────────
  // content.js already handles ESC while the host page is focused, but after
  // toggling a tool button focus stays in the side panel, so ESC never reaches
  // the page. Mirror that cancel here for panel-focused ESC.
  useEffect(() => {
    if (!mode) return undefined;
    const cancel = () => {
      setModeState(null);
      if (tabId) toContent(tabId, 'cc:content:mode', { mode: null }).catch(() => {});
    };
    function onKey(e) { if (e.key === 'Escape') cancel(); }
    // Right-click inside the panel also cancels the active tool (and suppresses
    // the panel's own context menu), matching the on-page picker/shape tools.
    function onContext(e) { e.preventDefault(); cancel(); }
    window.addEventListener('keydown', onKey);
    window.addEventListener('contextmenu', onContext);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('contextmenu', onContext);
    };
  }, [mode, tabId]);

  // ── Auto-scroll to the annotated element when a thread is opened ───────────
  // Same effect as the detail-view "locate" button, but triggered automatically
  // for every entry path (list click, on-page dot click, new-thread creation).
  useEffect(() => {
    if (view === 'detail' && activeId && tabId) {
      toContent(tabId, 'cc:content:scrollTo', { threadId: activeId }).catch(() => {});
    }
  }, [view, activeId, tabId]);

  // ── Handlers ─────────────────────────────────────────────────────────────
  async function handleNewThread(url, anchor, body) {
    let created = null;
    try {
      const thread = await sw('cc:api:createThread', { pageUrl: url, anchor });
      created = thread;
      if (thread && body) {
        const authorName = myAuthorName(auth.profile);
        await sw('cc:api:createComment', { threadId: thread.id, body, authorName });
      }
      await fetchThreads(url);
      if (thread) { setActiveId(thread.id); setView('detail'); }
    } catch (err) {
      // The thread and its first comment aren't created atomically: if the
      // comment call fails after the thread was created, roll the thread back so
      // we don't leave an empty "(no comments)" thread (and a stray on-page dot).
      if (created?.id) {
        try { await sw('cc:api:deleteThread', { id: created.id }); } catch { /* best effort */ }
      }
      setError(`Couldn't save your comment — ${err.message}`);
    }
  }
  // Keep the ref pointing at the current-render closure (fresh auth/state).
  handleNewThreadRef.current = handleNewThread;

  function toggleMode(m) {
    const next = mode === m ? null : m;
    setModeState(next);
    if (tabId) toContent(tabId, 'cc:content:mode', { mode: next }).catch(() => {});
  }

  async function signIn() {
    try {
      await sw('cc:auth:signIn');
      setSessionExpired(false); // fresh token — clear any expiry banner
      await refreshAuth(); // sets auth.signedIn → true
      // Immediately fetch threads for the current page rather than relying solely
      // on the effect (which won't re-fire if pageUrl didn't change).
      // Use the panel's own windowId so a focus shift during auth picks the right tab.
      const wid = panelWindowIdRef.current;
      const query = wid !== null ? { active: true, windowId: wid } : { active: true, currentWindow: true };
      const tabs = await new Promise((res) => chrome.tabs.query(query, res));
      const tab = tabs?.[0];
      if (tab?.url) {
        try {
          const u = new URL(tab.url);
          if (u.protocol === 'http:' || u.protocol === 'https:') {
            const url = u.origin + u.pathname;
            setPageUrl(url); // ensure pageUrl is in sync
            // Silent so there's no spinner double-flash — the effect may also fire
            await fetchThreads(url, { silent: true });
          }
        } catch { /* malformed URL — ignore */ }
      }
    } catch (err) { setError(err.message); }
  }

  async function signOut() {
    await sw('cc:auth:signOut');
    setAuth({ signedIn: false, profile: null });
    setThreads([]);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ pageUrl, threads }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chit-chat-${(pageUrl || 'export').replace(/[^a-z0-9]/gi, '_')}.json`;
    a.click();
    // Release the blob once the download has kicked off (next tick is enough).
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const filteredThreads = threads.filter((t) => {
    // Threads with no explicit status are treated as 'open' everywhere else.
    if (statusFilter !== 'all' && (t.status || 'open') !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const preview = stripHtml(t.comments?.[0]?.body ?? '').toLowerCase();
      // Match any comment author on the thread so the "comments and authors"
      // search placeholder holds true.
      const authors = (t.comments ?? []).map((c) => (c.author_name ?? '').toLowerCase());
      if (!preview.includes(q)
        && !authors.some((a) => a.includes(q))
        && !(t.anchor?.cssSelector ?? '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const activeThread = threads.find((t) => t.id === activeId);

  return (
    <Provider
      colorScheme={theme}
      background="base"
      UNSAFE_style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      {/* Top bar — identity left, actions right */}
      <div className="cc-topbar">
        {auth.signedIn ? (
          <>
            {auth.profile?.avatar && !avatarFailed
              ? <img
                  className="cc-avatar cc-avatar--img"
                  src={auth.profile.avatar}
                  alt=""
                  onError={() => setAvatarFailed(true)}
                />
              : <div className="cc-avatar">{initials(auth.profile)}</div>}
            <span className="cc-identity-name">
              {auth.profile?.name ?? auth.profile?.email ?? 'Signed in'}
            </span>
          </>
        ) : (
          <Button variant="accent" size="S" onPress={signIn}>Sign in</Button>
        )}
        <span style={{ flex: 1 }} />
        {auth.signedIn && (
          <Button variant="secondary" size="S" onPress={signOut}>Sign out</Button>
        )}
        <ActionButton
          isQuiet
          aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          onPress={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
          size="S"
        >
          <BrightnessContrastIcon />
        </ActionButton>
        <ActionButton isQuiet aria-label="Export JSON" onPress={exportJson} size="S">
          <DownloadIcon />
        </ActionButton>
      </div>

      <Divider size="S" />

      {/* Error banner */}
      {error && (
        <div className="cc-error-row">
          <InlineAlert variant="negative" UNSAFE_style={{ flex: 1 }}>
            <Heading>{error}</Heading>
          </InlineAlert>
          <ActionButton
            isQuiet
            size="S"
            aria-label="Dismiss error"
            onPress={() => setError(null)}
          >
            <CloseIcon />
          </ActionButton>
        </div>
      )}

      {/* Session-expiry banner — non-destructive: the view (and any unsent
          draft) stays mounted; re-sign-in is a single click and the next
          successful fetch clears it. */}
      {auth.signedIn && sessionExpired && (
        <div className="cc-error-row">
          <InlineAlert variant="notice" UNSAFE_style={{ flex: 1 }}>
            <Heading>Your session expired</Heading>
          </InlineAlert>
          <Button variant="accent" size="S" onPress={signIn}>Sign in</Button>
        </div>
      )}

      {auth.signedIn ? (
        view === 'list'
          ? <ThreadList
              threads={filteredThreads}
              resolution={resolution}
              loading={loading}
              search={search}
              setSearch={setSearch}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              onSelect={(id) => { setActiveId(id); setView('detail'); }}
              tabId={tabId}
            />
          : <ThreadDetail
              thread={activeThread}
              resolution={resolution[activeId]}
              tabId={tabId}
              pageUrl={pageUrl}
              auth={auth}
              onBack={() => { setView('list'); setActiveId(null); }}
              onUpdate={(updated) => {
                // Optimistic mutation — mark it so an older in-flight poll can't
                // revert it (see fetchThreads' mutationSeq guard).
                mutationSeqRef.current += 1;
                setThreads(ts => ts.map(t => t.id === updated.id ? updated : t));
              }}
              onDelete={() => {
                mutationSeqRef.current += 1;
                setThreads(ts => ts.filter(t => t.id !== activeId));
                setView('list'); setActiveId(null);
              }}
              onScrollTo={() => {
                if (tabId && activeThread) toContent(tabId, 'cc:content:scrollTo', { threadId: activeId }).catch(() => {});
              }}
              onError={setError}
            />
      ) : (
        <div className="cc-signed-out">
          <p>Sign in with your Adobe ID to view and add annotations.</p>
          <Button variant="accent" onPress={signIn}>Sign in</Button>
        </div>
      )}

      {/* Annotation mode buttons — bottom-left, auth-gated */}
      {auth.signedIn && (
        <div className="cc-annotation-bar">
          <ToggleButton
            isSelected={mode === 'element'}
            onChange={() => toggleMode('element')}
            size="S"
          >
            <CursorClickIcon />
            <Text>Element</Text>
          </ToggleButton>
          <ToggleButton
            isSelected={mode === 'rect'}
            onChange={() => toggleMode('rect')}
            size="S"
          >
            <SelectRectangleIcon />
            <Text>Rectangle</Text>
          </ToggleButton>
          <ToggleButton
            isSelected={mode === 'ellipse'}
            onChange={() => toggleMode('ellipse')}
            size="S"
          >
            <CircleIcon />
            <Text>Ellipse</Text>
          </ToggleButton>
        </div>
      )}
    </Provider>
  );
}

// ── Thread list ───────────────────────────────────────────────────────────────

function ThreadList({ threads, resolution, loading, search, setSearch, statusFilter, setStatusFilter, onSelect }) {
  const isFiltered = statusFilter !== 'all' || !!search;
  return (
    <div className="cc-body">
      <div className="cc-search-area">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Search comments and authors…"
          aria-label="Search comments and authors"
          width="100%"
        />
        <ToggleButtonGroup
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[statusFilter]}
          onSelectionChange={(keys) => setStatusFilter([...keys][0] ?? 'all')}
          size="S"
          aria-label="Filter by status"
        >
          <ToggleButton id="all">All</ToggleButton>
          <ToggleButton id="open">Open</ToggleButton>
          <ToggleButton id="in_progress">In progress</ToggleButton>
          <ToggleButton id="resolved">Resolved</ToggleButton>
        </ToggleButtonGroup>
      </div>

      {loading && (
        <div className="cc-centered">
          <ProgressCircle isIndeterminate aria-label="Loading threads" size="S" />
        </div>
      )}
      {!loading && threads.length === 0 && (
        <div className="cc-empty">
          {isFiltered ? 'No threads match the current filter.' : 'No annotations on this page yet.'}
        </div>
      )}

      <div className="cc-list">
        {threads.map((t) => (
          <ThreadCard
            key={t.id}
            thread={t}
            resolution={resolution[t.id]}
            onClick={() => onSelect(t.id)}
          />
        ))}
      </div>
    </div>
  );
}

// ── Thread card ───────────────────────────────────────────────────────────────

function ThreadCard({ thread, resolution, onClick }) {
  const firstComment = thread.comments?.[0];
  const preview = firstComment ? stripHtml(firstComment.body) : '(no comments)';
  const isOrphaned = resolution === 'unanchored';
  const count = thread.comments?.length ?? 0;

  return (
    <button type="button" className="cc-thread-btn" onClick={onClick}>
      <div className="cc-card-status">
        <Badge variant={statusBadgeVariant(thread.status)} size="S">
          {statusLabel(thread.status)}
        </Badge>
        {isOrphaned && <Badge variant="neutral" size="S">orphaned</Badge>}
      </div>
      <div className="cc-card-preview">{preview}</div>
      <div className="cc-card-meta">
        <span className="cc-card-author">{firstComment?.author_name ?? '—'}</span>
        <span className="cc-card-sep">·</span>
        <span>{count} {count === 1 ? 'comment' : 'comments'}</span>
        <span className="cc-card-sep">·</span>
        <span title={thread.created_at ? fmtDate(thread.created_at) : ''}>
          {thread.created_at ? relTime(thread.created_at) : ''}
        </span>
      </div>
    </button>
  );
}

// ── Thread detail ─────────────────────────────────────────────────────────────

function ThreadDetail({ thread, resolution, tabId, pageUrl, auth, onBack, onUpdate, onDelete, onScrollTo, onError }) {
  const [replyText, setReplyText] = useState('');
  const [posting, setPosting] = useState(false);
  const commentsRef = useRef(null);

  if (!thread) {
    // activeId is only ever set once the thread exists, so a missing thread
    // here means it was deleted (by us elsewhere, another client, or dropped
    // by the poll). Offer a way back instead of spinning forever.
    return (
      <div className="cc-detail">
        <div className="cc-detail-header">
          <ActionButton isQuiet aria-label="Back to list" onPress={onBack} size="S">
            <ChevronLeftIcon />
          </ActionButton>
        </div>
        <div className="cc-empty">This thread is no longer available.</div>
      </div>
    );
  }

  async function changeStatus(status) {
    try {
      const updated = await sw('cc:api:patchThread', { id: thread.id, data: { status } });
      onUpdate({ ...thread, status: updated?.status ?? status });
    } catch (err) { onError?.(`Couldn't update status — ${err.message}`); }
  }

  async function deleteThread() {
    try {
      await sw('cc:api:deleteThread', { id: thread.id });
      onDelete();
    } catch (err) { onError?.(`Couldn't delete thread — ${err.message}`); }
  }

  // Delete a single comment. If it was the last one, the thread would be left
  // empty, so cascade into deleting the thread and returning to the list —
  // matches the milo reference (panel.js) and avoids orphaned "(no comments)"
  // threads. The backend's FK cascade handles the comment rows either way; this
  // just keeps the client state (and the on-page marker) consistent.
  async function deleteComment(commentId) {
    try {
      await sw('cc:api:deleteComment', { id: commentId });
      const remaining = (thread.comments ?? []).filter((c) => c.id !== commentId);
      if (remaining.length === 0) {
        await sw('cc:api:deleteThread', { id: thread.id });
        onDelete();
      } else {
        onUpdate({ ...thread, comments: remaining });
      }
    } catch (err) { onError?.(`Couldn't delete comment — ${err.message}`); }
  }

  async function postReply() {
    if (!replyText.trim()) return;
    setPosting(true);
    try {
      const authorName = myAuthorName(auth.profile);
      const comment = await sw('cc:api:createComment', { threadId: thread.id, body: replyText.trim(), authorName });
      onUpdate({ ...thread, comments: [...(thread.comments ?? []), comment] });
      setReplyText('');
      // Bring the just-posted comment into view (comments render oldest→newest).
      // Double rAF so the scroll runs after React has committed the new node.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = commentsRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }));
    } catch (err) {
      // Leave replyText intact so the user doesn't lose what they wrote.
      onError?.(`Couldn't post reply — ${err.message}`);
    } finally { setPosting(false); }
  }

  const isOrphaned = resolution === 'unanchored';
  // Slack-style: only the thread's creator (author of its first comment) may
  // delete the whole thread. Same best-effort, display-name guard as
  // isMyComment — not a security boundary (see its note).
  const canDeleteThread = isMyComment(thread.comments?.[0], auth.profile);

  return (
    <div className="cc-detail">
      {/* Detail header */}
      <div className="cc-detail-header">
        <ActionButton isQuiet aria-label="Back to list" onPress={onBack} size="S">
          <ChevronLeftIcon />
        </ActionButton>
        {isOrphaned && <Badge variant="neutral" size="S">orphaned</Badge>}
        <span style={{ flex: 1 }} />
        <ActionButton isQuiet aria-label="Scroll to on page" onPress={onScrollTo} size="S">
          <TargetIcon />
        </ActionButton>
        {canDeleteThread && (
          <DialogTrigger>
            <ActionButton isQuiet aria-label="Delete thread" size="S">
              <DeleteIcon />
            </ActionButton>
            <AlertDialog
              variant="destructive"
              title="Delete thread"
              primaryActionLabel="Delete"
              cancelLabel="Cancel"
              onPrimaryAction={deleteThread}
            >
              Delete this thread and all its comments? This cannot be undone.
            </AlertDialog>
          </DialogTrigger>
        )}
      </div>

      {/* Status selector */}
      <div className="cc-detail-status">
        <ToggleButtonGroup
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[thread.status ?? 'open']}
          onSelectionChange={(keys) => {
            const next = [...keys][0];
            if (next && next !== (thread.status ?? 'open')) changeStatus(next);
          }}
          size="S"
          aria-label="Thread status"
        >
          <ToggleButton id="open">Open</ToggleButton>
          <ToggleButton id="in_progress">In progress</ToggleButton>
          <ToggleButton id="resolved">Resolved</ToggleButton>
        </ToggleButtonGroup>
      </div>

      <Divider size="S" />

      {/* Comments */}
      <div className="cc-comments" ref={commentsRef}>
        {(thread.comments ?? []).map((c) => (
          <CommentItem
            key={c.id}
            comment={c}
            canModify={isMyComment(c, auth.profile)}
            isLast={(thread.comments?.length ?? 0) <= 1}
            onUpdate={(updated) => onUpdate({
              ...thread,
              comments: thread.comments.map(x => x.id === updated.id ? updated : x),
            })}
            onDelete={() => deleteComment(c.id)}
            onError={onError}
          />
        ))}
      </div>

      {/* Reply compose — Cmd/Ctrl+Enter submits */}
      <div className="cc-reply-area">
        <div onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) postReply(); }}>
          <TextArea
            value={replyText}
            onChange={setReplyText}
            placeholder="Reply…"
            aria-label="Reply text"
            width="100%"
          />
        </div>
        <div className="cc-reply-hint">Enter for a new line · ⌘/Ctrl+Enter to send</div>
        <div className="cc-reply-actions">
          <Button
            variant="accent"
            size="S"
            onPress={postReply}
            isDisabled={posting || !replyText.trim()}
          >
            {posting ? 'Posting…' : 'Reply'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Comment item ──────────────────────────────────────────────────────────────

function CommentItem({ comment, canModify, isLast, onUpdate, onDelete, onError }) {
  const [editing, setEditing] = useState(false);
  // editText is seeded when the editor opens (see openEditor), not just at mount,
  // so it reflects the freshest server body if a poll updated it in the meantime.
  const [editText, setEditText] = useState(comment.body ?? '');
  // Tri-state: 1 = upvoted, -1 = downvoted, 0 = not voted
  const [myVote, setMyVoteState] = useState(0);

  useEffect(() => { getMyVote(comment.id).then(setMyVoteState); }, [comment.id]);

  // Open/close the inline editor. On open, re-seed from the current comment.body
  // so an edit that started after a background poll doesn't begin from stale
  // text. While the editor is open, editText persists across re-renders, so an
  // incoming poll never clobbers what the user is typing — the React analogue of
  // milo's guard, which simply skips re-rendering the detail view during editing.
  function toggleEditor() {
    if (editing) { setEditing(false); return; }
    setEditText(comment.body ?? '');
    setEditing(true);
  }

  async function saveEdit() {
    const body = editText.trim();
    if (!body) return;
    try {
      const updated = await sw('cc:api:patchComment', { id: comment.id, body });
      onUpdate({ ...comment, body: updated?.body ?? body, edited_at: updated?.edited_at ?? comment.edited_at });
      setEditing(false);
    } catch (err) {
      // Keep the editor open with the user's text so the edit isn't lost.
      onError?.(`Couldn't save edit — ${err.message}`);
    }
  }

  async function vote(dir) {
    const prev = myVote;
    // Clicking the active direction undoes it (toggle off → 0)
    const next = prev === dir ? 0 : dir;
    if (prev === next) return;
    const upDelta   = (next === 1  ? 1 : 0) - (prev === 1  ? 1 : 0);
    const downDelta = (next === -1 ? 1 : 0) - (prev === -1 ? 1 : 0);
    // Optimistic; revert both the toggle and the stored vote if the call fails.
    setMyVoteState(next);
    await setMyVote(comment.id, next);
    try {
      const updated = await sw('cc:api:voteComment', {
        id: comment.id, upvoteDelta: upDelta, downvoteDelta: downDelta,
      });
      onUpdate({ ...comment, upvotes: updated?.upvotes ?? comment.upvotes, downvotes: updated?.downvotes ?? comment.downvotes });
    } catch (err) {
      setMyVoteState(prev);
      await setMyVote(comment.id, prev);
      onError?.(`Couldn't record vote — ${err.message}`);
    }
  }

  return (
    <div className="cc-comment-block">
      <div className="cc-comment-header">
        <span className="cc-comment-author">{comment.author_name ?? '?'}</span>
        <span className="cc-comment-time">{comment.created_at ? fmtDate(comment.created_at) : ''}</span>
        {comment.edited_at && <span className="cc-comment-edited">(edited)</span>}
        <span style={{ flex: 1 }} />
        {/* Edit/delete are shown only for the current user's own comments — see
            isMyComment. Not a security boundary; the backend enforces nothing. */}
        {canModify && (
          <>
            <ActionButton isQuiet size="XS" aria-label="Edit comment" onPress={toggleEditor}>
              <EditIcon />
            </ActionButton>
            <DialogTrigger>
              <ActionButton isQuiet size="XS" aria-label="Delete comment">
                <DeleteIcon />
              </ActionButton>
              <AlertDialog
                variant="destructive"
                title={isLast ? 'Delete comment and thread' : 'Delete comment'}
                primaryActionLabel="Delete"
                cancelLabel="Cancel"
                onPrimaryAction={onDelete}
              >
                {isLast
                  ? 'This is the only comment in this thread — deleting it also deletes the thread. This cannot be undone.'
                  : 'Delete this comment? This cannot be undone.'}
              </AlertDialog>
            </DialogTrigger>
          </>
        )}
      </div>

      {editing ? (
        /* ⌘/Ctrl+Enter saves — parity with the reply and compose boxes. */
        <div onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit(); }}>
          <TextArea
            value={editText}
            onChange={setEditText}
            aria-label="Edit comment text"
            width="100%"
            autoFocus
          />
          <div className="cc-reply-hint">Enter for a new line · ⌘/Ctrl+Enter to save</div>
          <div className="cc-edit-actions">
            <Button variant="secondary" size="S" onPress={() => setEditing(false)}>Cancel</Button>
            <Button variant="accent" size="S" onPress={saveEdit} isDisabled={!editText.trim()}>Save</Button>
          </div>
        </div>
      ) : (
        /* Strip any HTML from milo-authored bodies; plain-text input stays as-is */
        <p className="cc-comment-body">{stripHtml(comment.body ?? '')}</p>
      )}

      <div className="cc-vote-row">
        <ToggleButton
          isQuiet
          isSelected={myVote === 1}
          onChange={() => vote(1)}
          size="S"
          aria-label={`Upvote (${comment.upvotes ?? 0})`}
        >
          <ThumbUpIcon />
          <Text>{comment.upvotes ?? 0}</Text>
        </ToggleButton>
        <ToggleButton
          isQuiet
          isSelected={myVote === -1}
          onChange={() => vote(-1)}
          size="S"
          aria-label={`Downvote (${comment.downvotes ?? 0})`}
        >
          <ThumbDownIcon />
          <Text>{comment.downvotes ?? 0}</Text>
        </ToggleButton>
      </div>
    </div>
  );
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

createRoot(document.getElementById('root')).render(<App />);
