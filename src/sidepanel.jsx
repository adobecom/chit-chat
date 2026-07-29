/**
 * sidepanel.js — Chit Chat side panel app (React 19 + React Spectrum S2)
 *
 * Runs in the extension's own origin (chrome-extension://…/sidepanel.html).
 * All network I/O is proxied through the service worker via chrome.runtime.sendMessage.
 * All on-page DOM interactions are delegated to the content script via the same channel.
 *
 * State model:
 *   pageUrl    — current active tab's page URL (updated by content script messages)
 *   threads    — from the backend: an SSE stream (see the realtime effect), with a
 *                10s poll as the fallback when the stream cannot be held
 *   resolution — { [threadId]: 'resolved'|'approximate'|'unanchored' } from content script
 *   view       — 'list' | 'detail'
 *   activeId   — focused thread id (detail view)
 *   mode       — annotation mode: null|'element'|'rect'|'ellipse'
 *   auth       — { signedIn: bool, profile: { email, name, avatar }|null }
 *   theme      — 'light'|'dark'
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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
  TagGroup,
  Tag,
  Avatar,
} from '@react-spectrum/s2';
import { sanitizeHtml, stripHtml } from '@adobe/annotations-core/sanitize';
import { STATUS_BADGE_VARIANT } from '@adobe/annotations-core/colors';
import { eventsPath } from '@adobe/annotations-core/contract';
import { createRealtimeConnection, pumpSseStream } from '@adobe/annotations-core/realtime';
import {
  MENTION_SEARCH_DEBOUNCE_MS, createMentionPicker, findMentionQuery,
} from '@adobe/annotations-core/mentions';
import QuillEditor from '@adobe/annotations-core/QuillEditor';
// Quill itself (and its CSS) is bundled here, not lazy-loaded, since the side
// panel's CSP is script-src 'self' — nothing can load from a CDN. Passed to
// the shared QuillEditor via loadQuill; milo-logs-deploy's client instead
// passes its own CDN-lazy loader (see QuillEditor.jsx's header comment for why).
import Quill from 'quill';
import 'quill/dist/quill.snow.css';
import EmojiIcon from '@react-spectrum/s2/icons/Emoji';
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

// Quill is already loaded (static import above) — the shared QuillEditor's
// loadQuill prop exists so milo-logs-deploy's client can lazy-load from a CDN
// instead; here it just resolves immediately. Defined once at module scope
// (not per-render) since it's passed to every QuillEditor instance.
const loadQuill = () => Promise.resolve(Quill);
const renderEmojiIcon = () => <EmojiIcon aria-hidden UNSAFE_className="cc-emoji-icon" />;

// Caps a comment body defensively — base64 screenshots can bloat it into the
// MBs, and neither the API proxy nor the backend's body-column limit is guarded.
const MAX_COMMENT_BODY_CHARS = 2_000_000; // ~2MB
// How long after a local optimistic mutation an incoming SSE frame is ignored.
// The backend re-broadcasts after every write, so the authoritative state lands
// just after this window — long enough to cover the write's round trip, short
// enough that a genuine remote change is never delayed noticeably.
const MUTATION_GRACE_MS = 1_500;

const BODY_TOO_LARGE_MSG = "That comment is too large to post — try a smaller or cropped screenshot.";

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

export function relTime(iso) {
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Absolute date-time string, e.g. "Jul 10, 12:45 AM". Used inside a thread
// (comments) where the precise time matters; the list keeps the terse relTime.
export function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// Two-letter initials from a profile: first + last name initial
// (e.g. John Doe → "JD"). Prefers structured given/family name parts, then
// falls back to splitting the display name, then the email local part.
export function initials(profile) {
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

// Wraps "@Name" occurrences (matched against comment.mentions, not raw "@"
// text) in a highlight span, operating on already-*sanitized* HTML rather than
// plain text — comment bodies are Quill-authored HTML now, so a naive
// string/regex pass over the markup could match inside attribute values.
// Walking text nodes via DOMParser (no browsing context, so no embedded
// resource ever loads/fires here) keeps the rewrite scoped to visible text.
export function highlightMentionsHtml(html, mentions) {
  const names = [...new Set((mentions ?? []).map((m) => m.name?.trim()).filter(Boolean))]
    // Longest names first, so "@Alice Reza" isn't cut short by "@Alice" from another mention.
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!names.length || !html) return html;

  const re = new RegExp(`@(?:${names.join('|')})`, 'g');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node = walker.nextNode();
  while (node) { textNodes.push(node); node = walker.nextNode(); }

  textNodes.forEach((textNode) => {
    const text = textNode.textContent;
    re.lastIndex = 0;
    if (!re.test(text)) return;
    re.lastIndex = 0;
    const frag = doc.createDocumentFragment();
    let lastIndex = 0;
    let match = re.exec(text);
    while (match) {
      if (match.index > lastIndex) frag.appendChild(doc.createTextNode(text.slice(lastIndex, match.index)));
      const span = doc.createElement('span');
      span.className = 'cc-mention';
      span.textContent = match[0];
      frag.appendChild(span);
      lastIndex = match.index + match[0].length;
      match = re.exec(text);
    }
    if (lastIndex < text.length) frag.appendChild(doc.createTextNode(text.slice(lastIndex)));
    textNode.replaceWith(frag);
  });
  return doc.body.innerHTML;
}

// Human-readable status label. Undefined/null is treated as 'open'.
export function statusLabel(status) {
  if (status === 'in_progress') return 'In progress';
  if (status === 'resolved') return 'Resolved';
  return 'Open';
}

// S2 Badge variant per status — colored text/pill with theme-safe contrast
// in both light and dark (S2 owns the fg/bg pairing). Shared with
// milo-logs-deploy's ThreadCard.js, which independently landed on this same
// mapping — single source of truth now instead of two maps that happen to agree.
export function statusBadgeVariant(status) {
  return STATUS_BADGE_VARIANT[status] ?? STATUS_BADGE_VARIANT.open; // 'open' or undefined
}

// The author_name we stamp on comments this user creates — single source of
// truth shared by comment creation and the ownership guard below.
export function myAuthorName(profile) {
  return profile?.name ?? profile?.email ?? null;
}

// Frontend-only ownership check. The backend stores author_id as NULL and does
// NOT enforce ownership (edit/delete are open to anyone with the id), so this
// is a best-effort UI guard matched on display name: it hides edit/delete for
// comments that aren't the current user's. Limitations: identical display names
// collide, and a changed profile name orphans a user from their old comments.
// This is a courtesy guard, not a security boundary.
export function isMyComment(comment, profile) {
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
  // When the last optimistic mutation happened. The SSE stream needs a different
  // guard from fetchThreads': a stream frame has no "request start" to compare a
  // sequence number against, so instead frames are suppressed for a short window
  // after a local mutation. The backend re-broadcasts after every write, so the
  // authoritative state arrives right after the window closes — this trades a
  // few hundred ms of staleness for never flickering a just-made change back to
  // its old value.
  const lastMutationAtRef = useRef(0);

  // Records a local optimistic mutation for BOTH staleness guards at once, so
  // the poll path and the stream path can never drift out of sync.
  const noteLocalMutation = useCallback(() => {
    mutationSeqRef.current += 1;
    lastMutationAtRef.current = Date.now();
  }, []);

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

  // ── Realtime: SSE stream, falling back to polling ─────────────────────────
  // Previously a fixed 10s poll, which meant the extension was always up to 10s
  // stale even though the backend pushes instantly in production. The
  // connect/retry/fall-back-to-poll ladder is shared with milo's in-page client
  // via @adobe/annotations-core/realtime; only how the connection is opened
  // differs, and it has to:
  //
  //   - milo uses a native EventSource authenticated by the pc_session cookie
  //     (EventSource cannot send an Authorization header).
  //   - the panel is a chrome-extension:// origin, so that cookie would be
  //     third-party and subject to blocking. Instead it reads the stream with
  //     fetch + ReadableStream and the SAME Bearer token every other request
  //     uses — the backend accepts a Bearer on GET /annotations/events (its
  //     cookie branch only applies when no Authorization header is present).
  //     No server change, and no third-party-cookie dependency.
  //
  // Stream frames need the same protection poll responses get: a frame is just
  // as capable of clobbering optimistic local state. The sequence-number trick
  // fetchThreads uses doesn't transfer — a pushed frame has no "request start"
  // to compare against — so frames are suppressed for a short window after a
  // local mutation instead. See lastMutationAtRef.
  //
  // A suppressed frame must be RE-FETCHED, not merely dropped. The backend
  // broadcasts only on write, and no poll is running while the stream is healthy
  // (the realtime ladder stops it on the first frame), so a discarded frame is
  // gone for good: if another reviewer's change happens to land inside the
  // window, this panel would never see it for the rest of the session. The timer
  // below re-syncs once the window closes, which restores eventual consistency.
  const catchUpTimerRef = useRef(null);
  const applyStreamThreads = useCallback((payload, forUrl) => {
    if (forUrl !== pageUrlRef.current) return; // page changed under us

    const sinceMutation = Date.now() - lastMutationAtRef.current;
    if (sinceMutation < MUTATION_GRACE_MS) {
      // One pending catch-up is enough — collapse repeats rather than stacking
      // a timer per suppressed frame.
      if (catchUpTimerRef.current === null) {
        catchUpTimerRef.current = setTimeout(() => {
          catchUpTimerRef.current = null;
          if (forUrl === pageUrlRef.current) {
            catchUpRef.current?.(forUrl);
          }
        }, MUTATION_GRACE_MS - sinceMutation + 50);
      }
      return;
    }

    const list = payload?.threads ?? payload ?? [];
    if (!Array.isArray(list)) return;
    // Bump the sequence so an in-flight poll started BEFORE this frame can't
    // land afterwards and revert it (fetchThreads compares against this).
    mutationSeqRef.current += 1;
    threadsUrlRef.current = forUrl;
    setThreads(list);
    setSessionExpired(false); // a live frame proves the session is healthy
  }, []);

  // Indirection so applyStreamThreads (deps []) can reach the current
  // fetchThreads without being recreated — recreating it would tear down and
  // reopen the SSE stream on every render.
  const catchUpRef = useRef(null);

  // Keep the catch-up indirection pointing at the live fetchThreads.
  useEffect(() => {
    catchUpRef.current = (url) => fetchThreads(url, { silent: true, background: true });
  }, [fetchThreads]);

  useEffect(() => () => {
    if (catchUpTimerRef.current !== null) clearTimeout(catchUpTimerRef.current);
  }, []);

  useEffect(() => {
    if (!pageUrl || !auth.signedIn) return undefined;

    const urlAtStart = pageUrl;
    const conn = createRealtimeConnection({
      // Keep the existing SW-proxied fetch as the fallback: it already handles
      // token refresh, SESSION_EXPIRED and the 401 retry. Skipped while the
      // panel is hidden — a background poll for a panel nobody is looking at is
      // pure API load (the pre-SSE poll had this same guard).
      poll: () => {
        if (document.hidden) return undefined;
        return fetchThreads(urlAtStart, { silent: true, background: true });
      },
      onThreads: (payload) => applyStreamThreads(payload, urlAtStart),
      pollMs: 10_000, // unchanged from the previous fixed poll
      openStream: async ({ onMessage, onError }) => {
        const { token, apiBase, clientId } = await sw('cc:auth:streamToken');
        // No token → let the ladder degrade to polling rather than opening an
        // unauthenticated stream that would 401 immediately.
        if (!token) throw new Error('no token for stream');

        const controller = new AbortController();
        const url = `${apiBase}${eventsPath(urlAtStart)}&clientId=${clientId}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);

        // Pump in the background; a normal end-of-stream is also a failure from
        // the ladder's perspective (the server closed), so both paths call
        // onError and let it decide whether to retry or degrade.
        pumpSseStream(res.body, onMessage, { signal: controller.signal })
          .then(() => { if (!controller.signal.aborted) onError(new Error('stream ended')); })
          .catch((err) => { if (!controller.signal.aborted) onError(err); });

        return () => controller.abort();
      },
    });

    conn.start();
    // Returning to the panel reconnects a dead stream / polls immediately, so
    // it never shows stale threads after being hidden.
    const onVisible = () => { if (!document.hidden) conn.refreshNow(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      conn.stop();
    };
  }, [pageUrl, auth.signedIn, fetchThreads, applyStreamThreads]);

  // ── Push threads to content script overlay ────────────────────────────────
  // Only push when the current threads actually belong to the active page. On a
  // tab switch to a different URL, this effect can run once with the new tabId
  // but the previous page's threads still in state; pushing then would flash the
  // old page's markers on the new tab. threadsUrlRef is set in fetchThreads to
  // the URL the threads were fetched for.
  // statusFilter rides along so the on-page overlay hides the same threads the
  // list does (the shared overlay model applies it) — before this the overlay
  // rendered every thread regardless of the filter, including orphaned ones.
  useEffect(() => {
    if (tabId !== null && threadsUrlRef.current === pageUrl) {
      toContent(tabId, 'cc:content:threads', { threads, statusFilter }).catch(() => {});
    }
  }, [threads, tabId, pageUrl, statusFilter]);

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
                noteLocalMutation();
                setThreads(ts => ts.map(t => t.id === updated.id ? updated : t));
              }}
              onDelete={() => {
                noteLocalMutation();
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

// ── @-mention autocomplete ───────────────────────────────────────────────────
// "@" opens a floating suggestion list. Not an atomic token — a mention is just
// inserted "@Name " text in the Quill editor (see QuillEditor.jsx) plus an email
// tracked alongside it in React state, not a rich-text object Quill itself
// understands. Shared by the reply composer (ThreadDetail) and edit editor
// (CommentItem).
//
// The query detection, debounce, list navigation and insert-on-pick logic all
// live in @adobe/annotations-core/mentions, shared with milo-logs-deploy's
// client (which previously could RENDER mentions but not author them). Only the
// transport is injected here: this client proxies the people search through its
// service worker, milo calls fetch directly.
// Re-exported so tests can exercise it through this module; the implementation
// now lives in the shared package.
export { findMentionQuery };

const useMentionPicker = createMentionPicker({
  useState,
  useEffect,
  searchPeople: (q) => sw('cc:api:searchPeople', { q }),
});

function MentionSuggestions({ results, activeIndex, onPick, onHover }) {
  if (!results.length) return null;
  return (
    <div className="cc-mention-popover" role="listbox" aria-label="Mention suggestions">
      {results.map((person, i) => (
        <button
          type="button"
          key={person.email}
          role="option"
          aria-selected={i === activeIndex}
          className={`cc-mention-suggestion${i === activeIndex ? ' is-active' : ''}`}
          onMouseEnter={() => onHover(i)}
          // mousedown fires before blur, so pick()'s caret read is still valid.
          onMouseDown={(e) => { e.preventDefault(); onPick(person); }}
        >
          <Avatar src={person.avatar} alt="" size={20} />
          <span className="cc-mention-suggestion-text">
            <span className="cc-mention-suggestion-name">{person.name}</span>
            <span className="cc-mention-suggestion-email">{person.email}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function MentionChips({ mentions, onRemove }) {
  if (!mentions.length) return null;
  return (
    <TagGroup
      aria-label="Mentioned people"
      UNSAFE_className="cc-mention-chips"
      items={mentions.map((m) => ({ id: m.email, ...m }))}
      onRemove={(keys) => [...keys].forEach((email) => onRemove(email))}
    >
      {(item) => <Tag id={item.id}>{item.name}</Tag>}
    </TagGroup>
  );
}

// ── Thread assignee ──────────────────────────────────────────────────────────
// Same Slack-directory search as @-mentions, but a standalone SearchField (no
// caret to track). Persists via patchThread's `assignee` field — not
// ownership-gated, unlike status.
function AssigneePicker({ thread, onUpdate, onError }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    // Opening the picker fires this before any typing — skip the round trip
    // on an empty query, same as the mention picker.
    if (!query.trim()) { setResults([]); return undefined; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const people = await sw('cc:api:searchPeople', { q: query });
        if (!cancelled) setResults(people ?? []);
      } catch {
        if (!cancelled) setResults([]);
      }
    }, MENTION_SEARCH_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, query]);

  async function assign(person) {
    setSaving(true);
    try {
      const updated = await sw('cc:api:patchThread', { id: thread.id, data: { assignee: person?.email ?? null } });
      onUpdate({ ...thread, assignee: updated?.assignee ?? (person ? { id: person.email, name: person.name } : null) });
      setOpen(false);
      setQuery('');
      setResults([]);
    } catch (err) {
      onError?.(`Couldn't update assignee — ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  if (thread.assignee && !open) {
    return (
      <div className="cc-assignee">
        <span className="cc-assignee-label">Assigned to</span>
        <TagGroup
          aria-label="Assignee"
          items={[{ id: thread.assignee.id, name: thread.assignee.name }]}
          onRemove={() => assign(null)}
        >
          {(item) => <Tag id={item.id}>{item.name}</Tag>}
        </TagGroup>
        <ActionButton isQuiet size="S" onPress={() => setOpen(true)} isDisabled={saving}>Change</ActionButton>
      </div>
    );
  }

  return (
    <div className="cc-assignee">
      {!open ? (
        <ActionButton isQuiet size="S" onPress={() => setOpen(true)}>+ Assign</ActionButton>
      ) : (
        <div className="cc-assignee-picker">
          <SearchField
            aria-label="Search people to assign"
            placeholder="Assign to…"
            value={query}
            onChange={setQuery}
            autoFocus
            size="S"
          />
          <MentionSuggestions results={results} activeIndex={-1} onPick={assign} onHover={() => {}} />
          <ActionButton
            isQuiet
            size="S"
            onPress={() => { setOpen(false); setQuery(''); setResults([]); }}
            isDisabled={saving}
          >
            Cancel
          </ActionButton>
        </div>
      )}
    </div>
  );
}

// ── Thread detail ─────────────────────────────────────────────────────────────

function ThreadDetail({ thread, resolution, tabId, pageUrl, auth, onBack, onUpdate, onDelete, onScrollTo, onError }) {
  // Uncontrolled Quill instance (see QuillEditor) — track only whether it's
  // empty, to drive the Reply button's disabled state.
  const replyEditorRef = useRef(null);
  const [replyEmpty, setReplyEmpty] = useState(true);
  const [replyMentions, setReplyMentions] = useState([]);
  const [posting, setPosting] = useState(false);
  // Field-level validation error (size guard), shown inline under the editor —
  // distinct from onError's global banner, which is reserved for API/network failures.
  const [replyError, setReplyError] = useState(null);
  const commentsRef = useRef(null);
  const mentionPicker = useMentionPicker(replyEditorRef, replyMentions, setReplyMentions);

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
    const editor = replyEditorRef.current;
    if (!editor || replyEmpty) return;
    setReplyError(null);
    // Store raw HTML; CommentBody sanitizes at render time (same as milo).
    const body = editor.getHtml();
    if (body.length > MAX_COMMENT_BODY_CHARS) { setReplyError(BODY_TOO_LARGE_MSG); return; }
    setPosting(true);
    try {
      const authorName = myAuthorName(auth.profile);
      const comment = await sw('cc:api:createComment', {
        threadId: thread.id, body, authorName, mentions: replyMentions.map((m) => m.email),
      });
      onUpdate({ ...thread, comments: [...(thread.comments ?? []), comment] });
      editor.clear();
      setReplyEmpty(true);
      setReplyMentions([]);
      mentionPicker.reset();
      // Bring the just-posted comment into view (comments render oldest→newest).
      // Double rAF so the scroll runs after React has committed the new node.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = commentsRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }));
    } catch (err) {
      // Leave the editor's contents and picked mentions intact so the user doesn't lose what they wrote.
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
        <AssigneePicker thread={thread} onUpdate={onUpdate} onError={onError} />
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

      {/* Reply compose — Cmd/Ctrl+Enter submits, @name opens the mention picker */}
      <div className="cc-reply-area">
        <MentionChips mentions={replyMentions} onRemove={mentionPicker.removeMention} />
        <div
          className="cc-mention-compose"
          onKeyDown={(e) => {
            if (mentionPicker.handleKeyDown(e)) { e.preventDefault(); return; }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) postReply();
          }}
        >
          <QuillEditor
            ref={replyEditorRef}
            loadQuill={loadQuill}
            renderEmojiIcon={renderEmojiIcon}
            placeholder="Reply… (@ to mention someone)"
            aria-label="Reply text"
            onEmptyChange={setReplyEmpty}
            onCaretChange={mentionPicker.syncFromCaret}
          />
          <MentionSuggestions
            results={mentionPicker.results}
            activeIndex={mentionPicker.activeIndex}
            onPick={mentionPicker.pick}
            onHover={mentionPicker.setActiveIndex}
          />
        </div>
        <div className={`cc-reply-hint${replyError ? ' cc-reply-error' : ''}`}>
          {replyError ?? 'Enter for a new line · ⌘/Ctrl+Enter to send'}
        </div>
        <div className="cc-reply-actions">
          <Button
            variant="accent"
            size="S"
            onPress={postReply}
            isDisabled={posting || replyEmpty}
          >
            {posting ? 'Posting…' : 'Reply'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Sanitized render of a comment body (milo-authored HTML may include links
// and images), with "@Name" mentions highlighted afterward. Memoized since
// screenshot bodies can be large base64 strings.
function CommentBody({ body, mentions }) {
  const safe = useMemo(
    () => highlightMentionsHtml(sanitizeHtml(body ?? ''), mentions),
    [body, mentions],
  );
  // A <div>, not <p> — sanitized output can itself contain block-level <p>.
  return <div className="cc-comment-body" dangerouslySetInnerHTML={{ __html: safe }} />;
}

// ── Comment item ──────────────────────────────────────────────────────────────

function CommentItem({ comment, canModify, isLast, onUpdate, onDelete, onError }) {
  const [editing, setEditing] = useState(false);
  const [editEmpty, setEditEmpty] = useState(false);
  // Field-level validation error (size guard), shown inline under the editor —
  // distinct from onError's global banner, which is reserved for API/network failures.
  const [editError, setEditError] = useState(null);
  // Uncontrolled Quill instance, remounted fresh each time `editing` flips
  // true, seeded from comment.body — so it reflects the latest server body.
  const editorRef = useRef(null);
  // editMentions is (re-)seeded when the editor opens (see toggleEditor), not
  // just at mount, so it reflects the freshest server mentions if a poll
  // updated the comment in the meantime.
  const [editMentions, setEditMentions] = useState(comment.mentions ?? []);
  const mentionPicker = useMentionPicker(editorRef, editMentions, setEditMentions);
  // Tri-state: 1 = upvoted, -1 = downvoted, 0 = not voted
  const [myVote, setMyVoteState] = useState(0);

  useEffect(() => { getMyVote(comment.id).then(setMyVoteState); }, [comment.id]);

  // Open/close the inline editor. On open, re-seed editMentions from the
  // current comment.mentions (the Quill instance itself is remounted fresh
  // from comment.body, see editorRef above) so an edit that started after a
  // background poll doesn't begin from stale data. While the editor is open,
  // an incoming poll never clobbers what's being typed — the React analogue
  // of milo's guard, which simply skips re-rendering the detail view during
  // editing.
  function toggleEditor() {
    mentionPicker.reset();
    setEditError(null); // don't carry a stale error into the next open
    if (!editing) setEditMentions(comment.mentions ?? []);
    setEditing((prev) => !prev);
  }

  async function saveEdit() {
    const editor = editorRef.current;
    if (!editor || editEmpty) return;
    setEditError(null);
    const body = editor.getHtml();
    if (body.length > MAX_COMMENT_BODY_CHARS) { setEditError(BODY_TOO_LARGE_MSG); return; }
    try {
      const updated = await sw('cc:api:patchComment', { id: comment.id, body, mentions: editMentions.map((m) => m.email) });
      onUpdate({
        ...comment,
        body: updated?.body ?? body,
        mentions: updated?.mentions ?? editMentions,
        edited_at: updated?.edited_at ?? comment.edited_at,
      });
      setEditing(false);
      mentionPicker.reset();
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
        <>
          {/* ⌘/Ctrl+Enter saves — parity with the reply and compose boxes. @name opens the mention picker. */}
          <MentionChips mentions={editMentions} onRemove={mentionPicker.removeMention} />
          <div
            className="cc-mention-compose"
            onKeyDown={(e) => {
              if (mentionPicker.handleKeyDown(e)) { e.preventDefault(); return; }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit();
            }}
          >
            <QuillEditor
              ref={editorRef}
              loadQuill={loadQuill}
              renderEmojiIcon={renderEmojiIcon}
              initialHtml={comment.body ?? ''}
              aria-label="Edit comment text"
              onEmptyChange={setEditEmpty}
              onCaretChange={mentionPicker.syncFromCaret}
              autoFocus
            />
            <MentionSuggestions
              results={mentionPicker.results}
              activeIndex={mentionPicker.activeIndex}
              onPick={mentionPicker.pick}
              onHover={mentionPicker.setActiveIndex}
            />
          </div>
          <div className={`cc-reply-hint${editError ? ' cc-reply-error' : ''}`}>
            {editError ?? 'Enter for a new line · ⌘/Ctrl+Enter to save'}
          </div>
          <div className="cc-edit-actions">
            <Button variant="secondary" size="S" onPress={toggleEditor}>Cancel</Button>
            <Button variant="accent" size="S" onPress={saveEdit} isDisabled={editEmpty}>Save</Button>
          </div>
        </>
      ) : (
        <>
          <CommentBody body={comment.body} mentions={comment.mentions} />
          {comment.mentions?.length > 0 && (
            <TagGroup
              aria-label="Mentioned people"
              UNSAFE_className="cc-mention-chips"
              items={comment.mentions.map((m) => ({ id: m.email, ...m }))}
            >
              {(item) => <Tag id={item.id}>{item.name}</Tag>}
            </TagGroup>
          )}
        </>
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
