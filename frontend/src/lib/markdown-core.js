/**
 * Tiny, dependency-free markdown renderer - the React-element core behind
 * `markdown.jsx`.
 *
 * This is where raw text becomes typed blocks: admin page bodies, Barista's
 * answers (it is prompted, and its deterministic fallback is built, in
 * markdown), and anything else routed through <Markdown>. Elements are built
 * directly - there is no HTML string anywhere in the pipeline, so raw
 * `<script>` in input is text, not markup. It lives here rather than in a
 * `.jsx` file so `node --test` can import it without a build (see
 * tests/markdown.test.mjs); react-dom/server renders the result in tests.
 *
 * Supported: #/##/### headings, - and * bullets (with indented continuation
 * lines merged into their item), 1. ordered lists, > quotes, ``` fenced code,
 * --- rules, tables are NOT supported, plus inline **bold**, *italic*,
 * `code`, [links](url), bare URLs, and bare repo links (/file/slug).
 */
import { createElement as h, Fragment } from 'react';
import { safeHref } from './utils.js';

/** Inline formatting -> array of React nodes. */
export function renderInline(text, keyPrefix = 'i') {
  const nodes = [];
  // Order matters: code first so ** inside backticks stays literal; the
  // markdown link before the bare /file/ path so "[x](/file/y)" links as a
  // unit; the http URL before it so "https://host/file/x" is one token.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\((?:[^()\s]|\([^()\s]*\))+\))|(https?:\/\/[^\s<>()]+)|(\/file\/[a-z0-9-]+)/g;

  let last = 0;
  let match;
  let n = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${n++}`;

    if (token.startsWith('`')) {
      nodes.push(
        h('code', { key, className: 'px-1.5 py-0.5 rounded bg-background border border-border text-[0.85em] font-mono text-primary' },
          token.slice(1, -1))
      );
    } else if (token.startsWith('**')) {
      // Recurse on the content: `**[Name](/file/slug)**` is exactly what the
      // deterministic fallback emits, and `[^*]+` in the pattern guarantees
      // no bold can remain inside, so this cannot loop.
      nodes.push(h('strong', { key, className: 'font-semibold text-textPrimary' }, renderInline(token.slice(2, -2), `${key}-b`)));
    } else if (token.startsWith('*')) {
      nodes.push(h('em', { key }, renderInline(token.slice(1, -1), `${key}-i`)));
    } else if (token.startsWith('[')) {
      const [, label, href] = token.match(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/) || [];
      const safe = safeHref(href);
      nodes.push(
        safe
          ? h('a', {
              key,
              href: safe,
              target: safe.startsWith('http') ? '_blank' : undefined,
              rel: 'noreferrer noopener',
              className: 'text-primary hover:underline break-words',
            }, label)
          // An unsafe target still shows the text it was wrapped around;
          // only the link goes away.
          : h(Fragment, { key }, label)
      );
    } else {
      // Bare http(s) URL or bare repo path (/file/slug). The answer
      // sanitizer rewrites repo links to the relative form on purpose, and
      // the deterministic fallback emits "View details: /file/slug", so the
      // bare path is linked too - in the same tab, never _blank.
      const safe = safeHref(token);
      if (!safe) {
        nodes.push(token);
      } else {
        nodes.push(
          h('a', {
            key,
            href: safe,
            target: token.startsWith('/') ? undefined : '_blank',
            rel: 'noreferrer noopener',
            className: 'text-primary hover:underline break-words',
          }, token)
        );
      }
    }

    last = match.index + token.length;
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** True when a line would open a block of its own (so it must not be swallowed as continuation text). */
function startsBlock(line) {
  return /^```|^#{1,4}\s|^>\s?|^\s*[-*+]\s+|^\s*\d+[.)]\s+/.test(line)
    || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

/**
 * Collect consecutive list items from `start`. An indented, non-block line
 * after an item belongs to it (wrapped prose, or the fallback answer's
 * "  Version: …" line) and is merged into the item's text.
 */
function collectListItems(lines, start, itemRe) {
  const items = [];
  let i = start;
  while (i < lines.length && itemRe.test(lines[i])) {
    let item = lines[i].replace(itemRe, '');
    i += 1;
    while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !startsBlock(lines[i])) {
      item += ' ' + lines[i].trim();
      i += 1;
    }
    items.push(item);
  }
  return { items, next: i };
}

/** Markdown source -> array of React block elements. */
export function renderMarkdown(source) {
  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];

  let i = 0;
  let key = 0;
  const k = () => `md-${key++}`;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code
    if (/^```/.test(line)) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1; // closing fence
      blocks.push(
        h('pre', { key: k(), className: 'my-3 p-3 rounded-xl bg-background border border-border overflow-x-auto' },
          h('code', { className: 'text-xs font-mono text-textSecondary whitespace-pre' }, body.join('\n')))
      );
      continue;
    }

    // Blank line
    if (!line.trim()) { i += 1; continue; }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(h('hr', { key: k(), className: 'my-5 border-white/10' }));
      i += 1;
      continue;
    }

    // Headings
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const content = renderInline(heading[2], k());
      const cls = {
        1: 'text-2xl font-bold text-textPrimary mt-6 mb-3 first:mt-0',
        2: 'text-lg font-bold text-textPrimary mt-6 mb-2 first:mt-0',
        3: 'text-base font-semibold text-textPrimary mt-5 mb-2 first:mt-0',
        4: 'text-sm font-semibold text-textSecondary uppercase tracking-widest mt-4 mb-2 first:mt-0',
      }[level];
      const Tag = `h${Math.min(level + 1, 6)}`;
      blocks.push(h(Tag, { key: k(), className: cls }, content));
      i += 1;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { body.push(lines[i].replace(/^>\s?/, '')); i += 1; }
      blocks.push(
        h('blockquote', { key: k(), className: 'my-3 pl-4 border-l-2 border-primary/40 text-sm text-textSecondary italic' },
          renderInline(body.join(' '), k()))
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const { items, next } = collectListItems(lines, i, /^\s*[-*+]\s+/);
      i = next;
      blocks.push(
        h('ul', { key: k(), className: 'my-3 space-y-1.5 list-disc list-outside pl-5 text-sm text-textSecondary marker:text-primary/70' },
          items.map((item, idx) => h('li', { key: idx }, renderInline(item, `${idx}`))))
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const { items, next } = collectListItems(lines, i, /^\s*\d+[.)]\s+/);
      i = next;
      blocks.push(
        h('ol', { key: k(), className: 'my-3 space-y-1.5 list-decimal list-outside pl-5 text-sm text-textSecondary marker:text-primary/70' },
          items.map((item, idx) => h('li', { key: idx }, renderInline(item, `${idx}`))))
      );
      continue;
    }

    // Paragraph: gather until a blank line or the start of another block
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !startsBlock(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push(
      h('p', { key: k(), className: 'my-3 text-sm text-textSecondary leading-relaxed first:mt-0' },
        renderInline(para.join(' '), k()))
    );
  }

  return blocks;
}
