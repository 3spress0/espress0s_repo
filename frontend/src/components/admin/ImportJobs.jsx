import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Plus, Play, Trash2, Edit, X, AlertTriangle, CheckCircle2, XCircle, Eye, Github, Link2 } from 'lucide-react';
import { importJobsApi } from '../../lib/api';
import { LoadingDots } from '../Loading';

/**
 * Scheduled imports: pull a GitHub Releases feed or a remote catalog.zip on an
 * interval, through the same import pipeline as a manual upload. Lives on the
 * Admin -> Catalogue page under the manual import.
 */
const EMPTY = { name: '', source_type: 'github-releases', source_url: '', mode: 'upsert', interval_minutes: 360, enabled: true,
  options: { category: '', folder: '', prefix: '', tags: '', asset_pattern: '', include_prereleases: false, max_releases: 20, platform: '', license_status: '' } };

function Status({ job }) {
  if (!job.enabled) return <span className="text-xs text-textMuted">paused</span>;
  if (job.last_status === 'failed') return <span className="inline-flex items-center gap-1 text-xs text-red-400" title={job.last_error || ''}><XCircle className="w-3 h-3" /> failed</span>;
  if (job.last_status === 'ok-with-errors') return <span className="inline-flex items-center gap-1 text-xs text-amber-300"><AlertTriangle className="w-3 h-3" /> ok, with row errors</span>;
  if (job.last_status === 'ok') return <span className="inline-flex items-center gap-1 text-xs text-emerald-400"><CheckCircle2 className="w-3 h-3" /> ok</span>;
  return <span className="text-xs text-textMuted">not run yet</span>;
}

const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

export default function ImportJobs({ onNotify }) {
  const [jobs, setJobs] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(null);
  const [preview, setPreview] = useState(null);

  const notify = (kind, msg) => onNotify?.(kind, msg);
  const load = useCallback(async () => {
    try { setJobs((await importJobsApi.list()).jobs || []); } catch (e) { notify('error', e.response?.data?.error || 'Failed to load import jobs'); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { load(); }, [load]);

  const open = (job = null) => {
    setError('');
    setEditing(job || 'new');
    setForm(job ? { ...job, options: { ...EMPTY.options, ...job.options, tags: (job.options.tags || []).join(', ') } } : EMPTY);
  };
  const setOpt = (k, v) => setForm(f => ({ ...f, options: { ...f.options, [k]: v } }));

  const save = async (e) => {
    e?.preventDefault(); setSaving(true); setError('');
    const o = form.options;
    const options = {
      ...(o.category ? { category: o.category } : {}), ...(o.folder ? { folder: o.folder } : {}), ...(o.prefix ? { prefix: o.prefix } : {}),
      ...(o.platform ? { platform: o.platform } : {}), ...(o.license_status ? { license_status: o.license_status } : {}),
      ...(o.asset_pattern ? { asset_pattern: o.asset_pattern } : {}),
      tags: String(o.tags || '').split(',').map(s => s.trim()).filter(Boolean),
      include_prereleases: !!o.include_prereleases,
      max_releases: parseInt(o.max_releases, 10) || 20,
    };
    const payload = { name: form.name, source_type: form.source_type, source_url: form.source_url, mode: form.mode, interval_minutes: parseInt(form.interval_minutes, 10) || 360, enabled: form.enabled, options };
    try {
      if (editing === 'new') { await importJobsApi.create(payload); notify('success', 'Import job created'); }
      else { await importJobsApi.update(editing.id, payload); notify('success', 'Import job saved'); }
      setEditing(null); await load();
    } catch (err) { setError(err.response?.data?.error || 'Save failed'); }
    finally { setSaving(false); }
  };

  const run = async (job, apply) => {
    setRunning(job.id); setPreview(null);
    try {
      const res = await importJobsApi.run(job.id, apply);
      if (apply) notify('success', `Ran “${job.name}”: ${res.report.items.created} created, ${res.report.items.updated} updated, ${res.report.items.unchanged} unchanged${res.report.errorCount ? `, ${res.report.errorCount} row error(s)` : ''}`);
      else setPreview({ job, report: res.report });
      await load();
    } catch (err) {
      const d = err.response?.data;
      notify('error', d?.error || 'Run failed'); await load();
    } finally { setRunning(null); }
  };
  const remove = async (job) => {
    if (!confirm(`Delete import job “${job.name}”? Imported pages stay.`)) return;
    try { await importJobsApi.remove(job.id); notify('success', 'Deleted'); await load(); } catch (err) { notify('error', err.response?.data?.error || 'Delete failed'); }
  };
  const toggle = async (job) => {
    try { await importJobsApi.update(job.id, { enabled: !job.enabled }); await load(); } catch (err) { notify('error', err.response?.data?.error || 'Update failed'); }
  };

  const isGh = form.source_type === 'github-releases';
  const input = 'px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50 w-full';

  return (
    <div className="space-y-4 pt-6 mt-6 border-t border-white/5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-bold text-textPrimary flex items-center gap-2 mr-auto"><CalendarClock className="w-5 h-5 text-primary" /> Scheduled imports</h3>
        <button onClick={() => open()} className="px-4 py-2 bg-gradient-primary text-white rounded-xl text-sm font-medium flex items-center gap-2"><Plus className="w-4 h-4" /> New job</button>
      </div>
      <p className="text-xs text-textMuted">Pull a GitHub Releases feed or a remote <span className="font-mono">catalog.zip</span> on a schedule. Every run goes through the same validation, modes and history as a manual import - check <span className="text-textSecondary">Import history</span> above for the per-run report.</p>

      {editing && (
        <form onSubmit={save} className="glass rounded-2xl border border-white/5 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-textPrimary">{editing === 'new' ? 'New import job' : `Edit “${editing.name}”`}</h4>
            <button type="button" onClick={() => setEditing(null)} className="p-1.5 rounded-lg hover:bg-surfaceHover text-textMuted"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Name" required className={input} />
            <select value={form.source_type} onChange={e => setForm({ ...form, source_type: e.target.value })} className={input}>
              <option value="github-releases">GitHub Releases</option>
              <option value="catalog">Remote catalog.zip / catalog.json</option>
            </select>
            <input value={form.source_url} onChange={e => setForm({ ...form, source_url: e.target.value })} placeholder={isGh ? 'owner/repo or https://github.com/owner/repo' : 'https://example.com/catalog.zip'} required className={`${input} font-mono sm:col-span-2`} />
            <select value={form.mode} onChange={e => setForm({ ...form, mode: e.target.value })} className={input}>
              <option value="upsert">Upsert - create new, update existing</option>
              <option value="add-only">Add only</option>
              <option value="update-only">Update only</option>
            </select>
            <label className="text-sm text-textSecondary flex items-center gap-2">Every <input type="number" min="15" value={form.interval_minutes} onChange={e => setForm({ ...form, interval_minutes: e.target.value })} className={`${input} !w-24`} /> minutes</label>
          </div>
          {isGh && (
            <div className="grid sm:grid-cols-3 gap-3">
              <input value={form.options.category} onChange={e => setOpt('category', e.target.value)} placeholder="Category slug (e.g. development)" className={input} />
              <input value={form.options.folder} onChange={e => setOpt('folder', e.target.value)} placeholder="Folder slug (optional)" className={input} />
              <input value={form.options.prefix} onChange={e => setOpt('prefix', e.target.value)} placeholder="Slug prefix (default: repo name)" className={input} />
              <input value={form.options.tags} onChange={e => setOpt('tags', e.target.value)} placeholder="Tags, comma separated" className={input} />
              <input value={form.options.asset_pattern} onChange={e => setOpt('asset_pattern', e.target.value)} placeholder="Asset regex (e.g. linux.*x64)" className={`${input} font-mono`} />
              <input value={form.options.platform} onChange={e => setOpt('platform', e.target.value)} placeholder="Platform (windows / linux / …)" className={input} />
              <label className="text-sm text-textSecondary flex items-center gap-2"><input type="checkbox" checked={!!form.options.include_prereleases} onChange={e => setOpt('include_prereleases', e.target.checked)} className="accent-purple-500" /> Include pre-releases</label>
              <label className="text-sm text-textSecondary flex items-center gap-2">Newest <input type="number" min="1" max="200" value={form.options.max_releases} onChange={e => setOpt('max_releases', e.target.value)} className={`${input} !w-20`} /> releases</label>
              <label className="text-sm text-textSecondary flex items-center gap-2"><input type="checkbox" checked={!!form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} className="accent-purple-500" /> Enabled</label>
            </div>
          )}
          {error && <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-300 flex gap-2"><AlertTriangle className="w-4 h-4 mt-0.5" /> {error}</div>}
          <button type="submit" disabled={saving} className="px-5 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium disabled:opacity-50">{saving ? <LoadingDots size={14} /> : (editing === 'new' ? 'Create' : 'Save')}</button>
        </form>
      )}

      {jobs.length === 0 ? <p className="text-sm text-textMuted">No scheduled imports.</p> : (
        <div className="space-y-2">
          {jobs.map(job => (
            <div key={job.id} className="glass rounded-2xl border border-white/5 p-4 flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-[220px]">
                <div className="font-medium text-textPrimary flex items-center gap-2">
                  {job.source_type === 'github-releases' ? <Github className="w-4 h-4 text-textMuted" /> : <Link2 className="w-4 h-4 text-textMuted" />}
                  {job.name} <Status job={job} />
                </div>
                <div className="text-xs font-mono text-textMuted truncate">{job.source_url} · {job.mode} · every {job.interval_minutes} min</div>
                <div className="text-[11px] text-textMuted">last: {fmt(job.last_run_at)} · next: {job.enabled ? fmt(job.next_run_at) : '—'} · runs: {job.run_count}
                  {job.last_report && <> · {job.last_report.items.created} new / {job.last_report.items.updated} updated</>}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => run(job, false)} disabled={running === job.id} title="Preview (dry run)" className="p-2 rounded-lg hover:bg-surfaceHover text-textMuted hover:text-primary">{running === job.id ? <LoadingDots size={12} /> : <Eye className="w-4 h-4" />}</button>
                <button onClick={() => run(job, true)} disabled={running === job.id} title="Run now" className="p-2 rounded-lg hover:bg-surfaceHover text-textMuted hover:text-emerald-400"><Play className="w-4 h-4" /></button>
                <button onClick={() => toggle(job)} className="px-2 py-1.5 rounded-lg text-xs text-textMuted hover:text-textPrimary">{job.enabled ? 'Pause' : 'Resume'}</button>
                <button onClick={() => open(job)} title="Edit" className="p-2 rounded-lg hover:bg-surfaceHover text-textMuted hover:text-primary"><Edit className="w-4 h-4" /></button>
                <button onClick={() => remove(job)} title="Delete" className="p-2 rounded-lg hover:bg-surfaceHover text-textMuted hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {preview && (
        <div className="glass rounded-2xl border border-white/5 p-4 text-sm space-y-2">
          <div className="flex items-center justify-between"><span className="font-semibold text-textPrimary">Preview · {preview.job.name}</span><button onClick={() => setPreview(null)} className="text-textMuted"><X className="w-4 h-4" /></button></div>
          <div className="text-textSecondary">Would create <b>{preview.report.items.created}</b>, update <b>{preview.report.items.updated}</b>, leave <b>{preview.report.items.unchanged}</b> unchanged, skip <b>{preview.report.items.skipped}</b>{preview.report.errorCount ? <>, with <b className="text-amber-300">{preview.report.errorCount}</b> row error(s)</> : null}.</div>
          {preview.report.errors?.slice(0, 10).map((e, i) => <div key={i} className="text-xs text-amber-300 font-mono">{e.slug || '—'} · {e.field || '—'} · {e.error}</div>)}
        </div>
      )}
    </div>
  );
}
