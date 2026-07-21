/**
 * QuillEditor.jsx — rich-text compose box for replies and comment edits.
 *
 * Bundles Quill (rather than the milo client's lazy CDN load) since the side
 * panel's MV3 CSP is script-src 'self'. Uncontrolled by design — `getHtml`/
 * `onEmptyChange` read Quill's own DOM instead of mirroring it into state.
 */
import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import Quill from 'quill';
import 'quill/dist/quill.snow.css';
import { escAttr, stripHtml } from './sanitize.js';

// Downscale pasted/inserted screenshots before embedding as base64 — full
// resolution can be several MB. Duplicated in content.js, which can't
// import this module (dependency-free IIFE bundle).
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

// Native Unicode emoji, inserted as plain text — no allow-list/sanitizer
// changes needed. Duplicated in content.js for the same reason as above.
const EMOJIS = ['👍', '👎', '😀', '😂', '🎉', '🔥', '👀', '✅', '❌', '⚠️', '🐛', '💡', '❓', '❤️', '🙏', '👏', '🚀', '💯', '😅', '🤔', '🙌', '✨', '📌', '⏳'];

// Quill's array-based toolbar only renders buttons for built-in formats, so
// the emoji picker is appended to the generated toolbar by hand rather than
// through modules.toolbar. mousedown/preventDefault on every button keeps
// focus (and Quill's last selection range) in the editor.
function attachEmojiPicker(quill, toolbarEl) {
  const wrap = document.createElement('span');
  wrap.className = 'cc-emoji-wrap';

  const popover = document.createElement('div');
  popover.className = 'cc-emoji-popover';
  popover.hidden = true;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cc-emoji-btn';
  btn.textContent = '🙂';
  btn.title = 'Insert emoji';
  btn.setAttribute('aria-label', 'Insert emoji');
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => { popover.hidden = !popover.hidden; });
  EMOJIS.forEach((emoji) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'cc-emoji-item';
    item.textContent = emoji;
    item.setAttribute('aria-label', emoji);
    item.addEventListener('mousedown', (e) => e.preventDefault());
    item.addEventListener('click', () => {
      const range = quill.getSelection() ?? { index: quill.getLength(), length: 0 };
      quill.insertText(range.index, emoji, 'user');
      quill.setSelection(range.index + emoji.length, 0, 'silent');
      popover.hidden = true;
    });
    popover.appendChild(item);
  });

  function onDocClick(e) {
    if (!wrap.contains(e.target)) popover.hidden = true;
  }
  document.addEventListener('click', onDocClick);

  wrap.append(btn, popover);
  toolbarEl.appendChild(wrap);
  return () => document.removeEventListener('click', onDocClick);
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
    let detachEmojiPicker;

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

      const toolbarEl = el.querySelector('.ql-toolbar');
      if (toolbarEl) detachEmojiPicker = attachEmojiPicker(q, toolbarEl);
    } catch {
      // Fallback if Quill fails to construct (e.g. unexpected DOM state) —
      // keep the box usable as plain text rather than losing compose entirely.
      el.innerHTML = `<textarea class="cc-quill-fallback" placeholder="${escAttr(placeholder)}" aria-label="${escAttr(ariaLabel ?? placeholder)}">${escAttr(stripHtml(initialHtml))}</textarea>`;
      onEmptyChange?.(!stripHtml(initialHtml).trim());
    }

    return () => {
      detachEmojiPicker?.();
      quillRef.current = null;
    };
  }, []); // intentionally run once — this is an uncontrolled editor

  return <div ref={mountRef} className="cc-quill-mount" />;
});

export default QuillEditor;
