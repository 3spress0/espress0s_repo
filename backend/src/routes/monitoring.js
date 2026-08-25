import { monitoringService } from '../services/monitoringService.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import fs from 'fs';

export async function monitoringRoutes(fastify) {
  // Public health (basic)
  fastify.get('/monitoring/health', async (request, reply) => {
    const db = getDb();
    let dbStatus = 'ok';
    let dbError = null;
    
    try {
      db.prepare('SELECT 1').get();
    } catch (e) {
      dbStatus = 'error';
      dbError = e.message;
    }

    return {
      status: dbStatus === 'ok' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      service: "espress0's repo",
      version: '1.0.0',
      checks: {
        database: { status: dbStatus, error: dbError },
        encryption: { 
          status: process.env.ENCRYPTION_KEY ? 'ok' : 'warning',
          message: process.env.ENCRYPTION_KEY ? 'ENCRYPTION_KEY set' : 'Using derived key (set ENCRYPTION_KEY in prod)'
        },
        captcha: {
          status: 'ok',
          type: process.env.CAPTCHA_TYPE || 'math'
        }
      },
      uptime: monitoringService.getSystemMetrics().uptime
    };
  });

  // Detailed metrics (admin only)
  fastify.get('/monitoring/metrics', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    return monitoringService.getAllMetrics();
  });

  // Prometheus metrics (admin only, or with token)
  fastify.get('/monitoring/prometheus', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    reply.header('Content-Type', 'text/plain; version=0.0.4');
    return monitoringService.getPrometheusMetrics();
  });

  // System only
  fastify.get('/monitoring/system', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    return monitoringService.getSystemMetrics();
  });

  // Requests only
  fastify.get('/monitoring/requests', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    return monitoringService.getRequestMetrics();
  });

  // Database only
  fastify.get('/monitoring/database', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    return monitoringService.getDatabaseMetrics();
  });

  // Logs info (not raw logs for security, but stats)
  fastify.get('/monitoring/logs', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const db = getDb();
    
    // Get recent items as activity
    const recentItems = db.prepare('SELECT id, name, slug, created_at FROM items ORDER BY created_at DESC LIMIT 10').all();
    const recentUsers = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC LIMIT 10').all();
    
    // Get backup info
    let backups = [];
    try {
      const backupDir = './backups';
      if (fs.existsSync(backupDir)) {
        backups = fs.readdirSync(backupDir).map(f => {
          const stat = fs.statSync(`${backupDir}/${f}`);
          return {
            name: f,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            encrypted: f.includes('.enc.')
          };
        }).sort((a, b) => new Date(b.modified) - new Date(a.modified)).slice(0, 10);
      }
    } catch {}

    return {
      recentActivity: {
        items: recentItems,
        users: recentUsers,
      },
      backups,
      requestMetrics: monitoringService.getRequestMetrics(),
      system: {
        uptime: monitoringService.getSystemMetrics().uptime,
        memory: monitoringService.getSystemMetrics().process.memory,
      }
    };
  });

  // Reset metrics (admin)
  fastify.post('/monitoring/reset', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    monitoringService.requestCount = 0;
    monitoringService.errorCount = 0;
    monitoringService.statusCodes = {};
    monitoringService.responseTimes = [];
    monitoringService.endpoints = {};
    monitoringService.failedLogins = 0;
    monitoringService.successfulLogins = 0;
    monitoringService.captchaGenerated = 0;
    monitoringService.captchaFailed = 0;
    monitoringService.downloads = 0;
    
    return { success: true, message: 'Metrics reset' };
  });
}
