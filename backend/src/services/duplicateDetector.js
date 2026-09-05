/**
 * Duplicate detection for catalogue imports (#8).
 *
 * The import pipeline is idempotent *by slug*. That is precise but blind to
 * the common mistake: the same software arriving under a slightly different
 * slug ("7zip-2301" vs "7-zip-23-01", "VLC Media Player 3.0.20" vs
 * "vlc-3.0.20"). Those would be created as second copies without anyone
 * noticing. This module looks at the entries an import is about to CREATE and
 * flags existing rows - and other entries in the same archive - that look like
 * the same thing, so the admin sees a warning in the preview before applying.
 *
 * Pure functions; the only database access is loading the existing index once.
 */

const STOP = new Set(['the', 'and', 'for', 'edition', 'version', 'release', 'portable', 'installer', 'setup', 'x64', 'x86', 'win', 'windows', 'linux', 'macos', 'mac', 'bit', '64bit', '32bit', 'amd64', 'arm64']);

/** Lower-case alphanumerics only: "7-Zip 23.01" -> "7zip2301". */
export function normalizeSlugish(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Version-ish tokens: 1.2, v3, 2024.1, 23.01-beta2, 4.8rc1 ... */
const VERSION_RE = /^v?\d+(?:[._-]\d+)*(?:[a-z]+\d*)?$/i;

/**
 * Name reduced to what identifies the product: lower-case words, no
 * punctuation, no version tokens, no packaging noise. Returns the sorted set
 * of tokens and the joined key.
 */
export function normalizeName(name) {
  const words = String(name || '').toLowerCase().replace(/[^a-z0-9.+#]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const tokens = [];
  for (const w of words) {
    // A single digit is part of a name ("7 zip", "mp3"), not a version.
    if (VERSION_RE.test(w) && !/^\d$/.test(w)) continue;
    const t = w.replace(/[^a-z0-9+#]/g, '');
    if (!t || STOP.has(t)) continue;
    tokens.push(t);
  }
  const uniq = [...new Set(tokens)].sort();
  return { tokens: uniq, key: uniq.join('') };
}

/** Normalised version: "v1.2.0" == "1.2" == "1-2-0". */
export function normalizeVersion(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim().toLowerCase().replace(/^v(?=\d)/, '').replace(/[-_\s]+/g, '.');
  if (!s) return null;
  // Drop trailing ".0" segments so 1.2.0 == 1.2.
  const parts = s.split('.');
  while (parts.length > 1 && /^0+$/.test(parts[parts.length - 1])) parts.pop();
  return parts.join('.');
}

/** Sørensen–Dice similarity over character bigrams, 0..1. */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const ga = grams(a); const gb = grams(b);
  let hit = 0;
  for (const [g, n] of ga) if (gb.has(g)) hit += Math.min(n, gb.get(g));
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

export const THRESHOLDS = { likely: 0.92, possible: 0.8 };

/**
 * Score one candidate pair. Returns null when it is not a plausible duplicate,
 * otherwise { score, level: 'likely'|'possible', reason }.
 */
export function compareEntries(a, b) {
  const na = normalizeName(a.name); const nb = normalizeName(b.name);
  const sa = normalizeSlugish(a.slug); const sb = normalizeSlugish(b.slug);
  const va = normalizeVersion(a.version); const vb = normalizeVersion(b.version);
  const sameVersion = va !== null && vb !== null && va === vb;
  const versionConflict = va !== null && vb !== null && va !== vb;

  const nameSim = na.key && nb.key ? similarity(na.key, nb.key) : 0;
  const slugSim = sa && sb ? similarity(sa, sb) : 0;
  const best = Math.max(nameSim, slugSim);

  // Identical product name but a different version is a legitimate sibling
  // entry (an archive of releases), not a duplicate.
  if (versionConflict) {
    if (sa && sa === sb) return { score: 1, level: 'possible', reason: 'slugs differ only in punctuation but versions differ' };
    return null;
  }

  if (na.key && na.key === nb.key) {
    return sameVersion
      ? { score: 1, level: 'likely', reason: 'same name and version' }
      : { score: 0.95, level: va === null && vb === null ? 'likely' : 'possible', reason: 'same name' + (va === null && vb === null ? '' : ', one side has no version') };
  }
  if (sa && sa === sb) return { score: 0.98, level: 'likely', reason: 'slugs differ only in punctuation' };
  if (best >= THRESHOLDS.likely) return { score: best, level: sameVersion ? 'likely' : 'possible', reason: `${nameSim >= slugSim ? 'name' : 'slug'} ${Math.round(best * 100)}% similar${sameVersion ? ', same version' : ''}` };
  if (best >= THRESHOLDS.possible) return { score: best, level: 'possible', reason: `${nameSim >= slugSim ? 'name' : 'slug'} ${Math.round(best * 100)}% similar${sameVersion ? ', same version' : ''}` };
  return null;
}

/**
 * Index of rows to compare against. Blocking by name token keeps this linear
 * in practice: only rows sharing at least one identifying token (or the
 * normalised slug prefix) are scored.
 */
export class DuplicateIndex {
  constructor(rows = []) {
    this.rows = [];
    this.byToken = new Map();
    this.byPrefix = new Map();
    for (const r of rows) this.add(r);
  }

  add(row) {
    const rec = { id: row.id ?? null, slug: row.slug, name: row.name, version: row.version ?? null, _n: normalizeName(row.name), _s: normalizeSlugish(row.slug) };
    const idx = this.rows.push(rec) - 1;
    for (const t of rec._n.tokens) {
      if (!this.byToken.has(t)) this.byToken.set(t, []);
      this.byToken.get(t).push(idx);
    }
    const p = rec._s.slice(0, 4);
    if (p) { if (!this.byPrefix.has(p)) this.byPrefix.set(p, []); this.byPrefix.get(p).push(idx); }
    return rec;
  }

  /** Candidates for `entry`, best first. `exclude` = predicate on the record. */
  find(entry, { exclude = () => false, limit = 5 } = {}) {
    const n = normalizeName(entry.name);
    const s = normalizeSlugish(entry.slug);
    const seen = new Set();
    const pool = [];
    const take = (list) => { for (const i of list || []) if (!seen.has(i)) { seen.add(i); pool.push(this.rows[i]); } };
    for (const t of n.tokens) take(this.byToken.get(t));
    take(this.byPrefix.get(s.slice(0, 4)));
    const out = [];
    for (const rec of pool) {
      if (exclude(rec)) continue;
      const cmp = compareEntries(entry, rec);
      if (cmp) out.push({ id: rec.id, slug: rec.slug, name: rec.name, version: rec.version, ...cmp });
    }
    out.sort((a, b) => b.score - a.score || (a.level === 'likely' ? -1 : 1));
    return out.slice(0, limit);
  }
}

/** Load every item's identity into an index. Cheap: three small columns. */
export function loadExistingIndex(db) {
  return new DuplicateIndex(db.prepare('SELECT id, slug, name, version FROM items').all());
}
