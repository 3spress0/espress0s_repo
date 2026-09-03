import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Upload, FileJson, AlertTriangle, CheckCircle2, ShieldAlert, History, Undo2, RefreshCw } from 'lucide-react';
import { backupApi, snapshotApi } from '../../lib/api';
import Loading, { LoadingDots } from '../../components/Loading';

/**
 * Backup page: export the whole archive (categories, folders, items + mirrors,
 * FAQ, settings - never users) to one JSON file, and restore it back with a
 * mandatory dry-run preview so a bad file is discovered before it writes.
 */
export default function AdminBackup() {
  const fileInput = useRef(null);
  const [exporting, setExporting] = useState(false);
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState(null); // parsed export object
  const [report, setReport] = useState(null); // dry-run or apply result
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Database snapshots taken automatically before imports and bulk edits, and
  // the pending rollback the admin is about to confirm.
  const [snapshots, setSnapshots] = useState(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotMsg, setSnapshotMsg] = useState('');
  const [pending, setPending] = useState(null); // { snapshot, preview }

  const loadSnapshots = useCallback(() => {
    snapshotApi.list().then(d => setSnapshots(d.snapshots || [])).catch(() => setSnapshots([]));
  }, []);

  useEffect(() => { loadSnapshots(); }, [loadSnapshots]);

  /** Always preview a rollback first: it replaces every catalogue row. */
  const previewRestore = async (snapshot) => {
    setSnapshotBusy(true);
    setSnapshotMsg('');
    try {
      const res = await snapshotApi.restore(snapshot.path, { scope: 'catalogue', dryRun: true });
      setPending({ snapshot, preview: res });
    } catch (e) {
      setSnapshotMsg(e.response?.data?.error || 'Could not read that snapshot');
    } finally {
      setSnapshotBusy(false);
    }
  };

  const doRestore = async () => {
    if (!pending) return;
    setSnapshotBusy(true);
    setSnapshotMsg('');
    try {
      const res = await snapshotApi.restore(pending.snapshot.path, { scope: 'catalogue' });
      setSnapshotMsg(`Rolled back: ${Object.entries(res.restored).map(([t, n]) => `${n} ${t}`).join(', ')}`);
      setPending(null);
      loadSnapshots();
    } catch (e) {
      setSnapshotMsg(e.response?.data?.error || 'Rollback failed');
    } finally {
      setSnapshotBusy(false);
    }
  };

  const doExport = async () => {
    setExporting(true);
    setError('');
    try {
      const blob = await backupApi.export();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `espress0-repo-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.response?.data?.error || 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const pickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setError('');
    setReport(null);
    setParsed(null);
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.format !== 'espress0-repo-export') {
        setError('That file is not an espress0 repo export (missing "format" marker).');
        return;
      }
      setParsed(data);
      setFileName(file.name);
    } catch {
      setError('Could not parse that file as JSON.');
    }
  };

  const dryRun = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await backupApi.import({ ...parsed, apply: false });
      setReport(res);
    } catch (err) {
      setError(err.response?.data?.error || 'Validation failed');
      setReport(null);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await backupApi.import({ ...parsed, apply: true });
      setReport(res);
    } catch (err) {
      setError(err.response?.data?.error || 'Import failed - nothing was written');
    } finally {
      setBusy(false);
    }
  };

  const counts = parsed ? {
    items: parsed.items?.length || 0,
    categories: parsed.categories?.length || 0,
    folders: parsed.folders?.length || 0,
    faq: parsed.faq_entries?.length || 0,
  } : null;

  const ReportLine = ({ label, r }) => (
    r && (
      <div className="flex items-center justify-between p-3 rounded-xl bg-background border border-border text-sm">
        <span className="text-textSecondary">{label}</span>
        <span className="font-mono text-xs text-textPrimary">
          {r.created} created • {r.updated} updated • {r.unchanged} unchanged
        </span>
      </div>
    )
  );

  return (
    <div className="space-y-6">
      {/* Export */}
      <div className="glass rounded-2xl border border-white/5 p-6">
        <h3 className="font-semibold text-textPrimary mb-2 flex items-center gap-2">
          <Download className="w-4 h-4 text-primary" /> Export
        </h3>
        <p className="text-sm text-textSecondary mb-4 max-w-2xl">
          Downloads the entire archive as one JSON file: categories, folders, every item page with its
          mirror URLs, FAQ entries and site settings. <strong className="text-textPrimary">User accounts are never included.</strong>
        </p>
        <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300 mb-4 max-w-2xl">
          <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
          The export contains decrypted mirror and download URLs - treat the file like a password database backup.
        </div>
        <button
          onClick={doExport}
          disabled={exporting}
          className="px-5 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium flex items-center gap-2 disabled:opacity-50"
        >
          {exporting ? <LoadingDots size={16} /> : <Download className="w-4 h-4" />}
          Download export (.json)
        </button>
      </div>

      {/* Import */}
      <div className="glass rounded-2xl border border-white/5 p-6">
        <h3 className="font-semibold text-textPrimary mb-2 flex items-center gap-2">
          <Upload className="w-4 h-4 text-primary" /> Import / restore
        </h3>
        <p className="text-sm text-textSecondary mb-4 max-w-2xl">
          Items are matched by their page URL (slug): pages that exist are updated, new ones are created,
          nothing is ever deleted. A <strong className="text-textPrimary">dry run</strong> shows exactly what would
          change before anything is written.
        </p>

        <input ref={fileInput} type="file" accept="application/json,.json" onChange={pickFile} className="hidden" />
        <button
          onClick={() => fileInput.current?.click()}
          className="px-5 py-2.5 bg-surface border border-border rounded-xl text-sm hover:border-primary/30 flex items-center gap-2"
        >
          <FileJson className="w-4 h-4" /> Choose export file...
        </button>

        {parsed && (
          <div className="mt-5 space-y-4">
            <div className="flex items-center gap-3 p-3 rounded-xl bg-background border border-border">
              <FileJson className="w-5 h-5 text-primary flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-sm text-textPrimary font-medium truncate">{fileName}</div>
                <div className="text-xs text-textMuted">
                  {counts.items} items • {counts.categories} categories • {counts.folders} folders • {counts.faq} FAQ
                  {parsed.exported_at && <> • exported {new Date(parsed.exported_at).toLocaleString()}</>}
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={dryRun}
                disabled={busy}
                className="px-5 py-2.5 bg-surface border border-border rounded-xl text-sm hover:border-primary/30 flex items-center gap-2 disabled:opacity-50"
              >
                {busy ? <LoadingDots size={16} /> : null}
                {report ? 'Re-run dry run' : 'Preview changes (dry run)'}
              </button>
              {report?.dryRun && (
                <button
                  onClick={apply}
                  disabled={busy}
                  className="px-5 py-2.5 bg-green-500/10 border border-green-500/30 text-green-400 rounded-xl text-sm font-medium flex items-center gap-2 disabled:opacity-50"
                >
                  <CheckCircle2 className="w-4 h-4" /> Apply import
                </button>
              )}
            </div>

            {report && (
              <div className="space-y-2">
                <div className={`flex items-center gap-2 text-sm font-medium ${report.dryRun ? 'text-amber-400' : 'text-green-400'}`}>
                  {report.dryRun
                    ? <><AlertTriangle className="w-4 h-4" /> Dry run - nothing was written.</>
                    : <><CheckCircle2 className="w-4 h-4" /> Import applied.</>}
                </div>
                <ReportLine label="Items" r={report.items} />
                <ReportLine label="Folders" r={report.folders} />
                <ReportLine label="Categories" r={report.categories} />
                {report.faq && (report.faq.created > 0 || report.faq.skipped > 0) && (
                  <div className="flex items-center justify-between p-3 rounded-xl bg-background border border-border text-sm">
                    <span className="text-textSecondary">FAQ entries</span>
                    <span className="font-mono text-xs text-textPrimary">{report.faq.created} added • {report.faq.skipped} already present</span>
                  </div>
                )}
                {report.settings && (report.settings.updated > 0 || report.settings.unchanged > 0) && (
                  <div className="flex items-center justify-between p-3 rounded-xl bg-background border border-border text-sm">
                    <span className="text-textSecondary">Site settings</span>
                    <span className="font-mono text-xs text-textPrimary">{report.settings.updated} updated • {report.settings.unchanged} unchanged</span>
                  </div>
                )}
                {report.items?.errors?.length > 0 && (
                  <div className="p-3 rounded-xl bg-red-500/5 border border-red-500/20">
                    <div className="text-xs font-medium text-red-400 mb-2">{report.items.errors.length} item(s) failed validation:</div>
                    <ul className="text-xs text-red-300 space-y-1 font-mono">
                      {report.items.errors.slice(0, 10).map((e, i) => (
                        <li key={i}>• {e.slug}: {e.error}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Snapshots taken automatically before imports and bulk edits. Rolling
          one back replaces every catalogue row, so it previews first. */}
      <div className="mt-6 rounded-2xl border border-white/5 glass p-5">
        <div className="flex items-center gap-2 mb-1">
          <History className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-bold text-textPrimary">Database snapshots</h3>
          <button
            onClick={loadSnapshots}
            className="ml-auto p-1.5 text-textMuted hover:text-primary"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-textMuted mb-4">
          Taken automatically before a catalogue import and before any bulk edit that rewrites
          rows. Rolling back restores the catalogue tables (categories, folders, tags, items,
          mirrors, relations) in one transaction — users and site settings are left alone.
        </p>

        {snapshotMsg && (
          <div className="mb-3 p-3 rounded-xl bg-surface border border-border text-sm text-textSecondary flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0 text-green-400" /> {snapshotMsg}
          </div>
        )}

        {snapshots === null ? (
          <Loading text="Loading snapshots…" />
        ) : snapshots.length === 0 ? (
          <p className="text-sm text-textMuted">No snapshots yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {snapshots.map(snap => (
              <li key={snap.path} className="flex flex-wrap items-center gap-2 text-xs rounded-lg border border-border bg-surface/40 px-3 py-2">
                <span className="font-mono text-textPrimary truncate max-w-[320px]" title={snap.path}>{snap.name}</span>
                <span className="text-textMuted">{(snap.sizeBytes / 1024 / 1024).toFixed(1)} MB</span>
                <span className="text-textMuted">{new Date(snap.createdAt).toLocaleString()}</span>
                <button
                  onClick={() => previewRestore(snap)}
                  disabled={snapshotBusy}
                  className="ml-auto px-2.5 py-1 rounded-md bg-surface border border-border text-textMuted hover:text-primary disabled:opacity-40 flex items-center gap-1.5"
                >
                  {snapshotBusy ? <LoadingDots size={12} /> : <Undo2 className="w-3 h-3" />}
                  Roll back to this
                </button>
              </li>
            ))}
          </ul>
        )}

        {pending && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
            <h4 className="text-sm font-bold text-amber-300 flex items-center gap-2 mb-2">
              <ShieldAlert className="w-4 h-4" /> Confirm rollback
            </h4>
            <p className="text-xs text-textSecondary mb-3">
              Every catalogue row will be replaced by the contents of{' '}
              <span className="font-mono">{pending.snapshot.name}</span>
              ({new Date(pending.snapshot.createdAt).toLocaleString()}). Anything added since then
              is lost. This cannot itself be undone.
            </p>
            <ul className="text-xs text-textSecondary grid gap-1 sm:grid-cols-2 mb-3">
              {Object.entries(pending.preview.restored || {}).map(([table, n]) => (
                <li key={table} className="flex justify-between gap-2">
                  <span className="font-mono">{table}</span>
                  <span className="tabular-nums">{n} rows</span>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <button
                onClick={doRestore}
                disabled={snapshotBusy}
                className="px-4 py-2 bg-red-500/15 border border-red-500/40 text-red-400 rounded-lg text-sm font-medium disabled:opacity-40"
              >
                Yes, roll back
              </button>
              <button
                onClick={() => setPending(null)}
                disabled={snapshotBusy}
                className="px-4 py-2 bg-surface border border-border rounded-lg text-sm text-textSecondary disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
