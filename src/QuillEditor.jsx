/**
 * QuillEditor.jsx — rich-text compose box for replies and comment edits.
 *
 * Bundles Quill (rather than the milo client's lazy CDN load) since the side
 * panel's MV3 CSP is script-src 'self'. Uncontrolled by design — `getHtml`/
 * `onEmptyChange` read Quill's own DOM instead of mirroring it into state.
 */
import { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import Quill from 'quill';
import 'quill/dist/quill.snow.css';
import { escAttr, stripHtml } from '@adobe/annotations-core/sanitize';
import EmojiIcon from '@react-spectrum/s2/icons/Emoji';

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

// Quill's getText() silently drops non-string embeds (e.g. inserted images) —
// every image insert op is 0 characters in that string, while it's exactly 1
// unit in the *real* document index space getSelection()/deleteText()/
// insertText() all operate in (Parchment's default embed length is 1). Any
// caller pairing getText() with getSelection().index desyncs the moment an
// image sits before the caret. This mirrors that layout with a single
// placeholder character per embed so index arithmetic against the returned
// string lines up with Quill's real indices.
function getTextWithEmbeds(quill) {
  return quill.getContents().ops.reduce(
    (acc, op) => acc + (typeof op.insert === 'string' ? op.insert : '￼'),
    '',
  );
}

// Native Unicode emoji, inserted as plain text — no allow-list/sanitizer
// changes needed. Duplicated in content.js for the same reason as above.
const EMOJIS = ['👍', '👎', '😀', '😂', '🎉', '🔥', '👀', '✅', '❌', '⚠️', '🐛', '💡', '❓', '❤️', '🙏', '👏', '🚀', '💯', '😅', '🤔', '🙌', '✨', '📌', '⏳'];

// Quill's array-based toolbar only renders buttons for built-in formats, so
// the emoji picker is appended to the generated toolbar by hand rather than
// through modules.toolbar — including its icon, which is left for the caller
// to portal an S2 <EmojiIcon> into (see the `button` returned below), since
// this runs outside React's render. mousedown/preventDefault on every button
// keeps focus (and Quill's last selection range) in the editor.
function attachEmojiPicker(quill, toolbarEl) {
  const wrap = document.createElement('span');
  wrap.className = 'cc-emoji-wrap';

  const popover = document.createElement('div');
  popover.className = 'cc-emoji-popover';
  popover.hidden = true;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cc-emoji-btn';
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
  return { button: btn, detach: () => document.removeEventListener('click', onDocClick) };
}

const QuillEditor = forwardRef(function QuillEditor(
  {
    placeholder = 'Write a comment…',
    initialHtml = '',
    onEmptyChange,
    // Fired on every text/selection change with (plainText, caretIndex|null) —
    // caretIndex is null when the editor has no active selection (e.g. blur).
    // Lets @-mention autocomplete (see useMentionPicker in sidepanel.jsx) track
    // the caret against Quill's own document instead of mirroring text into
    // React state, which the uncontrolled-editor design above avoids.
    onCaretChange,
    autoFocus = false,
    'aria-label': ariaLabel,
  },
  ref,
) {
  const mountRef = useRef(null);
  const quillRef = useRef(null);
  const [emojiBtn, setEmojiBtn] = useState(null);

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
    // Mention support below is Quill-only — the plain-<textarea> fallback (used
    // only if Quill itself fails to construct) has no equivalent, so callers
    // see no caret updates and a picker that simply never opens in that path.
    getSelection() {
      return quillRef.current ? quillRef.current.getSelection() : null;
    },
    // Deletes the [start, end) range and inserts `text` in its place — used to
    // swap an in-progress "@query" for the picked "@Full Name " mention.
    replaceRange(start, end, text) {
      const q = quillRef.current;
      if (!q) return;
      if (end > start) q.deleteText(start, end - start, 'user');
      q.insertText(start, text, 'user');
      q.setSelection(start + text.length, 0, 'silent');
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
      // getLength() counts the doc's mandatory trailing newline, so an empty
      // editor is always exactly 1 — including an embed (e.g. a lone pasted
      // image) makes it >= 2. Unlike getText().trim(), this correctly treats
      // an image-only body as non-empty.
      onEmptyChange?.(q.getLength() <= 1);
      q.on('text-change', () => {
        onEmptyChange?.(q.getLength() <= 1);
        onCaretChange?.(getTextWithEmbeds(q), q.getSelection()?.index ?? null);
      });
      // Also fires on caret moves that don't change text (click, arrow keys) —
      // needed so opening/closing the mention popover tracks cursor position,
      // not just edits. Range is null on blur, which closes the popover.
      q.on('selection-change', (range) => {
        onCaretChange?.(getTextWithEmbeds(q), range ? range.index : null);
      });
      if (autoFocus) q.focus();

      const toolbarEl = el.querySelector('.ql-toolbar');
      if (toolbarEl) {
        const picker = attachEmojiPicker(q, toolbarEl);
        detachEmojiPicker = picker.detach;
        setEmojiBtn(picker.button);
      }
    } catch {
      // Fallback if Quill fails to construct (e.g. unexpected DOM state) —
      // keep the box usable as plain text rather than losing compose entirely.
      el.innerHTML = `<textarea class="cc-quill-fallback" placeholder="${escAttr(placeholder)}" aria-label="${escAttr(ariaLabel ?? placeholder)}">${escAttr(stripHtml(initialHtml))}</textarea>`;
      onEmptyChange?.(!stripHtml(initialHtml).trim());
    }

    return () => {
      detachEmojiPicker?.();
      setEmojiBtn(null);
      quillRef.current = null;
    };
  }, []); // intentionally run once — this is an uncontrolled editor

  return (
    <>
      <div ref={mountRef} className="cc-quill-mount" />
      {/* attachEmojiPicker builds the button imperatively (outside React,
          alongside Quill's own toolbar DOM) — portal the S2 icon into it. */}
      {emojiBtn && createPortal(<EmojiIcon aria-hidden UNSAFE_className="cc-emoji-icon" />, emojiBtn)}
    </>
  );
});

export default QuillEditor;
