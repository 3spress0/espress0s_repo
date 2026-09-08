import { APP_VERSION, COMMIT, COMMIT_SHORT, STARTED_AT } from '../lib/buildInfo.js';

/**
 * Health, and the proof of which release is actually serving it.
 *
 * `commit` is captured when this process starts (see lib/buildInfo.js), not
 * read per request, so an old Node process cannot answer with the new commit
 * just because the files on disk were swapped underneath it. The auto-updater
 * relies on exactly that: it compares this value to the commit it deployed and
 * refuses to call an update successful until they match.
 *
 * These are liveness probes, so they must not depend on database availability.
 */
export async function healthRoutes(fastify) {
  const healthResponse = async () => {
    return {
      status: 'ok',
      service: "espress0's repo",
      version: APP_VERSION,
      commit: COMMIT,
      commitShort: COMMIT_SHORT,
      startedAt: STARTED_AT,
      timestamp: new Date().toISOString(),
    };
  };

  // Keep both paths: /api/health is used by deployment tooling, while /health
  // is convenient for reverse proxies and platform probes.
  fastify.get('/api/health', healthResponse);
  fastify.get('/health', healthResponse);
}
