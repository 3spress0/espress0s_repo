import { useRef, useState } from 'react';
import { Download, Upload, FileJson, Loader2, AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react';
import { backupApi } from '../../lib/api';

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
          {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
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
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
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
    </div>
  );
}
