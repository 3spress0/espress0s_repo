import { useState, useEffect } from 'react';
import { Activity, Cpu, HardDrive, Database, Clock, AlertTriangle, Check, Zap, Download, Users, Shield, RefreshCw, Terminal, BarChart3 } from 'lucide-react';
import api from '../lib/api';

export default function Monitoring() {
  const [metrics, setMetrics] = useState(null);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchMetrics = async () => {
    try {
      const [metricsRes, healthRes] = await Promise.all([
        api.get('/monitoring/metrics').catch(() => null),
        api.get('/monitoring/health').catch(() => null),
      ]);
      
      if (metricsRes) setMetrics(metricsRes.data);
      if (healthRes) setHealth(healthRes.data);
      setError('');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load metrics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMetrics();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  const handleReset = async () => {
    if (!confirm('Reset request metrics?')) return;
    try {
      await api.post('/monitoring/reset');
      fetchMetrics();
    } catch (e) {
      setError('Failed to reset');
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-24 glass rounded-2xl border border-white/5 animate-pulse" />
        ))}
      </div>
    );
  }

  if (error && !metrics) {
    return (
      <div className="p-6 glass rounded-2xl border border-red-500/20 bg-red-500/5 text-center">
        <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-red-400" />
        <p className="text-sm text-red-400">{error}</p>
        <button onClick={fetchMetrics} className="mt-3 px-4 py-2 bg-surface border border-border rounded-xl text-sm">Retry</button>
      </div>
    );
  }

  const sys = metrics?.system;
  const req = metrics?.requests;
  const db = metrics?.database;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-textPrimary flex items-center gap-2">
            <Activity className="w-5 h-5 text-green-400" />
            Monitoring Dashboard
          </h2>
          <p className="text-sm text-textMuted mt-1">Live system, requests, database, security metrics</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-textMuted">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto-refresh 5s
          </label>
          <button onClick={fetchMetrics} className="p-2.5 rounded-xl bg-surface border border-border hover:border-primary/30">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={handleReset} className="px-3 py-2 rounded-xl bg-surface border border-border text-xs hover:border-amber-500/30">
            Reset counters
          </button>
        </div>
      </div>

      {health && (
        <div className={`glass rounded-2xl border p-4 flex items-center gap-3 ${health.status === 'ok' ? 'border-green-500/20 bg-green-500/5' : 'border-amber-500/20 bg-amber-500/5'}`}>
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${health.status === 'ok' ? 'bg-green-500/10 border border-green-500/20' : 'bg-amber-500/10 border border-amber-500/20'}`}>
            {health.status === 'ok' ? <Check className="w-5 h-5 text-green-400" /> : <AlertTriangle className="w-5 h-5 text-amber-400" />}
          </div>
          <div className="flex-1">
            <div className="font-semibold text-textPrimary">System {health.status} • Uptime {health.uptime?.human}</div>
            <div className="text-xs text-textMuted mt-1 flex flex-wrap gap-3">
              <span>DB: {health.checks?.database?.status}</span>
              <span>Encryption: {health.checks?.encryption?.status}</span>
              <span>CAPTCHA: {health.checks?.captcha?.type}</span>
            </div>
          </div>
          <div className="text-xs text-textMuted">{new Date(health.timestamp).toLocaleTimeString()}</div>
        </div>
      )}

      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="glass rounded-2xl border border-white/5 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-violet-500 flex items-center justify-center"><Activity className="w-5 h-5 text-white" /></div>
            <span className="text-xs text-textMuted">Total</span>
          </div>
          <div className="text-2xl font-bold text-textPrimary">{req?.totalRequests || 0}</div>
          <div className="text-xs text-textMuted uppercase tracking-widest">Requests</div>
          <div className="mt-2 text-xs text-textMuted">Errors: {req?.totalErrors || 0} ({req?.errorRate || '0%'})</div>
        </div>

        <div className="glass rounded-2xl border border-white/5 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center"><Clock className="w-5 h-5 text-white" /></div>
            <span className="text-xs text-textMuted">Avg</span>
          </div>
          <div className="text-2xl font-bold text-textPrimary">{req?.avgResponseTime || '0ms'}</div>
          <div className="text-xs text-textMuted uppercase tracking-widest">Response Time</div>
          <div className="mt-2 text-xs text-textMuted">Uptime: {sys?.uptime?.human || '—'}</div>
        </div>

        <div className="glass rounded-2xl border border-white/5 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center"><Database className="w-5 h-5 text-white" /></div>
            <span className="text-xs text-textMuted">DB</span>
          </div>
          <div className="text-2xl font-bold text-textPrimary">{db?.size || '—'}</div>
          <div className="text-xs text-textMuted uppercase tracking-widest">Database Size</div>
          <div className="mt-2 text-xs text-textMuted">{db?.counts?.items || 0} items, {db?.counts?.users || 0} users</div>
        </div>

        <div className="glass rounded-2xl border border-white/5 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-pink-500 flex items-center justify-center"><Shield className="w-5 h-5 text-white" /></div>
            <span className="text-xs text-textMuted">Auth</span>
          </div>
          <div className="text-2xl font-bold text-textPrimary">{req?.auth?.failedLogins || 0}</div>
          <div className="text-xs text-textMuted uppercase tracking-widest">Failed Logins</div>
          <div className="mt-2 text-xs text-textMuted">Success: {req?.auth?.successfulLogins || 0} ({req?.auth?.loginSuccessRate || '—'})</div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <div className="glass rounded-2xl border border-white/5 p-6">
          <h3 className="font-semibold text-textPrimary flex items-center gap-2 mb-4">
            <Cpu className="w-4 h-4 text-primary" />
            System Resources
          </h3>
          {sys ? (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 rounded-xl bg-surface border border-border">
                  <div className="text-xs text-textMuted uppercase tracking-widest">Memory RSS</div>
                  <div className="font-bold text-textPrimary mt-1">{sys.process.memory.rss}</div>
                  <div className="text-xs text-textMuted">Heap: {sys.process.memory.heapUsed} / {sys.process.memory.heapTotal}</div>
                </div>
                <div className="p-3 rounded-xl bg-surface border border-border">
                  <div className="text-xs text-textMuted uppercase tracking-widest">System Memory</div>
                  <div className="font-bold text-textPrimary mt-1">{sys.system.usedMem} / {sys.system.totalMem}</div>
                  <div className="text-xs text-textMuted">{sys.system.memUsagePercent} used, {sys.system.freeMem} free</div>
                </div>
              </div>
              <div className="p-3 rounded-xl bg-surface border border-border">
                <div className="text-xs text-textMuted uppercase tracking-widest">CPU & Load</div>
                <div className="mt-2 space-y-1 text-xs">
                  <div className="flex justify-between"><span>Model</span><span className="font-mono truncate max-w-[200px]">{sys.system.cpuModel}</span></div>
                  <div className="flex justify-between"><span>Cores</span><span>{sys.system.cpus}</span></div>
                  <div className="flex justify-between"><span>Load Avg (1m,5m,15m)</span><span>{sys.system.loadAvg.map(n=>n.toFixed(2)).join(', ')}</span></div>
                  <div className="flex justify-between"><span>Platform</span><span>{sys.system.platform} {sys.system.arch}</span></div>
                </div>
              </div>
              <div className="p-3 rounded-xl bg-surface border border-border">
                <div className="text-xs text-textMuted uppercase tracking-widest">Process</div>
                <div className="mt-2 space-y-1 text-xs font-mono">
                  <div className="flex justify-between"><span>PID</span><span>{sys.process.pid}</span></div>
                  <div className="flex justify-between"><span>Node</span><span>{sys.process.nodeVersion}</span></div>
                  <div className="flex justify-between"><span>Uptime</span><span>{sys.uptime.human} ({sys.uptime.seconds}s)</span></div>
                </div>
              </div>
            </div>
          ) : <div className="text-sm text-textMuted">No system data</div>}
        </div>

        <div className="space-y-6">
          <div className="glass rounded-2xl border border-white/5 p-6">
            <h3 className="font-semibold text-textPrimary flex items-center gap-2 mb-4">
              <BarChart3 className="w-4 h-4 text-secondary" />
              Top Endpoints
            </h3>
            {req?.topEndpoints?.length ? (
              <div className="space-y-2">
                {req.topEndpoints.map((ep, i) => (
                  <div key={i} className="flex items-center justify-between p-2.5 rounded-xl bg-surface border border-border text-sm">
                    <span className="font-mono text-xs truncate max-w-[250px]">{ep.endpoint}</span>
                    <span className="px-2.5 py-1 rounded-full bg-primary/10 text-primary text-xs font-bold">{ep.count}</span>
                  </div>
                ))}
              </div>
            ) : <div className="text-sm text-textMuted">No endpoint data yet</div>}
          </div>

          <div className="glass rounded-2xl border border-white/5 p-6">
            <h3 className="font-semibold text-textPrimary flex items-center gap-2 mb-4">
              <Zap className="w-4 h-4 text-amber-400" />
              Security Metrics
            </h3>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="p-3 rounded-xl bg-surface border border-border text-center">
                <div className="text-lg font-bold text-textPrimary">{req?.auth?.successfulLogins || 0}</div>
                <div className="text-xs text-textMuted">Successful Logins</div>
              </div>
              <div className="p-3 rounded-xl bg-surface border border-border text-center">
                <div className="text-lg font-bold text-red-400">{req?.auth?.failedLogins || 0}</div>
                <div className="text-xs text-textMuted">Failed Logins</div>
              </div>
              <div className="p-3 rounded-xl bg-surface border border-border text-center">
                <div className="text-lg font-bold text-textPrimary">{req?.captcha?.generated || 0}</div>
                <div className="text-xs text-textMuted">CAPTCHA Generated</div>
              </div>
              <div className="p-3 rounded-xl bg-surface border border-border text-center">
                <div className="text-lg font-bold text-amber-400">{req?.captcha?.failed || 0}</div>
                <div className="text-xs text-textMuted">CAPTCHA Failed</div>
              </div>
              <div className="p-3 rounded-xl bg-surface border border-border text-center col-span-2">
                <div className="text-lg font-bold text-blue-400">{req?.downloads || 0}</div>
                <div className="text-xs text-textMuted">Total Downloads (redirects)</div>
              </div>
            </div>
            <div className="mt-4 p-3 rounded-xl bg-surface border border-border">
              <div className="text-xs text-textMuted uppercase tracking-widest mb-2">Status Codes</div>
              <div className="flex flex-wrap gap-2">
                {req?.statusCodes && Object.entries(req.statusCodes).map(([code, count]) => (
                  <span key={code} className={`px-2.5 py-1 rounded-full text-xs font-mono ${code.startsWith('2') ? 'bg-green-500/10 text-green-400' : code.startsWith('4') ? 'bg-amber-500/10 text-amber-400' : 'bg-red-500/10 text-red-400'}`}>
                    {code}: {count}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <div className="glass rounded-2xl border border-white/5 p-6">
          <h3 className="font-semibold text-textPrimary flex items-center gap-2 mb-4">
            <Database className="w-4 h-4 text-green-400" />
            Database
          </h3>
          {db ? (
            <div className="space-y-3 text-sm">
              <div className="flex justify-between"><span className="text-textMuted">Path</span><span className="font-mono text-xs truncate max-w-[250px]">{db.path}</span></div>
              <div className="flex justify-between"><span className="text-textMuted">Size</span><span className="font-bold">{db.size}</span></div>
              <div className="flex justify-between"><span className="text-textMuted">FTS Index</span><span>{db.ftsCount} docs</span></div>
              <div className="pt-3 border-t border-white/5">
                <div className="text-xs text-textMuted uppercase tracking-widest mb-2">Table Counts</div>
                <div className="grid grid-cols-2 gap-2">
                  {db.counts && Object.entries(db.counts).map(([table, count]) => (
                    <div key={table} className="flex justify-between p-2 rounded-lg bg-surface border border-border text-xs">
                      <span>{table}</span><span className="font-bold">{count}</span>
                    </div>
                  ))}
                </div>
              </div>
              {db.encryption && (
                <div className="pt-3 border-t border-white/5">
                  <div className="text-xs text-textMuted uppercase tracking-widest mb-2">Encryption at Rest</div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between"><span>Encrypted emails</span><span className="text-green-400">{db.encryption.encryptedEmails}</span></div>
                    <div className="flex justify-between"><span>Peppered pwd</span><span className="text-green-400">{db.encryption.pepperedPasswords}</span></div>
                    <div className="flex justify-between"><span>Enc storage_path</span><span className="text-green-400">{db.encryption.encryptedStorage}</span></div>
                  </div>
                </div>
              )}
            </div>
          ) : <div className="text-sm text-textMuted">No DB data</div>}
        </div>

        <div className="glass rounded-2xl border border-white/5 p-6">
          <h3 className="font-semibold text-textPrimary flex items-center gap-2 mb-4">
            <Terminal className="w-4 h-4 text-primary" />
            Prometheus Metrics
          </h3>
          <p className="text-xs text-textMuted mb-3">For Grafana / Prometheus scraping (admin only)</p>
          <div className="p-3 rounded-xl bg-background border border-border font-mono text-[11px] whitespace-pre-wrap max-h-64 overflow-auto">
            {`# HELP espress0_uptime_seconds Uptime
# TYPE espress0_uptime_seconds gauge
espress0_uptime_seconds ${sys?.uptime?.seconds || 0}

# HELP espress0_requests_total Total requests
# TYPE espress0_requests_total counter
espress0_requests_total ${req?.totalRequests || 0}

# HELP espress0_errors_total Errors
# TYPE espress0_errors_total counter
espress0_errors_total ${req?.totalErrors || 0}

# HELP espress0_items_total Items
# TYPE espress0_items_total gauge
espress0_items_total ${db?.counts?.items || 0}

# HELP espress0_users_total Users
# TYPE espress0_users_total gauge
espress0_users_total ${db?.counts?.users || 0}
`}
          </div>
          <div className="mt-3 flex gap-2">
            <a href="/api/monitoring/prometheus" target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 rounded-lg bg-surface border border-border text-xs hover:border-primary/30">Open /api/monitoring/prometheus</a>
            <a href="/api/monitoring/health" target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 rounded-lg bg-surface border border-border text-xs">Health</a>
          </div>
        </div>
      </div>
    </div>
  );
}
