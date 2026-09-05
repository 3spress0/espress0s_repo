import { getDb } from '../db/index.js';
import { buildFtsQuery } from './searchService.js';
import { generate, redact } from './aiProviders.js';
import { extractJsonObject } from './aiService.js';
import { onEvent } from './eventBus.js';

/**
 * "Similar software" (#21).
 *
 * Two layers, always in this order:
 *
 *   1. Deterministic scoring over the catalogue - explicit item_relations,
 *      shared tags, same category / platform / architecture, and an FTS5
 *      match on the name + description. This alone produces the answer when
 *      no model is configured, when the model fails, or when it times out.
 *   2. Optional AI rerank: the configured provider receives ONLY the
 *      candidate list from step 1 (id, name, one-line description) and may
 *      reorder it and add a short "why" per entry. It cannot add entries
 *      that are not in the pool, so it can never point at software the
 *      archive does not have. Anything malformed falls back to step 1.
 *
 * Results are cached per item; every item.* / review write event clears
 * the cache so edits show up immediately.
 */
export const DEFAULT_LIMIT = 6;
const POOL = 12;
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

const WEIGHTS = { relation: 20, tag: 2, category: 3, platform: 1, architecture: 0.5, text: 4 };

const SIMILAR_SYSTEM_PROMPT = `You rank software from a personal archive by how similar it is to a reference entry.
You are given the reference and a numbered list of candidates. Only those candidates exist.
Return a JSON object: {"ranked":[{"id":<candidate id>,"why":"<max 12 words>"}...]}, best match first.
Use only ids from the list. Do not invent software. Do not add commentary outside the JSON.`;

export function clearSimilarCache() { cache.clear(); }
onEvent(() => cache.clear());

function parseTags(raw) {
  if (Array.isArray(raw)) return raw;
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** Deterministic candidate scoring. Exported for tests and for the fallback. */
export function scoreSimilar(itemId, { limit = POOL } = {}) {
  const db = getDb();
  const ref = db.prepare('SELECT id, name, slug, description, category_id, platform, architecture, tags FROM items WHERE id = ?').get(itemId);
  if (!ref) return [];
  const refTags = new Set(parseTags(ref.tags).map((t) => String(t).toLowerCase()));
  const scores = new Map();
  const bump = (id, points, reason) => {
    if (id === ref.id) return;
    const s = scores.get(id) || { score: 0, reasons: [] };
    s.score += points;
    if (reason && !s.reasons.some((r) => r.reason === reason)) s.reasons.push({ reason, points });
    scores.set(id, s);
  };

  for (const r of db.prepare('SELECT related_item_id AS id, relation FROM item_relations WHERE item_id = ? UNION SELECT item_id, relation FROM item_relations WHERE related_item_id = ?').all(ref.id, ref.id)) {
    bump(r.id, WEIGHTS.relation, r.relation === 'related' ? 'linked by the curator' : r.relation);
  }

  const meta = db.prepare(`
    SELECT id, category_id, platform, architecture, tags FROM items
    WHERE published = 1 AND id != ? AND (category_id = ? OR platform = ? OR tags IS NOT NULL)`).all(ref.id, ref.category_id ?? -1, ref.platform ?? '');
  for (const m of meta) {
    if (ref.category_id && m.category_id === ref.category_id) bump(m.id, WEIGHTS.category, 'same category');
    if (ref.platform && m.platform === ref.platform) bump(m.id, WEIGHTS.platform, `also for ${ref.platform}`);
    if (ref.architecture && m.architecture === ref.architecture) bump(m.id, WEIGHTS.architecture, null);
    if (refTags.size) {
      const shared = parseTags(m.tags).map((t) => String(t).toLowerCase()).filter((t) => refTags.has(t));
      if (shared.length) bump(m.id, WEIGHTS.tag * shared.length, `shares ${shared.slice(0, 3).join(', ')}`);
    }
  }

  const q = buildFtsQuery(`${ref.name} ${(ref.description || '').split(/\s+/).slice(0, 12).join(' ')}`);
  if (q) {
    try {
      const rows = db.prepare(`
        SELECT i.id, bm25(items_fts, 10, 2, 5, 1) AS rank FROM items_fts
        JOIN items i ON i.id = items_fts.rowid
        WHERE items_fts MATCH ? AND i.published = 1 AND i.id != ? ORDER BY rank LIMIT 20`).all(q, ref.id);
      rows.forEach((r, i) => bump(r.id, WEIGHTS.text * (1 - i / rows.length), 'similar description'));
    } catch { /* FTS syntax edge case: text signal simply contributes nothing */ }
  }

  const ids = [...scores.entries()].filter(([, s]) => s.score > 0).sort((a, b) => b[1].score - a[1].score).slice(0, limit).map(([id]) => id);
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT id, name, slug, description, version, file_type, platform, architecture, icon_url, image_url FROM items WHERE published = 1 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.filter((id) => byId.has(id)).map((id) => ({ ...byId.get(id), score: Math.round(scores.get(id).score * 10) / 10, why: scores.get(id).reasons.sort((a, b) => b.points - a.points).slice(0, 2).map((r) => r.reason).join(' · ') }));
}

async function rerankWithProvider(ref, pool, cfg) {
  const list = pool.map((p) => `${p.id}. ${p.name}${p.version ? ` ${p.version}` : ''} - ${(p.description || '').slice(0, 120)}`).join('\n');
  const prompt = `Reference: ${ref.name}${ref.version ? ` ${ref.version}` : ''} - ${(ref.description || '').slice(0, 200)}\n\nCandidates:\n${list}\n\nReturn the JSON object.`;
  const out = (await generate({ system: SIMILAR_SYSTEM_PROMPT, prompt, cfg, kind: 'draft' }).then((r) => r.text)) || '';
  const parsed = extractJsonObject(out);
  if (!parsed || !Array.isArray(parsed.ranked)) return null;
  const allowed = new Map(pool.map((p) => [p.id, p]));
  const seen = new Set();
  const ranked = [];
  for (const entry of parsed.ranked) {
    const id = Number(entry?.id);
    if (!allowed.has(id) || seen.has(id)) continue; // hallucinated or duplicate id -> dropped
    seen.add(id);
    const why = typeof entry.why === 'string' ? entry.why.replace(/[\r\n]+/g, ' ').replace(/https?:\/\/\S+/g, '').trim().slice(0, 100) : '';
    ranked.push({ ...allowed.get(id), why: why || allowed.get(id).why });
  }
  return ranked.length ? ranked : null;
}

/**
 * @returns {{ items: Array, usedAI: boolean, provider: string|null, aiError?: string }}
 */
export async function similarItems(itemId, { limit = DEFAULT_LIMIT, aiService = null } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), POOL);
  const key = `${itemId}:${lim}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const db = getDb();
  const ref = db.prepare('SELECT id, name, version, description FROM items WHERE id = ?').get(itemId);
  const pool = ref ? scoreSimilar(itemId, { limit: POOL }) : [];
  let result = { items: pool.slice(0, lim), usedAI: false, provider: null };

  if (aiService && pool.length > 1) {
    let cfg = null;
    try {
      cfg = await aiService.aiConfig();
      if (cfg.enabled && cfg.provider !== 'none') {
        const ranked = await rerankWithProvider(ref, pool, cfg);
        if (ranked) result = { items: ranked.slice(0, lim), usedAI: true, provider: cfg.provider };
        else result.provider = cfg.provider;
      }
    } catch (e) {
      result = { ...result, provider: cfg?.provider || null, aiError: redact(e.message || String(e), cfg?.apiKey).slice(0, 200) };
    }
  }

  cache.set(key, { value: result, expires: Date.now() + CACHE_TTL_MS });
  return result;
}
