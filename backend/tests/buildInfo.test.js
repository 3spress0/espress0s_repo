import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

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
const { healthRoutes } = await import('../src/routes/health.js');

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
  let app;

  before(async () => {
    // Exercise the same routes as the server without starting a listener or
    // opening SQLite. Source-text checks broke when the inline handler became
    // shared; the HTTP contract must not depend on where that handler lives.
    app = Fastify({ logger: false });
    await app.register(healthRoutes);
    await app.ready();
  });

  after(async () => { await app?.close(); });

  for (const url of ['/api/health', '/health']) {
    it(`serves the process build info on ${url}`, async () => {
      const beforeRequest = Date.now();
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200);
      assert.match(response.headers['content-type'], /application\/json/);
      const { timestamp, ...buildInfo } = response.json();
      assert.deepStrictEqual(buildInfo, {
        status: 'ok',
        service: "espress0's repo",
        version: '1.0.0',
        commit: COMMIT,
        commitShort: COMMIT_SHORT,
        startedAt: STARTED_AT,
      });
      assert.ok(Date.parse(timestamp) >= beforeRequest, 'timestamp is generated for this request');
      assert.ok(Date.parse(timestamp) <= Date.now());
    });

    it(`keeps the process commit frozen across requests to ${url}`, async () => {
      const first = (await app.inject({ method: 'GET', url })).json();
      const nextCommit = (COMMIT === 'a'.repeat(40) ? 'b' : 'a').repeat(40);
      const previous = process.env.GIT_COMMIT;
      process.env.GIT_COMMIT = nextCommit;
      try {
        // Prove that resolving again would now see a different deployment.
        assert.equal(resolveCommit(), nextCommit);
        const response = await app.inject({ method: 'GET', url });
        assert.equal(response.statusCode, 200);
        const body = response.json();
        assert.equal(body.commit, first.commit, 'a stale process must not report a new release');
        assert.equal(body.commitShort, first.commitShort);
        assert.equal(body.startedAt, first.startedAt);
      } finally {
        if (previous === undefined) delete process.env.GIT_COMMIT;
        else process.env.GIT_COMMIT = previous;
      }
    });
  }
});
