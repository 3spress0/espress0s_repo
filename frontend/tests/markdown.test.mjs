import { test } from 'node:test';
import assert from 'node:assert';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMarkdown } from '../src/lib/markdown-core.js';

/**
 * The markdown renderer Barista answers and admin page bodies share.
 *
 * The core lives in a plain .js file (React elements via createElement, no
 * JSX) so this runs under bare `node --test` - no build step, no DOM. The
 * assertions are written against renderToStaticMarkup output: if a test here
 * passes but the screen shows raw `**markdown**`, the bug is in what feeds
 * this, not in this.
 */

const render = (md) => renderToStaticMarkup(createElement(Fragment, null, ...renderMarkdown(md)));

test('paragraphs: bold, italic and inline code render as elements', () => {
  const html = render('a **b** *c* `d` e');
  assert.match(html, /<strong[^>]*>b<\/strong>/);
  assert.match(html, /<em[^>]*>c<\/em>/);
  assert.match(html, /<code[^>]*>d<\/code>/);
});

test('headings, rules and blockquotes become block elements', () => {
  const html = render('# Title\n\n> quoted **text**\n\n---');
  assert.match(html, /<h2[^>]*>Title<\/h2>/);
  assert.match(html, /<blockquote[^>]*>quoted <strong[^>]*>text<\/strong><\/blockquote>/);
  assert.match(html, /<hr[^>]*\/>/);
});

test('fenced code keeps content literal - no markdown, no markup', () => {
  const html = render('```\n**not bold** <b>not bold</b>\n```');
  assert.match(html, /<pre[^>]*><code[^>]*>\*\*not bold\*\* &lt;b&gt;not bold&lt;\/b&gt;/);
});

test('a markdown link to a repo path is an anchor; an unsafe one loses its href', () => {
  const ok = render('[Ubuntu 24.04](/file/ubuntu-24-04)');
  assert.match(ok, /<a href="\/file\/ubuntu-24-04"[^>]*>Ubuntu 24\.04<\/a>/);
  assert.ok(!ok.includes('target="_blank"'), 'relative links stay in this tab');

  const evil = render('[click](javascript:alert(1))');
  assert.ok(!evil.includes('<a'), 'no anchor is emitted for an unsafe target');
  assert.match(evil, /click/, 'but the label text survives');
});

test('a bare http URL is linked with target _blank', () => {
  const html = render('see https://example.com/a.zip for more');
  assert.match(html, /<a href="https:\/\/example\.com\/a\.zip" target="_blank"/);
});

test('a bare /file/slug path is linked too (the fallback emits "View details: /file/x")', () => {
  const html = render('View details: /file/ubuntu-24-04');
  assert.match(html, /<a href="\/file\/ubuntu-24-04"[^>]*>\/file\/ubuntu-24-04<\/a>/);
  assert.ok(!html.includes('target'), 'and not in a new tab');
});

test('a link wrapped in bold still renders - the deterministic fallback format', () => {
  const html = render('**[Ubuntu 24.04 LTS](/file/ubuntu-24-04-lts)** - the current release');
  assert.match(html, /<strong[^>]*><a href="\/file\/ubuntu-24-04-lts"[^>]*>Ubuntu 24\.04 LTS<\/a><\/strong>/);
});

test('indented continuation lines stay inside their list item (Version/Platform lines)', () => {
  const md = [
    '- **[Ubuntu 24.04](/file/ubuntu-24-04)** - LTS release',
    '  Version: 24.04 | PC x86_64 | 4.7 MB',
    '',
    '- **[Debian 13](/file/debian-13)** - stable',
    '  Version: 13.1 | PC x86_64 | 3.9 MB',
  ].join('\n');
  const html = render(md);
  const items = html.match(/<li[^>]*>.*?<\/li>/gs);
  assert.ok(items, 'a list was rendered');
  assert.equal(items.length, 2, 'one item per bullet, not one per line');
  assert.match(items[0], /Version: 24\.04 \| PC x86_64 \| 4\.7 MB/);
  assert.match(items[0], /<a href="\/file\/ubuntu-24-04"[^>]*>/);
});

test('ordered lists render as <ol> with their items', () => {
  const html = render('1. first **thing**\n2. second');
  assert.match(html, /<ol[^>]*>/);
  assert.match(html, /<li[^>]*>first <strong[^>]*>thing<\/strong><\/li>/);
  assert.match(html, /<li[^>]*>second<\/li>/);
});

test('a paragraph breaks at a list without a blank line (fallback "Other related files:")', () => {
  const html = render('Other related files:\n- [A](/file/a)\n- [B](/file/b)');
  assert.match(html, /<p[^>]*>Other related files:<\/p><ul/);
});

test('markup in the input is text, never DOM - no HTML strings anywhere', () => {
  const html = render('<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>');
  assert.ok(!html.includes('<img'), 'the img tag stays text');
  assert.ok(!html.includes('<script'), 'the script tag stays text');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('empty and whitespace-only input render nothing', () => {
  assert.deepEqual(renderMarkdown(''), []);
  assert.deepEqual(renderMarkdown('   \n\n  '), []);
});
