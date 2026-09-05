import { describe, it } from 'node:test';
import assert from 'node:assert';

/**
 * The HTML-to-text extractor behind Admin -> "autofill metadata from a URL".
 *
 * Its output becomes the suggestion an admin sees in the item form, so a
 * sloppy strip shows up as junk in a version field. The naive `/<[^>]+>/`
 * version of this had two holes worth pinning down: a `>` inside a quoted
 * attribute ended the tag early, and an unterminated <script> left its source
 * behind as if it were prose.
 */

const { stripTags } = await import('../src/services/metadataAutofillService.js');

describe('stripTags', () => {
  it('keeps prose and drops markup', () => {
    assert.equal(stripTags('<p>Hello <b>world</b></p>'), 'Hello world');
    assert.equal(stripTags('plain text'), 'plain text');
    assert.equal(stripTags(''), '');
  });

  it('keeps a quoted ">" inside the tag it belongs to', () => {
    assert.equal(stripTags('<a title="a>b">Ubuntu 24.04</a>'), 'Ubuntu 24.04');
    assert.equal(stripTags("<img alt='x>y' src=a.png>1.2.3"), '1.2.3');
  });

  it('does not treat an unterminated <script> body as text', () => {
    assert.equal(stripTags('<p>1.0</p><script>var marker = "<b>";'), '1.0');
    assert.equal(stripTags('<style>body{color:red}</style>2.0'), '2.0');
  });

  it('drops comments before scanning for tags', () => {
    assert.equal(stripTags('<!-- a > b -->Ubuntu'), 'Ubuntu');
  });

  it('decodes entities after stripping, so they are not re-parsed', () => {
    assert.equal(stripTags('<p>&lt;b&gt;bold&lt;/b&gt;</p>'), '<b>bold</b>');
  });

  it('collapses whitespace', () => {
    assert.equal(stripTags('<h1>\n  Ubuntu\n  24.04 \n</h1>'), 'Ubuntu 24.04');
  });

  it('stays linear on hostile input', () => {
    const cases = [
      '<' + 'a'.repeat(200000), // one unterminated tag
      '<a '.repeat(50000) + '>tail', // thousands of them
      '<a href="' + 'x'.repeat(200000), // an unterminated attribute
    ];
    const started = Date.now();
    for (const input of cases) stripTags(input);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `took ${elapsed}ms`);

    assert.equal(stripTags('<' + 'a'.repeat(100)), '', 'an unterminated tag swallows its text, as a browser would');
    assert.equal(stripTags('<a '.repeat(3) + '>tail'), 'tail', 'text after the tags survives');
  });
});
