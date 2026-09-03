export async function searchRoutes(fastify) {
  fastify.get('/search', async (request, reply) => {
    const {
      q = '',
      category,
      folder,
      tag,
      license_status,
      file_type,
      platform,
      architecture,
      sort = 'relevance',
      order = 'desc',
      page = 1,
      limit = 20,
      featured,
    } = request.query;

    const { searchService, MAX_QUERY_LENGTH } = await import('../services/searchService.js');

    // Query strings are attacker-controlled: clamp them before they reach the
    // query builder so NaN cannot flow into LIMIT/OFFSET and an oversized `q`
    // cannot drive the fuzzy ranker.
    const toInt = (value, fallback, min, max) => {
      const n = parseInt(value, 10);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(Math.max(n, min), max);
    };
    const safeQ = String(q ?? '').slice(0, MAX_QUERY_LENGTH);

    const result = searchService.search({
      q: safeQ,
      category: category || null,
      folder: folder || null,
      tag: tag ? String(tag).slice(0, 64) : null,
      license_status: license_status || null,
      file_type: file_type || null,
      platform: platform || null,
      architecture: architecture || null,
      sort,
      order,
      page: toInt(page, 1, 1, 1000),
      limit: toInt(limit, 20, 1, 50),
      featured: featured !== undefined ? (featured === 'true' || featured === '1' ? 1 : 0) : null,
      published: 1,
    });

    return {
      query: safeQ,
      // Set only when nothing matched as typed and a close catalogue word did,
      // so the UI can say "showing results for ..." instead of silently
      // answering a different question.
      correctedQuery: result.correctedQuery || null,
      corrections: result.corrections || [],
      results: result.results,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
      filters: {
        category,
        folder,
        tag,
        license_status,
        file_type,
        platform,
        architecture,
      }
    };
  });

  fastify.get('/search/suggestions', async (request, reply) => {
    // Duplicated query params arrive as arrays; coerce before using string
    // methods so `?q=a&q=b` cannot turn into a 500.
    const q = String(request.query?.q ?? '').slice(0, 128);
    if (q.length < 2) return { suggestions: [] };

    const { getDb } = await import('../db/index.js');
    const db = getDb();

    // Simple suggestions from item names
    const suggestions = db.prepare(`
      SELECT name, slug, file_type FROM items 
      WHERE published = 1 AND LOWER(name) LIKE @q
      ORDER BY download_count DESC LIMIT 8
    `).all({ q: `%${q.toLowerCase()}%` });

    return { suggestions };
  });
}
