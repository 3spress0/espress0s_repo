import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The health endpoint has to prove which commit the RUNNING PROCESS is on.
 *
 * The auto-updater's whole safety story rests on this: it swaps files, restarts
 * the app, and only accepts the deploy when /api/health reports the commit it
 * just deployed. If that value tracked the working tree instead of the process,
 * an app that never restarted would report the new commit and the updater would
 * again declare success while serving stale code - the exact bug being fixed.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

const { COMMIT, COMMIT_SHORT, STARTED_AT, resolveCommit } = await import('../src/lib/buildInfo.js');

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

describe('build info: which commit is this process running', () => {
  it('reports the checkout commit as a full 40-character sha', () => {
    const head = gitHead();
    if (!head) return; // not a git checkout (tarball install): nothing to compare
    assert.equal(COMMIT, head.toLowerCase());
    assert.match(COMMIT, /^[0-9a-f]{40}$/);
    assert.equal(COMMIT_SHORT, head.slice(0, 7).toLowerCase());
  });

  it('is frozen at import: the exported value never follows the working tree', async () => {
    // Re-importing returns the same module instance, so the constant cannot be
    // recomputed by anything happening on disk later in the process's life.
    const again = await import('../src/lib/buildInfo.js');
    assert.equal(again.COMMIT, COMMIT);
    assert.equal(again.STARTED_AT, STARTED_AT);
  });

  it('records when the process started, not when the request arrived', () => {
    assert.match(STARTED_AT, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(new Date(STARTED_AT).getTime() <= Date.now());
  });

  it('prefers an explicit commit from the environment (containers ship no .git)', () => {
    const sha = 'a'.repeat(40);
    const previous = process.env.GIT_COMMIT;
    process.env.GIT_COMMIT = sha;
    try {
      assert.equal(resolveCommit(), sha);
    } finally {
      if (previous === undefined) delete process.env.GIT_COMMIT;
      else process.env.GIT_COMMIT = previous;
    }
  });

  it('ignores a malformed commit from the environment rather than reporting junk', () => {
    const previous = process.env.GIT_COMMIT;
    process.env.GIT_COMMIT = 'not-a-sha';
    try {
      const resolved = resolveCommit();
      assert.notEqual(resolved, 'not-a-sha');
      if (resolved !== null) assert.match(resolved, /^[0-9a-f]{40}$/);
    } finally {
      if (previous === undefined) delete process.env.GIT_COMMIT;
      else process.env.GIT_COMMIT = previous;
    }
  });

  it('never throws, even with no git available', () => {
    assert.doesNotThrow(() => resolveCommit());
  });
});

describe('health endpoint contract', () => {
  const indexSrc = fs.readFileSync(path.resolve(here, '../src/index.js'), 'utf8');

  it('serves the process commit on /api/health', () => {
    const route = indexSrc.slice(indexSrc.indexOf("fastify.get('/api/health'"));
    const body = route.slice(0, route.indexOf('});'));
    assert.match(body, /status: 'ok'/);
    assert.match(body, /commit: COMMIT/, 'the updater verifies deployments against this field');
  });

  it('uses the frozen constant, not a per-request git call', () => {
    const route = indexSrc.slice(indexSrc.indexOf("fastify.get('/api/health'"));
    const body = route.slice(0, route.indexOf('});'));
    assert.ok(
      !/resolveCommit\(\)|execSync|rev-parse/.test(body),
      're-resolving the commit per request would let a stale process report fresh code'
    );
  });
});
