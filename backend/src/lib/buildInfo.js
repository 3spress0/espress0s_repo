import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Which commit is this *process* running?
 *
 * The auto-updater needs to tell "the new code is on disk" apart from "the new
 * code is being served". Those are different facts: swapping files under a
 * running Node process changes the checkout and nothing else, and a health
 * check answered by the old process is exactly the false positive that made a
 * bare `./espress0 update` report success while serving the previous release.
 *
 * So the commit is resolved ONCE, at import time, and never re-read. A later
 * `git reset`, file swap or deploy cannot change what this module reports -
 * only restarting Node can. That is what makes it a usable restart proof.
 *
 * Resolution order, first hit wins:
 *   1. GIT_COMMIT / SOURCE_COMMIT in the environment (containers and CI
 *      builds, where .git is usually not shipped).
 *   2. A `commit` file written next to the source by a build.
 *   3. `git rev-parse HEAD` in the repository this file lives in.
 *   4. .git/HEAD read directly, for a checkout with no git binary available.
 *
 * Never throws: an unknown commit degrades the updater's verification to a
 * clear "unknown" rather than taking the health endpoint down with it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function fromEnv() {
  for (const name of ['GIT_COMMIT', 'SOURCE_COMMIT', 'ESPRESS0_COMMIT']) {
    const value = String(process.env[name] || '').trim();
    if (SHA_PATTERN.test(value)) return value.toLowerCase();
  }
  return null;
}

function fromFile() {
  for (const candidate of [path.join(repoRoot, 'commit'), path.join(repoRoot, '.commit')]) {
    try {
      const value = fs.readFileSync(candidate, 'utf8').trim();
      if (SHA_PATTERN.test(value)) return value.toLowerCase();
    } catch { /* not present: try the next source */ }
  }
  return null;
}

function fromGitCommand() {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    return SHA_PATTERN.test(out) ? out.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** No git binary (slim container, hardened host): read the ref files by hand. */
function fromGitDir() {
  try {
    const head = fs.readFileSync(path.join(repoRoot, '.git', 'HEAD'), 'utf8').trim();
    if (SHA_PATTERN.test(head)) return head.toLowerCase();
    const match = head.match(/^ref:\s*(.+)$/);
    if (!match) return null;
    const ref = match[1].trim();
    try {
      const value = fs.readFileSync(path.join(repoRoot, '.git', ref), 'utf8').trim();
      if (SHA_PATTERN.test(value)) return value.toLowerCase();
    } catch { /* packed-refs below */ }
    const packed = fs.readFileSync(path.join(repoRoot, '.git', 'packed-refs'), 'utf8');
    for (const line of packed.split('\n')) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && SHA_PATTERN.test(sha || '')) return sha.toLowerCase();
    }
  } catch { /* not a checkout */ }
  return null;
}

export function resolveCommit() {
  return fromEnv() || fromFile() || fromGitCommand() || fromGitDir() || null;
}

/**
 * Frozen at import. Deliberately not a getter: the whole point is that this
 * value cannot follow the working tree once the process is up.
 */
export const COMMIT = resolveCommit();
export const COMMIT_SHORT = COMMIT ? COMMIT.slice(0, 7) : null;
export const STARTED_AT = new Date().toISOString();
