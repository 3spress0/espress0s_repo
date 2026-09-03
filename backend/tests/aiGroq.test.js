import { after, describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';

/**
 * Regression for the production Groq configuration. The status endpoint used
 * to probe `tgpt --version` unconditionally before resolving AI_PROVIDER. A
 * broken tgpt executable could therefore hang both GET /api/ai/status and the
 * admin test before the configured OpenAI-compatible provider was ever used.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'espress0-groq-'));
const marker = path.join(tmp, 'tgpt-was-probed');
const unrelatedTgpt = path.join(tmp, 'tgpt');
fs.writeFileSync(unrelatedTgpt, [
  '#!/bin/sh',
  `touch ${JSON.stringify(marker)}`,
  'sleep 1',
  'echo "not relevant"',
].join('\n'));
fs.chmodSync(unrelatedTgpt, 0o755);

// config.js is evaluated once, so the deployment values must precede imports.
process.env.DATABASE_PATH = path.join(tmp, 'groq-status.db');
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = 'https://api.groq.com/openai/v1';
process.env.AI_MODEL = 'openai/gpt-oss-120b';
process.env.AI_API_KEY = 'gsk_test_key_not_real_0123456789';
process.env.AI_TIMEOUT_MS = '2000';
process.env.AI_TGPT_BINARY_PATH = unrelatedTgpt;
delete process.env.AI_FORMAT;

const { aiService } = await import('../src/services/aiService.js');
const { closeDb } = await import('../src/db/index.js');
const originalFetch = globalThis.fetch;
const originalLookup = dns.lookup;

after(() => {
  globalThis.fetch = originalFetch;
  dns.lookup = originalLookup;
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Groq/OpenAI-compatible status resolution', () => {
  it('returns the configured provider without probing an unrelated tgpt binary', async () => {
    const started = Date.now();
    const status = await aiService.status();

    assert.deepEqual(status, {
      enabled: true,
      ready: true,
      provider: 'openai',
      model: 'openai/gpt-oss-120b',
      fallback: 'rule-based metadata search',
    });
    assert.ok(Date.now() - started < 800, 'status waited for the unrelated tgpt executable');
    assert.equal(fs.existsSync(marker), false, 'explicit AI_PROVIDER=openai must not run tgpt --version');
  });

  it('uses the Groq chat/completions path for the admin provider test', async () => {
    const calls = [];
    dns.lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const result = await aiService.testProvider();

    assert.equal(result.ok, true);
    assert.equal(result.provider, 'openai');
    assert.equal(result.model, 'openai/gpt-oss-120b');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(calls[0].init.headers.authorization, 'Bearer gsk_test_key_not_real_0123456789');
    assert.equal(calls[0].body.model, 'openai/gpt-oss-120b');
    assert.equal(fs.existsSync(marker), false, 'the admin test must not probe tgpt either');
  });

  it('returns and records actionable Groq provider errors', async () => {
    dns.lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { message: 'Invalid API Key', type: 'invalid_request_error' },
    }), { status: 401, headers: { 'content-type': 'application/json' } });

    const result = await aiService.testProvider();
    const status = await aiService.adminStatus();

    assert.equal(result.ok, false);
    assert.equal(result.code, 'http');
    assert.match(result.error, /HTTP 401/);
    assert.match(result.error, /Invalid API Key/);
    assert.match(status.error, /\[openai\] http: HTTP 401/);
    assert.ok(!result.error.includes(process.env.AI_API_KEY), 'provider error leaked the configured key');
  });
});
