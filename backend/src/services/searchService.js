import { getDb } from '../db/index.js';

/**
 * Typo-tolerant search
 * Uses FTS5 for full-text + custom ranking + Levenshtein for typo tolerance
 */

// Levenshtein is O(n*m); refuse to run it on pathological input so a long
// query string cannot pin a CPU core.
const MAX_TERM_LENGTH = 64;
export const MAX_QUERY_LENGTH = 128;

function levenshtein(a, b) {
  if (a.length > MAX_TERM_LENGTH || b.length > MAX_TERM_LENGTH) {
    return Math.abs(a.length - b.length) + MAX_TERM_LENGTH;
  }
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function tokenize(query) {
  return String(query || '')
    .slice(0, MAX_QUERY_LENGTH)
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 1)
    .slice(0, 12);
}

/**
 * Build an FTS5 MATCH expression.
 *
 * The tokens are wrapped in double quotes, so a token containing a quote used
 * to break out of the phrase and let the caller inject FTS operators (NEAR,
 * column filters, unbalanced syntax that throws). Everything except letters,
 * digits, dot, underscore and dash is stripped first - FTS5 has no bound
 * parameters inside a MATCH string, so escaping is the only option.
 */
function sanitizeFtsToken(token) {
  return token.replace(/[^\p{L}\p{N}._-]+/gu, ' ').trim();
}

function buildFtsQuery(query) {
  // Convert "ubuntu 24.04" to "ubuntu* 24.04*"
  const tokens = tokenize(query)
    .map(sanitizeFtsToken)
    .filter(t => t.length > 1);
  if (tokens.length === 0) return '';
  // Use prefix matching for typo tolerance: token*
  // Also handle OR for better recall
  return tokens.map(t => `"${t}"*`).join(' OR ');
}

export class SearchService {
  search({
    q = '',
    category = null,
    file_type = null,
    platform = null,
    architecture = null,
    sort = 'relevance',
    order = 'desc',
    page = 1,
    limit = 20,
    featured = null,
    published = 1,
  } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;
    let results = [];
    let total = 0;

    const conditions = [];
    const params = {};

    if (published !== null && published !== undefined) {
      conditions.push('items.published = @published');
      params.published = published ? 1 : 0;
    }

    if (category) {
      // category can be slug or id
      const cat = db.prepare('SELECT id FROM categories WHERE slug = ? OR id = ?').get(category, category);
      if (cat) {
        conditions.push('items.category_id = @category_id');
        params.category_id = cat.id;
      }
    }

    if (file_type) {
      conditions.push('items.file_type = @file_type');
      params.file_type = file_type;
    }

    if (platform) {
      conditions.push('items.platform = @platform');
      params.platform = platform;
    }

    if (architecture) {
      conditions.push('items.architecture = @architecture');
      params.architecture = architecture;
    }

    if (featured !== null) {
      conditions.push('items.featured = @featured');
      params.featured = featured ? 1 : 0;
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    if (q && q.trim().length > 0) {
      const ftsQuery = buildFtsQuery(q);
      // Try FTS search first
      try {
        const countQuery = `
          SELECT COUNT(*) as total FROM items
          JOIN items_fts ON items.id = items_fts.rowid
          ${whereClause ? whereClause + ' AND' : 'WHERE'} items_fts MATCH @ftsQuery
        `;
        const countResult = db.prepare(countQuery).get({ ...params, ftsQuery });
        total = countResult?.total || 0;

        // Get ranked results
        let orderClause = 'ORDER BY rank';
        if (sort === 'name') orderClause = `ORDER BY items.name ${order === 'desc' ? 'DESC' : 'ASC'}`;
        if (sort === 'date') orderClause = `ORDER BY items.created_at ${order === 'desc' ? 'DESC' : 'ASC'}`;
        if (sort === 'size') orderClause = `ORDER BY items.file_size ${order === 'desc' ? 'DESC' : 'ASC'}`;
        if (sort === 'popular') orderClause = `ORDER BY items.download_count ${order === 'desc' ? 'DESC' : 'ASC'}`;

        const searchQuery = `
          SELECT items.*, categories.name as category_name, categories.slug as category_slug,
                 items_fts.rank as fts_rank
          FROM items
          JOIN items_fts ON items.id = items_fts.rowid
          LEFT JOIN categories ON items.category_id = categories.id
          ${whereClause ? whereClause + ' AND' : 'WHERE'} items_fts MATCH @ftsQuery
          ${orderClause}
          LIMIT @limit OFFSET @offset
        `;

        results = db.prepare(searchQuery).all({
          ...params,
          ftsQuery,
          limit,
          offset,
        });

        // If FTS returned nothing, fallback to LIKE with typo tolerance
        if (results.length === 0 && total === 0) {
          return this.fallbackLikeSearch({ q, category, file_type, platform, architecture, sort, order, page, limit, featured, published });
        }

        // Enhance with Levenshtein for typo tolerance ranking if needed
        if (sort === 'relevance') {
          results = this.rerankWithLevenshtein(results, q);
        }

      } catch (e) {
        console.warn('FTS search failed, fallback:', e.message);
        return this.fallbackLikeSearch({ q, category, file_type, platform, architecture, sort, order, page, limit, featured, published });
      }
    } else {
      // No query, just filter
      const countQuery = `
        SELECT COUNT(*) as total FROM items
        ${whereClause}
      `;
      total = db.prepare(countQuery).get(params)?.total || 0;

      let orderClause = 'ORDER BY items.created_at DESC';
      if (sort === 'name') orderClause = `ORDER BY items.name ${order === 'desc' ? 'DESC' : 'ASC'}`;
      if (sort === 'date') orderClause = `ORDER BY items.created_at ${order === 'desc' ? 'DESC' : 'ASC'}`;
      if (sort === 'size') orderClause = `ORDER BY items.file_size ${order === 'desc' ? 'DESC' : 'ASC'}`;
      if (sort === 'popular') orderClause = `ORDER BY items.download_count ${order === 'desc' ? 'DESC' : 'ASC'}`;
      if (sort === 'version') orderClause = `ORDER BY items.version ${order === 'desc' ? 'DESC' : 'ASC'}`;

      const query = `
        SELECT items.*, categories.name as category_name, categories.slug as category_slug
        FROM items
        LEFT JOIN categories ON items.category_id = categories.id
        ${whereClause}
        ${orderClause}
        LIMIT @limit OFFSET @offset
      `;
      results = db.prepare(query).all({ ...params, limit, offset });
    }

    return {
      results,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  fallbackLikeSearch({ q, category, file_type, platform, architecture, sort, order, page, limit, featured, published }) {
    const db = getDb();
    const offset = (page - 1) * limit;
    const likeQ = `%${q.toLowerCase()}%`;

    const conditions = [];
    const params = { likeQ };

    if (published !== null) {
      conditions.push('items.published = @published');
      params.published = published ? 1 : 0;
    }
    if (category) {
      const cat = db.prepare('SELECT id FROM categories WHERE slug = ? OR id = ?').get(category, category);
      if (cat) {
        conditions.push('items.category_id = @category_id');
        params.category_id = cat.id;
      }
    }
    if (file_type) {
      conditions.push('items.file_type = @file_type');
      params.file_type = file_type;
    }
    if (platform) {
      conditions.push('items.platform = @platform');
      params.platform = platform;
    }
    if (architecture) {
      conditions.push('items.architecture = @architecture');
      params.architecture = architecture;
    }
    if (featured !== null) {
      conditions.push('items.featured = @featured');
      params.featured = featured ? 1 : 0;
    }

    // Search in multiple fields
    conditions.push(`(
      LOWER(items.name) LIKE @likeQ OR
      LOWER(items.description) LIKE @likeQ OR
      LOWER(items.file_name) LIKE @likeQ OR
      LOWER(items.version) LIKE @likeQ OR
      LOWER(items.tags) LIKE @likeQ
    )`);

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countQuery = `SELECT COUNT(*) as total FROM items ${whereClause}`;
    const total = db.prepare(countQuery).get(params)?.total || 0;

    let orderClause = 'ORDER BY items.created_at DESC';
    if (sort === 'name') orderClause = `ORDER BY items.name ${order === 'desc' ? 'DESC' : 'ASC'}`;

    const query = `
      SELECT items.*, categories.name as category_name, categories.slug as category_slug
      FROM items
      LEFT JOIN categories ON items.category_id = categories.id
      ${whereClause}
      ${orderClause}
      LIMIT @limit OFFSET @offset
    `;

    let results = db.prepare(query).all({ ...params, limit, offset });

    // Rerank with Levenshtein for typo tolerance
    results = this.rerankWithLevenshtein(results, q);

    return {
      results,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  rerankWithLevenshtein(results, query) {
    const qLower = query.toLowerCase();
    return results
      .map(item => {
        const nameDist = levenshtein(qLower, item.name.toLowerCase().slice(0, qLower.length + 10));
        const fileDist = item.file_name ? levenshtein(qLower, item.file_name.toLowerCase().slice(0, qLower.length + 10)) : 10;
        const minDist = Math.min(nameDist, fileDist);
        // Boost if exact substring
        const substringBoost = item.name.toLowerCase().includes(qLower) ? -5 : 0;
        return { ...item, _levDist: minDist + substringBoost };
      })
      .sort((a, b) => a._levDist - b._levDist)
      .map(({ _levDist, ...rest }) => rest);
  }

  getPopular(limit = 10) {
    const db = getDb();
    return db.prepare(`
      SELECT items.*, categories.name as category_name, categories.slug as category_slug
      FROM items
      LEFT JOIN categories ON items.category_id = categories.id
      WHERE items.published = 1
      ORDER BY items.download_count DESC, items.view_count DESC
      LIMIT ?
    `).all(limit);
  }

  getRecent(limit = 10) {
    const db = getDb();
    return db.prepare(`
      SELECT items.*, categories.name as category_name, categories.slug as category_slug
      FROM items
      LEFT JOIN categories ON items.category_id = categories.id
      WHERE items.published = 1
      ORDER BY items.created_at DESC
      LIMIT ?
    `).all(limit);
  }

  getFeatured(limit = 10) {
    const db = getDb();
    return db.prepare(`
      SELECT items.*, categories.name as category_name, categories.slug as category_slug
      FROM items
      LEFT JOIN categories ON items.category_id = categories.id
      WHERE items.published = 1 AND items.featured = 1
      ORDER BY items.created_at DESC
      LIMIT ?
    `).all(limit);
  }
}

export const searchService = new SearchService();
