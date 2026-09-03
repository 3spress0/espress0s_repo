import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, RefreshCw, AlertTriangle } from 'lucide-react';
import { adminApi, linkHealthApi } from '../../lib/api';
import { LoadingDots } from '../../components/Loading';

const PROVIDERS = [
  {
    id: 'gdrive',
    title: 'Google Drive Provider',
    body: 'Set storage_path to the File ID (e.g. 1a2b3c...). Encrypted at rest. The download URL is constructed as https://drive.google.com/uc?export=download&id=FILEID',
  },
  {
    id: 'onedrive',
    title: 'OneDrive Provider',
    body: 'Set download_url to a shareable link. Encrypted at rest. ?download=1 is appended for a direct download.',
  },
  {
    id: 'external',
    title: 'External URL',
    body: 'Set download_url to a direct external URL. Encrypted at rest. No storage_path needed.',
  },
  {
    id: 'github',
    title: 'GitHub Releases',
    body: 'For open-source tools. Set download_url to the release asset URL. Encrypted at rest.',
  },
];

export default function AdminStorage() {
  const [providers, setProviders] = useState(null);
  const [health, setHealth] = useState(null);
  const [running, setRunning] = useState(false);
  const [healthError, setHealthError] = useState('');

  useEffect(() => {
    adminApi.storage().then(d => setProviders(d.providers || d)).catch(() => setProviders([]));
  }, []);

  const loadHealth = useCallback(() => {
    linkHealthApi.summary().then(setHealth).catch(e => setHealthError(e.response?.data?.error || 'Could not load link health'));
  }, []);
  useEffect(() => { loadHealth(); }, [loadHealth]);

  const runAll = async () => {
    setRunning(true);
    setHealthError('');
    try {
      await linkHealthApi.runAll();
      loadHealth();
    } catch (e) {
      setHealthError(e.response?.data?.error || 'Link check failed to start');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Download-link health */}
      <div className="glass rounded-2xl border border-white/5 p-6">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          <div>
            <h3 className="font-semibold text-textPrimary flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" /> Download mirror health
            </h3>
            <p className="text-xs text-textMuted mt-1">
              Probes every mirror with a HEAD request and records the verdict. 404/410 means the host says the file is
              gone and marks the mirror down; timeouts and 403s are recorded as “unknown” so a flaky network or
              bot-wall never takes a mirror offline by itself.
              {health?.config && !health.config.enabled && (
                <> Background checks are off - enable <code className="font-mono">linkcheck_enabled</code> in Site Settings.</>
              )}
            </p>
          </div>
          <button
            onClick={runAll}
            disabled={running || health?.running}
            className="px-4 py-2 bg-gradient-primary text-white rounded-xl text-sm font-medium flex items-center gap-2 disabled:opacity-50"
          >
            {(running || health?.running) ? <LoadingDots size={16} /> : <RefreshCw className="w-4 h-4" />}
            Check all mirrors now
          </button>
        </div>

        {healthError && <p className="text-sm text-red-400 mb-3">{healthError}</p>}

        {health && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
              {[
                { label: 'Mirrors', value: health.counts.total, cls: 'text-textPrimary' },
                { label: 'Up', value: health.counts.up, cls: 'text-green-400' },
                { label: 'Down (404/410)', value: health.counts.down, cls: 'text-red-400' },
                { label: 'Unknown', value: health.counts.unknown, cls: 'text-amber-400' },
                { label: 'Never checked', value: health.counts.neverChecked, cls: 'text-textMuted' },
              ].map(c => (
                <div key={c.label} className="p-3 rounded-xl bg-surface border border-border">
                  <div className={`text-xl font-bold ${c.cls}`}>{c.value}</div>
                  <div className="text-[11px] text-textMuted uppercase tracking-widest">{c.label}</div>
                </div>
              ))}
            </div>

            {health.lastRun && (
              <p className="text-xs text-textMuted mb-4">
                Last run {new Date(health.lastRun.finishedAt || health.lastRun.startedAt).toLocaleString()} —{' '}
                {health.lastRun.checked} checked, {health.lastRun.down} down, {health.lastRun.up} up
                {health.lastRun.skipped ? `, ${health.lastRun.skipped} skipped (local provider)` : ''}.
              </p>
            )}

            {health.problems?.length > 0 && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/5 overflow-hidden">
                <div className="px-4 py-2.5 text-xs font-medium text-red-400 flex items-center gap-2 border-b border-red-500/10">
                  <AlertTriangle className="w-3.5 h-3.5" /> Mirrors needing attention
                </div>
                <div className="divide-y divide-white/5">
                  {health.problems.map(p => (
                    <div key={p.id} className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <Link to={`/admin/items/${p.item_id}`} className="text-textPrimary hover:text-primary font-medium truncate max-w-[220px]">
                        {p.item_name}
                      </Link>
                      <span className="text-textMuted truncate">{p.label}</span>
                      <span className={`px-2 py-0.5 rounded-full ${p.status === 'down' || p.is_down ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400'}`}>
                        {p.is_down ? 'Manually down' : p.status}{p.http_status ? ` ${p.http_status}` : ''}
                      </span>
                      {p.check_error && <span className="text-textMuted truncate max-w-[300px]" title={p.check_error}>{p.check_error}</span>}
                      {p.last_checked && (
                        <span className="text-textMuted ml-auto">{new Date(p.last_checked.replace(' ', 'T') + 'Z').toLocaleString()}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="glass rounded-2xl border border-white/5 p-6">
        <h3 className="font-semibold text-textPrimary mb-3">Storage Abstraction</h3>
        <p className="text-sm text-textSecondary leading-relaxed">
          Large files are not stored on the VM. The database keeps only metadata - encrypted with AES-256-GCM -
          and downloads redirect straight to the configured provider.
        </p>
      </div>

      {Array.isArray(providers) && providers.length > 0 && (
        <div className="glass rounded-2xl border border-white/5 p-6">
          <h3 className="font-semibold text-textPrimary mb-4">Configured Providers</h3>
          <div className="grid md:grid-cols-3 gap-3">
            {providers.map(p => (
              <div key={p.id} className="p-4 rounded-xl bg-surface border border-border">
                <div className="font-medium text-textPrimary text-sm">{p.name}</div>
                <div className="text-xs text-textMuted mt-1">ID: {p.id} • {p.enabled ? 'Enabled' : 'Disabled'}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="glass rounded-2xl border border-white/5 p-6">
        <h3 className="font-semibold text-textPrimary mb-4">How each provider works</h3>
        <div className="grid md:grid-cols-2 gap-4">
          {PROVIDERS.map(p => (
            <div key={p.id} className="p-4 rounded-xl bg-surface border border-border">
              <h4 className="font-medium text-textPrimary text-sm mb-2">{p.title}</h4>
              <p className="text-xs text-textMuted mb-3">{p.body}</p>
              <code className="text-xs bg-background p-2 rounded block font-mono">storage_provider: {p.id}</code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
