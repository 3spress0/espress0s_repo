import { getDb } from '../db/index.js';

export async function statsRoutes(fastify) {
  fastify.get('/stats', async (request, reply) => {
    const db = getDb();

    const totalItems = db.prepare('SELECT COUNT(*) as c FROM items WHERE published = 1').get().c;
    const totalCategories = db.prepare('SELECT COUNT(*) as c FROM categories').get().c;
    const totalSizeResult = db.prepare('SELECT SUM(file_size) as total FROM items WHERE published = 1').get();
    const totalDownloads = db.prepare('SELECT SUM(download_count) as total FROM items').get().total || 0;

    const byCategory = db.prepare(`
      SELECT c.name, c.slug, c.icon, c.color, COUNT(i.id) as count
      FROM categories c
      LEFT JOIN items i ON i.category_id = c.id AND i.published = 1
      GROUP BY c.id
      ORDER BY count DESC
    `).all();

    const byPlatform = db.prepare(`
      SELECT platform, COUNT(*) as count FROM items 
      WHERE published = 1 AND platform IS NOT NULL 
      GROUP BY platform ORDER BY count DESC
    `).all();

    const byArch = db.prepare(`
      SELECT architecture, COUNT(*) as count FROM items 
      WHERE published = 1 AND architecture IS NOT NULL 
      GROUP BY architecture ORDER BY count DESC
    `).all();

    const byFileType = db.prepare(`
      SELECT file_type, COUNT(*) as count FROM items 
      WHERE published = 1 AND file_type IS NOT NULL 
      GROUP BY file_type ORDER BY count DESC
    `).all();

    const recent = db.prepare(`
      SELECT id, name, slug, created_at FROM items 
      WHERE published = 1 ORDER BY created_at DESC LIMIT 5
    `).all();

    return {
      totals: {
        items: totalItems,
        categories: totalCategories,
        totalSize: totalSizeResult.total || 0,
        totalSizeFormatted: formatBytes(totalSizeResult.total || 0),
        totalDownloads,
      },
      byCategory,
      byPlatform,
      byArchitecture: byArch,
      byFileType,
      recent,
    };
  });
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
