import { describe, it } from 'node:test';
import assert from 'node:assert';

import { footerVersionLabel } from '../src/lib/footerVersion.js';

/**
 * The version stamp visitors see at the bottom of every page.
 *
 * The component just prints whatever this returns, which is what keeps the
 * three cases apart: turned off, no version to name, and a version to show.
 * The interesting failure mode is the middle one - a footer reading "v" with
 * nothing after it - so the empty inputs are the point of the test.
 * backend/tests/footerVersion.test.js covers the other side: the setting
 * existing, defaulting to on, and the server actually reporting a number.
 */

describe('footer version label', () => {
  it('prints the version the server reported', () => {
    assert.equal(footerVersionLabel({ app: { version: '1.0.0' }, showVersion: true }), 'v1.0.0');
  });

  it('says nothing when the admin turned it off', () => {
    assert.equal(footerVersionLabel({ app: { version: '1.0.0' }, showVersion: false }), null);
    assert.equal(footerVersionLabel({ app: {}, showVersion: false }), null);
  });

  it('says nothing rather than "v" when the build has no version', () => {
    // APP_VERSION is null without a readable manifest, and there is no `app`
    // block at all when the settings request failed and the site is on
    // fallbacks. Both must degrade to no stamp, not a lonely "v".
    for (const app of [undefined, null, {}, { version: null }, { version: '' }, { version: '   ' }]) {
      assert.equal(footerVersionLabel({ app, showVersion: true }), null);
    }
  });

  it('does not double-prefix a version that already carries one', () => {
    assert.equal(footerVersionLabel({ app: { version: 'v1.0.0' }, showVersion: true }), 'v1.0.0');
    assert.equal(footerVersionLabel({ app: { version: 'V2.1' }, showVersion: true }), 'V2.1');
    assert.equal(footerVersionLabel({ app: { version: ' 1.2.3-rc1 ' }, showVersion: true }), 'v1.2.3-rc1');
  });
});
