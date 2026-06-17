/**
 * sidepanel.js — Chit Chat side panel app.
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
 *   auth       — { signedIn: bool, email: string|null }
 *   theme      — 'light'|'dark'
 */

import { h, render } from 'preact';
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';

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

// ── Sanitization ──────────────────────────────────────────────────────────────
// Stored comment bodies are rendered into reviewers' DOM. Strip all HTML to
// prevent stored-XSS. (No DOMPurify dep — side panel scope is simple rich-text.)

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Relative time ─────────────────────────────────────────────────────────────

function relTime(iso) {
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function initials(email) {
  if (!email) return '?';
  const [name] = email.split('@');
  return name.slice(0, 2).toUpperCase();
}

// ── Storage helpers (chrome.storage.sync for theme/votes) ────────────────────

const storage = {
  async get(key) { return new Promise(r => chrome.storage.sync.get(key, d => r(d[key] ?? null))); },
  async set(key, val) { return new Promise(r => chrome.storage.sync.set({ [key]: val }, r)); },
};

async function getVoted(commentId) { return !!(await storage.get(`vote:${commentId}`)); }
async function setVoted(commentId, v) { return storage.set(`vote:${commentId}`, v); }

// ── Main App ──────────────────────────────────────────────────────────────────

function App() {
  const [pageUrl, setPageUrl] = useState('');
  const [tabId, setTabId] = useState(null);
  const [threads, setThreads] = useState([]);
  const [resolution, setResolution] = useState({});
  const [view, setView] = useState('list'); // 'list' | 'detail'
  const [activeId, setActiveId] = useState(null);
  const [mode, setModeState] = useState(null);
  const [auth, setAuth] = useState({ signedIn: false, email: null });
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
    document.documentElement.dataset.theme = theme;
    storage.set('theme', theme);
  }, [theme]);

  // ── Auth status ───────────────────────────────────────────────────────────
  const refreshAuth = useCallback(async () => {
    try {
      const res = await sw('cc:auth:status');
      setAuth(prev => ({ ...prev, signedIn: res.signedIn }));
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { refreshAuth(); }, []);

  // ── Get current tab ───────────────────────────────────────────────────────
  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) setTabId(tabs[0].id);
    });
    // Also listen for tab activation changes
    chrome.tabs.onActivated.addListener(({ tabId: tid }) => setTabId(tid));
    chrome.tabs.onUpdated.addListener((tid, info) => {
      if (info.status === 'complete') {
        chrome.tabs.query({ active: true, currentWindow: true }, (ts) => {
          if (ts[0]?.id === tid) setTabId(tid);
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
      const list = data?.threads ?? data ?? [];
      setThreads(list);
    } catch (err) {
      if (err.message?.includes('401') || err.message?.includes('auth')) {
        setAuth(prev => ({ ...prev, signedIn: false }));
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-fetch when URL changes
  useEffect(() => { if (pageUrl) fetchThreads(pageUrl); }, [pageUrl]);

  // Poll every 10s (pause when doc hidden)
  useEffect(() => {
    if (!pageUrl) return;
    const tick = () => { if (!document.hidden) fetchThreads(pageUrl); };
    pollRef.current = setInterval(tick, 10_000);
    return () => clearInterval(pollRef.current);
  }, [pageUrl]);

  // ── Send threads to content script for overlay ────────────────────────────
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
          // User posted a new comment via the on-page compose popover
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

  // ── Create thread ─────────────────────────────────────────────────────────
  async function handleNewThread(url, anchor, body) {
    try {
      const thread = await sw('cc:api:createThread', { pageUrl: url, anchor });
      if (thread && body) {
        await sw('cc:api:createComment', { threadId: thread.id, body });
      }
      await fetchThreads(url);
      if (thread) { setActiveId(thread.id); setView('detail'); }
    } catch (err) { setError(err.message); }
  }

  // ── Mode toggle ───────────────────────────────────────────────────────────
  function toggleMode(m) {
    const next = mode === m ? null : m;
    setModeState(next);
    if (tabId) toContent(tabId, 'cc:content:mode', { mode: next }).catch(() => {});
  }

  // ── Sign in / out ─────────────────────────────────────────────────────────
  async function signIn() {
    try {
      await sw('cc:auth:signIn');
      setAuth(prev => ({ ...prev, signedIn: true }));
      if (pageUrl) fetchThreads(pageUrl);
    } catch (err) { setError(err.message); }
  }
  async function signOut() {
    await sw('cc:auth:signOut');
    setAuth({ signedIn: false, email: null });
    setThreads([]);
  }

  // ── Export ────────────────────────────────────────────────────────────────
  function exportJson() {
    const blob = new Blob([JSON.stringify({ pageUrl, threads }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `chit-chat-${(pageUrl || 'export').replace(/[^a-z0-9]/gi, '_')}.json`;
    a.click();
  }

  // ── Filtered thread list ──────────────────────────────────────────────────
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

  // ── Render ────────────────────────────────────────────────────────────────
  return h('div', { id: 'cc-app', style: { display: 'flex', flexDirection: 'column', height: '100%' } },
    // Toolbar
    h('div', { className: 'cc-toolbar' },
      h('span', { className: 'cc-toolbar-title' }, 'Chit Chat'),
      h('button', {
        className: `cc-icon-btn${mode === 'element' ? ' active' : ''}`,
        title: 'Element comment mode',
        onClick: () => toggleMode('element'),
      }, '⊙'),
      h('button', {
        className: `cc-icon-btn${mode === 'rect' ? ' active' : ''}`,
        title: 'Rectangle annotation',
        onClick: () => toggleMode('rect'),
      }, '▭'),
      h('button', {
        className: `cc-icon-btn${mode === 'ellipse' ? ' active' : ''}`,
        title: 'Ellipse annotation',
        onClick: () => toggleMode('ellipse'),
      }, '◯'),
      h('button', {
        className: 'cc-icon-btn',
        title: theme === 'light' ? 'Dark mode' : 'Light mode',
        onClick: () => setTheme(t => t === 'light' ? 'dark' : 'light'),
      }, theme === 'light' ? '🌙' : '☀️'),
      h('button', { className: 'cc-icon-btn', title: 'Export JSON', onClick: exportJson }, '⬇'),
    ),

    // Identity bar
    h('div', { className: 'cc-identity' },
      auth.signedIn
        ? h('div', { className: 'cc-avatar' }, initials(auth.email))
        : h('div', { className: 'cc-avatar', style: { background: 'var(--text2)' } }, '?'),
      h('span', { className: 'cc-identity-name' },
        auth.signedIn ? (auth.email ?? 'Signed in') : 'Not signed in',
      ),
      auth.signedIn
        ? h('button', { className: 'cc-sign-btn out', onClick: signOut }, 'Sign out')
        : h('button', { className: 'cc-sign-btn', onClick: signIn }, 'Sign in'),
    ),

    error && h('div', { className: 'cc-error', onClick: () => setError(null) }, `⚠ ${error}`),

    view === 'list'
      ? h(ThreadList, {
          threads: filteredThreads, resolution, loading,
          search, setSearch, statusFilter, setStatusFilter,
          onSelect: (id) => { setActiveId(id); setView('detail'); },
          tabId,
        })
      : h(ThreadDetail, {
          thread: activeThread,
          resolution: resolution[activeId],
          tabId,
          pageUrl,
          onBack: () => { setView('list'); setActiveId(null); },
          onUpdate: (updated) => setThreads(ts => ts.map(t => t.id === updated.id ? updated : t)),
          onDelete: () => {
            setThreads(ts => ts.filter(t => t.id !== activeId));
            setView('list'); setActiveId(null);
          },
          onScrollTo: () => {
            if (tabId && activeThread) toContent(tabId, 'cc:content:scrollTo', { threadId: activeId }).catch(() => {});
          },
        }),
  );
}

// ── Thread list ───────────────────────────────────────────────────────────────

function ThreadList({ threads, resolution, loading, search, setSearch, statusFilter, setStatusFilter, onSelect, tabId }) {
  const statuses = ['all', 'open', 'approved', 'closed'];
  return h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
    h('div', { className: 'cc-search-bar' },
      h('input', {
        type: 'search', placeholder: 'Search…', value: search,
        onInput: (e) => setSearch(e.target.value),
      }),
    ),
    h('div', { className: 'cc-filter-chips' },
      statuses.map((s) =>
        h('button', {
          key: s,
          className: `cc-chip${statusFilter === s ? ' active' : ''}`,
          onClick: () => setStatusFilter(s),
        }, s.charAt(0).toUpperCase() + s.slice(1)),
      ),
    ),
    loading && h('div', { className: 'cc-loading' }, 'Loading…'),
    !loading && threads.length === 0 && h('div', { className: 'cc-empty' }, 'No annotations on this page yet.'),
    h('div', { className: 'cc-list' },
      threads.map((t) =>
        h(ThreadCard, {
          key: t.id, thread: t,
          resolution: resolution[t.id],
          onClick: () => onSelect(t.id),
        }),
      ),
    ),
  );
}

// ── Thread card ───────────────────────────────────────────────────────────────

function ThreadCard({ thread, resolution, onClick }) {
  const firstComment = thread.comments?.[0];
  const preview = firstComment ? stripHtml(firstComment.body) : '(no comments)';
  const isOrphaned = resolution === 'unanchored';
  return h('div', { className: 'cc-thread-card', onClick },
    h('div', { className: 'cc-card-header' },
      h('div', { className: `cc-status-dot cc-status-${thread.status ?? 'open'}` }),
      h('span', { className: 'cc-card-author' }, firstComment?.author ?? '—'),
      isOrphaned && h('span', { className: 'cc-orphan-badge' }, 'orphaned'),
      h('span', { className: 'cc-card-time' }, thread.createdAt ? relTime(thread.createdAt) : ''),
    ),
    h('div', { className: 'cc-card-preview' }, preview),
  );
}

// ── Thread detail ─────────────────────────────────────────────────────────────

function ThreadDetail({ thread, resolution, tabId, pageUrl, onBack, onUpdate, onDelete, onScrollTo }) {
  const [replyText, setReplyText] = useState('');
  const [posting, setPosting] = useState(false);

  if (!thread) return h('div', { className: 'cc-loading' }, 'Thread not found.');

  async function changeStatus(status) {
    try {
      const updated = await sw('cc:api:patchThread', { id: thread.id, data: { status } });
      onUpdate({ ...thread, status: updated?.status ?? status });
    } catch (err) { console.error(err); }
  }

  async function deleteThread() {
    if (!confirm('Delete this thread and all comments?')) return;
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

  return h('div', { className: 'cc-detail' },
    // Detail header
    h('div', { className: 'cc-detail-header' },
      h('button', { className: 'cc-back-btn', onClick: onBack }, '← Back'),
      isOrphaned && h('span', { className: 'cc-orphan-badge', style: { marginLeft: 4 } }, 'orphaned'),
      h('span', { style: { flex: 1 } }),
      h('button', {
        className: 'cc-icon-btn',
        title: 'Scroll to on page',
        onClick: onScrollTo,
        style: { fontSize: '12px' },
      }, '⌖'),
      h('button', {
        className: 'cc-icon-btn',
        title: 'Delete thread',
        onClick: deleteThread,
        style: { color: 'var(--danger)' },
      }, '🗑'),
    ),

    // Status buttons
    h('div', { className: 'cc-detail-status-bar' },
      h('button', {
        className: `cc-status-btn${thread.status === 'open' || !thread.status ? ' active' : ''}`,
        onClick: () => changeStatus('open'),
      }, 'Open'),
      h('button', {
        className: `cc-status-btn approve${thread.status === 'approved' ? ' active' : ''}`,
        onClick: () => changeStatus('approved'),
      }, 'Approved'),
      h('button', {
        className: `cc-status-btn${thread.status === 'closed' ? ' active' : ''}`,
        onClick: () => changeStatus('closed'),
      }, 'Closed'),
    ),

    // Comments
    h('div', { className: 'cc-comments' },
      (thread.comments ?? []).map((c) =>
        h(CommentItem, {
          key: c.id,
          comment: c,
          onUpdate: (updated) => onUpdate({
            ...thread,
            comments: thread.comments.map(x => x.id === updated.id ? updated : x),
          }),
          onDelete: () => onUpdate({
            ...thread,
            comments: thread.comments.filter(x => x.id !== c.id),
          }),
        }),
      ),
    ),

    // Reply compose
    h('div', { className: 'cc-reply' },
      h('textarea', {
        placeholder: 'Reply…',
        value: replyText,
        onInput: (e) => setReplyText(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) postReply(); },
      }),
      h('div', { className: 'cc-reply-actions' },
        h('button', { onClick: postReply, className: 'primary', disabled: posting || !replyText.trim() },
          posting ? 'Posting…' : 'Reply',
        ),
      ),
    ),
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

  return h('div', { className: 'cc-comment' },
    h('div', { className: 'cc-comment-header' },
      h('span', { className: 'cc-comment-author' }, comment.author ?? '?'),
      h('span', { className: 'cc-comment-time' }, comment.createdAt ? relTime(comment.createdAt) : ''),
      h('span', { className: 'cc-comment-actions' },
        h('button', { className: 'cc-mini-btn', onClick: () => setEditing(!editing), title: 'Edit' }, '✎'),
        h('button', { className: 'cc-mini-btn danger', onClick: deleteComment, title: 'Delete' }, '✕'),
      ),
    ),
    editing
      ? h('div', null,
          h('textarea', {
            className: 'cc-edit-area', value: editText,
            onInput: (e) => setEditText(e.target.value),
          }),
          h('div', { className: 'cc-reply-actions', style: { marginTop: 4 } },
            h('button', { onClick: () => setEditing(false) }, 'Cancel'),
            h('button', { className: 'primary', onClick: saveEdit }, 'Save'),
          ),
        )
      : h('div', {
          className: 'cc-comment-body',
          // Sanitized: escHtml prevents XSS from stored content; dangerouslySetInnerHTML is safe here
          // because we're rendering text only (no tags). We use innerText equivalent via textContent.
          ref: (el) => { if (el) el.textContent = comment.body ?? ''; },
        }),
    h('div', { className: 'cc-vote-bar' },
      h('button', {
        className: `cc-vote-btn${voted ? ' voted' : ''}`,
        onClick: () => vote(true),
        title: 'Upvote',
      }, `▲ ${comment.upvotes ?? 0}`),
      h('button', {
        className: 'cc-vote-btn',
        onClick: () => vote(false),
        title: 'Downvote',
      }, `▼ ${comment.downvotes ?? 0}`),
    ),
  );
}

// ── Utility ───────────────────────────────────────────────────────────────────

function stripHtml(html) {
  if (!html) return '';
  const el = document.createElement('div');
  el.innerHTML = html;
  return el.textContent ?? '';
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

render(h(App), document.getElementById('root'));
