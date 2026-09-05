import os from 'os';
import fs from 'fs';
import { getDb } from '../db/index.js';

class MonitoringService {
  constructor() {
    this.startTime = Date.now();
    this.requestCount = 0;
    this.errorCount = 0;
    this.statusCodes = {};
    this.responseTimes = [];
    this.endpoints = {};
    this.failedLogins = 0;
    this.successfulLogins = 0;
    this.captchaGenerated = 0;
    this.captchaFailed = 0;
    this.downloads = 0;
  }

  recordRequest(req, reply, responseTime) {
    this.requestCount++;
    
    const status = reply.statusCode;
    this.statusCodes[status] = (this.statusCodes[status] || 0) + 1;
    
    if (status >= 400) this.errorCount++;
    
    // Keep last 100 response times for avg
    this.responseTimes.push(responseTime);
    if (this.responseTimes.length > 100) this.responseTimes.shift();
    
    const endpoint = `${req.method} ${req.routerPath || req.url.split('?')[0]}`;
    this.endpoints[endpoint] = (this.endpoints[endpoint] || 0) + 1;

    // Track specific events
    if (req.url.includes('/auth/login')) {
      if (status === 200) this.successfulLogins++;
      else if (status === 401) this.failedLogins++;
    }
    if (req.url.includes('/captcha') && req.method === 'GET') this.captchaGenerated++;
    if (req.url.includes('/download')) this.downloads++;
  }

  recordCaptchaFailed() {
    this.captchaFailed++;
  }

  getSystemMetrics() {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    const uptime = process.uptime();
    const uptimeMs = Date.now() - this.startTime;

    return {
      timestamp: new Date().toISOString(),
      uptime: {
        seconds: Math.floor(uptime),
        human: this.formatUptime(uptime),
        since: new Date(this.startTime).toISOString(),
        ms: uptimeMs
      },
      process: {
        pid: process.pid,
        nodeVersion: process.version,
        memory: {
          rss: this.formatBytes(memUsage.rss),
          heapUsed: this.formatBytes(memUsage.heapUsed),
          heapTotal: this.formatBytes(memUsage.heapTotal),
          external: this.formatBytes(memUsage.external),
          raw: memUsage
        },
        cpu: {
          user: cpuUsage.user,
          system: cpuUsage.system
        }
      },
      system: {
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model || 'unknown',
        loadAvg: os.loadavg(),
        totalMem: this.formatBytes(os.totalmem()),
        freeMem: this.formatBytes(os.freemem()),
        usedMem: this.formatBytes(os.totalmem() - os.freemem()),
        memUsagePercent: ((1 - os.freemem() / os.totalmem()) * 100).toFixed(1) + '%'
      }
    };
  }

  getRequestMetrics() {
    const avgResponseTime = this.responseTimes.length 
      ? (this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length).toFixed(2)
      : 0;

    return {
      totalRequests: this.requestCount,
      totalErrors: this.errorCount,
      errorRate: this.requestCount ? ((this.errorCount / this.requestCount) * 100).toFixed(2) + '%' : '0%',
      avgResponseTime: avgResponseTime + 'ms',
      statusCodes: this.statusCodes,
      topEndpoints: Object.entries(this.endpoints)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([endpoint, count]) => ({ endpoint, count })),
      auth: {
        successfulLogins: this.successfulLogins,
        failedLogins: this.failedLogins,
        loginSuccessRate: (this.successfulLogins + this.failedLogins) 
          ? ((this.successfulLogins / (this.successfulLogins + this.failedLogins)) * 100).toFixed(1) + '%'
          : 'N/A'
      },
      captcha: {
        generated: this.captchaGenerated,
        failed: this.captchaFailed,
        successRate: this.captchaGenerated
          ? (((this.captchaGenerated - this.captchaFailed) / this.captchaGenerated) * 100).toFixed(1) + '%'
          : 'N/A'
      },
      downloads: this.downloads
    };
  }

  getDatabaseMetrics() {
    try {
      const db = getDb();
      const dbPath = db.name;
      
      let size = 0;
      let sizeFormatted = '0 B';
      try {
        const stats = fs.statSync(dbPath);
        size = stats.size;
        sizeFormatted = this.formatBytes(size);
      } catch {}

      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'").all();
      
      const counts = {};
      for (const table of tables) {
        try {
          const count = db.prepare(`SELECT COUNT(*) as c FROM ${table.name}`).get();
          counts[table.name] = count.c;
        } catch {
          counts[table.name] = 0;
        }
      }

      // Encryption stats
      let encStats = {};
      try {
        encStats = {
          encryptedEmails: db.prepare("SELECT COUNT(*) as c FROM users WHERE email LIKE 'enc_v1:%'").get().c,
          pepperedPasswords: db.prepare("SELECT COUNT(*) as c FROM users WHERE password_hash LIKE 'pepper_v1:%'").get().c,
          encryptedStorage: db.prepare("SELECT COUNT(*) as c FROM items WHERE storage_path LIKE 'enc_v1:%'").get().c,
        };
      } catch {}

      return {
        path: dbPath,
        size: sizeFormatted,
        sizeBytes: size,
        tables: tables.map(t => t.name),
        counts,
        encryption: encStats,
        ftsCount: db.prepare("SELECT COUNT(*) as c FROM items_fts").get().c,
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  getStorageMetrics() {
    try {
      const { storageManager } = require('../services/storage/index.js');
      return storageManager.listProviders();
    } catch {
      return [
        { id: 'local', name: 'Local Storage (Dev Only)', enabled: true },
        { id: 'gdrive', name: 'Google Drive', enabled: true },
        { id: 'onedrive', name: 'Microsoft OneDrive', enabled: true },
        { id: 'external', name: 'External URL', enabled: true },
        { id: 'github', name: 'GitHub Releases', enabled: true },
      ];
    }
  }

  getAllMetrics() {
    return {
      system: this.getSystemMetrics(),
      requests: this.getRequestMetrics(),
      database: this.getDatabaseMetrics(),
      storage: this.getStorageMetrics(),
    };
  }

  formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }

  // Prometheus-style metrics
  getPrometheusMetrics() {
    const sys = this.getSystemMetrics();
    const req = this.getRequestMetrics();
    const db = this.getDatabaseMetrics();

    let metrics = '';
    metrics += `# HELP espress0_uptime_seconds Uptime in seconds\n`;
    metrics += `# TYPE espress0_uptime_seconds gauge\n`;
    metrics += `espress0_uptime_seconds ${sys.uptime.seconds}\n\n`;

    metrics += `# HELP espress0_memory_rss_bytes RSS memory\n`;
    metrics += `# TYPE espress0_memory_rss_bytes gauge\n`;
    metrics += `espress0_memory_rss_bytes ${sys.process.memory.raw.rss}\n\n`;

    metrics += `# HELP espress0_requests_total Total requests\n`;
    metrics += `# TYPE espress0_requests_total counter\n`;
    metrics += `espress0_requests_total ${req.totalRequests}\n\n`;

    metrics += `# HELP espress0_errors_total Total errors\n`;
    metrics += `# TYPE espress0_errors_total counter\n`;
    metrics += `espress0_errors_total ${req.totalErrors}\n\n`;

    metrics += `# HELP espress0_failed_logins_total Failed logins\n`;
    metrics += `# TYPE espress0_failed_logins_total counter\n`;
    metrics += `espress0_failed_logins_total ${req.auth.failedLogins}\n\n`;

    metrics += `# HELP espress0_items_total Total items\n`;
    metrics += `# TYPE espress0_items_total gauge\n`;
    metrics += `espress0_items_total ${db.counts?.items || 0}\n\n`;

    metrics += `# HELP espress0_users_total Total users\n`;
    metrics += `# TYPE espress0_users_total gauge\n`;
    metrics += `espress0_users_total ${db.counts?.users || 0}\n\n`;

    return metrics;
  }
}

export const monitoringService = new MonitoringService();
