import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lucide from 'lucide-react';

/**
 * The 918ecff incident, as a test.
 *
 * Dependabot bumped lucide-react 0.395.0 -> 1.39.0 and 1.x removed the
 * brand icons; src/components/admin/ImportJobs.jsx still imported `Github`,
 * and the production build died at deploy time with [MISSING_EXPORT]. The
 * build stops at the FIRST missing icon, so "the build passed" also could
 * never prove the rest of the set was safe.
 *
 * This test checks every named lucide-react import in src against the
 * INSTALLED package's exports, so the next icon removal fails here - in
 * `npm test`, in CI, minutes after the bump is proposed - instead of during
 * a deploy, on a loaded box, with dist/ already emptied.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function* jsxFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsxFiles(full);
    else if (/\.jsx?$/.test(entry.name)) yield full;
  }
}

function collectImports() {
  // icon name -> files importing it
  const used = new Map();
  for (const file of jsxFiles(SRC)) {
    const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/gs)) {
      for (const spec of match[1].split(',')) {
        const name = spec.trim().split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        if (!used.has(name)) used.set(name, new Set());
        used.get(name).add(path.relative(SRC, file));
      }
    }
  }
  return used;
}

test('every lucide-react icon imported anywhere in src exists in the installed package', () => {
  const used = collectImports();
  assert.ok(used.size > 50, `sanity: the app uses many icons, found ${used.size}`);
  const missing = [...used.entries()]
    .filter(([name]) => !(name in lucide))
    .map(([name, files]) => `${name} (imported by ${[...files].join(', ')})`);
  assert.deepEqual(
    missing,
    [],
    'icons that do not exist in the installed lucide-react - the build will fail at deploy time otherwise',
  );
});

test('the incident icon is not re-imported from lucide-react (brand icons were removed in 1.x)', () => {
  const importJobs = fs.readFileSync(
    path.join(SRC, 'components/admin/ImportJobs.jsx'),
    'utf8',
  );
  assert.doesNotMatch(
    importJobs,
    /import\s*\{[^}]*\bGithub\b[^}]*\}\s*from\s*['"]lucide-react['"]/s,
    'use the local GithubMark component - lucide-react removed the brand icons',
  );
});
