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
  Badge,
  StatusLight,
  SearchField,
  ProgressCircle,
  InlineAlert,
  Heading,
  Text,
  Content,
  Divider,
  DialogTrigger,
  AlertDialog,
  TextArea,
  SegmentedControl,
  SegmentedControlItem,
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

// Kept for completeness; comment bodies are rendered as text nodes so XSS isn't a concern.
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function relTime(iso) {
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function initials(name, email) {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  }
  if (email) {
    const [local] = email.split('@');
    return local.slice(0, 2).toUpperCase();
  }
  return '?';
}

const storage = {
  async get(key) { return new Promise(r => chrome.storage.sync.get(key, d => r(d[key] ?? null))); },
  async set(key, val) { return new Promise(r => chrome.storage.sync.set({ [key]: val }, r)); },
};

async function getVoted(commentId) { return !!(await storage.get(`vote:${commentId}`)); }
async function setVoted(commentId, v) { return storage.set(`vote:${commentId}`, v); }

function stripHtml(html) {
  if (!html) return '';
  const el = document.createElement('div');
  el.innerHTML = html;
  return el.textContent ?? '';
}

// StatusLight variant by thread status
function statusVariant(status) {
  if (status === 'approved') return 'positive';
  if (status === 'closed') return 'neutral';
  return 'info'; // 'open' or undefined
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
  const pollRef = useRef(null);

  // ── Theme ────────────────────────────────────────────────────────────────
  useEffect(() => {
    storage.get('theme').then(t => { if (t) setTheme(t); });
  }, []);
  useEffect(() => {
    storage.set('theme', theme);
  }, [theme]);

  // ── Auth ─────────────────────────────────────────────────────────────────
  const refreshAuth = useCallback(async () => {
    try {
      const res = await sw('cc:auth:status');
      setAuth({ signedIn: res.signedIn, profile: res.profile ?? null });
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { refreshAuth(); }, []);

  // ── Tab tracking ──────────────────────────────────────────────────────────
  // The content script sends cc:panel:pageUrl on boot, but the panel may load
  // after that message was already sent. Read the tab URL directly so threads
  // load immediately without waiting for the next content-script event.
  useEffect(() => {
    function applyTab(tab) {
      if (!tab) return;
      setTabId(tab.id);
      const url = tab.url ? new URL(tab.url) : null;
      if (url) setPageUrl(url.origin + url.pathname);
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => applyTab(tabs[0]));

    chrome.tabs.onActivated.addListener(({ tabId: tid }) => {
      chrome.tabs.get(tid, applyTab);
    });
    chrome.tabs.onUpdated.addListener((tid, info, tab) => {
      if (info.status === 'complete') {
        chrome.tabs.query({ active: true, currentWindow: true }, (ts) => {
          if (ts[0]?.id === tid) applyTab(ts[0]);
        });
      }
    });
  }, []);

  // ── Fetch threads ─────────────────────────────────────────────────────────
  const fetchThreads = useCallback(async (url) => {
    if (!url) return;
    setLoading(true); setError(null);
    try {
      const data = await sw('cc:api:fetchThreads', { pageUrl: url });
      setThreads(data?.threads ?? data ?? []);
      refreshAuth(); // token may have been acquired implicitly by ensureToken — sync state
    } catch (err) {
      if (err.message?.includes('401') || err.message?.includes('auth')) {
        setAuth({ signedIn: false, profile: null });
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }, [refreshAuth]);

  // Re-fetch when URL changes
  useEffect(() => { if (pageUrl) fetchThreads(pageUrl); }, [pageUrl]);

  // Poll every 10s (pause when doc hidden or signed out)
  useEffect(() => {
    if (!pageUrl || !auth.signedIn) return;
    const tick = () => { if (!document.hidden) fetchThreads(pageUrl); };
    pollRef.current = setInterval(tick, 10_000);
    return () => clearInterval(pollRef.current);
  }, [pageUrl, auth.signedIn]);

  // ── Push threads to content script overlay ────────────────────────────────
  useEffect(() => {
    if (tabId !== null && threads.length >= 0) {
      toContent(tabId, 'cc:content:threads', { threads }).catch(() => {});
    }
  }, [threads, tabId]);

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
          handleNewThread(p.pageUrl, p.anchor, p.body);
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

  // ── Handlers ─────────────────────────────────────────────────────────────
  async function handleNewThread(url, anchor, body) {
    try {
      const thread = await sw('cc:api:createThread', { pageUrl: url, anchor });
      if (thread && body) await sw('cc:api:createComment', { threadId: thread.id, body });
      await fetchThreads(url);
      if (thread) { setActiveId(thread.id); setView('detail'); }
    } catch (err) { setError(err.message); }
  }

  function toggleMode(m) {
    const next = mode === m ? null : m;
    setModeState(next);
    if (tabId) toContent(tabId, 'cc:content:mode', { mode: next }).catch(() => {});
  }

  async function signIn() {
    try {
      await sw('cc:auth:signIn');
      await refreshAuth();
      if (pageUrl) fetchThreads(pageUrl);
    } catch (err) { setError(err.message); }
  }

  async function signOut() {
    await sw('cc:auth:signOut');
    setAuth({ signedIn: false, profile: null });
    setThreads([]);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ pageUrl, threads }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `chit-chat-${(pageUrl || 'export').replace(/[^a-z0-9]/gi, '_')}.json`;
    a.click();
  }

  const filteredThreads = threads.filter((t) => {
    if (statusFilter !== 'all' && t.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const preview = (t.comments?.[0]?.body ?? '').toLowerCase();
      if (!preview.includes(q) && !(t.anchor?.cssSelector ?? '').toLowerCase().includes(q)) return false;
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
            {auth.profile?.avatar
              ? <img className="cc-avatar cc-avatar--img" src={auth.profile.avatar} alt="" />
              : <div className="cc-avatar">{initials(auth.profile?.name, auth.profile?.email)}</div>}
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
              onBack={() => { setView('list'); setActiveId(null); }}
              onUpdate={(updated) => setThreads(ts => ts.map(t => t.id === updated.id ? updated : t))}
              onDelete={() => {
                setThreads(ts => ts.filter(t => t.id !== activeId));
                setView('list'); setActiveId(null);
              }}
              onScrollTo={() => {
                if (tabId && activeThread) toContent(tabId, 'cc:content:scrollTo', { threadId: activeId }).catch(() => {});
              }}
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
            isQuiet
            isSelected={mode === 'element'}
            onChange={() => toggleMode('element')}
            aria-label="Element comment mode"
            size="S"
          >
            <CursorClickIcon />
          </ToggleButton>
          <ToggleButton
            isQuiet
            isSelected={mode === 'rect'}
            onChange={() => toggleMode('rect')}
            aria-label="Rectangle annotation"
            size="S"
          >
            <SelectRectangleIcon />
          </ToggleButton>
          <ToggleButton
            isQuiet
            isSelected={mode === 'ellipse'}
            onChange={() => toggleMode('ellipse')}
            aria-label="Ellipse annotation"
            size="S"
          >
            <CircleIcon />
          </ToggleButton>
        </div>
      )}
    </Provider>
  );
}

// ── Thread list ───────────────────────────────────────────────────────────────

function ThreadList({ threads, resolution, loading, search, setSearch, statusFilter, setStatusFilter, onSelect }) {
  return (
    <div className="cc-body">
      <div className="cc-search-area">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Search…"
          aria-label="Search threads"
          width="100%"
        />
        <SegmentedControl
          selectedKey={statusFilter}
          onSelectionChange={setStatusFilter}
          aria-label="Filter by status"
        >
          <SegmentedControlItem id="all">All</SegmentedControlItem>
          <SegmentedControlItem id="open">Open</SegmentedControlItem>
          <SegmentedControlItem id="approved">Approved</SegmentedControlItem>
          <SegmentedControlItem id="closed">Closed</SegmentedControlItem>
        </SegmentedControl>
      </div>

      {loading && (
        <div className="cc-centered">
          <ProgressCircle isIndeterminate aria-label="Loading threads" size="S" />
        </div>
      )}
      {!loading && threads.length === 0 && (
        <div className="cc-empty">No annotations on this page yet.</div>
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

  return (
    <button type="button" className="cc-thread-btn" onClick={onClick}>
      <div className="cc-card-header">
        <StatusLight
          variant={statusVariant(thread.status)}
          aria-label={thread.status ?? 'open'}
          UNSAFE_style={{ marginRight: 2 }}
        />
        <span className="cc-card-author">{firstComment?.author ?? '—'}</span>
        {isOrphaned && <Badge variant="neutral" size="S">orphaned</Badge>}
        <span className="cc-card-time">{thread.createdAt ? relTime(thread.createdAt) : ''}</span>
      </div>
      <div className="cc-card-preview">{preview}</div>
    </button>
  );
}

// ── Thread detail ─────────────────────────────────────────────────────────────

function ThreadDetail({ thread, resolution, tabId, pageUrl, onBack, onUpdate, onDelete, onScrollTo }) {
  const [replyText, setReplyText] = useState('');
  const [posting, setPosting] = useState(false);

  if (!thread) {
    return (
      <div className="cc-centered">
        <ProgressCircle isIndeterminate aria-label="Loading" size="S" />
      </div>
    );
  }

  async function changeStatus(status) {
    try {
      const updated = await sw('cc:api:patchThread', { id: thread.id, data: { status } });
      onUpdate({ ...thread, status: updated?.status ?? status });
    } catch (err) { console.error(err); }
  }

  // Called by AlertDialog onAction — no confirm() needed
  async function deleteThread() {
    await sw('cc:api:deleteThread', { id: thread.id });
    onDelete();
  }

  async function postReply() {
    if (!replyText.trim()) return;
    setPosting(true);
    try {
      const comment = await sw('cc:api:createComment', { threadId: thread.id, body: replyText.trim() });
      onUpdate({ ...thread, comments: [...(thread.comments ?? []), comment] });
      setReplyText('');
    } catch (err) { console.error(err); } finally { setPosting(false); }
  }

  const isOrphaned = resolution === 'unanchored';

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
        <DialogTrigger>
          <ActionButton isQuiet aria-label="Delete thread" size="S">
            <DeleteIcon />
          </ActionButton>
          <AlertDialog
            variant="destructive"
            title="Delete thread"
            actionLabel="Delete"
            onAction={deleteThread}
          >
            Delete this thread and all its comments? This cannot be undone.
          </AlertDialog>
        </DialogTrigger>
      </div>

      {/* Status selector */}
      <div className="cc-detail-status">
        <SegmentedControl
          selectedKey={thread.status ?? 'open'}
          onSelectionChange={changeStatus}
          aria-label="Thread status"
        >
          <SegmentedControlItem id="open">Open</SegmentedControlItem>
          <SegmentedControlItem id="approved">Approved</SegmentedControlItem>
          <SegmentedControlItem id="closed">Closed</SegmentedControlItem>
        </SegmentedControl>
      </div>

      <Divider size="S" />

      {/* Comments */}
      <div className="cc-comments">
        {(thread.comments ?? []).map((c) => (
          <CommentItem
            key={c.id}
            comment={c}
            onUpdate={(updated) => onUpdate({
              ...thread,
              comments: thread.comments.map(x => x.id === updated.id ? updated : x),
            })}
            onDelete={() => onUpdate({
              ...thread,
              comments: thread.comments.filter(x => x.id !== c.id),
            })}
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

function CommentItem({ comment, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(comment.body ?? '');
  const [voted, setVotedState] = useState(false);

  useEffect(() => { getVoted(comment.id).then(setVotedState); }, [comment.id]);

  async function saveEdit() {
    const body = editText.trim();
    if (!body) return;
    const updated = await sw('cc:api:patchComment', { id: comment.id, body });
    onUpdate({ ...comment, body: updated?.body ?? body });
    setEditing(false);
  }

  async function deleteComment() {
    await sw('cc:api:deleteComment', { id: comment.id });
    onDelete();
  }

  async function vote(up) {
    const next = !voted;
    setVotedState(next);
    await setVoted(comment.id, next);
    const delta = next ? 1 : -1;
    const updated = up
      ? await sw('cc:api:voteComment', { id: comment.id, upvoteDelta: delta, downvoteDelta: 0 })
      : await sw('cc:api:voteComment', { id: comment.id, upvoteDelta: 0, downvoteDelta: delta });
    onUpdate({ ...comment, upvotes: updated?.upvotes ?? comment.upvotes, downvotes: updated?.downvotes ?? comment.downvotes });
  }

  return (
    <div className="cc-comment-block">
      <div className="cc-comment-header">
        <span className="cc-comment-author">{comment.author ?? '?'}</span>
        <span className="cc-comment-time">{comment.createdAt ? relTime(comment.createdAt) : ''}</span>
        <span style={{ flex: 1 }} />
        <ActionButton isQuiet size="XS" aria-label="Edit comment" onPress={() => setEditing(!editing)}>
          <EditIcon />
        </ActionButton>
        <ActionButton isQuiet size="XS" aria-label="Delete comment" onPress={deleteComment}>
          <DeleteIcon />
        </ActionButton>
      </div>

      {editing ? (
        <div>
          <TextArea
            value={editText}
            onChange={setEditText}
            aria-label="Edit comment text"
            width="100%"
          />
          <div className="cc-edit-actions">
            <Button variant="secondary" size="S" onPress={() => setEditing(false)}>Cancel</Button>
            <Button variant="accent" size="S" onPress={saveEdit}>Save</Button>
          </div>
        </div>
      ) : (
        /* React auto-escapes text children — XSS-safe without extra sanitization */
        <p className="cc-comment-body">{comment.body ?? ''}</p>
      )}

      <div className="cc-vote-row">
        {/* ToggleButton for upvote so isSelected reflects the voted state */}
        <ToggleButton
          isQuiet
          isSelected={voted}
          onChange={() => vote(true)}
          size="S"
          aria-label={`Upvote (${comment.upvotes ?? 0})`}
        >
          <ThumbUpIcon />
          <Text>{comment.upvotes ?? 0}</Text>
        </ToggleButton>
        <ActionButton
          isQuiet
          size="S"
          aria-label={`Downvote (${comment.downvotes ?? 0})`}
          onPress={() => vote(false)}
        >
          <ThumbDownIcon />
          <Text>{comment.downvotes ?? 0}</Text>
        </ActionButton>
      </div>
    </div>
  );
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

createRoot(document.getElementById('root')).render(<App />);
