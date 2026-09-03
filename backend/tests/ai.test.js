import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression tests for Barista's ask path.
 *
 * The deployed symptom was every question answering "Sorry, error: timeout of
 * 30000ms exceeded. Try browsing directly." The server handed tgpt a 30000 ms
 * budget - exactly the axios request budget in frontend/src/lib/api.js - so a
 * slow provider was killed at the same instant the browser gave up. The
 * rule-based fallback answer was computed for nobody.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const apiClientPath = path.resolve(here, '../../frontend/src/lib/api.js');

// config.js reads these at import time, so they have to be set before the
// dynamic imports below - and the tgpt stand-in has to exist by then too.
const ASK_BUDGET_MS = 2000; // the smallest budget config.js accepts

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgpt-slow-'));
const slowTgpt = path.join(binDir, 'tgpt');
fs.writeFileSync(
  slowTgpt,
  [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "tgpt 2.9.2 (slow test double)"; exit 0; fi',
    // `exec` replaces the shell so the SIGKILL that enforces the budget hits
    // this process directly instead of orphaning a sleep.
    'exec sleep 8',
  ].join('\n')
);
fs.chmodSync(slowTgpt, 0o755);

// Deliberately the OLD variable names, with no AI_* equivalents set: that is a
// .env from before the Gemini provider existed, and it has to keep working -
// both the tuned budget and the binary path. The new names are covered below.
process.env.TGPT_TIMEOUT_MS = String(ASK_BUDGET_MS);
process.env.TGPT_BINARY_PATH = slowTgpt;

const { config } = await import('../src/config.js');
const { aiService } = await import('../src/services/aiService.js');
const { getDb } = await import('../src/db/index.js');

/** The AI request budget the browser actually uses, read from the shipped client. */
function clientAiTimeout() {
  const src = fs.readFileSync(apiClientPath, 'utf8');
  const match = src.match(/export const AI_TIMEOUT\s*=\s*(\d+)/);
  assert.ok(match, `AI_TIMEOUT not found in ${apiClientPath}`);
  return Number(match[1]);
}

describe('Barista ask timeouts', () => {
  let canaryId = null;

  before(() => {
    const db = getDb();
    if (db.prepare('SELECT COUNT(*) c FROM items').get().c === 0) {
      canaryId = db.prepare(`
        INSERT INTO items (name, slug, description, tags, published)
        VALUES ('Ubuntu 24.04 LTS canary', 'ubuntu-24-04-lts-canary',
                'Fixture row for the AI timeout tests', '["linux","ubuntu"]', 1)
      `).run().lastInsertRowid;
    }
  });

  after(() => {
    if (canaryId) getDb().prepare('DELETE FROM items WHERE id = ?').run(canaryId);
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  it('keeps the server provider budget below the browser request budget', () => {
    const client = clientAiTimeout();
    assert.ok(
      config.ai.timeoutMs < client,
      `ask budget (${config.ai.timeoutMs} ms) must stay below the client AI_TIMEOUT (${client} ms), or the fallback answer never arrives`
    );
    assert.ok(
      config.ai.draftTimeoutMs < client,
      `draft budget (${config.ai.draftTimeoutMs} ms) must stay below the client AI_TIMEOUT (${client} ms)`
    );
  });

  it('still answers from repository metadata when the provider exceeds its budget', async () => {
    assert.equal(await aiService.checkTgptAvailable(), true, 'the tgpt stand-in should be detected as available');
    // auto + no key + an installed tgpt has to land on tgpt, or this test would
    // be exercising a provider that does not exist on a CI box.
    assert.equal((await aiService.aiConfig()).provider, 'tgpt', 'AI_PROVIDER=auto should resolve to the installed tgpt');

    const started = Date.now();
    const result = await aiService.ask('What does this tool do?', { limit: 5 });
    const elapsed = Date.now() - started;

    assert.equal(result.usedAI, false, 'should have fallen back to the rule-based answer');
    assert.equal(result.provider, null, 'a fallback answer must not claim a provider');
    assert.ok(result.answer && result.answer.length > 0, 'the fallback produced no answer text');
    assert.ok(
      elapsed >= ASK_BUDGET_MS,
      `returned after ${elapsed} ms - the ${ASK_BUDGET_MS} ms budget was not enforced`
    );
    assert.ok(
      elapsed < config.ai.timeoutMs + 5000,
      `took ${elapsed} ms to produce the fallback, far more than the budget allows`
    );
    assert.match(
      result.aiError || '',
      /timed out/,
      'the metadata-only answer should say the provider timed out'
    );
    // The key must not ride along in a string that reaches an admin-visible
    // response body.
    assert.ok(!/AIza|sk-/.test(result.aiError || ''), 'aiError leaked what looks like a key');
  });

  it('still honours the older TGPT_TIMEOUT_MS name when AI_TIMEOUT_MS is absent', () => {
    // A .env from before this change is exactly that case, and silently going
    // back to the 20 s default would re-break the tuned budget an operator set.
    assert.equal(config.ai.timeoutMs, ASK_BUDGET_MS,
      'TGPT_TIMEOUT_MS alone must still set the budget, or an existing deployment silently regresses');
    assert.equal(config.ai.tgpt.binaryPath, slowTgpt, 'TGPT_BINARY_PATH must still be read');
  });

  it('ignores a malformed timeout instead of disabling the timeout', async () => {
    for (const bogus of ['', 'not-a-number', '-5']) {
      process.env.AI_TIMEOUT_MS = bogus;
      delete process.env.TGPT_TIMEOUT_MS; // so the fallback cannot satisfy the assertion
      // Cache-busted so config.js is re-evaluated with the new environment.
      const fresh = await import(`../src/config.js?bust=${encodeURIComponent(bogus)}-${Math.random()}`);
      assert.equal(
        fresh.config.ai.timeoutMs,
        20000,
        `TGPT_TIMEOUT_MS=${JSON.stringify(bogus)} should fall back to the 20000 ms default`
      );
    }
    process.env.AI_TIMEOUT_MS = String(ASK_BUDGET_MS);
  });
});
