import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isBlockedIp, assertPublicUrl, UnsafeUrlError } from '../src/lib/safeFetch.js';

/**
 * SSRF guard tests. Deliberately dependency-free (no database, no native
 * modules) so they run anywhere with:
 *   node --test tests/ssrf.test.js
 */

describe('isBlockedIp', () => {
  const blocked = [
    '0.0.0.0', '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '2002::1',
  ];
  const allowed = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111'];

  for (const ip of blocked) {
    it(`blocks ${ip}`, () => assert.equal(isBlockedIp(ip), true));
  }
  for (const ip of allowed) {
    it(`allows ${ip}`, () => assert.equal(isBlockedIp(ip), false));
  }
  it('rejects non-IP input', () => assert.equal(isBlockedIp('not-an-ip'), true));
});

describe('assertPublicUrl', () => {
  const rejected = [
    ['non-http scheme', 'file:///etc/passwd'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['loopback literal', 'http://127.0.0.1:8080/admin'],
    ['loopback name', 'https://localhost/secret'],
    ['ipv6 loopback', 'http://[::1]/'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['private range', 'http://192.168.0.10/'],
    ['credentials in url', 'https://user:pass@example.com/'],
    ['blocked port', 'https://example.com:22/x'],
    ['internal tld', 'https://db.internal/dump'],
    ['garbage', 'not a url at all'],
  ];

  for (const [label, url] of rejected) {
    it(`rejects ${label}`, async () => {
      await assert.rejects(() => assertPublicUrl(url), UnsafeUrlError);
    });
  }
});
