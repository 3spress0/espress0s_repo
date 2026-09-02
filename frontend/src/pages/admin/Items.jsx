import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Search, Plus, Edit, Trash2, Eye, X, Link2, ImageIcon, Copy,
  EyeOff, Loader2, AlertTriangle, CheckCircle2, Star, Folder, FolderInput,
} from 'lucide-react';
import { adminApi, itemsApi, foldersApi } from '../../lib/api';
import ItemEditor from '../../components/admin/ItemEditor';

function formatSize(bytes) {
  if (!bytes) return '—';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'published', label: 'Published' },
  { id: 'draft', label: 'Drafts' },
];

/** Confirm dialog for destructive actions — replaces window.confirm. */
function ConfirmDialog({ title, body, confirmLabel, onConfirm, onCancel, busy }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md bg-surface border border-border rounded-2xl p-6">
        <div className="flex items-start gap-3 mb-3">
          <span className="w-9 h-9 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-4 h-4 text-red-400" />
          </span>
          <div>
            <h3 className="text-base font-bold text-textPrimary">{title}</h3>
            <div className="text-sm text-textSecondary mt-1">{body}</div>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onCancel} className="px-4 py-2.5 bg-surface border border-border rounded-xl text-sm">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="px-4 py-2.5 bg-red-500/15 border border-red-500/40 text-red-400 rounded-xl text-sm font-medium flex items-center gap-2 disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdminItems() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState([]);
  const [folders, setFolders] = useState([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [folderFilter, setFolderFilter] = useState(searchParams.get('folder') || 'all');
  const [moveTarget, setMoveTarget] = useState('');
  const [editing, setEditing] = useState(null); // item object being edited
  const [creating, setCreating] = useState(false);
  const [loadingId, setLoadingId] = useState(null);
  const [selected, setSelected] = useState([]); // ids
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null); // { kind, message }
  const [confirm, setConfirm] = useState(null); // { title, body, confirmLabel, run }

  const notify = (kind, message) => {
    setToast({ kind, message });
    setTimeout(() => setToast(t => (t?.message === message ? null : t)), 4000);
  };

  const load = useCallback(async (q = '') => {
    try {
      const data = await adminApi.items({ q, limit: 200 });
      setItems(data.items || []);
    } catch (e) {
      console.error('Failed to load items', e);
      notify('error', e.response?.data?.error || 'Failed to load pages');
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    foldersApi.adminList().then(d => setFolders(d.folders || [])).catch(() => {});
  }, []);

  const folderById = useMemo(() => new Map(folders.map(f => [f.id, f])), [folders]);
  const folderName = (folderId) => folderId ? (folderById.get(folderId)?.name || `#${folderId}`) : null;

  const changeFolderFilter = (value) => {
    setFolderFilter(value);
    const next = new URLSearchParams(searchParams);
    if (value && value !== 'all') next.set('folder', value); else next.delete('folder');
    setSearchParams(next, { replace: true });
  };

  // Deep link: /admin/items/:id opens that item's editor directly.
  useEffect(() => {
    if (!id) { setEditing(null); return; }
    let cancelled = false;
    setLoadingId(Number(id));
    itemsApi.get(id)
      .then(data => { if (!cancelled) setEditing(data.item || data); })
      .catch(() => { if (!cancelled) setEditing(null); })
      .finally(() => { if (!cancelled) setLoadingId(null); });
    return () => { cancelled = true; };
  }, [id]);

  const visible = useMemo(() => items.filter(i => {
    if (filter === 'published') return !!i.published;
    if (filter === 'draft') return !i.published;
    return true;
  }).filter(i => {
    if (folderFilter === 'all') return true;
    if (folderFilter === 'none') return !i.folder_id;
    return String(i.folder_id) === String(folderFilter);
  }), [items, filter, folderFilter]);

  const allVisibleSelected = visible.length > 0 && visible.every(i => selected.includes(i.id));

  const toggleSelect = (itemId) =>
    setSelected(s => (s.includes(itemId) ? s.filter(x => x !== itemId) : [...s, itemId]));

  const toggleSelectAll = () =>
    setSelected(allVisibleSelected ? [] : visible.map(i => i.id));

  const closeEditor = () => {
    setEditing(null);
    setCreating(false);
    if (id) navigate('/admin/items');
  };

  const onSaved = async (saved) => {
    closeEditor();
    await load(query);
    notify('success', saved?.name ? `Saved “${saved.name}”` : 'Page saved');
  };

  /* ---- single-row actions ---- */

  const togglePublished = async (item) => {
    setBusy(true);
    try {
      await adminApi.bulkItems(item.published ? 'unpublish' : 'publish', [item.id]);
      setItems(list => list.map(i => (i.id === item.id ? { ...i, published: item.published ? 0 : 1 } : i)));
      notify('success', `“${item.name}” is now ${item.published ? 'a draft' : 'published'}`);
    } catch (e) {
      notify('error', e.response?.data?.error || 'Could not change the status');
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async (item) => {
    setBusy(true);
    try {
      const res = await adminApi.duplicateItem(item.id);
      await load(query);
      notify('success', res.message || 'Duplicated as a draft');
      if (res.item?.id) navigate(`/admin/items/${res.item.id}`);
    } catch (e) {
      notify('error', e.response?.data?.error || 'Duplicate failed');
    } finally {
      setBusy(false);
    }
  };

  const askDelete = (item) => setConfirm({
    title: `Delete “${item.name}”?`,
    body: (
      <>
        The page at <span className="font-mono text-textPrimary">/file/{item.slug}</span> and its{' '}
        {item.download_links?.length || 0} download link{(item.download_links?.length || 0) === 1 ? '' : 's'} are removed
        permanently. Consider unpublishing instead if you might want it back.
      </>
    ),
    confirmLabel: 'Delete page',
    run: async () => {
      await itemsApi.delete(item.id);
      setSelected(s => s.filter(x => x !== item.id));
      await load(query);
      notify('success', `Deleted “${item.name}”`);
    },
  });

  /* ---- bulk actions ---- */

  const runBulk = async (action) => {
    setBusy(true);
    try {
      const res = await adminApi.bulkItems(action, selected);
      await load(query);
      setSelected([]);
      notify('success', `${action} applied to ${res.affected} page${res.affected === 1 ? '' : 's'}`);
    } catch (e) {
      notify('error', e.response?.data?.error || 'Bulk action failed');
    } finally {
      setBusy(false);
    }
  };

  const askBulkDelete = () => setConfirm({
    title: `Delete ${selected.length} page${selected.length === 1 ? '' : 's'}?`,
    body: 'These pages and all of their download links are removed permanently.',
    confirmLabel: `Delete ${selected.length}`,
    run: async () => {
      await adminApi.bulkItems('delete', selected);
      await load(query);
      setSelected([]);
      notify('success', 'Pages deleted');
    },
  });

  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      await confirm.run();
      setConfirm(null);
    } catch (e) {
      notify('error', e.response?.data?.error || 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const showEditor = creating || !!editing;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-center">
        <div className="flex-1 min-w-[220px] relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textMuted" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') load(query); }}
            placeholder="Search pages by name or slug..."
            className="w-full pl-10 pr-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
          />
        </div>
        <button onClick={() => load(query)} className="px-5 py-2.5 bg-surface border border-border rounded-xl text-sm hover:border-primary/30">
          Search
        </button>

        <div className="relative">
          <Folder className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textMuted pointer-events-none" />
          <select
            value={folderFilter}
            onChange={(e) => changeFolderFilter(e.target.value)}
            title="Filter by folder"
            className="pl-9 pr-8 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50 appearance-none"
          >
            <option value="all">All folders</option>
            <option value="none">Unfiled</option>
            {folders.map(f => (
              <option key={f.id} value={String(f.id)}>{f.icon ? `${f.icon} ` : ''}{f.name}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1 p-1 bg-surface rounded-xl border border-border">
          {FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                filter === f.id ? 'bg-gradient-primary text-white' : 'text-textSecondary hover:text-textPrimary'
              }`}
            >
              {f.label}
              {f.id !== 'all' && (
                <span className="ml-1.5 opacity-70">
                  {items.filter(i => (f.id === 'published' ? i.published : !i.published)).length}
                </span>
              )}
            </button>
          ))}
        </div>

        <button
          onClick={() => { setCreating(true); setEditing(null); }}
          className="px-5 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium shadow-lg shadow-purple-500/20 flex items-center gap-2"
        >
          <Plus className="w-4 h-4" /> New page
        </button>
      </div>

      {/* Bulk action bar */}
      {selected.length > 0 && (
        <div className="glass rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 flex flex-wrap items-center gap-2">
          <span className="text-sm text-textSecondary mr-1">
            {selected.length} selected
          </span>
          <button onClick={() => runBulk('publish')} disabled={busy}
            className="px-3 py-1.5 rounded-lg text-xs bg-surface border border-border hover:border-green-500/40 text-textSecondary disabled:opacity-50">
            Publish
          </button>
          <button onClick={() => runBulk('unpublish')} disabled={busy}
            className="px-3 py-1.5 rounded-lg text-xs bg-surface border border-border hover:border-amber-500/40 text-textSecondary disabled:opacity-50">
            Unpublish
          </button>
          <button onClick={() => runBulk('feature')} disabled={busy}
            className="px-3 py-1.5 rounded-lg text-xs bg-surface border border-border hover:border-primary/40 text-textSecondary disabled:opacity-50">
            Feature
          </button>
          <button onClick={() => runBulk('unfeature')} disabled={busy}
            className="px-3 py-1.5 rounded-lg text-xs bg-surface border border-border hover:border-primary/40 text-textSecondary disabled:opacity-50">
            Unfeature
          </button>
          <span className="inline-flex items-center gap-1 rounded-lg bg-surface border border-border px-1">
            <FolderInput className="w-3.5 h-3.5 text-textMuted ml-1" />
            <select
              value={moveTarget}
              onChange={async (e) => {
                const v = e.target.value;
                setMoveTarget('');
                if (v === '') return;
                setBusy(true);
                try {
                  const folderId = v === 'none' ? null : Number(v);
                  const res = await adminApi.bulkItems('folder', selected, { folderId });
                  await load(query);
                  setSelected([]);
                  notify('success', folderId === null
                    ? `Removed ${res.affected} page${res.affected === 1 ? '' : 's'} from their folder`
                    : `Moved ${res.affected} page${res.affected === 1 ? '' : 's'} to “${res.folder}”`);
                } catch (err) {
                  notify('error', err.response?.data?.error || 'Move failed');
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
              className="py-1.5 pr-1 bg-transparent text-xs text-textSecondary focus:outline-none disabled:opacity-50"
            >
              <option value="">Move to folder…</option>
              <option value="none">— Remove from folder —</option>
              {folders.map(f => (
                <option key={f.id} value={String(f.id)}>{f.name}</option>
              ))}
            </select>
          </span>
          <button onClick={askBulkDelete} disabled={busy}
            className="px-3 py-1.5 rounded-lg text-xs bg-red-500/10 border border-red-500/30 text-red-400 disabled:opacity-50">
            Delete
          </button>
          <button onClick={() => setSelected([])} className="ml-auto text-xs text-textMuted hover:text-textPrimary">
            Clear selection
          </button>
        </div>
      )}

      <div className="glass rounded-2xl border border-white/5 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface border-b border-border text-xs text-textMuted uppercase tracking-widest">
              <tr>
                <th className="p-4 w-10">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAll}
                    className="accent-purple-500"
                    aria-label="Select all pages"
                  />
                </th>
                <th className="text-left p-4 font-medium">Page</th>
                <th className="text-left p-4 font-medium">Folder</th>
                <th className="text-left p-4 font-medium">Type</th>
                <th className="text-left p-4 font-medium">Size</th>
                <th className="text-left p-4 font-medium">Links</th>
                <th className="text-left p-4 font-medium">Media</th>
                <th className="text-left p-4 font-medium">Status</th>
                <th className="text-right p-4 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(item => (
                <tr key={item.id} className={`border-b border-white/5 transition-colors ${selected.includes(item.id) ? 'bg-primary/5' : 'hover:bg-surface/50'}`}>
                  <td className="p-4">
                    <input
                      type="checkbox"
                      checked={selected.includes(item.id)}
                      onChange={() => toggleSelect(item.id)}
                      className="accent-purple-500"
                      aria-label={`Select ${item.name}`}
                    />
                  </td>
                  <td className="p-4">
                    <div className="font-medium text-textPrimary truncate max-w-xs flex items-center gap-1.5">
                      {item.name}
                      {!!item.featured && <Star className="w-3 h-3 text-amber-400 flex-shrink-0" />}
                    </div>
                    <div className="text-xs text-textMuted font-mono">/file/{item.slug}</div>
                  </td>
                  <td className="p-4">
                    {folderName(item.folder_id) ? (
                      <span
                        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border border-white/10"
                        style={folderById.get(item.folder_id)?.color ? { color: folderById.get(item.folder_id).color } : undefined}
                      >
                        {folderById.get(item.folder_id)?.icon || <Folder className="w-3 h-3" />}
                        <span className="text-textSecondary">{folderName(item.folder_id)}</span>
                      </span>
                    ) : (
                      <span className="text-xs text-textMuted">—</span>
                    )}
                  </td>
                  <td className="p-4 text-textSecondary">{item.file_type || '—'}{item.architecture ? ` • ${item.architecture}` : ''}</td>
                  <td className="p-4 text-textSecondary">{formatSize(item.file_size)}</td>
                  <td className="p-4">
                    <span className={`inline-flex items-center gap-1 text-xs ${item.download_links?.length ? 'text-green-400' : 'text-amber-400'}`}>
                      <Link2 className="w-3 h-3" /> {item.download_links?.length || 0}
                    </span>
                  </td>
                  <td className="p-4">
                    {item.image_url || item.icon_url ? (
                      <img src={item.image_url || item.icon_url} alt="" className="w-6 h-6 rounded object-cover" onError={(e) => { e.target.style.display = 'none'; }} />
                    ) : (
                      <ImageIcon className="w-4 h-4 text-textMuted" />
                    )}
                  </td>
                  <td className="p-4">
                    <button
                      onClick={() => togglePublished(item)}
                      disabled={busy}
                      title={item.published ? 'Unpublish (hide from visitors)' : 'Publish'}
                      className={`px-2 py-1 rounded-full text-xs transition-colors disabled:opacity-50 ${
                        item.published
                          ? 'bg-green-500/10 text-green-400 hover:bg-green-500/20'
                          : 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
                      }`}
                    >
                      {item.published ? 'Published' : 'Draft'}
                    </button>
                  </td>
                  <td className="p-4">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => { setCreating(false); setEditing(item); }}
                        title="Edit"
                        className="p-2 hover:bg-surfaceHover rounded-lg text-textMuted hover:text-primary transition-colors"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => duplicate(item)}
                        disabled={busy}
                        title="Duplicate as draft"
                        className="p-2 hover:bg-surfaceHover rounded-lg text-textMuted hover:text-primary transition-colors disabled:opacity-40"
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => togglePublished(item)}
                        disabled={busy}
                        title={item.published ? 'Unpublish' : 'Publish'}
                        className="p-2 hover:bg-surfaceHover rounded-lg text-textMuted hover:text-primary transition-colors disabled:opacity-40"
                      >
                        {item.published ? <EyeOff className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                      </button>
                      <a
                        href={`/file/${item.slug}`}
                        target="_blank"
                        rel="noreferrer"
                        title="View page"
                        className="p-2 hover:bg-surfaceHover rounded-lg text-textMuted hover:text-primary transition-colors"
                      >
                        <Eye className="w-4 h-4" />
                      </a>
                      <button
                        onClick={() => askDelete(item)}
                        title="Delete"
                        className="p-2 hover:bg-surfaceHover rounded-lg text-textMuted hover:text-red-400 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={9} className="p-10 text-center">
                    <p className="text-sm text-textSecondary mb-1">
                      {items.length === 0 ? 'No file pages yet.' : 'No pages match this filter.'}
                    </p>
                    <p className="text-xs text-textMuted mb-4">
                      {items.length === 0
                        ? 'Start from a template — it fills in the type, tags and a description outline for you.'
                        : 'Try a different filter or clear the search.'}
                    </p>
                    <button
                      onClick={() => { setCreating(true); setEditing(null); }}
                      className="px-4 py-2 bg-gradient-primary text-white rounded-xl text-sm font-medium inline-flex items-center gap-2"
                    >
                      <Plus className="w-4 h-4" /> Create a page
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-[70] px-4 py-3 rounded-xl border text-sm shadow-lg ${
            toast.kind === 'error'
              ? 'bg-red-500/10 border-red-500/30 text-red-300'
              : 'bg-green-500/10 border-green-500/30 text-green-300'
          }`}
        >
          {toast.message}
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={runConfirm}
        />
      )}

      {showEditor && (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto">
          <div className="w-full max-w-4xl my-8 relative">
            <button
              type="button"
              onClick={closeEditor}
              className="absolute -top-3 -right-3 z-10 p-2 rounded-full bg-surface border border-border text-textSecondary hover:text-textPrimary"
            >
              <X className="w-4 h-4" />
            </button>
            {loadingId ? (
              <div className="bg-surface border border-border rounded-2xl p-10 text-center text-textMuted text-sm">Loading page...</div>
            ) : (
              <ItemEditor item={creating ? null : editing} onSaved={onSaved} onClose={closeEditor} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
