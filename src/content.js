/**
 * content.js — Chit Chat content script.
 *
 * Runs in the ISOLATED world (Chrome's default for content scripts) so that
 * chrome.runtime messaging works correctly.
 * Owns everything that requires live host-DOM access:
 *   - Anchor capture/resolution — from @adobe/annotations-core, shared with
 *     milo-logs-deploy's page-commenter client so stored threads stay
 *     resolvable across both.
 *   - Overlay: dot markers + shape markers
 *   - Element-picker mode, shape-draw mode, text-selection button
 *   - Scroll-to-thread / flash
 *   - SPA-navigation detection via the 'cc:navigated' CustomEvent, which is
 *     dispatched from a tiny MAIN-world shim injected by background.js that
 *     wraps history.pushState / replaceState. popstate/hashchange are also
 *     listened to directly (they fire in the ISOLATED world as well).
 *   - MutationObserver for anchor re-resolution
 *
 * Communicates with the service worker via chrome.runtime.sendMessage.
 * Never makes fetch() calls directly — all network I/O lives in background.js.
 *
 * Guard against double-injection.
 */
import { captureAnchor, resolveAnchor, finalizeAnchorForSave } from '@adobe/annotations-core/anchor';
import { STATUS_COLORS } from '@adobe/annotations-core/colors';
import { resolveMarkerPlacement, resolveShapePlacement } from '@adobe/annotations-core/marker-geometry';

// Markers render on the host page, not inside chit-chat's own themed side
// panel — its light/dark contrast needs depend on the host page's own
// background, unrelated to the extension's panel-theme preference. The
// overlay's injected stylesheet has never been theme-reactive (unlike the
// shadow-root-scoped compose/picker UI, which toggles a `.cc-dark` class),
// so use the light variant unconditionally rather than inventing new
// theme-reactive infra a color-value fix doesn't call for.
const OPEN_COLOR = STATUS_COLORS.open.light;
const IN_PROGRESS_COLOR = STATUS_COLORS.in_progress.light;
const RESOLVED_COLOR = STATUS_COLORS.resolved.light;

// Translucent fill for shape markers — same status color, alpha-blended.
function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

if (window.__chitChatLoaded) {
  // already running — ignore
} else {
  window.__chitChatLoaded = true;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function send(type, payload = {}) {
    // After the extension is reloaded/updated, this content script keeps running
    // but its chrome.* bridge is invalidated (chrome.runtime.id becomes
    // undefined) — calling sendMessage would throw synchronously. Bail quietly,
    // and swallow async rejections (e.g. no receiver) so fire-and-forget callers
    // like toPanel never produce uncaught errors.
    if (!chrome.runtime?.id) return Promise.resolve();
    try {
      return chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  /** postMessage-safe wrapper to tell the panel something. */
  function toPanel(type, payload = {}) {
    send('cc:panel:forward', { payload: { type, ...payload } });
  }

  // ── Overlay container ──────────────────────────────────────────────────────

  const OWN_IDS = new Set(['cc-overlay', 'cc-element-picker', 'cc-snap-preview', 'cc-compose']);

  function isOwnUi(el) {
    if (!el) return false;
    return el.closest('[id^="cc-"]') !== null || OWN_IDS.has(el.id);
  }

  // Inject overlay stylesheet once
  function injectStyles() {
    if (document.getElementById('cc-styles')) return;
    const s = document.createElement('style');
    s.id = 'cc-styles';
    s.textContent = `
      #cc-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 2147483640; overflow: visible; }
      .cc-dot { position: absolute; width: 22px; height: 22px; border-radius: 50%;
                box-shadow: 0 2px 8px rgba(0,0,0,.35); cursor: pointer; pointer-events: all;
                transform: translate(-50%,-50%); transition: transform .1s;
                display: flex; align-items: center; justify-content: center;
                font: bold 10px/1 sans-serif; color: #fff;
                border: 2px solid #fff; box-sizing: border-box; }
      .cc-dot:hover { transform: translate(-50%,-50%) scale(1.2); }
      /* Status ring colors (background is now per-user, set inline). Sourced
         from @adobe/annotations-core/colors — the same S2 semantic values
         this extension's own status badge already uses (open/notice,
         in_progress/informative, resolved/positive), so the marker no longer
         contradicts its own badge. */
      .cc-dot--open        { border-color: ${OPEN_COLOR}; }
      .cc-dot--in_progress { border-color: ${IN_PROGRESS_COLOR}; }
      .cc-dot--resolved    { border-color: ${RESOLVED_COLOR}; }
      .cc-shape { position: absolute; pointer-events: all; cursor: pointer;
                  border: 2px solid ${OPEN_COLOR}; background: ${withAlpha(OPEN_COLOR, 0.08)};
                  box-sizing: border-box; }
      .cc-shape--ellipse { border-radius: 50%; }
      .cc-shape--in_progress { border-color: ${IN_PROGRESS_COLOR}; background: ${withAlpha(IN_PROGRESS_COLOR, 0.08)}; }
      .cc-shape--resolved    { border-color: ${RESOLVED_COLOR}; background: ${withAlpha(RESOLVED_COLOR, 0.08)}; }
      /* Anchor-resolution dimming — a separate visual channel (opacity/
         filter) from the workflow-status border-color rules above, so the
         two independent signals (workflow status vs. anchor-match
         confidence) can't fight over the same CSS property. data-status
         mirrors milo-logs-deploy's DotMarker.js/ShapeMarker.js convention
         exactly (this repo's markers had no viewport-visibility distinction
         at all before — every dot rendered full-opacity regardless of
         whether its element was actually on-screen, or even resolved). */
      .cc-dot[data-status="offscreen"], .cc-shape[data-status="offscreen"] { opacity: .35; }
      .cc-dot[data-status="hidden"] { display: none; }
      .cc-dot[data-status="unanchored"] { opacity: .25; filter: grayscale(1); }
      /* Uncertain (fuzzy tag-wide text match) rather than a confident
         selector/XPath hit — distinct from the viewport-visibility dimming
         above, but both drive opacity, so they can't just be declared
         independently: on equal specificity CSS lets whichever rule comes
         later in the stylesheet win outright, silently erasing the other
         (exactly the failure mode data-status/data-confidence's separation
         from the border-color classes was meant to avoid — just one level
         up, between these two new rules instead of the old ones). The
         combined selector below has higher specificity than either alone,
         so a dot that's both off-screen AND an uncertain match gets its own
         (lower) opacity instead of one signal clobbering the other. */
      .cc-dot[data-confidence="approximate"] { opacity: .7; }
      .cc-dot[data-status="offscreen"][data-confidence="approximate"] { opacity: .25; }
      /* element-picker highlight overlay */
      #cc-element-picker { position: fixed; inset: 0; z-index: 2147483641;
                           pointer-events: none; }
      .cc-el-highlight { position: absolute; background: rgba(2,101,220,.12);
                         outline: 2px solid #0265DC; box-sizing: border-box;
                         pointer-events: none; border-radius: 2px; }
      .cc-el-tag { position: absolute; top: -20px; left: 0; background: #0265DC;
                   color: #fff; font: 11px/16px monospace; padding: 0 4px;
                   border-radius: 2px; white-space: nowrap; }
      /* element-picker disambiguation menu (box/position only — its list
         content lives in a shadow root, same reasoning as #cc-compose) */
      #cc-picker-menu { position: fixed; z-index: 2147483646; background: #fff;
                        border: 1px solid #ccc; border-radius: 6px;
                        box-shadow: 0 8px 32px rgba(0,0,0,.2); padding: 6px;
                        min-width: 220px; color: #1b1b1b;
                        font: 12px/1.4 -apple-system, sans-serif; }
      #cc-picker-menu.cc-dark { background: #2b2b2b; border-color: #555; color: #eee;
                                box-shadow: 0 8px 32px rgba(0,0,0,.5); }
      /* shape draw */
      #cc-shape-draw { position: fixed; inset: 0; z-index: 2147483641;
                       cursor: crosshair; }
      .cc-shape-preview { position: fixed; pointer-events: none;
                          border: 2px dashed #0265DC; background: rgba(2,101,220,.08);
                          box-sizing: border-box; z-index: 2147483642; }
      .cc-shape-preview--ellipse { border-radius: 50%; }
      /* text selection button */
      #cc-sel-btn { position: fixed; background: #0265DC; color: #fff;
                    font: 13px/1 -apple-system, sans-serif; padding: 4px 10px;
                    border-radius: 4px; cursor: pointer; z-index: 2147483643;
                    box-shadow: 0 2px 8px rgba(0,0,0,.3); user-select: none; }
      /* flash */
      .cc-flash { outline: 3px solid #0265DC !important; transition: outline .1s; }
      /* compose popover (box/position only — its own text styling lives in a
         shadow root so the host page's CSS can't bleed into the dialog) */
      #cc-compose { position: fixed; background: #fff; border-radius: 8px;
                    box-shadow: 0 8px 32px rgba(0,0,0,.2); padding: 12px;
                    z-index: 2147483644; width: 380px; box-sizing: border-box;
                    color: #1b1b1b; font: 13px/1.5 -apple-system, sans-serif; }
      #cc-compose.cc-dark { background: #2b2b2b; color: #eee;
                             box-shadow: 0 8px 32px rgba(0,0,0,.5); }
    `;
    document.head.appendChild(s);
  }

  // Compose dialog's own styling, scoped inside its shadow root so page rules
  // (e.g. a global `button { color: ... }` or `* { color: ... }` reset) can't
  // reach in — no !important needed since the shadow boundary blocks the
  // selectors from matching at all. `:host(.cc-dark)` mirrors the panel's
  // light/dark toggle (synced via chrome.storage.sync, see _theme).
  const COMPOSE_SHADOW_CSS = `
    /* contenteditable, not Quill — keeps this injected-into-every-page bundle
       dependency-free while still letting QA author bold/italic/links/pasted
       screenshots inline. */
    .cc-compose-editable { display: block; width: 100%; min-height: 120px; max-height: 45vh;
               box-sizing: border-box; overflow-y: auto;
               border: 1px solid #ccc; border-radius: 4px; padding: 8px;
               font: 13px/1.5 -apple-system, sans-serif; color: #1b1b1b; background: #fff;
               outline-color: #0265DC; }
    .cc-compose-editable:empty::before { content: attr(data-placeholder); color: #888; }
    .cc-compose-editable img { display: block; max-width: 100%; margin: 4px 0; border-radius: 4px; }
    .cc-compose-editable a { color: #0265DC; text-decoration: underline; }
    .cc-compose-toolbar { display: flex; gap: 4px; margin-bottom: 6px; }
    .cc-compose-toolbtn { min-width: 28px; height: 26px; padding: 0 6px; border-radius: 4px;
                          border: 1px solid #ccc; cursor: pointer;
                          font: 12px/1 -apple-system, sans-serif; color: #1b1b1b; background: #fff; }
    .cc-compose-toolbtn:hover { background: #f0f0f0; }
    .cc-compose-linkform { display: flex; gap: 6px; margin-bottom: 6px; }
    .cc-compose-linkform input { flex: 1; min-width: 0; padding: 4px 6px; box-sizing: border-box;
                                 border: 1px solid #ccc; border-radius: 4px;
                                 font: 12px/1.4 -apple-system, sans-serif; }
    .cc-compose-emojipopover { grid-template-columns: repeat(6, 1fr); gap: 2px; margin-bottom: 6px;
                               padding: 6px; border: 1px solid #ccc; border-radius: 4px; background: #fff; }
    .cc-compose-emojiitem { font-size: 16px; line-height: 1; padding: 4px; border: none;
                            background: transparent; cursor: pointer; border-radius: 4px; }
    .cc-compose-emojiitem:hover { background: #f0f0f0; }
    .cc-compose-hint { margin-top: 6px; font: 11px/1.4 -apple-system, sans-serif;
                       color: #6d6d6d; }
    .cc-compose-hint.cc-compose-error { color: #c0392b; font-weight: 600; }
    .cc-compose-actions { display: flex; gap: 8px; margin-top: 8px; justify-content: flex-end; }
    button { padding: 6px 14px; border-radius: 4px; border: 1px solid #ccc;
             cursor: pointer; font: 13px/1 -apple-system, sans-serif; color: #1b1b1b; background: #fff; }
    .cc-compose-save { background: #0265DC; color: #fff; border-color: #0265DC; }
    .cc-compose-cancel { background: #fff; color: #1b1b1b; }
    :host(.cc-dark) .cc-compose-editable { background: #1e1e1e; border-color: #555; color: #eee; }
    :host(.cc-dark) .cc-compose-editable a { color: #5aa2ff; }
    :host(.cc-dark) .cc-compose-hint { color: #aaa; }
    :host(.cc-dark) button, :host(.cc-dark) .cc-compose-toolbtn { background: #3a3a3a; border-color: #555; color: #eee; }
    :host(.cc-dark) .cc-compose-toolbtn:hover { background: #4a4a4a; }
    :host(.cc-dark) .cc-compose-linkform input { background: #1e1e1e; border-color: #555; color: #eee; }
    :host(.cc-dark) .cc-compose-emojipopover { background: #1e1e1e; border-color: #555; }
    :host(.cc-dark) .cc-compose-emojiitem:hover { background: #3a3a3a; }
    :host(.cc-dark) .cc-compose-save { background: #0265DC; border-color: #0265DC; color: #fff; }
    :host(.cc-dark) .cc-compose-cancel { background: #3a3a3a; color: #eee; }
  `;

  // Element-picker disambiguation dropdown's own styling — same shadow-root
  // isolation + dark-mode approach as COMPOSE_SHADOW_CSS above.
  const PICKER_SHADOW_CSS = `
    .cc-picker-label { font-size: 11px; color: #6d6d6d; margin: 4px 6px 6px;
                       text-transform: uppercase; letter-spacing: .04em; }
    .cc-picker-list { list-style: none; margin: 0; padding: 0; }
    .cc-picker-item { padding: 6px 8px; border-radius: 4px; cursor: pointer;
                      display: flex; align-items: center; gap: 6px; color: #1b1b1b; }
    .cc-picker-item:hover { background: #ebebeb; }
    .cc-picker-item code { background: #f0f0f0; padding: 1px 4px; border-radius: 3px;
                           font: 11px/1.4 monospace; }
    .cc-picker-item span { color: #6d6d6d; font-size: 11px; overflow: hidden;
                           text-overflow: ellipsis; white-space: nowrap; }
    :host(.cc-dark) .cc-picker-label { color: #aaa; }
    :host(.cc-dark) .cc-picker-item { color: #eee; }
    :host(.cc-dark) .cc-picker-item:hover { background: #3a3a3a; }
    :host(.cc-dark) .cc-picker-item code { background: #1e1e1e; color: #eee; }
    :host(.cc-dark) .cc-picker-item span { color: #aaa; }
  `;

  // Create the fixed overlay container once
  function ensureOverlay() {
    let el = document.getElementById('cc-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cc-overlay';
      document.body.appendChild(el);
    }
    return el;
  }

  // ── Thread marker state ────────────────────────────────────────────────────

  let _threads = []; // cached from last cc:content:threads message
  let _resolvedMap = {}; // threadId → { element, status }
  let _theme = 'light'; // synced from the panel's chrome.storage.sync 'theme' setting

  function renderMarkers() {
    const overlay = ensureOverlay();
    overlay.innerHTML = '';
    for (const t of _threads) {
      const res = _resolvedMap[t.id];
      if (!res) continue;
      if (t.anchor?.type === 'shape') {
        renderShapeMarker(overlay, t);
      } else {
        // Render even when res.element is null (anchor didn't resolve) —
        // resolveMarkerPlacement falls back to the anchor's stored
        // boundingRect and reports 'unanchored', so the dot still shows up
        // (dimmed/grayscale) instead of silently vanishing from the overlay.
        renderDotMarker(overlay, t, res);
      }
    }
  }

  function resolveAll(threads) {
    const map = {};
    for (const t of threads) {
      if (t.anchor?.type === 'shape') {
        map[t.id] = { element: null, status: 'resolved' };
      } else {
        map[t.id] = resolveAnchor(t.anchor);
      }
    }
    return map;
  }

  /**
   * Derive a deterministic background color from an author string.
   * Hashes the string to a hue and returns an HSL color.
   * Empty / unknown authors get a neutral gray.
   */
  function colorForUser(author) {
    if (!author) return '#6d6d6d';
    let h = 0;
    for (let i = 0; i < author.length; i++) {
      h = (h * 31 + author.charCodeAt(i)) & 0xffffffff;
    }
    // Map to a hue in [0, 360), skip the yellow-green band (80–140) that
    // clashes with the status ring colors.
    const raw = ((h >>> 0) % 360);
    const hue = raw < 80 ? raw : raw < 140 ? raw + 80 : raw;
    return `hsl(${hue % 360}, 60%, 42%)`;
  }

  // Builds a standalone `.cc-dot` element (color + author initial + status
  // ring) shared by element-anchor and shape-anchor markers.
  function createCommenterDot(thread) {
    const dot = document.createElement('div');
    const statusClass = `cc-dot--${thread.status ?? 'open'}`;
    dot.className = `cc-dot ${statusClass}`;
    dot.dataset.threadId = thread.id;
    dot.title = thread.title ?? '';

    // Per-user color as background; status drives the ring (border-color via CSS class).
    const author = thread.comments?.[0]?.author_name ?? '';
    dot.style.background = colorForUser(author);

    // Show the author's first initial inside the dot (mirrors milo DotMarker.js).
    dot.textContent = (author || '?')[0].toUpperCase();

    // Shape markers nest this dot inside their own click target — stop the
    // click from also bubbling to the shape's handler and double-firing.
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      toPanel('cc:panel:dotClicked', { threadId: thread.id });
    });
    return dot;
  }

  // `res` is resolveAnchor's { element, status } — element may be null
  // (anchor never resolved to anything; resolveMarkerPlacement falls back to
  // the anchor's stored boundingRect for a static position). status is the
  // anchor-match confidence (resolved/approximate/unanchored), independent
  // of dataset.status below (viewport visibility) — approximate gets its own
  // lighter dim via data-confidence so the two signals don't fight over the
  // same visual channel.
  function renderDotMarker(overlay, thread, res) {
    const placement = resolveMarkerPlacement(res.element, thread.anchor);
    const dot = createCommenterDot(thread);
    // Overlay is position:fixed — placement.left/top are already viewport coords.
    dot.style.left = `${placement.left + placement.width / 2}px`;
    dot.style.top = `${placement.top}px`;
    dot.dataset.status = placement.status;
    if (res.status === 'approximate') dot.dataset.confidence = 'approximate';
    overlay.appendChild(dot);
  }

  function renderShapeMarker(overlay, thread) {
    const a = thread.anchor;
    const placement = resolveShapePlacement(a);
    const shape = document.createElement('div');
    const statusMod = (thread.status === 'in_progress' || thread.status === 'resolved')
      ? ` cc-shape--${thread.status}` : '';
    shape.className = `cc-shape${a.shape === 'ellipse' ? ' cc-shape--ellipse' : ''}${statusMod}`;
    shape.style.left = `${placement.left}px`;
    shape.style.top = `${placement.top}px`;
    shape.style.width = `${placement.width}px`;
    shape.style.height = `${placement.height}px`;
    shape.dataset.threadId = thread.id;
    shape.dataset.status = placement.status;
    shape.addEventListener('click', () => toPanel('cc:panel:dotClicked', { threadId: thread.id }));
    overlay.appendChild(shape);

    // Corner commenter badge: `.cc-dot` centers on its left/top via a
    // translate(-50%,-50%) transform, and `.cc-shape` (its new containing
    // block) has no transform of its own, so left/top: 0 lands the dot
    // exactly on the shape's top-left corner.
    const dot = createCommenterDot(thread);
    dot.style.left = '0px';
    dot.style.top = '0px';
    shape.appendChild(dot);
  }

  // Reposition all markers on scroll/resize.
  // Dots track their element's viewport position; shapes re-convert page→viewport.
  function repositionMarkers() {
    const overlay = document.getElementById('cc-overlay');
    if (!overlay) return;
    for (const dot of overlay.querySelectorAll('.cc-dot')) {
      const tid = dot.dataset.threadId;
      // dataset values are always strings; stringify the id so numeric backend
      // ids still match threads found by object key elsewhere.
      const t = _threads.find((x) => String(x.id) === tid);
      if (!t?.anchor) continue;
      const res = _resolvedMap[tid];
      const placement = resolveMarkerPlacement(res?.element ?? null, t.anchor);
      dot.style.left = `${placement.left + placement.width / 2}px`;
      dot.style.top = `${placement.top}px`;
      dot.dataset.status = placement.status;
    }
    for (const shape of overlay.querySelectorAll('.cc-shape')) {
      const tid = shape.dataset.threadId;
      const t = _threads.find((x) => String(x.id) === tid);
      if (!t?.anchor) continue;
      const placement = resolveShapePlacement(t.anchor);
      shape.style.left = `${placement.left}px`;
      shape.style.top = `${placement.top}px`;
      shape.dataset.status = placement.status;
    }
  }

  window.addEventListener('scroll', repositionMarkers, { passive: true, capture: true });
  window.addEventListener('resize', repositionMarkers, { passive: true });

  // ── Flash helper ───────────────────────────────────────────────────────────

  function flash(el) {
    if (!el) return;
    el.classList.add('cc-flash');
    setTimeout(() => el.classList.remove('cc-flash'), 1200);
  }

  // ── Scroll-to-thread ───────────────────────────────────────────────────────

  function scrollToThread(thread) {
    const a = thread.anchor;
    if (!a) return;
    if (a.type === 'shape') {
      window.scrollTo({ top: a.top + a.height / 2 - window.innerHeight / 2, behavior: 'smooth' });
      // flash the shape marker
      const marker = document.querySelector(`#cc-overlay .cc-shape[data-thread-id="${thread.id}"]`);
      flash(marker);
      return;
    }
    const res = _resolvedMap[thread.id];
    if (res?.element) {
      res.element.scrollIntoView({ block: 'center', behavior: 'smooth' });
      flash(res.element);
    }
  }

  // ── Annotation mode ────────────────────────────────────────────────────────

  let _mode = null; // null | 'element' | 'rect' | 'ellipse'

  function setMode(mode) {
    _mode = mode;
    if (mode === 'element') startElementPicker();
    else stopElementPicker();
    if (mode === 'rect' || mode === 'ellipse') startShapeDraw(mode);
    else stopShapeDraw();
  }

  // ── Element picker ─────────────────────────────────────────────────────────

  let _pickerEl = null;
  let _highlightEl = null;
  let _tagEl = null;

  /** Return the z-ordered stack of page elements at (x, y), excluding our own UI. */
  function getPickerCandidates(x, y) {
    return document.elementsFromPoint(x, y).filter(
      (el) => !isOwnUi(el)
        && el.tagName !== 'HTML' && el.tagName !== 'HEAD' && el.tagName !== 'BODY',
    );
  }

  /** Move the highlight overlay to cover `el` and show its tag name. */
  function highlightPickerEl(el) {
    if (!_highlightEl) return;
    const rect = el.getBoundingClientRect();
    Object.assign(_highlightEl.style, {
      display: 'block',
      left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
    });
    if (_tagEl) _tagEl.textContent = `<${el.tagName.toLowerCase()}>`;
  }

  function hideHighlight() {
    if (_highlightEl) _highlightEl.style.display = 'none';
  }

  /**
   * Describe an element for a picker row: `tag#id` or `tag.class` in a <code>
   * chip, followed by up to 25 chars of text content.
   */
  function describePickerEl(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls = el.classList[0] ? `.${el.classList[0]}` : '';
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 25);
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<code>${esc(tag + (id || cls))}</code>${text ? ` <span>${esc(text)}</span>` : ''}`;
  }

  /**
   * When >1 candidates exist, show the disambiguation dropdown listing the
   * full z-stack so the user can pick the intended element — mirrors
   * milo-logs-deploy CommentModeLayer.js `showPicker`.
   */
  function showElementPicker(candidates, x, y) {
    document.getElementById('cc-picker-menu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'cc-picker-menu';
    if (_theme === 'dark') menu.classList.add('cc-dark');
    const items = candidates.slice(0, 7);

    // Same shadow-root isolation as the compose dialog: the page's own CSS
    // can't reach the list/label/code text inside, so no !important needed.
    const root = menu.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PICKER_SHADOW_CSS;
    root.appendChild(style);
    const content = document.createElement('div');
    content.innerHTML = `<p class="cc-picker-label">Pick an element:</p>`
      + `<ul class="cc-picker-list">${
        items.map((el, i) => `<li class="cc-picker-item" data-idx="${i}">${describePickerEl(el)}</li>`).join('')
      }</ul>`;
    root.appendChild(content);

    // Position near cursor, flip left/up if it would overflow the viewport.
    const mw = 240; const mh = 30 + items.length * 32;
    menu.style.left = `${Math.max(0, x + mw > window.innerWidth  ? x - mw : x)}px`;
    menu.style.top  = `${Math.max(0, y + mh > window.innerHeight ? y - mh : y)}px`;
    document.documentElement.appendChild(menu);

    const cleanup = () => {
      document.removeEventListener('keydown', onMenuKey, true);
      document.removeEventListener('mousedown', onMenuOutside, true);
      document.removeEventListener('contextmenu', onMenuContext, true);
    };
    // Tear the menu + highlight overlay down together on every exit, so nothing
    // is left half-armed. openCompose (on pick) clears _mode + notifies the
    // panel itself; the dismiss/cancel paths do it via cancel().
    const closeMenu = () => {
      menu.remove();
      hideHighlight();
      cleanup();
      stopElementPicker();
    };
    const cancel = () => { closeMenu(); _mode = null; toPanel('cc:panel:modeCancelled', {}); };
    const onMenuKey = (ev) => { if (ev.key === 'Escape') cancel(); };
    // Right-click cancels and suppresses the native menu — consistent with the
    // picker/shape tools. contextmenu fires AFTER mousedown, so onMenuOutside
    // must ignore right-clicks (button 2) or it would tear down first and let
    // the native menu through.
    const onMenuContext = (ev) => { ev.preventDefault(); cancel(); };
    const onMenuOutside = (ev) => {
      if (ev.button === 2) return;
      if (!menu.contains(ev.target)) cancel();
    };

    root.querySelectorAll('.cc-picker-item').forEach((li, i) => {
      li.addEventListener('click', () => {
        closeMenu();
        openCompose(items[i], null, x, y);
      });
      li.addEventListener('mouseenter', () => highlightPickerEl(items[i]));
      li.addEventListener('mouseleave', () => hideHighlight());
    });

    document.addEventListener('keydown', onMenuKey, true);
    document.addEventListener('contextmenu', onMenuContext, true);
    setTimeout(() => document.addEventListener('mousedown', onMenuOutside, true), 0);
  }

  // Just the hover-highlight overlay, no global listeners. Shared by the full
  // picker and by the disambiguation menu — the menu owns its own interaction
  // and must NOT have the picker's page-level click/contextmenu handlers armed
  // (otherwise a right-click's mousedown tears the picker down before its
  // contextmenu handler can suppress the native menu).
  function ensureHighlightOverlay() {
    if (_pickerEl) return;
    _pickerEl = document.createElement('div');
    _pickerEl.id = 'cc-element-picker';
    document.body.appendChild(_pickerEl);

    _highlightEl = document.createElement('div');
    _highlightEl.className = 'cc-el-highlight';
    _highlightEl.style.display = 'none';
    _tagEl = document.createElement('span');
    _tagEl.className = 'cc-el-tag';
    _highlightEl.appendChild(_tagEl);
    _pickerEl.appendChild(_highlightEl);
  }

  function startElementPicker() {
    if (_pickerEl) return;
    ensureHighlightOverlay();
    document.body.style.cursor = 'crosshair';
    document.addEventListener('mousemove', onPickerMove, { capture: true });
    document.addEventListener('click', onPickerClick, { capture: true });
    document.addEventListener('keydown', onPickerKey, { capture: true });
    document.addEventListener('contextmenu', onPickerContext, { capture: true });
  }

  function stopElementPicker() {
    document.getElementById('cc-picker-menu')?.remove();
    if (_pickerEl) { _pickerEl.remove(); _pickerEl = null; _highlightEl = null; _tagEl = null; }
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onPickerMove, { capture: true });
    document.removeEventListener('click', onPickerClick, { capture: true });
    document.removeEventListener('keydown', onPickerKey, { capture: true });
    document.removeEventListener('contextmenu', onPickerContext, { capture: true });
  }

  function onPickerMove(e) {
    const candidates = getPickerCandidates(e.clientX, e.clientY);
    // Prefer non-canvas/video as the hover target (mirrors milo).
    const el = candidates.find((c) => c.tagName !== 'CANVAS' && c.tagName !== 'VIDEO')
      || candidates[0];
    if (!el) { hideHighlight(); return; }
    highlightPickerEl(el);
  }

  function onPickerClick(e) {
    if (isOwnUi(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    const candidates = getPickerCandidates(e.clientX, e.clientY);
    if (!candidates.length) return;
    hideHighlight();
    stopElementPicker();
    _mode = null;
    if (candidates.length === 1) {
      openCompose(candidates[0], null, e.clientX, e.clientY);
    } else {
      // Only the highlight overlay — the menu owns its own interaction.
      ensureHighlightOverlay();
      showElementPicker(candidates, e.clientX, e.clientY);
    }
  }

  function onPickerKey(e) {
    if (e.key === 'Escape') {
      document.getElementById('cc-picker-menu')?.remove();
      stopElementPicker();
      _mode = null;
      toPanel('cc:panel:modeCancelled', {});
    }
  }

  // Right-click exits the picker (same as ESC); suppress the native menu.
  function onPickerContext(e) {
    e.preventDefault();
    document.getElementById('cc-picker-menu')?.remove();
    stopElementPicker();
    _mode = null;
    toPanel('cc:panel:modeCancelled', {});
  }

  // ── Shape draw ─────────────────────────────────────────────────────────────

  let _drawLayer = null;
  let _drawPreview = null;
  let _drawShape = null;
  let _drawStart = null;

  function startShapeDraw(shape) {
    _drawShape = shape;
    if (_drawLayer) return;
    _drawLayer = document.createElement('div');
    _drawLayer.id = 'cc-shape-draw';
    document.body.appendChild(_drawLayer);
    _drawLayer.addEventListener('mousedown', onDrawStart);
    document.addEventListener('keydown', onDrawKey, { capture: true });
    document.addEventListener('contextmenu', onDrawContext, { capture: true });
  }

  function stopShapeDraw() {
    if (_drawLayer) { _drawLayer.remove(); _drawLayer = null; }
    if (_drawPreview) { _drawPreview.remove(); _drawPreview = null; }
    document.removeEventListener('mousemove', onDrawMove, { capture: true });
    document.removeEventListener('mouseup', onDrawEnd, { capture: true });
    document.removeEventListener('keydown', onDrawKey, { capture: true });
    document.removeEventListener('contextmenu', onDrawContext, { capture: true });
    _drawStart = null; _drawShape = null;
  }

  function onDrawStart(e) {
    _drawStart = { x: e.clientX, y: e.clientY };
    _drawPreview = document.createElement('div');
    _drawPreview.className = `cc-shape-preview${_drawShape === 'ellipse' ? ' cc-shape-preview--ellipse' : ''}`;
    document.body.appendChild(_drawPreview);
    document.addEventListener('mousemove', onDrawMove, { capture: true });
    document.addEventListener('mouseup', onDrawEnd, { capture: true });
  }

  function onDrawMove(e) {
    if (!_drawStart || !_drawPreview) return;
    const x = Math.min(_drawStart.x, e.clientX);
    const y = Math.min(_drawStart.y, e.clientY);
    const w = Math.abs(e.clientX - _drawStart.x);
    const h = Math.abs(e.clientY - _drawStart.y);
    Object.assign(_drawPreview.style, {
      left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`,
    });
  }

  function onDrawEnd(e) {
    document.removeEventListener('mousemove', onDrawMove, { capture: true });
    document.removeEventListener('mouseup', onDrawEnd, { capture: true });
    if (!_drawStart) return;
    const x = Math.min(_drawStart.x, e.clientX) + window.scrollX;
    const y = Math.min(_drawStart.y, e.clientY) + window.scrollY;
    const width = Math.abs(e.clientX - _drawStart.x);
    const height = Math.abs(e.clientY - _drawStart.y);
    if (_drawPreview) { _drawPreview.remove(); _drawPreview = null; }
    if (width < 4 || height < 4) return; // too small — ignore
    const anchor = {
      type: 'shape',
      shape: _drawShape,
      left: Math.round(x), top: Math.round(y),
      width: Math.round(width), height: Math.round(height),
    };
    stopShapeDraw();
    _mode = null;
    openComposeWithAnchor(anchor, e.clientX, e.clientY);
  }

  function onDrawKey(e) {
    if (e.key === 'Escape') { stopShapeDraw(); _mode = null; toPanel('cc:panel:modeCancelled', {}); }
  }

  // Right-click exits shape-draw (same as ESC); suppress the native menu.
  function onDrawContext(e) {
    e.preventDefault();
    stopShapeDraw();
    _mode = null;
    toPanel('cc:panel:modeCancelled', {});
  }

  // ── Text selection button ──────────────────────────────────────────────────

  let _selBtn = null;

  function removeSelBtn() {
    if (_selBtn) { _selBtn.remove(); _selBtn = null; }
  }

  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { removeSelBtn(); return; }
    const range = sel.getRangeAt(0);
    if (!range.toString().trim()) { removeSelBtn(); return; }
    const rect = range.getBoundingClientRect();
    if (!_selBtn) {
      _selBtn = document.createElement('div');
      _selBtn.id = 'cc-sel-btn';
      _selBtn.textContent = '+ Comment';
      _selBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const saved = window.getSelection();
        const r = saved?.rangeCount ? saved.getRangeAt(0) : null;
        const container = r?.commonAncestorContainer;
        const el = container?.nodeType === Node.TEXT_NODE ? container.parentElement : container;
        removeSelBtn();
        if (el && r) openCompose(el, saved, e.clientX, e.clientY);
      });
      document.body.appendChild(_selBtn);
    }
    _selBtn.style.left = `${rect.left + rect.width / 2 - 50}px`;
    _selBtn.style.top = `${rect.top - 36}px`;
  });

  document.addEventListener('mousedown', (e) => {
    if (e.target !== _selBtn) removeSelBtn();
  });

  // ── Compose popover ────────────────────────────────────────────────────────

  // Same defensive cap as sidepanel.jsx's MAX_COMMENT_BODY_CHARS — pasted
  // screenshots as base64 can bloat a body into the MBs with no server-side guard.
  const MAX_COMPOSE_BODY_CHARS = 2_000_000; // ~2MB

  // Native Unicode emoji, inserted as plain text. Duplicated in
  // QuillEditor.jsx, which this dependency-free bundle can't import.
  const EMOJIS = ['👍', '👎', '😀', '😂', '🎉', '🔥', '👀', '✅', '❌', '⚠️', '🐛', '💡', '❓', '❤️', '🙏', '👏', '🚀', '💯', '😅', '🤔', '🙌', '✨', '📌', '⏳'];

  let _composeSaveBtn = null; // shadow-root button ref; can't querySelector across the boundary

  function openCompose(el, selection, cx, cy) {
    const anchor = captureAnchor(el, selection);
    openComposeWithAnchor(anchor, cx, cy);
  }

  function openComposeWithAnchor(anchor, cx, cy) {
    closeCompose();
    // The selection tool has done its job once a target is chosen and we're
    // composing — clear the mode and tell the panel so its tool toggle
    // deselects. (Tools are single-shot; this fires for element/shape/text-
    // selection paths alike since they all funnel through here.)
    _mode = null;
    toPanel('cc:panel:modeCancelled', {});
    const pop = document.createElement('div');
    pop.id = 'cc-compose';
    if (_theme === 'dark') pop.classList.add('cc-dark');

    // Position: prefer right/below the cursor, flip if too close to edge
    const W = window.innerWidth; const H = window.innerHeight;
    const pw = 380; const ph = 240;
    const left = cx + pw > W - 8 ? cx - pw : cx + 8;
    const top = cy + ph > H - 8 ? cy - ph : cy + 8;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;

    // The dialog's contents live in a shadow root: the host page's CSS
    // selectors can't cross the boundary, so its text can't be recolored by
    // page-level `button`/`textarea`/`*` rules.
    const root = pop.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = COMPOSE_SHADOW_CSS;
    root.appendChild(style);

    // We store raw contenteditable HTML — sanitizeHtml (sidepanel.jsx) is the
    // security gate at render time, so nothing needs sanitizing here.
    const toolbar = document.createElement('div');
    toolbar.className = 'cc-compose-toolbar';

    const editable = document.createElement('div');
    editable.className = 'cc-compose-editable';
    editable.contentEditable = 'true';
    editable.setAttribute('role', 'textbox');
    editable.setAttribute('aria-multiline', 'true');
    editable.setAttribute('aria-label', 'Comment text');
    editable.dataset.placeholder = 'Leave a comment… write as much as you need.';

    // Grow with content up to the CSS max-height (45vh), then the editable's
    // own scrollbar takes over — comfortable for long, multi-paragraph feedback.
    // The popover's top was placed once from the initial size estimate, so after
    // growing, nudge it up if the taller box would spill past the viewport bottom.
    const autoGrow = () => {
      const rect = pop.getBoundingClientRect();
      const margin = 8;
      if (rect.bottom > window.innerHeight - margin) {
        pop.style.top = `${Math.max(margin, window.innerHeight - margin - rect.height)}px`;
      }
    };
    editable.addEventListener('input', autoGrow);

    // Keep the current selection so a toolbar click (which can steal focus,
    // e.g. the link URL input) still applies to where the caret/selection was.
    let savedRange = null;
    function saveRange() {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && editable.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        savedRange = sel.getRangeAt(0).cloneRange();
      }
    }
    function restoreRange() {
      if (!savedRange) return;
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
    editable.addEventListener('keyup', saveRange);
    editable.addEventListener('mouseup', saveRange);

    function mkToolBtn(label, title, onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cc-compose-toolbtn';
      b.title = title;
      b.textContent = label;
      // Prevent the mousedown from moving focus off `editable`, so bold/italic
      // apply to the selection that's still active at click time.
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', onClick);
      return b;
    }

    const boldBtn = mkToolBtn('B', 'Bold', () => {
      editable.focus();
      document.execCommand('bold');
    });
    const italicBtn = mkToolBtn('I', 'Italic', () => {
      editable.focus();
      document.execCommand('italic');
    });

    const linkForm = document.createElement('div');
    linkForm.className = 'cc-compose-linkform';
    linkForm.style.display = 'none';
    const linkInput = document.createElement('input');
    linkInput.type = 'text';
    linkInput.placeholder = 'https://…';
    const linkAdd = document.createElement('button');
    linkAdd.type = 'button'; linkAdd.className = 'cc-compose-toolbtn'; linkAdd.textContent = 'Add';
    linkForm.append(linkInput, linkAdd);

    const linkBtn = mkToolBtn('🔗', 'Insert link', () => {
      saveRange();
      linkForm.style.display = linkForm.style.display === 'none' ? 'flex' : 'none';
      if (linkForm.style.display === 'flex') linkInput.focus();
    });
    function commitLink() {
      const url = linkInput.value.trim();
      linkForm.style.display = 'none';
      linkInput.value = '';
      if (!url) return;
      editable.focus();
      restoreRange();
      // safeMediaUrl (@adobe/annotations-core/sanitize) re-validates the scheme
      // at render time regardless — this is just so an obviously-bad scheme
      // isn't authored.
      if (/^\s*(javascript|data|vbscript):/i.test(url)) return;
      if (window.getSelection()?.isCollapsed) {
        document.execCommand('insertHTML', false, `<a href="${url.replace(/"/g, '&quot;')}">${url.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</a>`);
      } else {
        document.execCommand('createLink', false, url);
      }
      autoGrow();
    }
    linkAdd.addEventListener('click', commitLink);
    linkInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitLink(); }
      if (e.key === 'Escape') { e.stopPropagation(); linkForm.style.display = 'none'; editable.focus(); }
    });

    // Downscale before embedding as base64 — a full-resolution screenshot
    // can be several MB.
    function downscaleImage(dataUrl, maxDim) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
          if (!img.naturalWidth || scale >= 1) { resolve(dataUrl); return; }
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.naturalWidth * scale);
          canvas.height = Math.round(img.naturalHeight * scale);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
      });
    }

    function insertImageFile(file) {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        const raw = reader.result;
        if (typeof raw !== 'string' || !raw.startsWith('data:image/')) return;
        downscaleImage(raw, 1600).then((dataUrl) => {
          editable.focus();
          restoreRange();
          document.execCommand('insertHTML', false, `<img src="${dataUrl}">`);
          autoGrow();
        });
      };
      reader.readAsDataURL(file);
    }

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) insertImageFile(file);
      fileInput.value = '';
    });

    const imageBtn = mkToolBtn('🖼', 'Insert image', () => {
      saveRange();
      fileInput.click();
    });

    const emojiPopover = document.createElement('div');
    emojiPopover.className = 'cc-compose-emojipopover';
    emojiPopover.style.display = 'none';
    EMOJIS.forEach((emoji) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'cc-compose-emojiitem';
      item.textContent = emoji;
      item.setAttribute('aria-label', emoji);
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => {
        editable.focus();
        restoreRange();
        document.execCommand('insertText', false, emoji);
        emojiPopover.style.display = 'none';
        autoGrow();
      });
      emojiPopover.appendChild(item);
    });

    const emojiBtn = mkToolBtn('🙂', 'Insert emoji', () => {
      saveRange();
      emojiPopover.style.display = emojiPopover.style.display === 'none' ? 'grid' : 'none';
    });

    // The core QA flow: paste a screenshot straight into the comment.
    editable.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) insertImageFile(file);
          return;
        }
      }
      // Non-image paste falls through to the browser's default — sanitizeHtml
      // still gates it at render time.
    });

    toolbar.append(boldBtn, italicBtn, linkBtn, imageBtn, emojiBtn);
    root.append(toolbar, editable, linkForm, emojiPopover, fileInput);

    const hint = document.createElement('p');
    hint.className = 'cc-compose-hint';
    hint.textContent = 'Enter for a new line · ⌘/Ctrl+Enter to post';
    root.appendChild(hint);

    const actions = document.createElement('div');
    actions.className = 'cc-compose-actions';

    const cancel = document.createElement('button');
    cancel.className = 'cc-compose-cancel'; cancel.textContent = 'Cancel';
    cancel.addEventListener('click', closeCompose);

    const save = document.createElement('button');
    save.className = 'cc-compose-save'; save.textContent = 'Post';
    save.addEventListener('click', () => {
      // textContent is blind to <img> (a pasted screenshot with no caption
      // text) — same emptiness pitfall as the side panel's Quill boxes, fixed
      // there via an embed-aware check; mirrored here for this dependency-free
      // contenteditable.
      const isEmpty = !editable.textContent.trim() && !editable.querySelector('img');
      if (isEmpty) return;
      const body = editable.innerHTML;
      if (body.length > MAX_COMPOSE_BODY_CHARS) {
        hint.textContent = 'That comment is too large to post — try a smaller or cropped screenshot.';
        hint.classList.add('cc-compose-error');
        return;
      }
      closeCompose();
      toPanel('cc:panel:anchorCaptured', {
        anchor: finalizeAnchorForSave(anchor),
        body,
        pageUrl: window.location.origin + window.location.pathname,
      });
    });

    actions.append(cancel, save);
    root.appendChild(actions);
    document.body.appendChild(pop);
    editable.focus();
    // Without this, Chrome's default <div>-per-line on Enter gets unwrapped
    // (not allow-listed) with no separator, collapsing multi-line comments
    // into a run-on line — <p> is allow-listed, so use that instead.
    document.execCommand('defaultParagraphSeparator', false, 'p');

    _composeSaveBtn = save;
    document.addEventListener('keydown', onComposeKey);
  }

  function closeCompose() {
    const pop = document.getElementById('cc-compose');
    if (pop) pop.remove();
    _composeSaveBtn = null;
    document.removeEventListener('keydown', onComposeKey);
  }

  function onComposeKey(e) {
    if (e.key === 'Escape') closeCompose();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      if (_composeSaveBtn) _composeSaveBtn.click();
    }
  }

  // ── SPA navigation + MutationObserver ─────────────────────────────────────

  // Track origin+pathname (NOT full href) so it matches what onPageNavigated
  // compares against — otherwise the first nav event on a page with a query
  // string or hash would look like a navigation and wipe the markers.
  let _lastUrl = window.location.origin + window.location.pathname;

  function onPageNavigated() {
    const url = window.location.origin + window.location.pathname;
    if (url === _lastUrl) return;
    _lastUrl = url;
    // Clear markers and tell panel the URL changed
    _threads = []; _resolvedMap = {};
    const overlay = document.getElementById('cc-overlay');
    if (overlay) overlay.innerHTML = '';
    toPanel('cc:panel:pageUrl', { pageUrl: url });
  }

  // history.pushState/replaceState are intercepted by a MAIN-world shim injected
  // by background.js, which re-fires them as a 'cc:navigated' CustomEvent on window.
  // DOM CustomEvents cross the MAIN/ISOLATED boundary, so we receive them here.
  window.addEventListener('cc:navigated', onPageNavigated);
  window.addEventListener('popstate', onPageNavigated);
  window.addEventListener('hashchange', onPageNavigated);

  // Was this mutation caused by our own overlay/dialogs rather than page content?
  // Skip those so rendering markers / opening compose doesn't schedule a
  // needless re-resolution pass. (We only observe childList, so it's enough to
  // check the mutated container and the added/removed nodes.)
  function isOwnMutation(m) {
    if (isOwnUi(m.target)) return true;
    const nodes = [...m.addedNodes, ...m.removedNodes];
    return nodes.length > 0
      && nodes.every((n) => n.nodeType === Node.ELEMENT_NODE && isOwnUi(n));
  }

  // MutationObserver: re-resolve orphaned anchors when DOM changes
  let _mutationTimer = null;
  const mo = new MutationObserver((mutations) => {
    if (mutations.every(isOwnMutation)) return;
    clearTimeout(_mutationTimer);
    _mutationTimer = setTimeout(() => {
      if (!_threads.length) return;
      const updated = resolveAll(_threads);
      const changed = Object.keys(updated).some(
        (id) => updated[id].status !== _resolvedMap[id]?.status,
      );
      if (changed) {
        _resolvedMap = updated;
        renderMarkers();
        toPanel('cc:panel:resolutionUpdated', {
          resolution: Object.fromEntries(Object.entries(_resolvedMap).map(([id, r]) => [id, r.status])),
        });
      }
    }, 300);
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // ── Message listener ───────────────────────────────────────────────────────
  // Messages arrive from the service worker (forwarded from the side panel).

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'cc:content:threads') {
      _threads = msg.threads ?? [];
      _resolvedMap = resolveAll(_threads);
      renderMarkers();
      toPanel('cc:panel:resolutionUpdated', {
        resolution: Object.fromEntries(Object.entries(_resolvedMap).map(([id, r]) => [id, r.status])),
      });
      return;
    }
    if (msg.type === 'cc:content:scrollTo') {
      const t = _threads.find((x) => x.id === msg.threadId);
      if (t) scrollToThread(t);
      return;
    }
    if (msg.type === 'cc:content:mode') {
      setMode(msg.mode);
      return;
    }
  });

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  injectStyles();
  ensureOverlay();

  // Load the panel's light/dark preference so the compose dialog matches it,
  // and stay in sync if the user toggles theme while this tab is open.
  chrome.storage.sync.get('theme', (data) => { if (data.theme) _theme = data.theme; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.theme) _theme = changes.theme.newValue;
  });

  // Report initial page URL to the panel
  toPanel('cc:panel:pageUrl', { pageUrl: window.location.origin + window.location.pathname });
}
