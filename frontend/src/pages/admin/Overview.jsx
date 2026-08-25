import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Database } from 'lucide-react';
import { adminApi } from '../../lib/api';

export default function AdminOverview() {
  const [overview, setOverview] = useState(null);
  const [message, setMessage] = useState('');

  const load = () => adminApi.overview().then(setOverview).catch(() => setOverview(null));
  useEffect(() => { load(); }, []);

  const handleReindex = async () => {
    try {
      await adminApi.reindex();
      setMessage('Search index rebuilt.');
    } catch {
      setMessage('Reindex failed.');
    }
  };

  if (!overview) {
    return <div className="text-textMuted text-sm">Loading overview...</div>;
  }

  const cards = [
    { label: 'Total Files', value: overview.counts.totalItems, color: 'text-textPrimary' },
    { label: 'Published', value: overview.counts.published, color: 'text-green-400' },
    { label: 'Unpublished', value: overview.counts.unpublished, color: 'text-amber-400' },
    { label: 'Featured', value: overview.counts.featured, color: 'text-primary' },
    { label: `Users (${overview.counts.adminUsers || 0} admin)`, value: overview.counts.totalUsers || 0, color: 'text-blue-400' },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {cards.map(c => (
          <div key={c.label} className="glass rounded-2xl p-5 border border-white/5">
            <div className={`text-2xl font-bold ${c.color}`}>{c.value}</div>
            <div className="text-xs text-textMuted uppercase tracking-widest">{c.label}</div>
          </div>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="glass rounded-2xl border border-white/5 p-6">
          <h3 className="font-semibold text-textPrimary mb-4">Recent Additions</h3>
          <div className="space-y-2">
            {overview.recent?.map(item => (
              <Link
                key={item.id}
                to={`/admin/items/${item.id}`}
                className="flex items-center justify-between p-3 rounded-xl bg-surface border border-border text-sm hover:border-primary/30 transition-colors"
              >
                <span className="text-textPrimary truncate">{item.name}</span>
                <span className={`px-2 py-0.5 rounded-full text-xs ${item.published ? 'bg-green-500/10 text-green-400' : 'bg-amber-500/10 text-amber-400'}`}>
                  {item.published ? 'Published' : 'Draft'}
                </span>
              </Link>
            ))}
          </div>
        </div>

        <div className="glass rounded-2xl border border-white/5 p-6">
          <h3 className="font-semibold text-textPrimary mb-4">Top Downloads</h3>
          <div className="space-y-2">
            {overview.topDownloads?.map(item => (
              <div key={item.id} className="flex items-center justify-between p-3 rounded-xl bg-surface border border-border text-sm">
                <span className="text-textPrimary truncate">{item.name}</span>
                <span className="text-textMuted">{item.download_count} downloads</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="glass rounded-2xl border border-white/5 p-6">
        <h3 className="font-semibold text-textPrimary mb-4">Storage Providers & Monitoring</h3>
        <div className="grid md:grid-cols-3 gap-3 mb-4">
          {overview.storageProviders?.map(p => (
            <div key={p.id} className="p-4 rounded-xl bg-surface border border-border">
              <div className="font-medium text-textPrimary text-sm">{p.name}</div>
              <div className="text-xs text-textMuted mt-1">ID: {p.id} • {p.enabled ? 'Enabled' : 'Disabled'}</div>
            </div>
          ))}
        </div>
        {overview.monitoring && (
          <div className="grid md:grid-cols-3 gap-3 text-sm">
            <div className="p-3 rounded-xl bg-surface border border-border">
              <div className="text-xs text-textMuted uppercase tracking-widest">Uptime</div>
              <div className="font-bold mt-1">{overview.monitoring.uptime?.human}</div>
            </div>
            <div className="p-3 rounded-xl bg-surface border border-border">
              <div className="text-xs text-textMuted uppercase tracking-widest">Requests</div>
              <div className="font-bold mt-1">
                {overview.monitoring.requests?.totalRequests} total, {overview.monitoring.requests?.totalErrors} errors
              </div>
            </div>
            <div className="p-3 rounded-xl bg-surface border border-border">
              <div className="text-xs text-textMuted uppercase tracking-widest">Failed Logins</div>
              <div className="font-bold mt-1 text-red-400">{overview.monitoring.requests?.auth?.failedLogins}</div>
            </div>
          </div>
        )}
        <div className="flex items-center gap-3 mt-4">
          <button onClick={handleReindex} className="px-4 py-2 bg-surface border border-border rounded-xl text-sm hover:border-primary/30 transition-colors flex items-center gap-2">
            <Database className="w-4 h-4" /> Rebuild Search Index
          </button>
          {message && <span className="text-xs text-textMuted">{message}</span>}
        </div>
      </div>
    </div>
  );
}
