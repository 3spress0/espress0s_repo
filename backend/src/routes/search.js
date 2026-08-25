export async function searchRoutes(fastify) {
  fastify.get('/search', async (request, reply) => {
    const {
      q = '',
      category,
      file_type,
      platform,
      architecture,
      sort = 'relevance',
      order = 'desc',
      page = 1,
      limit = 20,
    } = request.query;

    const { searchService } = await import('../services/searchService.js');

    const result = searchService.search({
      q,
      category: category || null,
      file_type: file_type || null,
      platform: platform || null,
      architecture: architecture || null,
      sort,
      order,
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 50),
      published: 1,
    });

    return {
      query: q,
      results: result.results,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
      filters: {
        category,
        file_type,
        platform,
        architecture,
      }
    };
  });

  fastify.get('/search/suggestions', async (request, reply) => {
    const { q } = request.query;
    if (!q || q.length < 2) return { suggestions: [] };

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
