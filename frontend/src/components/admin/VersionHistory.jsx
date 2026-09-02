import { useCallback, useEffect, useState } from 'react';
import { History, RotateCcw, Loader2, AlertCircle, ChevronDown, ChevronUp, Link2 } from 'lucide-react';
import { adminApi } from '../../lib/api';
import { formatBytes } from '../../lib/utils';

/**
 * Version history for an item page: every save snapshots the page (name,
 * markdown body, mirrors, publishing flags...) so a bad edit - human or AI -
 * can be rolled back. Restoring is itself recorded as a new version, so the
 * log is append-only.
 */
export default function VersionHistory({ item, onRestored }) {
  const [versions, setVersions] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [restoredMsg, setRestoredMsg] = useState('');
  const [expanded, setExpanded] = useState(null); // version_num being previewed
  const [preview, setPreview] = useState(null); // snapshot of expanded version
  const [confirmRestore, setConfirmRestore] = useState(null); // version_num

  const load = useCallback(async () => {
    try {
      const data = await adminApi.versions(item.id);
      setVersions(data.versions || []);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not load history');
    }
  }, [item.id]);

  useEffect(() => { load(); }, [load]);

  const togglePreview = async (num) => {
    if (expanded === num) { setExpanded(null); setPreview(null); return; }
    setExpanded(num);
    setPreview(null);
    try {
      const data = await adminApi.version(item.id, num);
      setPreview(data.snapshot);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not load that snapshot');
    }
  };

  const restore = async (num) => {
    setBusy(true);
    setError('');
    try {
      const res = await adminApi.restoreVersion(item.id, num);
      setConfirmRestore(null);
      setExpanded(null);
      setPreview(null);
      setRestoredMsg(`Restored version ${num}. The editor now shows the restored content - review and save nothing unless you want more changes.`);
      onRestored?.(res.item);
      await load();
    } catch (e) {
      setError(e.response?.data?.error || 'Restore failed');
    } finally {
      setBusy(false);
    }
  };

  if (error && !versions) {
    return (
      <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400 flex items-start gap-2">
        <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" /> {error}
      </div>
    );
  }

  if (!versions) {
    return <div className="text-sm text-textMuted flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading history...</div>;
  }

  if (versions.length === 0) {
    return (
      <div className="text-sm text-textMuted">
        <History className="w-8 h-8 mb-2 opacity-50" />
        No history yet. The first snapshot is taken when a page is created; every save after that adds a version.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {restoredMsg && (
        <div className="p-3 rounded-xl bg-green-500/10 border border-green-500/20 text-xs text-green-300 flex items-start gap-2">
          <RotateCcw className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> {restoredMsg}
        </div>
      )}
      {error && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-400">{error}</div>
      )}

      <div className="rounded-xl border border-border divide-y divide-white/5 overflow-hidden">
        {versions.map(v => (
          <div key={v.version_num} className="bg-background">
            <div className="flex items-center gap-3 px-4 py-3">
              <span className="text-xs font-mono text-textMuted w-10 flex-shrink-0">v{v.version_num}</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-textPrimary truncate">{v.change_summary || '—'}</div>
                <div className="text-[11px] text-textMuted">
                  {new Date(v.created_at.replace(' ', 'T') + 'Z').toLocaleString()}
                  {v.changed_by_username ? ` • ${v.changed_by_username}` : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => togglePreview(v.version_num)}
                className="p-1.5 hover:bg-surfaceHover rounded-lg text-textMuted hover:text-primary"
                title="Preview this snapshot"
              >
                {expanded === v.version_num ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
              {v.version_num !== versions[0]?.version_num && (
                <button
                  type="button"
                  onClick={() => setConfirmRestore(v.version_num)}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-lg text-xs bg-surface border border-border hover:border-amber-500/40 text-textSecondary flex items-center gap-1.5 disabled:opacity-50"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Restore
                </button>
              )}
            </div>

            {expanded === v.version_num && (
              <div className="px-4 pb-4 text-xs">
                {!preview ? (
                  <div className="text-textMuted flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading snapshot...</div>
                ) : (
                  <div className="space-y-2 rounded-lg bg-surface border border-border p-3">
                    <div><span className="text-textMuted">Name:</span> <span className="text-textPrimary">{preview.name}</span></div>
                    <div><span className="text-textMuted">URL:</span> <span className="font-mono text-textSecondary">/file/{preview.slug}</span></div>
                    <div><span className="text-textMuted">Description:</span> <span className="text-textSecondary">{preview.description}</span></div>
                    <div className="flex items-center gap-1.5 text-textSecondary">
                      <Link2 className="w-3 h-3" />
                      {(preview.download_links || []).length} mirror{(preview.download_links || []).length === 1 ? '' : 's'}
                      {preview.file_size ? ` • ${formatBytes(preview.file_size)}` : ''}
                      {preview.version ? ` • v${preview.version}` : ''}
                      {' •'}{preview.published ? ' published' : ' draft'}
                    </div>
                    {preview.long_description && (
                      <details>
                        <summary className="text-textMuted cursor-pointer select-none">Page body snapshot</summary>
                        <pre className="mt-2 p-2 rounded bg-background border border-border overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto text-[11px]">{preview.long_description}</pre>
                      </details>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <p className="text-[11px] text-textMuted">
        Up to 50 versions are kept per page. Restoring an old version does not delete history - it is recorded as a new version.
      </p>

      {confirmRestore !== null && (
        <div className="fixed inset-0 z-[65] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md bg-surface border border-border rounded-2xl p-6">
            <h3 className="text-base font-bold text-textPrimary mb-2">Restore version {confirmRestore}?</h3>
            <p className="text-sm text-textSecondary">
              The page - including its download mirrors - will be replaced with the snapshot from version {confirmRestore}.
              The current state stays in history and can be restored back.
            </p>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setConfirmRestore(null)} className="px-4 py-2.5 bg-surface border border-border rounded-xl text-sm">Cancel</button>
              <button
                onClick={() => restore(confirmRestore)}
                disabled={busy}
                className="px-4 py-2.5 bg-amber-500/15 border border-amber-500/40 text-amber-300 rounded-xl text-sm font-medium flex items-center gap-2 disabled:opacity-50"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                Restore v{confirmRestore}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
