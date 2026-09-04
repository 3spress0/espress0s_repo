import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Download, Upload, FileArchive, AlertTriangle, CheckCircle2, XCircle,
  RefreshCw, History, Trash2, Undo2,
} from 'lucide-react';
import { catalogApi } from '../../lib/api';
import Loading, { LoadingDots } from '../../components/Loading';
import Progress from '../../components/Progress';
import ImportJobs from '../../components/admin/ImportJobs';

/**
 * Admin -> Catalogue: import a catalog.zip, export the current catalogue,
 * download the starter template, and read the import history.
 *
 * Import is two-step on purpose: the first upload is a dry run that writes
 * nothing and reports exactly what would change, and applying is a separate
 * click. That way a bad archive is discovered before it touches the database.
 */

const MODES = [
  { id: 'upsert', label: 'Upsert', hint: 'Create new pages, update existing ones' },
  { id: 'add-only', label: 'Add only', hint: 'Create new pages, leave existing ones alone' },
  { id: 'update-only', label: 'Update only', hint: 'Update existing pages, skip unknown slugs' },
];

const STATUS_STYLE = {
  ok: 'bg-green-500/10 text-green-400 border-green-500/30',
  failed: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  rejected: 'bg-red-500/10 text-red-400 border-red-500/30',
};

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value.includes('T') || value.includes('Z') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** Trigger a browser download from a blob response. */
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AdminImports() {
  const [history, setHistory] = useState(null);
  const [mode, setMode] = useState('upsert');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef(null);

  const load = useCallback(() => {
    // The endpoint answers { imports: [...] }, not a bare array: reading it as
    // one made `history.map` throw and took the whole page down.
    catalogApi.history(100)
      .then(data => setHistory(data.imports || []))
      .catch(() => setHistory([]));
  }, []);

  useEffect(() => { load(); }, [load]);

  const notify = (kind, message) => {
    const clear = kind === 'error' ? () => setError('') : () => setNotice('');
    (kind === 'error' ? setError : setNotice)(message);
    // Each banner clears itself, so a success message about this import is not
    // wiped out by the timer of an error from the one before.
    setTimeout(clear, 6000);
  };

  /** Step one: upload and preview. Nothing is written. */
  const onPick = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError('');
    setNotice('');
    setPreview(null);
    setProgress({ label: `Reading ${file.name}`, value: 20 });
    try {
      const res = await catalogApi.import(file, { apply: false, mode });
      setProgress({ label: 'Preview ready', value: 100, tone: 'success' });
      // The mode is frozen here: what you previewed is what Apply runs. Without
      // it, changing the dropdown after previewing applied a different rule
      // than the numbers on screen describe.
      setPreview({ ...res, file, mode });
      // Dry runs are recorded too, so the history answers "what did I look at".
      load();
    } catch (e) {
      notify('error', e.response?.data?.error || 'Could not read that archive');
      setProgress(null);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  /** Step two: apply the same archive for real. */
  const apply = async () => {
    if (!preview?.file) return;
    setBusy(true);
    setError('');
    setProgress({ label: 'Importing', value: 10, sublabel: 'taking a database snapshot first' });
    try {
      const res = await catalogApi.import(preview.file, { apply: true, mode: preview.mode || mode });
      setProgress({ label: 'Imported', value: 100, tone: 'success' });
      setPreview(null);
      notify('success', `Imported: ${res.items.created} created, ${res.items.updated} updated, ${res.errorCount} error${res.errorCount === 1 ? '' : 's'}`);
      load();
    } catch (e) {
      notify('error', e.response?.data?.error || 'Import failed');
      setProgress(null);
    } finally {
      setBusy(false);
      setTimeout(() => setProgress(null), 1500);
    }
  };

  const exportCatalog = async () => {
    setBusy(true);
    try {
      const blob = await catalogApi.export();
      saveBlob(blob, 'catalog.zip');
      notify('success', 'Catalogue exported as catalog.zip');
    } catch (e) {
      notify('error', e.response?.data?.error || 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = async () => {
    setBusy(true);
    try {
      const blob = await catalogApi.template();
      saveBlob(blob, 'catalog-template.zip');
    } catch (e) {
      notify('error', e.response?.data?.error || 'Could not download the template');
    } finally {
      setBusy(false);
    }
  };

  const downloadErrors = async (row, format) => {
    try {
      const blob = await catalogApi.errors(row.id, format);
      saveBlob(blob, `import-${row.id}-errors.${format}`);
    } catch (e) {
      notify('error', e.response?.data?.error || 'Could not download the errors');
    }
  };

  const counts = (row) => [
    ['created', row.items_created],
    ['updated', row.items_updated],
    ['unchanged', row.items_unchanged],
    ['skipped', row.items_skipped],
  ].filter(([, n]) => n > 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold text-textPrimary flex items-center gap-2 mr-auto">
          <FileArchive className="w-5 h-5 text-primary" /> Catalogue import / export
        </h2>
        <button
          onClick={downloadTemplate}
          disabled={busy}
          className="px-4 py-2 bg-surface border border-border rounded-xl text-sm text-textSecondary hover:border-primary/30 disabled:opacity-40 flex items-center gap-2"
        >
          <Download className="w-4 h-4" /> Template
        </button>
        <button
          onClick={exportCatalog}
          disabled={busy}
          className="px-4 py-2 bg-surface border border-border rounded-xl text-sm text-textSecondary hover:border-primary/30 disabled:opacity-40 flex items-center gap-2"
        >
          <Download className="w-4 h-4" /> Export catalog.zip
        </button>
      </div>

      {/* Upload + mode + preview */}
      <div className="glass rounded-2xl border border-white/5 p-5 space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-textMuted block mb-1">Import mode</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              disabled={busy}
              className="px-3 py-2.5 bg-surface border border-border rounded-xl text-sm text-textSecondary focus:outline-none focus:border-primary/50"
            >
              {MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <p className="text-xs text-textMuted pb-2.5">
            {MODES.find(m => m.id === mode)?.hint}
          </p>

          <label className="ml-auto px-5 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium shadow-lg shadow-purple-500/20 flex items-center gap-2 cursor-pointer disabled:opacity-40">
            {busy ? <LoadingDots size={16} /> : <Upload className="w-4 h-4" />}
            {busy ? 'Working…' : 'Choose catalog.zip'}
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              onChange={onPick}
              disabled={busy}
              className="hidden"
            />
          </label>
        </div>

        {progress && <div className="max-w-md"><Progress {...progress} /></div>}

        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" /> {error}
          </div>
        )}
        {notice && (
          <div className="rounded-xl border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-300 flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" /> {notice}
          </div>
        )}

        {preview && (
          <div className="rounded-xl border border-border bg-surface/40 p-4 space-y-3">
            <h3 className="text-sm font-bold text-textPrimary flex items-center gap-2">
              <History className="w-4 h-4 text-primary" />
              Preview — nothing has been written yet
            </h3>
            <p className="text-xs text-textMuted">
              {MODES.find(m => m.id === (preview.mode || mode))?.label || preview.mode} · {preview.file.name} ·{' '}
              {formatBytes(preview.file.size)}
              {preview.mode && preview.mode !== mode ? (
                <span className="text-amber-400"> (the dropdown now says “{MODES.find(m => m.id === mode)?.label}” — apply re-uses the previewed mode)</span>
              ) : null}
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 text-xs">
              {[
                ['Items created', preview.items?.created],
                ['Items updated', preview.items?.updated],
                ['Items unchanged', preview.items?.unchanged],
                ['Relations created', preview.relations?.created],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="text-lg font-bold text-textPrimary tabular-nums">{value ?? 0}</div>
                  <div className="text-textMuted">{label}</div>
                </div>
              ))}
            </div>

            {preview.backupPath && (
              <p className="text-[11px] text-textMuted">
                A database snapshot will be taken before this is applied: <span className="font-mono">{preview.backupPath}</span>
              </p>
            )}

            {preview.errorCount > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="text-xs text-amber-300 mb-2">
                  {preview.errorCount} row{preview.errorCount === 1 ? '' : 's'} would be skipped:
                </p>
                <ul className="text-[11px] text-textSecondary space-y-1 max-h-32 overflow-auto">
                  {(preview.errors || []).map((err, i) => (
                    <li key={i} className="font-mono">
                      {err.slug ? `${err.slug}: ` : ''}{err.field ? `${err.field} — ` : ''}{err.error}
                    </li>
                  ))}
                </ul>
                {preview.errorsTruncated && (
                  <p className="text-[11px] text-textMuted mt-1">…and more. The full list is downloadable after the import.</p>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={apply}
                disabled={busy}
                className="px-4 py-2 bg-gradient-primary text-white rounded-lg text-sm font-medium disabled:opacity-40"
              >
                Apply import
              </button>
              <button
                onClick={() => setPreview(null)}
                disabled={busy}
                className="px-4 py-2 bg-surface border border-border rounded-lg text-sm text-textSecondary disabled:opacity-40"
              >
                Discard
              </button>
            </div>
          </div>
        )}
      </div>

      {/* History */}
      <div className="glass rounded-2xl border border-white/5 overflow-hidden">
        <div className="px-5 py-3 border-b border-white/5 flex items-center gap-2">
          <h3 className="text-sm font-bold text-textPrimary flex items-center gap-2">
            <History className="w-4 h-4 text-primary" /> Import history
          </h3>
          <button
            onClick={load}
            className="ml-auto p-1.5 text-textMuted hover:text-primary"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {history === null ? (
          <div className="p-10"><Loading text="Loading import history…" /></div>
        ) : history.length === 0 ? (
          <p className="p-10 text-center text-sm text-textMuted">No imports yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border text-xs text-textMuted uppercase tracking-widest">
                <tr>
                  <th className="text-left p-3 font-medium">When</th>
                  <th className="text-left p-3 font-medium">Admin</th>
                  <th className="text-left p-3 font-medium">File</th>
                  <th className="text-left p-3 font-medium">Mode</th>
                  <th className="text-left p-3 font-medium">Result</th>
                  <th className="text-left p-3 font-medium">Counts</th>
                  <th className="text-right p-3 font-medium">Errors</th>
                </tr>
              </thead>
              <tbody>
                {history.map(row => (
                  <tr key={row.id} className="border-b border-white/5">
                    <td className="p-3 text-textSecondary whitespace-nowrap text-xs">{formatDate(row.started_at)}</td>
                    <td className="p-3 text-textSecondary text-xs">{row.imported_by_name || '—'}</td>
                    <td className="p-3 text-xs">
                      <div className="text-textPrimary font-mono truncate max-w-[220px]" title={row.filename}>
                        {row.filename}
                      </div>
                      <div className="text-textMuted">{formatBytes(row.size_bytes)} · {String(row.sha256 || '').slice(0, 12)}</div>
                    </td>
                    <td className="p-3 text-xs text-textSecondary">
                      {row.mode}
                      {row.dry_run ? <span className="ml-1.5 text-textMuted">(preview)</span> : null}
                    </td>
                    <td className="p-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] ${STATUS_STYLE[row.status] || STATUS_STYLE.failed}`}>
                        {row.status === 'ok' ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                        {row.status}
                      </span>
                    </td>
                    <td className="p-3 text-xs text-textSecondary">
                      {counts(row).length
                        ? counts(row).map(([label, n]) => `${n} ${label}`).join(' · ')
                        : '—'}
                      {row.relations_created > 0 && ` · ${row.relations_created} relations`}
                    </td>
                    <td className="p-3 text-right">
                      {row.error_count > 0 ? (
                        <span className="inline-flex gap-1">
                          <button
                            onClick={() => downloadErrors(row, 'json')}
                            className="px-2 py-1 rounded-md bg-surface border border-border text-[11px] text-textMuted hover:text-primary"
                            title="Download errors as JSON"
                          >
                            JSON
                          </button>
                          <button
                            onClick={() => downloadErrors(row, 'csv')}
                            className="px-2 py-1 rounded-md bg-surface border border-border text-[11px] text-textMuted hover:text-primary"
                            title="Download errors as CSV"
                          >
                            CSV
                          </button>
                          <span className="self-center text-[11px] text-amber-400 tabular-nums">{row.error_count}</span>
                        </span>
                      ) : (
                        <span className="text-textMuted text-xs">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs text-textMuted flex items-start gap-2">
        <Trash2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        Applying an import takes a database snapshot first, and the whole import runs in one
        transaction — a failure rolls back and leaves the catalogue as it was. Roll a change back
        from <span className="text-textSecondary">Admin → Backup</span>.
      </p>

      <p className="text-xs text-textMuted flex items-start gap-2">
        <Undo2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        Format reference: <span className="font-mono">CATALOG.md</span> at the repository root.
      </p>

      <ImportJobs onNotify={notify} />
    </div>
  );
}
