import { test } from 'node:test';
import assert from 'node:assert';
import { proxyImageUrl } from '../src/lib/imageProxy.js';

/**
 * proxyImageUrl decides whether an image URL reaches the browser as-is or is
 * routed through the backend's cookieless proxy. The invariant the tests pin
 * down: anything that would make the visitor's browser talk to a third party
 * comes back wrapped; everything else is untouched.
 */

const OUR_ORIGIN = 'https://repo.example.test';

function withOrigin(origin, fn) {
  const had = globalThis.window;
  globalThis.window = { location: { origin } };
  try {
    fn();
  } finally {
    if (had === undefined) delete globalThis.window;
    else globalThis.window = had;
  }
}

test('cross-origin http(s) URLs are proxied', () => {
  withOrigin(OUR_ORIGIN, () => {
    assert.equal(
      proxyImageUrl('https://cdn.jsdelivr.net/gh/foo/bar/icon.png'),
      '/api/media/image?u=' + encodeURIComponent('https://cdn.jsdelivr.net/gh/foo/bar/icon.png'),
    );
    assert.equal(
      proxyImageUrl('http://upload.wikimedia.org/w/cover.jpg'),
      '/api/media/image?u=' + encodeURIComponent('http://upload.wikimedia.org/w/cover.jpg'),
    );
  });
});

test('URLs carrying query strings survive intact through encodeURIComponent', () => {
  withOrigin(OUR_ORIGIN, () => {
    const url = 'https://img.example.com/a.png?x=1&y=2&lang=en#frag';
    assert.equal(proxyImageUrl(url), '/api/media/image?u=' + encodeURIComponent(url));
  });
});

test('same-origin, relative and non-http URLs pass through untouched', () => {
  withOrigin(OUR_ORIGIN, () => {
    assert.equal(proxyImageUrl(OUR_ORIGIN + '/cover.png'), OUR_ORIGIN + '/cover.png');
    assert.equal(proxyImageUrl('/api/uploads/abc.png'), '/api/uploads/abc.png');
    assert.equal(proxyImageUrl('cover.png'), 'cover.png');
    assert.equal(proxyImageUrl('data:image/png;base64,iVBORw0KGgo='), 'data:image/png;base64,iVBORw0KGgo=');
    assert.equal(proxyImageUrl('blob:https://repo.example.test/uuid'), 'blob:https://repo.example.test/uuid');
  });
});

test('junk and empty input is handed back unchanged, never proxied', () => {
  withOrigin(OUR_ORIGIN, () => {
    assert.equal(proxyImageUrl(''), '');
    assert.equal(proxyImageUrl(null), null);
    assert.equal(proxyImageUrl(undefined), undefined);
    assert.equal(proxyImageUrl('javascript:alert(1)'), 'javascript:alert(1)', 'non-http: the <img> cannot load it, the proxy must not fetch it');
    // Not parseable as a URL: returned as-is for the <img> onError path.
    assert.equal(proxyImageUrl('https://spaces in url'), 'https://spaces in url');
  });
});

test('without a browser origin (SSR-ish context) absolute URLs are proxied', () => {
  // window is undefined here: better to proxy everything than to leak.
  assert.equal(
    proxyImageUrl('https://cdn.jsdelivr.net/icon.png'),
    '/api/media/image?u=' + encodeURIComponent('https://cdn.jsdelivr.net/icon.png'),
  );
});
