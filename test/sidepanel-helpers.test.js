/**
 * Pure helpers from sidepanel.jsx.
 *
 * Scope note: importing sidepanel.jsx runs its module-scope
 * `createRoot(...).render(<App/>)` bootstrap (see test/setup.js for why that's
 * harmless here). The S2 component tree is deliberately out of scope — these
 * tests target the logic that can break silently, especially where it sits on
 * top of @adobe/annotations-core.
 *
 * highlightMentionsHtml gets the most attention because it is the one place
 * this extension rewrites already-sanitized HTML. It runs AFTER
 * sanitizeHtml, so a regex that strayed into attribute values or re-parsed
 * unsafely would reintroduce the stored-XSS surface the core sanitizer closed.
 */

import { describe, expect, test, vi, afterEach } from 'vitest';
import {
  findMentionQuery, highlightMentionsHtml, initials, isMyComment,
  myAuthorName, relTime, statusBadgeVariant, statusLabel,
} from '../src/sidepanel.jsx';
import { STATUS_BADGE_VARIANT } from '@adobe/annotations-core/colors';

afterEach(() => { vi.useRealTimers(); });

// ── Shared-core integration ─────────────────────────────────────────────────

describe('status vocabulary agrees with annotations-core', () => {
  test('statusBadgeVariant delegates to the shared map', () => {
    // Both clients used to keep their own copy of this mapping.
    for (const [status, variant] of Object.entries(STATUS_BADGE_VARIANT)) {
      expect(statusBadgeVariant(status)).toBe(variant);
    }
  });

  test('an unknown status falls back to the open variant, never undefined', () => {
    expect(statusBadgeVariant('not_a_status')).toBe(STATUS_BADGE_VARIANT.open);
    expect(statusBadgeVariant(undefined)).toBe(STATUS_BADGE_VARIANT.open);
  });

  test('statusLabel covers every status the shared map defines', () => {
    // Guards against a status being added to core while this label switch
    // silently keeps calling it "Open".
    expect(statusLabel('open')).toBe('Open');
    expect(statusLabel('in_progress')).toBe('In progress');
    expect(statusLabel('resolved')).toBe('Resolved');
    for (const status of Object.keys(STATUS_BADGE_VARIANT)) {
      expect(statusLabel(status)).not.toBe(undefined);
    }
  });

  test('a null status reads as Open', () => {
    expect(statusLabel(null)).toBe('Open');
    expect(statusLabel(undefined)).toBe('Open');
  });
});

// ── highlightMentionsHtml — runs on sanitized HTML ──────────────────────────

describe('highlightMentionsHtml', () => {
  test('wraps a matched mention in a highlight span', () => {
    const out = highlightMentionsHtml('<p>hi @Alice Smith</p>', [{ name: 'Alice Smith' }]);
    expect(out).toContain('<span class="cc-mention">@Alice Smith</span>');
  });

  test('leaves the body untouched when there are no mentions', () => {
    const html = '<p>plain body</p>';
    expect(highlightMentionsHtml(html, [])).toBe(html);
    expect(highlightMentionsHtml(html, null)).toBe(html);
    expect(highlightMentionsHtml(html, undefined)).toBe(html);
  });

  test('does NOT match a bare @ that is not in the mentions list', () => {
    // Matching is driven by comment.mentions, not raw "@" text, so an email or
    // a stray @ in prose is never styled as a mention.
    const out = highlightMentionsHtml('<p>email me @ bob@x.test</p>', [{ name: 'Alice' }]);
    expect(out).not.toContain('cc-mention');
  });

  test('prefers the longest name so a shorter one cannot truncate it', () => {
    const out = highlightMentionsHtml(
      '<p>@Alice Reza reviewed</p>',
      [{ name: 'Alice' }, { name: 'Alice Reza' }],
    );
    expect(out).toContain('<span class="cc-mention">@Alice Reza</span>');
    // The short name must not have produced a nested/partial span.
    expect(out).not.toContain('>@Alice</span> Reza');
  });

  test('does not rewrite inside attribute values', () => {
    // The reason this walks text nodes instead of regexing the markup string:
    // a naive pass would corrupt this href and could inject markup.
    const html = '<p><a href="https://x.test/@Alice" target="_blank" rel="noopener noreferrer">link</a></p>';
    const out = highlightMentionsHtml(html, [{ name: 'Alice' }]);
    expect(out).toContain('href="https://x.test/@Alice"');
    expect(out).not.toContain('<span class="cc-mention">@Alice</span>"');
  });

  test('inserts the matched mention as TEXT, so a markup-bearing name cannot inject', () => {
    // A mention name is server-supplied but human-authored. The highlight span
    // is built with span.textContent (not innerHTML), so a name whose characters
    // look like markup is escaped on the way in.
    //
    // The name must appear as literal TEXT in the body for the matcher to see
    // it (the body is parsed first, so real tags are never contiguous text) —
    // hence the escaped body here, which is exactly what sanitizeHtml would
    // have produced for a comment mentioning this user.
    const name = '<script>x</script>';
    const out = highlightMentionsHtml('<p>hi @&lt;script&gt;x&lt;/script&gt;</p>', [{ name }]);
    expect(out).toContain('cc-mention');
    // Still escaped after the rewrite — never re-parsed into a live element.
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<script>');
  });

  test('does not introduce new markup into an already-sanitized body', () => {
    // Real pipeline: sanitizeHtml runs FIRST, so by the time this function sees
    // a body there is no live handler left. What matters here is that the
    // rewrite adds only <span class="cc-mention"> and nothing else.
    const sanitized = '<p>hi @Alice <a href="https://x.test" target="_blank" rel="noopener noreferrer">l</a></p>';
    const out = highlightMentionsHtml(sanitized, [{ name: 'Alice' }]);
    const addedTags = out.match(/<[a-z]+/g).filter((t) => !sanitized.includes(t) || t === '<span');
    expect(new Set(addedTags)).toEqual(new Set(['<span']));
    expect(out).not.toContain('onerror');
  });

  test('regex metacharacters in a name are escaped, not interpreted', () => {
    // An unescaped "." or "(" would either throw or match the wrong text.
    expect(() => highlightMentionsHtml('<p>@A.B (C)</p>', [{ name: 'A.B (C)' }])).not.toThrow();
    const out = highlightMentionsHtml('<p>@A.B (C)</p>', [{ name: 'A.B (C)' }]);
    expect(out).toContain('cc-mention');
    // A literal-dot match must not also match "AxB".
    expect(highlightMentionsHtml('<p>@AxB</p>', [{ name: 'A.B' }])).not.toContain('cc-mention');
  });

  test('highlights every occurrence, not just the first', () => {
    const out = highlightMentionsHtml('<p>@Bob and @Bob again</p>', [{ name: 'Bob' }]);
    expect(out.match(/cc-mention/g)).toHaveLength(2);
  });

  test('handles multiple distinct mentions in one body', () => {
    const out = highlightMentionsHtml('<p>@Alice @Bob</p>', [{ name: 'Alice' }, { name: 'Bob' }]);
    expect(out.match(/cc-mention/g)).toHaveLength(2);
  });

  test('ignores mentions with a blank or missing name', () => {
    expect(highlightMentionsHtml('<p>@x</p>', [{ name: '  ' }, {}])).toBe('<p>@x</p>');
  });

  test('an empty body is returned as-is', () => {
    expect(highlightMentionsHtml('', [{ name: 'Alice' }])).toBe('');
  });

  test('preserves an inline image while highlighting around it', () => {
    const html = '<p>@Alice <img src="data:image/png;base64,iVBORw0KGgo="></p>';
    const out = highlightMentionsHtml(html, [{ name: 'Alice' }]);
    expect(out).toContain('cc-mention');
    expect(out).toContain('data:image/png;base64,iVBORw0KGgo=');
  });
});

// ── findMentionQuery — drives the picker against Quill's index space ─────────

describe('findMentionQuery', () => {
  test('finds an @query at the caret', () => {
    expect(findMentionQuery('hi @al', 6)).toEqual({ query: 'al', start: 3 });
  });

  test('a bare @ opens the picker with an empty query', () => {
    expect(findMentionQuery('hi @', 4)).toEqual({ query: '', start: 3 });
  });

  test('an @ at the very start of the body counts', () => {
    expect(findMentionQuery('@bo', 3)).toEqual({ query: 'bo', start: 0 });
  });

  test('a null caret (editor blurred) yields no query', () => {
    expect(findMentionQuery('hi @al', null)).toBeNull();
    expect(findMentionQuery('hi @al', undefined)).toBeNull();
  });

  test('mid-word @ (like an email) does NOT open the picker', () => {
    // Requires whitespace before the @, so "bob@x.test" never triggers it.
    expect(findMentionQuery('bob@x', 5)).toBeNull();
  });

  test('whitespace after the @query closes it', () => {
    expect(findMentionQuery('hi @al ', 7)).toBeNull();
  });

  test('a second @ inside the query closes it', () => {
    expect(findMentionQuery('hi @al@', 7)).toBeNull();
  });

  test('only text BEFORE the caret is considered', () => {
    // Caret sits before the @, so there is no active query yet.
    expect(findMentionQuery('hi @alice', 2)).toBeNull();
  });

  test('the returned start index is usable with QuillEditor.replaceRange', () => {
    const text = 'please review @ali';
    const found = findMentionQuery(text, text.length);
    // start..caret is exactly the span the picker replaces with the full name.
    expect(text.slice(found.start, text.length)).toBe('@ali');
  });
});

// ── Identity helpers ────────────────────────────────────────────────────────

describe('myAuthorName / isMyComment', () => {
  test('prefers the display name, falling back to email', () => {
    expect(myAuthorName({ name: 'Jane Doe', email: 'j@adobe.com' })).toBe('Jane Doe');
    expect(myAuthorName({ email: 'j@adobe.com' })).toBe('j@adobe.com');
    expect(myAuthorName(null)).toBeNull();
  });

  test('matches a comment authored under the same display name', () => {
    const profile = { name: 'Jane Doe' };
    expect(isMyComment({ author_name: 'Jane Doe' }, profile)).toBe(true);
    expect(isMyComment({ author_name: 'Someone Else' }, profile)).toBe(false);
  });

  test('a signed-out user owns nothing', () => {
    // Guards the case where a null author_name would otherwise "match" a null
    // profile name and expose edit/delete on every comment.
    expect(isMyComment({ author_name: null }, null)).toBe(false);
    expect(isMyComment({ author_name: null }, {})).toBe(false);
  });

  test('is a courtesy guard only — identical display names collide', () => {
    // Documented limitation, asserted so nobody mistakes it for authorization:
    // the backend does not enforce ownership.
    expect(isMyComment({ author_name: 'Jane Doe' }, { name: 'Jane Doe' })).toBe(true);
  });
});

describe('initials', () => {
  test('prefers structured first/last name parts', () => {
    expect(initials({ first: 'Jane', last: 'Doe', name: 'Ignored Name' })).toBe('JD');
  });

  test('falls back to splitting the display name', () => {
    expect(initials({ name: 'Jane Doe' })).toBe('JD');
    expect(initials({ name: 'Jane Van Der Doe' })).toBe('JD'); // first + last
  });

  test('a single-word name yields its first two letters', () => {
    expect(initials({ name: 'Prince' })).toBe('PR');
  });

  test('falls back to the email local part', () => {
    expect(initials({ email: 'jdoe@adobe.com' })).toBe('JD');
  });

  test('an empty profile yields ? rather than throwing', () => {
    expect(initials(null)).toBe('?');
    expect(initials({})).toBe('?');
  });
});

describe('relTime', () => {
  test('renders each bucket relative to now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T12:00:00Z'));
    expect(relTime('2026-07-28T11:59:30Z')).toBe('just now');
    expect(relTime('2026-07-28T11:30:00Z')).toBe('30m ago');
    expect(relTime('2026-07-28T09:00:00Z')).toBe('3h ago');
    expect(relTime('2026-07-26T12:00:00Z')).toBe('2d ago');
  });
});
