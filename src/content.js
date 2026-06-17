/**
 * content.js — Chit Chat content script.
 *
 * Runs in the host page's MAIN world (world: "MAIN" in the manifest/SW).
 * Owns everything that requires live host-DOM access:
 *   - Anchor capture (same JSON shape as the original page-commenter so stored
 *     threads stay resolvable) and resolution cascade
 *   - Overlay: dot markers + shape markers
 *   - Element-picker mode, shape-draw mode, text-selection button
 *   - Scroll-to-thread / flash
 *   - SPA-navigation hooks + MutationObserver for anchor re-resolution
 *
 * Communicates with the service worker via chrome.runtime.sendMessage.
 * Never makes fetch() calls directly — all network I/O lives in background.js.
 *
 * Guard against double-injection.
 */
if (window.__chitChatLoaded) {
  // already running — ignore
} else {
  window.__chitChatLoaded = true;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function send(type, payload = {}) {
    return chrome.runtime.sendMessage({ type, ...payload });
  }

  /** postMessage-safe wrapper to tell the panel something. */
  function toPanel(type, payload = {}) {
    send('cc:panel:forward', { payload: { type, ...payload } });
  }

  // ── Levenshtein / text similarity ─────────────────────────────────────────

  function levenshtein(a, b) {
    if (a === b) return 0;
    const la = a.length; const lb = b.length;
    if (!la) return lb; if (!lb) return la;
    const dp = Array.from({ length: la + 1 }, (_, i) => i);
    for (let j = 1; j <= lb; j++) {
      let prev = dp[0]; dp[0] = j;
      for (let i = 1; i <= la; i++) {
        const tmp = dp[i];
        dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1]);
        prev = tmp;
      }
    }
    return dp[la];
  }

  function textSimilarity(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    const as = a.slice(0, 512); const bs = b.slice(0, 512);
    return 1 - levenshtein(as, bs) / Math.max(as.length, bs.length);
  }

  // ── CSS selector / XPath builders ─────────────────────────────────────────

  function buildSelector(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      let seg = node.tagName.toLowerCase();
      if (node.id) { seg += `#${CSS.escape(node.id)}`; parts.unshift(seg); break; }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) seg += `:nth-child(${[...parent.children].indexOf(node) + 1})`;
      }
      parts.unshift(seg);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function buildXPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      let idx = 1;
      if (parent) for (const s of parent.children) { if (s === node) break; if (s.tagName === node.tagName) idx++; }
      parts.unshift(`${tag}[${idx}]`);
      node = parent;
    }
    return `/${parts.join('/')}`;
  }

  // ── Anchor capture ─────────────────────────────────────────────────────────
  // Produces the same JSON shape as the original anchor.js so stored threads
  // still resolve on the old bookmarklet client and vice-versa.

  function captureAnchor(el, selection) {
    const rect = el.getBoundingClientRect();
    const anchor = {
      cssSelector: buildSelector(el),
      xpath: buildXPath(el),
      textContent: el.textContent || '',
      boundingRect: {
        top: Math.round(rect.top + window.scrollY),
        left: Math.round(rect.left + window.scrollX),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      tagName: el.tagName,
    };
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const pre = document.createRange();
      pre.setStart(el, 0);
      pre.setEnd(range.startContainer, range.startOffset);
      anchor.textSelectionStart = pre.toString().length;
      anchor.textSelectionEnd = anchor.textSelectionStart + range.toString().length;
    }
    if (el.tagName === 'IMG') { anchor.altText = el.alt || null; anchor.src = el.currentSrc || el.src || null; }
    if (el.tagName === 'PICTURE') {
      const img = el.querySelector('img');
      anchor.altText = img?.alt || null; anchor.src = img?.currentSrc || img?.src || null;
    }
    if (el.tagName === 'VIDEO') {
      anchor.src = el.currentSrc || el.src || el.querySelector('source')?.src || null;
      anchor.poster = el.poster || null;
    }
    return anchor;
  }

  // ── Anchor resolution cascade ──────────────────────────────────────────────

  function resolveAnchor(anchor) {
    if (!anchor || anchor.type === 'shape') return { element: null, status: 'unanchored' };
    const { cssSelector, xpath, textContent, tagName } = anchor;
    let structurallyFound = false;
    try {
      const el = document.querySelector(cssSelector);
      if (el) {
        structurallyFound = true;
        if (textSimilarity(el.textContent, textContent) >= 0.8) return { element: el, status: 'resolved' };
      }
    } catch { /* invalid selector */ }
    try {
      const el = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (el) {
        structurallyFound = true;
        if (textSimilarity(el.textContent, textContent) >= 0.8) return { element: el, status: 'resolved' };
      }
    } catch { /* invalid xpath */ }
    if (structurallyFound && tagName) {
      let best = null; let bestScore = 0;
      for (const el of document.getElementsByTagName(tagName)) {
        const score = textSimilarity(el.textContent, textContent);
        if (score > bestScore) { bestScore = score; best = el; }
      }
      if (best && bestScore >= 0.5) return { element: best, status: bestScore >= 0.8 ? 'resolved' : 'approximate' };
    }
    return { element: null, status: 'unanchored' };
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
      .cc-dot { position: absolute; width: 20px; height: 20px; border-radius: 50%;
                box-shadow: 0 2px 8px rgba(0,0,0,.35); cursor: pointer; pointer-events: all;
                transform: translate(-50%,-50%); transition: transform .1s;
                display: flex; align-items: center; justify-content: center;
                font: bold 10px/1 sans-serif; color: #fff; }
      .cc-dot:hover { transform: translate(-50%,-50%) scale(1.2); }
      .cc-dot--open    { background: #0265DC; }
      .cc-dot--resolved{ background: #0265DC; }
      .cc-dot--approximate { background: #E68619; }
      .cc-dot--closed  { background: #6D6D6D; }
      .cc-dot--approved{ background: #2D9D78; }
      .cc-shape { position: absolute; pointer-events: all; cursor: pointer;
                  border: 2px solid #0265DC; background: rgba(2,101,220,.08);
                  box-sizing: border-box; }
      .cc-shape--ellipse { border-radius: 50%; }
      .cc-shape--closed  { border-color: #6D6D6D; background: rgba(109,109,109,.08); }
      .cc-shape--approved{ border-color: #2D9D78; background: rgba(45,157,120,.08); }
      /* element-picker highlight */
      #cc-element-picker { position: fixed; inset: 0; z-index: 2147483641;
                           pointer-events: none; }
      .cc-el-highlight { position: absolute; background: rgba(2,101,220,.12);
                         outline: 2px solid #0265DC; box-sizing: border-box;
                         pointer-events: none; border-radius: 2px; }
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
      /* compose popover */
      #cc-compose { position: fixed; background: #fff; border-radius: 8px;
                    box-shadow: 0 8px 32px rgba(0,0,0,.2); padding: 12px;
                    z-index: 2147483644; width: 320px; box-sizing: border-box; }
      #cc-compose textarea { width: 100%; min-height: 80px; box-sizing: border-box;
                              border: 1px solid #ccc; border-radius: 4px; padding: 8px;
                              font: 13px/1.5 -apple-system, sans-serif; resize: vertical;
                              outline-color: #0265DC; }
      #cc-compose .cc-compose-actions { display: flex; gap: 8px; margin-top: 8px;
                                         justify-content: flex-end; }
      #cc-compose button { padding: 6px 14px; border-radius: 4px; border: 1px solid #ccc;
                           cursor: pointer; font: 13px/1 -apple-system, sans-serif; }
      #cc-compose .cc-compose-save { background: #0265DC; color: #fff; border-color: #0265DC; }
      #cc-compose .cc-compose-cancel { background: #fff; }
    `;
    document.head.appendChild(s);
  }

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

  function renderMarkers() {
    const overlay = ensureOverlay();
    overlay.innerHTML = '';
    for (const t of _threads) {
      const res = _resolvedMap[t.id];
      if (!res) continue;
      if (t.anchor?.type === 'shape') {
        renderShapeMarker(overlay, t);
      } else if (res.element) {
        renderDotMarker(overlay, t, res.element);
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

  function renderDotMarker(overlay, thread, el) {
    const rect = el.getBoundingClientRect();
    const dot = document.createElement('div');
    const statusClass = `cc-dot--${thread.status ?? 'open'}`;
    dot.className = `cc-dot ${statusClass}`;
    dot.style.left = `${rect.left + rect.width / 2 + window.scrollX}px`;
    dot.style.top = `${rect.top + window.scrollY}px`;
    dot.dataset.threadId = thread.id;
    dot.title = thread.title ?? '';
    dot.addEventListener('click', () => toPanel('cc:panel:dotClicked', { threadId: thread.id }));
    overlay.appendChild(dot);
  }

  function renderShapeMarker(overlay, thread) {
    const a = thread.anchor;
    const shape = document.createElement('div');
    shape.className = `cc-shape${a.shape === 'ellipse' ? ' cc-shape--ellipse' : ''}${thread.status === 'closed' ? ' cc-shape--closed' : thread.status === 'approved' ? ' cc-shape--approved' : ''}`;
    shape.style.left = `${a.x}px`;
    shape.style.top = `${a.y}px`;
    shape.style.width = `${a.width}px`;
    shape.style.height = `${a.height}px`;
    shape.dataset.threadId = thread.id;
    shape.addEventListener('click', () => toPanel('cc:panel:dotClicked', { threadId: thread.id }));
    overlay.appendChild(shape);
  }

  // Reposition dot markers on scroll/resize (shapes use absolute page coords, skip)
  function repositionMarkers() {
    const overlay = document.getElementById('cc-overlay');
    if (!overlay) return;
    for (const dot of overlay.querySelectorAll('.cc-dot')) {
      const tid = dot.dataset.threadId;
      const res = _resolvedMap[tid];
      if (!res?.element) continue;
      const rect = res.element.getBoundingClientRect();
      dot.style.left = `${rect.left + rect.width / 2 + window.scrollX}px`;
      dot.style.top = `${rect.top + window.scrollY}px`;
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
      window.scrollTo({ top: a.y + a.height / 2 - window.innerHeight / 2, behavior: 'smooth' });
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
  let _pendingAnchorContext = null; // { el, selection } set during compose

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

  function startElementPicker() {
    if (_pickerEl) return;
    _pickerEl = document.createElement('div');
    _pickerEl.id = 'cc-element-picker';
    document.body.appendChild(_pickerEl);

    _highlightEl = document.createElement('div');
    _highlightEl.className = 'cc-el-highlight';
    _pickerEl.appendChild(_highlightEl);

    document.body.style.cursor = 'crosshair';
    document.addEventListener('mousemove', onPickerMove, { capture: true });
    document.addEventListener('click', onPickerClick, { capture: true });
    document.addEventListener('keydown', onPickerKey, { capture: true });
  }

  function stopElementPicker() {
    if (_pickerEl) { _pickerEl.remove(); _pickerEl = null; _highlightEl = null; }
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onPickerMove, { capture: true });
    document.removeEventListener('click', onPickerClick, { capture: true });
    document.removeEventListener('keydown', onPickerKey, { capture: true });
  }

  let _pickerTarget = null;
  function onPickerMove(e) {
    const els = document.elementsFromPoint(e.clientX, e.clientY)
      .filter((el) => !isOwnUi(el));
    const el = els[0];
    if (!el || el === document.documentElement || el === document.body) return;
    _pickerTarget = el;
    const rect = el.getBoundingClientRect();
    if (_highlightEl) {
      Object.assign(_highlightEl.style, {
        left: `${rect.left}px`, top: `${rect.top}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
      });
    }
  }

  function onPickerClick(e) {
    if (isOwnUi(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    const el = _pickerTarget;
    if (!el) return;
    stopElementPicker();
    _mode = null;
    openCompose(el, null, e.clientX, e.clientY);
  }

  function onPickerKey(e) {
    if (e.key === 'Escape') { stopElementPicker(); _mode = null; toPanel('cc:panel:modeCancelled', {}); }
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
  }

  function stopShapeDraw() {
    if (_drawLayer) { _drawLayer.remove(); _drawLayer = null; }
    if (_drawPreview) { _drawPreview.remove(); _drawPreview = null; }
    document.removeEventListener('mousemove', onDrawMove, { capture: true });
    document.removeEventListener('mouseup', onDrawEnd, { capture: true });
    document.removeEventListener('keydown', onDrawKey, { capture: true });
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
      x: Math.round(x), y: Math.round(y),
      width: Math.round(width), height: Math.round(height),
    };
    const currentShape = _drawShape;
    stopShapeDraw();
    _mode = null;
    openComposeWithAnchor(anchor, e.clientX, e.clientY);
  }

  function onDrawKey(e) {
    if (e.key === 'Escape') { stopShapeDraw(); _mode = null; toPanel('cc:panel:modeCancelled', {}); }
  }

  // ── Text selection button ──────────────────────────────────────────────────

  let _selBtn = null;
  let _selRange = null;

  function removeSelBtn() {
    if (_selBtn) { _selBtn.remove(); _selBtn = null; }
    _selRange = null;
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

  function openCompose(el, selection, cx, cy) {
    const anchor = captureAnchor(el, selection);
    openComposeWithAnchor(anchor, cx, cy);
  }

  function openComposeWithAnchor(anchor, cx, cy) {
    closeCompose();
    const pop = document.createElement('div');
    pop.id = 'cc-compose';

    // Position: prefer right/below the cursor, flip if too close to edge
    const W = window.innerWidth; const H = window.innerHeight;
    const pw = 320; const ph = 150;
    const left = cx + pw > W - 8 ? cx - pw : cx + 8;
    const top = cy + ph > H - 8 ? cy - ph : cy + 8;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Leave a comment…';
    pop.appendChild(textarea);

    const actions = document.createElement('div');
    actions.className = 'cc-compose-actions';

    const cancel = document.createElement('button');
    cancel.className = 'cc-compose-cancel'; cancel.textContent = 'Cancel';
    cancel.addEventListener('click', closeCompose);

    const save = document.createElement('button');
    save.className = 'cc-compose-save'; save.textContent = 'Post';
    save.addEventListener('click', () => {
      const body = textarea.value.trim();
      if (!body) return;
      closeCompose();
      toPanel('cc:panel:anchorCaptured', {
        anchor,
        body,
        pageUrl: window.location.origin + window.location.pathname,
      });
    });

    actions.append(cancel, save);
    pop.appendChild(actions);
    document.body.appendChild(pop);
    textarea.focus();

    document.addEventListener('keydown', onComposeKey);
  }

  function closeCompose() {
    const pop = document.getElementById('cc-compose');
    if (pop) pop.remove();
    document.removeEventListener('keydown', onComposeKey);
  }

  function onComposeKey(e) {
    if (e.key === 'Escape') closeCompose();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      const save = document.querySelector('#cc-compose .cc-compose-save');
      if (save) save.click();
    }
  }

  // ── SPA navigation + MutationObserver ─────────────────────────────────────

  let _lastUrl = window.location.href;

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

  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = function (...args) { const r = origPush(...args); onPageNavigated(); return r; };
  history.replaceState = function (...args) { const r = origReplace(...args); onPageNavigated(); return r; };
  window.addEventListener('popstate', onPageNavigated);
  window.addEventListener('hashchange', onPageNavigated);

  // MutationObserver: re-resolve orphaned anchors when DOM changes
  let _mutationTimer = null;
  const mo = new MutationObserver(() => {
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

  // Report initial page URL to the panel
  toPanel('cc:panel:pageUrl', { pageUrl: window.location.origin + window.location.pathname });
}
