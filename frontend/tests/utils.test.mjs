import { test } from 'node:test';
import assert from 'node:assert';
import { safeHref, formatBytes, formatDate, formatRelativeTime, cn, describeUrl } from '../src/lib/utils.js';

/**
 * The pure helpers the UI leans on. `safeHref` in particular is a security
 * boundary - it is what stands between an admin-authored URL in the database
 * and a `javascript:` navigation in the visitor's origin - so it is worth
 * pinning down with tests rather than trusting a grep.
 */

test('safeHref accepts http(s), app-relative, mailto, hash and magnet links', () => {
  assert.equal(safeHref('https://example.com/a.zip'), 'https://example.com/a.zip');
  assert.equal(safeHref('http://example.com'), 'http://example.com');
  assert.equal(safeHref('/browse?q=linux'), '/browse?q=linux');
  assert.equal(safeHref('#top'), '#top');
  assert.equal(safeHref('mailto:me@example.com'), 'mailto:me@example.com');
  assert.equal(safeHref('magnet:?xt=urn:btih:' + 'a'.repeat(40)), 'magnet:?xt=urn:btih:' + 'a'.repeat(40));
});

test('safeHref rejects scriptable schemes and control-character tricks', () => {
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('JaVaScRiPt:alert(1)'), null, 'the scheme test is case-insensitive');
  assert.equal(safeHref('java\nscript:alert(1)'), null, 'a newline inside the scheme must not slip through');
  assert.equal(safeHref('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(safeHref('vbscript:msgbox(1)'), null);
  assert.equal(safeHref(''), null);
  assert.equal(safeHref(null), null);
  assert.equal(safeHref(undefined), null);
  assert.equal(safeHref('   '), null, 'whitespace-only is empty');
});

test('safeHref trims surrounding whitespace', () => {
  assert.equal(safeHref('  https://example.com  '), 'https://example.com');
});

test('formatBytes renders binary units and handles the empty cases', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(null), '0 B');
  assert.equal(formatBytes(undefined), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5 MB');
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3 GB');
});

test('formatDate falls back to an em dash and never throws', () => {
  assert.equal(formatDate(''), '—');
  assert.equal(formatDate(null), '—');
  assert.equal(formatDate('2024-01-05T00:00:00Z'), new Date('2024-01-05T00:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }));
  assert.equal(formatDate('not a date'), 'Invalid Date', 'an unparseable string yields Invalid Date rather than throwing');
});

test('formatRelativeTime buckets by day, week, month and year', () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  assert.equal(formatRelativeTime(''), '');
  assert.equal(formatRelativeTime(daysAgo(0)), 'Today');
  assert.equal(formatRelativeTime(daysAgo(1)), 'Yesterday');
  assert.equal(formatRelativeTime(daysAgo(3)), '3d ago');
  assert.equal(formatRelativeTime(daysAgo(10)), '1w ago');
  assert.equal(formatRelativeTime(daysAgo(45)), '1mo ago');
  assert.equal(formatRelativeTime(daysAgo(400)), '1y ago');
});

test('cn joins truthy class names only', () => {
  assert.equal(cn('a', false, 'b', null, undefined, 'c'), 'a b c');
  assert.equal(cn({ a: true, b: false }, 'c'), 'a c');
});

test('describeUrl recognises a provider from the host itself, not from a substring', () => {
  assert.equal(
    describeUrl('https://github.com/espress0/repo/releases/download/v1.0/x.iso')?.provider,
    'github'
  );
  assert.equal(
    describeUrl('https://raw.githubusercontent.com/espress0/repo/main/x.iso')?.provider,
    'github'
  );
  assert.equal(describeUrl('https://drive.google.com/file/d/0Babcdefghijklmn/view')?.provider, 'gdrive');
  assert.equal(describeUrl('https://1drv.ms/u/s!AbCdEfGhIjK')?.provider, 'onedrive');
  assert.equal(describeUrl('https://mirror.example.org/ubuntu-24.04.iso.torrent')?.provider, 'torrent');
});

test('describeUrl does not mistake a lookalike host for a known provider', () => {
  for (const url of [
    'https://github.com.attacker.example/x.iso',
    'https://drive.google.com.evil.test/x.iso',
    'https://1drv.ms.evil.test/x.iso',
  ]) {
    assert.equal(describeUrl(url)?.provider, 'external', url);
  }
});

test('describeUrl only accepts parseable http(s) input', () => {
  assert.equal(describeUrl(''), null);
  assert.equal(describeUrl('javascript:alert(1)'), null);
  assert.equal(describeUrl('file:///etc/passwd'), null);
  assert.equal(describeUrl('not a url at all'), null);
});
