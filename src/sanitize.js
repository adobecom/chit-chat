/**
 * sanitize.js — HTML allow-list for milo-authored comment bodies.
 *
 * Mirrors the milo annotations client's sanitize.js, widened beyond
 * strong/em/p/br to also allow links and inline images.
 */
import DOMPurify from 'dompurify';

const PC_CONFIG = {
  // b/i (not just strong/em) because content.js's execCommand('bold'|'italic') emits them.
  ALLOWED_TAGS: ['strong', 'em', 'b', 'i', 'p', 'br', 'a', 'img'],
  // target/rel omitted — the hook below sets/strips them unconditionally on every <a>.
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title'],
};

// Safe media source for <img>/<video> src: http(s), protocol-relative
// (upgraded to https), relative, or raster data:image. Blocks javascript:/
// blob:/file: and markup-bearing data: (text/html, svg).
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

// Re-gates img[src]/a[href] through safeMediaUrl after DOMPurify's own
// attribute scrub, and forces target=_blank + rel=noopener noreferrer on
// links so a comment can't reverse-tabnab the panel.
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

// Plain text via an inert DOMParser (no browsing context, so <img> etc. never
// load). Used for thread-list previews/search, where only text is shown.
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
