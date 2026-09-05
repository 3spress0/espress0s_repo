import { describe, it, after } from 'node:test';
import assert from 'node:assert';

/**
 * CAPTCHA provider dispatch.
 *
 * `verifyWithType` used to read `if (type === 'turnstile' && payload.token)`,
 * so a request that simply omitted `token` skipped the provider the operator
 * configured and landed on the local math/SVG check instead. Whether the
 * configured check runs must not depend on a field the client controls.
 */

// setup.mjs (loaded by `npm test`) has already pointed DATABASE_PATH at a
// throwaway database, so importing the modules below is safe.
const { captchaService } = await import('../src/services/captchaService.js');

const configuredType = captchaService.type;
// No secrets are configured under tests/setup.mjs, so reaching the provider is
// visible as its "not configured" answer rather than a network call.
const noSecret = (message) => ({ success: false, message });

describe('verifyWithType', () => {
  after(() => {
    captchaService.type = configuredType;
  });

  it('does not fall back to the local captcha when turnstile is configured', async () => {
    captchaService.type = 'turnstile';
    const result = await captchaService.verifyWithType({ id: 'x', answer: '1' }, '203.0.113.7');
    assert.notStrictEqual(result.message, 'CAPTCHA ID and answer required');
    assert.strictEqual(result.success, false);
  });

  it('answers a turnstile deployment with a missing token as a failure', async () => {
    captchaService.type = 'turnstile';
    assert.deepStrictEqual(
      await captchaService.verifyWithType({}, '203.0.113.7'),
      noSecret('Missing captcha token')
    );
  });

  it('routes a token to the turnstile provider', async () => {
    captchaService.type = 'turnstile';
    assert.deepStrictEqual(
      await captchaService.verifyWithType({ token: 'abc' }, '203.0.113.7'),
      noSecret('Turnstile not configured')
    );
  });

  it('answers an hcaptcha deployment with a missing token as a failure', async () => {
    captchaService.type = 'hcaptcha';
    assert.deepStrictEqual(
      await captchaService.verifyWithType({ id: 'x', answer: '1' }, '203.0.113.7'),
      noSecret('Missing captcha token')
    );
  });

  it('routes a token to the hcaptcha provider', async () => {
    captchaService.type = 'hcaptcha';
    assert.deepStrictEqual(
      await captchaService.verifyWithType({ token: 'abc' }, '203.0.113.7'),
      noSecret('hCaptcha not configured')
    );
  });

  it('still uses the local captcha for math and svg', async () => {
    for (const type of ['math', 'svg']) {
      captchaService.type = type;
      const issued = captchaService.generate();
      assert.strictEqual(issued.type, type);
      const record = captchaService.store.get(issued.id);
      const ok = await captchaService.verifyWithType({ id: issued.id, answer: String(record.answer) });
      assert.strictEqual(ok.success, true, `${type} round trip`);

      const second = captchaService.generate();
      const bad = await captchaService.verifyWithType({ id: second.id, answer: 'definitely-wrong' });
      assert.strictEqual(bad.success, false, `${type} wrong answer`);
      assert.match(bad.message, /Incorrect CAPTCHA/);
    }
  });
});
