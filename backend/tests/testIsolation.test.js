/**
 * Regression tests for test isolation.
 *
 * Background: `./espress0 scan --full` on a live box reported 2 failing tests
 * that passed on a clean checkout. The cause was that the suite imported
 * src/config.js, which loads the project-root .env, and src/db/index.js, which
 * opens config.db.path. On a deployed machine that meant the tests read the
 * operator's real credentials and wrote to the LIVE production database.
 *
 * tests/setup.mjs fixes this by pinning the environment before any test file
 * loads. These assertions make sure it stays fixed - if someone drops the
 * --import flag from `npm test`, or the file stops neutralising a variable,
 * this suite fails loudly instead of silently touching production data again.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

describe('test isolation (tests/setup.mjs)', () => {
  test('the database under test is NOT the production database', async () => {
    const { config } = await import('../src/config.js');
    const dbPath = config.db.path;

    assert.ok(dbPath, 'config.db.path should be set');

    // The live database lives at <repo>/data/repo.db. The suite must never
    // open it: the tests create users, items and versions.
    const productionDb = path.resolve(repoRoot, 'data/repo.db');
    assert.notStrictEqual(
      path.resolve(dbPath), productionDb,
      'tests are pointed at the production database - they would write test rows into real data',
    );

    // Positively assert it is a throwaway location, so a future refactor
    // cannot satisfy the check above by picking some other real path.
    assert.ok(
      path.resolve(dbPath).startsWith(path.resolve(os.tmpdir())),
      `expected a temp-dir database, got ${dbPath}`,
    );
  });

  test('running the suite does not create the production database file', () => {
    // If setup.mjs is bypassed, importing the db module creates <repo>/data/
    // as a side effect. Guard the specific artefact.
    const productionDb = path.resolve(repoRoot, 'data/repo.db');
    const existedBefore = fs.existsSync(productionDb);
    // Touch the db layer the same way the app does.
    return import('../src/db/index.js').then(({ getDb }) => {
      getDb();
      if (!existedBefore) {
        assert.ok(
          !fs.existsSync(productionDb),
          'importing the db layer created the production database file',
        );
      }
    });
  });

  test('production secrets from .env do not leak into the suite', async () => {
    const { config, DEV_JWT_SECRET } = await import('../src/config.js');
    // Deterministic, obviously-fake value set by setup.mjs.
    assert.match(
      config.security.jwtSecret, /test-only/,
      'the suite is using a JWT secret that did not come from setup.mjs (likely the real .env)',
    );
    assert.notStrictEqual(config.security.jwtSecret, DEV_JWT_SECRET);
  });

  test('AI provider resolution is not influenced by an operator API key', () => {
    // This is the exact failure seen in the field: with a Gemini key present in
    // .env, AI_PROVIDER=auto resolved to "gemini" and tests/ai.test.js - which
    // asserts it resolves to the installed tgpt - failed for an environmental
    // reason rather than a code defect.
    for (const name of ['AI_API_KEY', 'GEMINI_API_KEY', 'AI_PROVIDER', 'AI_MODEL']) {
      const v = process.env[name];
      assert.ok(
        v === undefined || v === '',
        `${name} is set to a real value during tests; provider resolution is environment-dependent`,
      );
    }
  });

  test('npm test wires in the isolation preload', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    assert.match(
      pkg.scripts.test, /--import\s+\.\/tests\/setup\.mjs/,
      'npm test must preload tests/setup.mjs, or the suite runs against the real .env and database',
    );
  });
});
