import { describe, it } from 'node:test';
import assert from 'node:assert';

/**
 * Provider resolution: what .env, the admin settings table and the tgpt probe
 * turn into at runtime. Pure - no database, no network - because the whole
 * point of the layer is the precedence rules, and those are testable without
 * either.
 */

const KEY = 'AIzaSyTestKeyNotReal0123456789';

function env(partial = {}) {
  return {
    enabled: true,
    provider: 'auto',
    format: '',
    model: '',
    baseUrl: '',
    apiKey: '',
    temperature: 0.2,
    maxTokens: 1024,
    timeoutMs: 20000,
    draftTimeoutMs: 30000,
    allowPrivateBaseUrl: false,
    tgpt: { binaryPath: '/usr/local/bin/tgpt', provider: '', model: '' },
    ...partial,
  };
}

async function decide(partialEnv = {}, { settings = {}, ...opts } = {}) {
  const { decide: run } = await import('../src/services/aiConfig.js');
  const read = (key) => (key in settings ? settings[key] : null);
  return run({ env: env(partialEnv), settings: read, ...opts });
}

describe('provider resolution', () => {
  it('auto selects gemini when a key exists, with a usable model', async () => {
    const r = await decide({ apiKey: KEY });
    assert.equal(r.provider, 'gemini');
    assert.equal(r.format, 'gemini', 'the wire format follows the provider');
    assert.equal(r.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
    assert.equal(r.baseUrlIsDefault, true);
    assert.equal(r.model, 'gemini-2.5-flash', 'never an empty model: a default that exists beats one that does not');
    assert.equal(r.keyConfigured, true);
  });

  it('auto falls back to tgpt with no key, and to nothing with neither', async () => {
    assert.equal((await decide({}, { tgptAvailable: true })).provider, 'tgpt');
    assert.equal((await decide({}, { tgptAvailable: true })).format, 'tgpt');
    const none = await decide({}, { tgptAvailable: false });
    assert.equal(none.provider, 'none');
    assert.equal(none.format, 'none');
  });

  it('an explicit key-backed provider without a key degrades, it does not 401 forever', async () => {
    const withTgpt = await decide({ provider: 'gemini' }, { tgptAvailable: true });
    assert.equal(withTgpt.provider, 'tgpt');
    assert.match(withTgpt.notes.join(' '), /needs AI_API_KEY/);

    const without = await decide({ provider: 'gemini' }, { tgptAvailable: false });
    assert.equal(without.provider, 'none');
    assert.match(without.notes.join(' '), /metadata search/);
  });

  it('openai means a chat/completions endpoint and refuses to invent a model', async () => {
    const r = await decide({ provider: 'openai' });
    assert.equal(r.format, 'openai');
    assert.equal(r.baseUrl, 'https://api.openai.com/v1', 'the openai default, not the gemini one');
    assert.equal(r.model, '', 'a model name for someone else\'s endpoint has to come from the operator');

    const local = await decide({ provider: 'openai', model: 'llama3.1:8b', baseUrl: 'http://127.0.0.1:11434/v1' });
    assert.equal(local.model, 'llama3.1:8b');
    assert.equal(local.baseUrlIsDefault, false, 'so the transport knows to validate it');
  });

  it('the admin table overrides .env per key, and empty values defer to it', async () => {
    const r = await decide(
      { provider: 'tgpt', model: 'gemini-2.5-flash', apiKey: KEY },
      { settings: { ai_provider: 'gemini', ai_model: '', ai_format: 'gemini' } }
    );
    assert.equal(r.provider, 'gemini', 'a Settings change must beat a stale .env');
    assert.equal(r.model, 'gemini-2.5-flash', 'an empty setting falls through to .env instead of clearing it');
  });

  it('the Settings toggle turns AI off, but cannot overrule the env kill switch', async () => {
    assert.equal((await decide({ apiKey: KEY }, { settings: { ai_enabled: false } })).enabled, false);
    assert.equal((await decide({ enabled: false, apiKey: KEY }, { settings: { ai_enabled: true } })).enabled, false,
      'AI_ENABLED=false is the deployment owner saying no; a browser-side toggle must not undo that');
  });

  it('timeouts stay under the browser budget however they are set', async () => {
    const r = await decide({ timeoutMs: 90000, draftTimeoutMs: 120000 });
    assert.equal(r.timeoutMs, 55000, 'above the client budget the fallback answer never arrives');
    assert.equal(r.draftTimeoutMs, 55000);
    assert.match(r.notes.join(' '), /clamped/);

    const garbage = await decide({}, { settings: { ai_timeout_ms: 'soon' } });
    assert.equal(garbage.timeoutMs, 20000, 'an unparseable number falls back instead of disabling the timeout');
  });

  it('tgpt keeps its own sub-provider, model and discovered binary', async () => {
    const r = await decide(
      { provider: 'tgpt', tgpt: { binaryPath: '/usr/local/bin/tgpt', provider: 'phind', model: 'gpt-4o-mini' } },
      { settings: { ai_tgpt_provider: 'openrouter' }, tgptAvailable: true, tgptBinary: '/home/me/go/bin/tgpt' }
    );
    assert.equal(r.tgpt.provider, 'phind', 'the .env sub-provider is what the CLI is actually running with');
    assert.equal(r.tgpt.model, 'gpt-4o-mini');
    assert.equal(r.tgpt.binary, '/home/me/go/bin/tgpt', 'the binary the probe found beats the configured path');
    assert.equal(r.model, '', 'tgpt takes no top-level model');
  });

  it('describes itself for the public status endpoint without leaking internals', async () => {
    const { describeAi, describeAiForAdmin } = await import('../src/services/aiConfig.js');
    const r = await decide({ apiKey: KEY, baseUrl: 'http://127.0.0.1:11434/v1' });
    const pub = describeAi(r);
    assert.deepEqual(Object.keys(pub).sort(), ['enabled', 'fallback', 'model', 'provider', 'ready']);
    assert.ok(!JSON.stringify(pub).includes(KEY));
    assert.ok(!JSON.stringify(pub).includes('127.0.0.1'), 'the public view must not disclose the endpoint');

    const admin = describeAiForAdmin(r, 'tgpt timed out');
    assert.equal(admin.baseUrl, 'http://127.0.0.1:11434/v1');
    assert.match(admin.keyHint, /never stored in the database/);
    assert.ok(!JSON.stringify(admin).includes(KEY), 'even the admin view must not echo the key');
    assert.equal(admin.error, 'tgpt timed out');
  });
});
