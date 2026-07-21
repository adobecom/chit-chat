/**
 * QuillEditor.jsx — rich-text compose box for replies and comment edits.
 *
 * Mirrors the milo annotations client's QuillEditor.js, but bundled (npm
 * `quill` import) rather than lazy-loaded from a CDN: the extension's side
 * panel runs under MV3's default `script-src 'self'` CSP, which a CDN
 * <script>/<link> can't satisfy. Quill + its snow theme CSS ship inside
 * dist/sidepanel.js / dist/sidepanel.css instead.
 *
 * Uncontrolled by design — Quill owns its own DOM, so the parent doesn't hold
 * the HTML in React state on every keystroke. `onEmptyChange` lets the parent
 * drive a submit button's disabled state without re-rendering per keystroke.
 */
import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import Quill from 'quill';
import 'quill/dist/quill.snow.css';
import { escAttr, stripHtml } from './sanitize.js';

// Downscale a pasted/inserted screenshot before it's embedded as base64 — a
// full-resolution screenshot can be several MB, which bloats the stored
// comment body and risks the API proxy's request timeout (MWPW-201267).
// Mirrors content.js's downscaleImage; duplicated rather than shared because
// content.js is a dependency-free IIFE bundle and can't import this module.
const MAX_IMAGE_DIM = 1600;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function downscaleDataUrl(dataUrl, maxDim) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      if (!img.naturalWidth || scale >= 1) { resolve(dataUrl); return; }
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// Overrides Quill's default uploader handler (used for both the toolbar
// image button and pasted/dropped images) to downscale before inserting,
// instead of embedding the file at full resolution.
function uploadHandler(range, files) {
  const quill = this.quill;
  Promise.all(files.map((file) => readAsDataUrl(file).then((raw) => downscaleDataUrl(raw, MAX_IMAGE_DIM))))
    .then((dataUrls) => {
      let index = range.index;
      dataUrls.forEach((dataUrl) => {
        quill.insertEmbed(index, 'image', dataUrl, 'user');
        index += 1;
      });
      quill.setSelection(index, 'silent');
    });
}

const QuillEditor = forwardRef(function QuillEditor(
  {
    placeholder = 'Write a comment…',
    initialHtml = '',
    onEmptyChange,
    autoFocus = false,
    'aria-label': ariaLabel,
  },
  ref,
) {
  const mountRef = useRef(null);
  const quillRef = useRef(null);

  useImperativeHandle(ref, () => ({
    getHtml() {
      if (quillRef.current) return quillRef.current.root.innerHTML;
      return mountRef.current?.querySelector('textarea')?.value ?? '';
    },
    getText() {
      if (quillRef.current) return quillRef.current.getText().trim();
      return (mountRef.current?.querySelector('textarea')?.value ?? '').trim();
    },
    clear() {
      if (quillRef.current) quillRef.current.setText('');
      else if (mountRef.current?.querySelector('textarea')) {
        mountRef.current.querySelector('textarea').value = '';
      }
    },
    focus() {
      if (quillRef.current) quillRef.current.focus();
      else mountRef.current?.querySelector('textarea')?.focus();
    },
  }), []);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    try {
      const q = new Quill(el, {
        theme: 'snow',
        placeholder,
        modules: {
          toolbar: [['bold', 'italic'], ['link', 'image']],
          uploader: {
            mimetypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
            handler: uploadHandler,
          },
        },
      });
      if (initialHtml) q.clipboard.dangerouslyPasteHTML(initialHtml);
      if (ariaLabel) q.root.setAttribute('aria-label', ariaLabel);
      quillRef.current = q;
      onEmptyChange?.(q.getText().trim().length === 0);
      q.on('text-change', () => onEmptyChange?.(q.getText().trim().length === 0));
      if (autoFocus) q.focus();
    } catch {
      // Fallback if Quill fails to construct (e.g. unexpected DOM state) —
      // keep the box usable as plain text rather than losing compose entirely.
      el.innerHTML = `<textarea class="cc-quill-fallback" placeholder="${escAttr(placeholder)}" aria-label="${escAttr(ariaLabel ?? placeholder)}">${escAttr(stripHtml(initialHtml))}</textarea>`;
      onEmptyChange?.(!stripHtml(initialHtml).trim());
    }

    return () => {
      quillRef.current = null;
    };
  }, []); // intentionally run once — this is an uncontrolled editor

  return <div ref={mountRef} className="cc-quill-mount" />;
});

export default QuillEditor;
