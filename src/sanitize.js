/**
 * sanitize.js — HTML allow-list for milo-authored comment bodies.
 *
 * milo stores comments as Quill-authored HTML (see the milo annotations client's
 * own sanitize.js, which this module mirrors). Widened here (MWPW-201267) beyond
 * strong/em/p/br to also allow inline links and images — the same text-render
 * path emoji goes through (MWPW-200384) — so QA-pasted screenshots and links
 * show up instead of being flattened to plain text.
 */
import DOMPurify from 'dompurify';

const PC_CONFIG = {
  // b/i (not just strong/em) because content.js's in-page contenteditable
  // composer uses document.execCommand('bold'|'italic'), which emits <b>/<i>.
  ALLOWED_TAGS: ['strong', 'em', 'b', 'i', 'p', 'br', 'a', 'img'],
  // target/rel aren't here — the afterSanitizeAttributes hook below sets or
  // strips them unconditionally on every <a>, so whatever DOMPurify's own
  // attribute pass would've allowed through is irrelevant.
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title'],
};

// Returns `url` when it is a safe media source to render into an <img>/<video>
// src (http/https/protocol-relative/relative path, or an inline raster
// data:image), else ''. Blocks javascript:/blob:/file: and other schemes, and
// the markup-bearing data: types (data:text/html, data:image/svg+xml) on
// stored, attacker-authored comment bodies before they reach a reviewer's DOM.
const DATA_IMAGE_RASTER = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)\s*[;,]/i;

export function safeMediaUrl(url) {
  const s = String(url ?? '').trim();
  if (!s) return '';
  if (/^\/\//.test(s)) return `https:${s}`;            // protocol-relative → force https
  if (/^\.?\.?\//.test(s)) return s;                   // relative path (same-origin as host page)
  if (DATA_IMAGE_RASTER.test(s)) return s;             // inline raster image (never svg/text/html)
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? s : '';
  } catch {
    return '';
  }
}

// Re-gate img[src] and a[href] through safeMediaUrl after DOMPurify's own
// attribute scrub — the ALLOWED_ATTR list above permits *some* href/src value
// through, but safeMediaUrl is the scheme allow-list (blocks javascript:/blob:/
// file:/markup-bearing data:). Also forces target=_blank + rel=noopener
// noreferrer on links so a comment can't reverse-tabnab the panel.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'IMG') {
    const safe = safeMediaUrl(node.getAttribute('src'));
    if (!safe) { node.remove(); return; }
    node.setAttribute('src', safe);
  } else if (node.tagName === 'A') {
    const safe = safeMediaUrl(node.getAttribute('href'));
    if (!safe) {
      node.removeAttribute('href');
      node.removeAttribute('target');
      node.removeAttribute('rel');
    } else {
      node.setAttribute('href', safe);
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }
});

export function sanitizeHtml(html) {
  return DOMPurify.sanitize(String(html ?? ''), PC_CONFIG);
}

// Extract plain text from a (possibly HTML) comment body — milo stores Quill
// rich text, so bodies can contain markup. Parse with DOMParser rather than
// assigning innerHTML on a live-document element: a DOMParser document has no
// browsing context, so embedded resources (e.g. `<img src>`) never load and no
// beacon fires while we're only reading textContent. Used for thread-list
// previews/search, where only plain text is shown.
export function stripHtml(html) {
  if (!html) return '';
  return new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
}

export function escAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
