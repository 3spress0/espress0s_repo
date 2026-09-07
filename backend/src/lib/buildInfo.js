import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Which release is this, as a number?
 *
 * `version` used to be a literal '1.0.0' written out in three files - the
 * health endpoint, the monitoring endpoint and the OpenAPI header - so bumping
 * a release meant remembering all three, and forgetting one left the site
 * politely reporting the previous version. backend/package.json is the one
 * place the number is actually maintained (it is what npm reads, and what the
 * lockfiles and CI caches key off), so all three now resolve from here.
 *
 * Resolved ONCE, at import time, like the commit: a deploy that swaps files
 * without restarting Node must not appear to have bumped the version.
 */
export function resolveVersion() {
  for (const name of ['APP_VERSION', 'ESPRESS0_VERSION']) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '../../package.json'), 'utf8'));
    // The path is relative to this file, so a stray package.json elsewhere in
    // the tree can never be mistaken for ours.
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch { /* packaged without a manifest, or unreadable: version is unknown */ }
  return null;
}

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
 * Frozen at import. Deliberately not getters: the whole point is that these
 * values cannot follow the working tree or the manifest once the process is
 * up - only restarting Node changes what this build claims to be.
 *
 * APP_VERSION is null when the version genuinely cannot be determined, so a
 * consumer can say "unknown" instead of inventing a number.
 */
export const APP_VERSION = resolveVersion();
export const COMMIT = resolveCommit();
export const COMMIT_SHORT = COMMIT ? COMMIT.slice(0, 7) : null;
export const STARTED_AT = new Date().toISOString();
