import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderPlus, Folder, Trash2, Edit, X, AlertTriangle, Package } from 'lucide-react';
import { foldersApi } from '../../lib/api';
import Loading, { LoadingDots } from '../../components/Loading';

const COLORS = ['#8b5cf6', '#6366f1', '#3b82f6', '#06b6d4', '#10b981', '#f59e0b', '#ec4899', '#6b7280'];
const ICONS = ['📁', '💿', '🧰', '🎮', '📚', '🔐', '🐧', '⭐', '🧪', '📦'];

/**
 * Folder manager. Folders are the free-form sibling of categories: an item has
 * one category (what it is) and optionally one folder (how the admin files it
 * - "Linux ISOs 2026", "Recommended tools"). Deleting a folder never deletes
 * items; they just become unfiled.
 */
export default function AdminFolders() {
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // folder object or 'new'
  const [form, setForm] = useState({ name: '', description: '', icon: '', color: '', sort_order: 0 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const notify = (kind, message) => {
    setToast({ kind, message });
    setTimeout(() => setToast(t => (t?.message === message ? null : t)), 4000);
  };

  const load = useCallback(async () => {
    try {
      const data = await foldersApi.adminList();
      setFolders(data.folders || []);
    } catch (e) {
      notify('error', e.response?.data?.error || 'Failed to load folders');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openEditor = (folder = null) => {
    setError('');
    setEditing(folder || 'new');
    setForm(folder
      ? { name: folder.name, description: folder.description || '', icon: folder.icon || '', color: folder.color || '', sort_order: folder.sort_order ?? 0 }
      : { name: '', description: '', icon: '', color: '', sort_order: 0 });
  };

  const save = async (e) => {
    e?.preventDefault();
    if (form.name.trim().length < 2) { setError('Name needs at least 2 characters'); return; }
    setSaving(true);
    setError('');
    try {
      if (editing === 'new') {
        await foldersApi.create(form);
        notify('success', `Folder “${form.name}” created`);
      } else {
        await foldersApi.update(editing.id, form);
        notify('success', 'Folder updated');
      }
      setEditing(null);
      await load();
    } catch (err) {
      const details = err.response?.data?.details;
      setError(details ? details.map(d => d.message).join('; ') : (err.response?.data?.error || 'Save failed'));
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    setSaving(true);
    try {
      const res = await foldersApi.delete(confirmDelete.id);
      notify('success', res.message || 'Folder deleted');
      setConfirmDelete(null);
      await load();
    } catch (err) {
      notify('error', err.response?.data?.error || 'Delete failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-textSecondary max-w-xl">
          Folders group pages however you like - independently of categories. Visitors can filter by folder in Browse.
        </p>
        <button
          onClick={() => openEditor()}
          className="px-5 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium shadow-lg shadow-purple-500/20 flex items-center gap-2"
        >
          <FolderPlus className="w-4 h-4" /> New folder
        </button>
      </div>

      {loading ? (
        <div className="glass rounded-2xl border border-white/5 p-10">
          <Loading text="Loading folders…" />
        </div>
      ) : folders.length === 0 ? (
        <div className="glass rounded-2xl border border-white/5 p-10 text-center">
          <Folder className="w-10 h-10 mx-auto text-textMuted mb-3" />
          <p className="text-sm text-textSecondary mb-1">No folders yet.</p>
          <p className="text-xs text-textMuted mb-4">Create one, then assign pages to it from the File pages list or the page editor.</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {folders.map(f => (
            <div key={f.id} className="glass rounded-2xl border border-white/5 p-5 flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <span
                  className="w-10 h-10 rounded-xl flex items-center justify-center text-lg border border-white/10 flex-shrink-0"
                  style={f.color ? { backgroundColor: `${f.color}22`, color: f.color } : { backgroundColor: 'rgba(139,92,246,0.13)' }}
                >
                  {f.icon || '📁'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-textPrimary truncate">{f.name}</div>
                  <div className="text-xs text-textMuted font-mono truncate">/browse?folder={f.slug}</div>
                </div>
              </div>
              {f.description && <p className="text-xs text-textSecondary line-clamp-2">{f.description}</p>}
              <div className="flex items-center justify-between mt-auto pt-2 border-t border-white/5">
                <Link
                  to={`/admin/items?folder=${f.id}`}
                  className="text-xs text-textMuted hover:text-primary flex items-center gap-1.5"
                >
                  <Package className="w-3.5 h-3.5" />
                  {f.item_count} item{f.item_count === 1 ? '' : 's'}
                  {f.draft_count > 0 && <span className="text-amber-400">({f.draft_count} draft{f.draft_count === 1 ? '' : 's'})</span>}
                </Link>
                <div className="flex items-center gap-1">
                  <button onClick={() => openEditor(f)} title="Edit" className="p-2 hover:bg-surfaceHover rounded-lg text-textMuted hover:text-primary transition-colors">
                    <Edit className="w-4 h-4" />
                  </button>
                  <button onClick={() => setConfirmDelete(f)} title="Delete folder" className="p-2 hover:bg-surfaceHover rounded-lg text-textMuted hover:text-red-400 transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Editor modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <form onSubmit={save} className="w-full max-w-md bg-surface border border-border rounded-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-textPrimary">{editing === 'new' ? 'New folder' : `Edit “${editing.name}”`}</h3>
              <button type="button" onClick={() => setEditing(null)} className="p-2 hover:bg-surfaceHover rounded-xl"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <span className="text-[11px] text-textMuted block mb-1">Name *</span>
                <input
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Linux ISOs 2026"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/50"
                />
              </div>
              <div>
                <span className="text-[11px] text-textMuted block mb-1">Description</span>
                <textarea
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  rows={2}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/50"
                />
              </div>
              <div>
                <span className="text-[11px] text-textMuted block mb-1">Icon</span>
                <div className="flex flex-wrap gap-1.5">
                  {ICONS.map(i => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, icon: f.icon === i ? '' : i }))}
                      className={`w-9 h-9 rounded-lg border text-base ${form.icon === i ? 'border-primary bg-primary/10' : 'border-border bg-background hover:border-primary/30'}`}
                    >
                      {i}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <span className="text-[11px] text-textMuted block mb-1">Color</span>
                <div className="flex flex-wrap gap-1.5">
                  {COLORS.map(c => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, color: f.color === c ? '' : c }))}
                      className={`w-8 h-8 rounded-lg border ${form.color === c ? 'border-white scale-110' : 'border-transparent'}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
              <div>
                <span className="text-[11px] text-textMuted block mb-1">Sort order (lower = first)</span>
                <input
                  type="number"
                  value={form.sort_order}
                  onChange={e => setForm(f => ({ ...f, sort_order: parseInt(e.target.value, 10) || 0 }))}
                  className="w-28 px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/50"
                />
              </div>
              {error && <p className="text-sm text-red-400">{error}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setEditing(null)} className="px-4 py-2.5 bg-background border border-border rounded-xl text-sm">Cancel</button>
                <button type="submit" disabled={saving} className="px-5 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium flex items-center gap-2 disabled:opacity-50">
                  {saving && <LoadingDots size={16} />}
                  {editing === 'new' ? 'Create folder' : 'Save changes'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md bg-surface border border-border rounded-2xl p-6">
            <div className="flex items-start gap-3 mb-3">
              <span className="w-9 h-9 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-4 h-4 text-red-400" />
              </span>
              <div>
                <h3 className="text-base font-bold text-textPrimary">Delete “{confirmDelete.name}”?</h3>
                <p className="text-sm text-textSecondary mt-1">
                  The {confirmDelete.item_count} item{confirmDelete.item_count === 1 ? '' : 's'} inside are <strong>not</strong> deleted - they simply become unfiled.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setConfirmDelete(null)} className="px-4 py-2.5 bg-surface border border-border rounded-xl text-sm">Cancel</button>
              <button
                onClick={doDelete}
                disabled={saving}
                className="px-4 py-2.5 bg-red-500/15 border border-red-500/40 text-red-400 rounded-xl text-sm font-medium flex items-center gap-2 disabled:opacity-50"
              >
                {saving ? <LoadingDots size={16} /> : <Trash2 className="w-4 h-4" />}
                Delete folder
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`fixed bottom-6 right-6 z-[70] px-4 py-3 rounded-xl border text-sm shadow-lg ${
          toast.kind === 'error' ? 'bg-red-500/10 border-red-500/30 text-red-300' : 'bg-green-500/10 border-green-500/30 text-green-300'
        }`}>
          {toast.message}
        </div>
      )}
    </div>
  );
}
