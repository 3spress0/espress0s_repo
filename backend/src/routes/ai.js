import { aiQuerySchema } from '../utils/validation.js';
import { aiService } from '../services/aiService.js';
import { getDb } from '../db/index.js';

// Each ask can spawn a tgpt subprocess, so this endpoint is far more
// expensive than a normal read. Keep it well under the global limit.
const askRateLimit = { config: { rateLimit: { max: 15, timeWindow: '5 minutes' } } };
const MAX_QUESTION_LENGTH = 500;

export async function aiRoutes(fastify) {
  // GET /api/ai/ask?q=...
  fastify.get('/ai/ask', askRateLimit, async (request, reply) => {
    const { q, question } = request.query;
    const query = String(q || question || '').slice(0, MAX_QUESTION_LENGTH);

    if (query.length < 2) {
      return reply.code(400).send({ error: 'Query too short, min 2 chars' });
    }

    try {
      const result = await aiService.ask(query, { limit: 5 });
      return result;
    } catch (e) {
      request.log.error(e);
      return reply.code(500).send({ error: 'AI service error' });
    }
  });

  // POST /api/ai/ask
  fastify.post('/ai/ask', askRateLimit, async (request, reply) => {
    const parsed = aiQuerySchema.safeParse(request.body || request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid input', details: parsed.error.errors });
    }

    const query = String(parsed.data.q || parsed.data.question || '').slice(0, MAX_QUESTION_LENGTH);
    if (!query) return reply.code(400).send({ error: 'Missing question' });

    try {
      const result = await aiService.ask(query, { limit: 5 });
      return result;
    } catch (e) {
      request.log.error(e);
      return reply.code(500).send({ error: 'AI service error' });
    }
  });

  fastify.get('/ai/suggestions', async (request, reply) => {
    const suggestions = await aiService.getSuggestions();
    return { suggestions };
  });

  fastify.get('/ai/status', async (request, reply) => {
    const available = await aiService.checkTgptAvailable();
    return {
      tgptAvailable: available,
      provider: 'tgpt + metadata search',
      fallback: 'rule-based metadata search',
      enabled: true,
    };
  });

  // FAQ endpoints
  fastify.get('/faq', async (request, reply) => {
    const db = getDb();
    const faqs = db.prepare('SELECT * FROM faq_entries ORDER BY created_at DESC').all();
    return { faqs };
  });

  fastify.post('/faq', {
    preHandler: [(await import('../middleware/auth.js')).authenticate, (await import('../middleware/auth.js')).requireAdmin]
  }, async (request, reply) => {
    const { question, answer, category, related_item_ids } = request.body;
    if (!question || !answer) return reply.code(400).send({ error: 'Question and answer required' });

    const db = getDb();
    const result = db.prepare(`
      INSERT INTO faq_entries (question, answer, category, related_item_ids)
      VALUES (?, ?, ?, ?)
    `).run(question, answer, category || null, related_item_ids ? JSON.stringify(related_item_ids) : null);

    const newFaq = db.prepare('SELECT * FROM faq_entries WHERE id = ?').get(result.lastInsertRowid);
    return reply.code(201).send(newFaq);
  });
}
