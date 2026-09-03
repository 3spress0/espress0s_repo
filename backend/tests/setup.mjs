/**
 * Test isolation. Loaded with `node --import ./tests/setup.mjs`, so it runs
 * before any test file - and, crucially, before src/config.js is imported.
 *
 * Why this exists
 * ---------------
 * config.js calls dotenv.config() on the project-root .env at import time, and
 * db/index.js opens config.db.path. On a developer laptop both are harmless.
 * On a real deployment they are not: `./espress0 test` (and `./espress0 scan
 * --full`, which runs the suite) was reading the operator's PRODUCTION .env and
 * opening the LIVE repo.db.
 *
 * That caused two separate problems on a live box:
 *
 *   1. False failures. tests/ai.test.js asserts that `AI_PROVIDER=auto`
 *      resolves to tgpt - true on a bare checkout, false the moment the
 *      operator has a Gemini key in .env, where it resolves to gemini. The
 *      suite reported failures that said nothing about the code.
 *   2. Real risk. The suite creates users, items and versions. Pointed at the
 *      live database it writes test rows into production data, and reads live
 *      admin settings (an ai_max_tokens="0" row from the settings table was
 *      visible in the scan output) back into assertions.
 *
 * dotenv never overwrites a variable that is already set, so assigning the
 * values here is enough to win over whatever .env contains. Empty strings are
 * treated as "not configured" by config.js's envFirst(), which is exactly the
 * neutral state the tests are written against.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- 1. A private database per test run --------------------------------------
// Never the live one. Created under the OS temp dir and removed on exit.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'espress0-test-'));
const dbPath = path.join(tmpRoot, 'repo.db');

process.env.DATABASE_PATH = dbPath;
process.env.BACKUP_DIR = path.join(tmpRoot, 'backups');
process.env.UPLOAD_DIR = path.join(tmpRoot, 'uploads');
fs.mkdirSync(process.env.BACKUP_DIR, { recursive: true });
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

// --- 2. Deterministic secrets -------------------------------------------------
// Fixed, obviously-fake values so a test never depends on the operator's real
// keys, and never accidentally exercises production crypto material.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-production-use-1234';
process.env.ENCRYPTION_KEY = 'dGVzdC1vbmx5LWVuY3J5cHRpb24ta2V5LTMyLWJ5dGVzIQ==';
process.env.PASSWORD_PEPPER = '0'.repeat(64);

// --- 3. A neutral AI configuration -------------------------------------------
// The AI tests describe behaviour for a box with no provider configured and
// install their own stand-ins. A real key or endpoint in .env changes which
// provider `auto` resolves to and makes those assertions fail for reasons that
// have nothing to do with the code under test.
for (const name of [
  'AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'TGPT_API_KEY',
  'AI_PROVIDER', 'AI_MODEL', 'AI_BASE_URL', 'AI_FORMAT',
  'AI_TEMPERATURE', 'AI_MAX_TOKENS', 'AI_ENABLED', 'TGPT_ENABLED',
  'AI_TIMEOUT_MS', 'AI_DRAFT_TIMEOUT_MS', 'TGPT_TIMEOUT_MS',
  'AI_TGPT_PROVIDER', 'TGPT_PROVIDER', 'AI_TGPT_MODEL', 'TGPT_MODEL',
  'AI_TGPT_BINARY_PATH', 'TGPT_BINARY_PATH', 'AI_ALLOW_PRIVATE_BASE_URL',
]) {
  process.env[name] = '';
}

// --- 4. Keep the temp tree out of the way ------------------------------------
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

export { tmpRoot, dbPath };
