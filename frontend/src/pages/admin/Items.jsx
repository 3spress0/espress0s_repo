import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Search, Plus, Edit, Trash2, Eye, X, Link2, ImageIcon, Copy,
  EyeOff, Loader2, AlertTriangle, CheckCircle2, Star, Folder,
} from 'lucide-react';
import { adminApi, itemsApi, foldersApi, categoriesApi, catalogAdminApi } from '../../lib/api';
import ItemEditor from '../../components/admin/ItemEditor';
import Loading, { LoadingDots } from '../../components/Loading';
import Progress from '../../components/Progress';
import CatalogFilters from '../../components/admin/CatalogFilters';
import BulkEditPanel from '../../components/admin/BulkEditPanel';

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

const PAGE_SIZE = 50;

/**
 * Every value that narrows or orders the result set. They are sent to
 * `/admin/catalog/search`, which runs the FTS5 index and the admin-only
 * filters in SQL, so the table reflects the whole catalogue rather than one
 * page of rows filtered again in the browser.
 */
const DEFAULT_FILTERS = {
  q: '', published: '', status: '', category: '', tag: '', platform: '',
  architecture: '', version: '', storage_provider: '', folder: 'all',
  missing: '', link_health: '', release_from: '', release_to: '',
  sort: 'updated_at', order: 'desc', page: 1,
};

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
  // Seed the filter state from the query string so links from the dashboard
  // (?status=deprecated, ?missing=icon, ?link_health=down, ...) open this view
  // already filtered.
  const [filters, setFilters] = useState(() => {
    const next = { ...DEFAULT_FILTERS };
    for (const key of Object.keys(DEFAULT_FILTERS)) {
      const raw = searchParams.get(key);
      if (raw === null) continue;
      if (key === 'page') next.page = Math.max(1, parseInt(raw, 10) || 1);
      else next[key] = raw;
    }
    return next;
  });
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState({});
  const [categories, setCategories] = useState([]);
  const [progress, setProgress] = useState(null);
  const [editing, setEditing] = useState(null); // item object being edited
  const [creating, setCreating] = useState(false);
  const [loadingId, setLoadingId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState([]); // ids
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null); // { kind, message }
  const [confirm, setConfirm] = useState(null); // { title, body, confirmLabel, run }

  const notify = (kind, message) => {
    setToast({ kind, message });
    setTimeout(() => setToast(t => (t?.message === message ? null : t)), 4000);
  };

  /** Re-run the current filter set (used after bulk edits and single saves). */
  const load = useCallback(() => setFilters(f => ({ ...f })), []);

  // One request per filter change, debounced so typing in the search box does
  // not fire a query per keystroke.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const t = setTimeout(async () => {
      try {
        const res = await catalogAdminApi.search({ ...filters, limit: PAGE_SIZE });
        if (cancelled) return;
        setItems(res.items || []);
        setTotal(res.total || 0);
      } catch (e) {
        if (cancelled) return;
        setError(e.response?.data?.error || e.message || 'Search failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [filters]);

  useEffect(() => {
    catalogAdminApi.facets().then(setFacets).catch(() => {});
    foldersApi.adminList().then(d => setFolders(d.folders || [])).catch(() => {});
    categoriesApi.list().then(r => setCategories(r.categories || [])).catch(() => {});
  }, []);

  const patchFilters = (patch) => {
    setFilters(f => ({ ...f, ...patch, page: 1 }));
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      if (v && v !== 'all') next.set(k, v); else next.delete(k);
    }
    setSearchParams(next, { replace: true });
  };


  const folderById = useMemo(() => new Map(folders.map(f => [f.id, f])), [folders]);
  const folderName = (folderId) => folderId ? (folderById.get(folderId)?.name || `#${folderId}`) : null;


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

  // Every filter is already applied server-side, so the table renders what
  // came back.
  const visible = items;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
    load();
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
      load();
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
      load();
      notify('success', `Deleted “${item.name}”`);
    },
  });

  /* ---- bulk actions ---- */

  /**
   * Run a bulk action with a progress bar. The request itself is one
   * transaction, so the bar shows staged progress (sending, waiting,
   * refreshing) rather than pretending to know per-row progress.
   */
  const runBulk = async (action, value, label) => {
    const count = selected.length;
    setBusy(true);
    setProgress({ label: label || action, value: 5, sublabel: `${count} selected` });
    try {
      const res = await adminApi.bulkItems(action, selected, value ?? undefined);
      setProgress({ label: label || action, value: 75, sublabel: `${res.affected} updated` });
      load();
      setSelected([]);
      notify('success', `${label || action}: ${res.affected} page${res.affected === 1 ? '' : 's'}`);
      setProgress({ label: 'Done', value: 100, tone: 'success' });
    } catch (e) {
      notify('error', e.response?.data?.error || 'Bulk action failed');
      setProgress(null);
    } finally {
      setBusy(false);
      setTimeout(() => setProgress(null), 1200);
    }
  };

  /** Field edits from the bulk panel map onto a bulk action + value. */
  const applyBulkEdit = (field, value, label) => {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) {
      notify('error', `Enter a value for ${label}`);
      return;
    }
    // The endpoint takes the new value under a generic `value` key (folder
    // keeps its own `folderId` so null can mean "remove from folder").
    const payload = field === 'folder'
      ? { folderId: trimmed === 'none' ? null : Number(trimmed) }
      : { value: trimmed };
    runBulk(field, payload, label);
  };

  /** Archive/delete go through ConfirmDialog first. */
  const askBulk = (kind) => {
    const n = selected.length;
    if (kind === 'archive') {
      setConfirm({
        title: `Archive ${n} page${n === 1 ? '' : 's'}?`,
        body: 'They are marked as archived and unpublished, so visitors no longer see them. Nothing is deleted and you can restore them at any time.',
        confirmLabel: `Archive ${n}`,
        run: async () => { await runBulk('archive', null, 'Archive'); },
      });
      return;
    }
    setConfirm({
      title: `Delete ${n} page${n === 1 ? '' : 's'}?`,
      body: 'These pages and all of their download links are removed permanently. Consider archiving instead if you might want them back.',
      confirmLabel: `Delete ${n}`,
      run: async () => { await runBulk('delete', null, 'Delete'); },
    });
  };

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
      {/* Search box: server-side FTS5 across the whole catalogue. */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="flex-1 min-w-[220px] relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textMuted" />
          <input
            type="search"
            value={filters.q}
            onChange={(e) => patchFilters({ q: e.target.value })}
            placeholder="Search the whole catalogue by name, description or tag..."
            aria-label="Search the catalogue"
            className="w-full pl-10 pr-12 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
          />
          {loading && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2">
              <LoadingDots size={16} />
            </span>
          )}
        </div>

        <div className="relative">
          <Folder className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textMuted pointer-events-none" />
          <select
            value={filters.folder}
            onChange={(e) => patchFilters({ folder: e.target.value })}
            title="Filter by folder"
            aria-label="Filter by folder"
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
          {FILTERS.map(f => {
            const want = f.id === 'published' ? 'true' : f.id === 'draft' ? 'false' : '';
            const activeTab = (filters.published || '') === want;
            return (
              <button
                key={f.id}
                onClick={() => patchFilters({ published: want })}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  activeTab ? 'bg-gradient-primary text-white' : 'text-textSecondary hover:text-textPrimary'
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        <button
          onClick={() => { setCreating(true); setEditing(null); }}
          className="px-5 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium shadow-lg shadow-purple-500/20 flex items-center gap-2"
        >
          <Plus className="w-4 h-4" /> New page
        </button>
      </div>

      {/* Filters + sorting. Options come from the database, so the dropdowns
          only offer values that actually exist. */}
      <CatalogFilters
        facets={facets}
        value={filters}
        onChange={(next) => {
          setFilters(next);
          const sp = new URLSearchParams(searchParams);
          if (next.folder && next.folder !== 'all') sp.set('folder', next.folder); else sp.delete('folder');
          if (next.q) sp.set('q', next.q); else sp.delete('q');
          setSearchParams(sp, { replace: true });
        }}
        onReset={() => {
          setFilters(DEFAULT_FILTERS);
          setSearchParams(new URLSearchParams(), { replace: true });
        }}
        resultCount={total}
        loading={loading}
      />

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Bulk selection: quick toggles, any-field edits, archive and delete. */}
      {selected.length > 0 && (
        <>
          <BulkEditPanel
            count={selected.length}
            categories={categories}
            folders={folders}
            busy={busy}
            progress={progress ? (
              <Progress
                value={progress.value}
                label={progress.label}
                sublabel={progress.sublabel}
                tone={progress.tone}
              />
            ) : null}
            onApply={(action, value, label) => {
              if (value === null || value === undefined) runBulk(action, null, label);
              else applyBulkEdit(action, value, label);
            }}
            onConfirm={askBulk}
          />
          <div className="flex justify-end">
            <button onClick={() => setSelected([])} className="text-xs text-textMuted hover:text-textPrimary">
              Clear selection
            </button>
          </div>
        </>
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
              {loading && visible.length === 0 && (
                <tr>
                  <td colSpan={9} className="p-10 text-center">
                    <Loading text="Searching the catalogue…" />
                  </td>
                </tr>
              )}
              {visible.length === 0 && !loading && (
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

      {/* Result count + paging. The server sorts and filters, so the page
          controls just move the window over the same query. */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-textMuted">
        <span className="tabular-nums">
          {total === 0 ? 'No matches' : `Showing ${visible.length} of ${total.toLocaleString()}`}
        </span>
        {pageCount > 1 && (
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setFilters(f => ({ ...f, page: Math.max(1, (f.page || 1) - 1) }))}
              disabled={loading || (filters.page || 1) <= 1}
              className="px-3 py-1.5 rounded-lg bg-surface border border-border text-textSecondary disabled:opacity-40 hover:border-primary/30"
            >
              Previous
            </button>
            <span className="tabular-nums">Page {filters.page || 1} of {pageCount}</span>
            <button
              onClick={() => setFilters(f => ({ ...f, page: Math.min(pageCount, (f.page || 1) + 1) }))}
              disabled={loading || (filters.page || 1) >= pageCount}
              className="px-3 py-1.5 rounded-lg bg-surface border border-border text-textSecondary disabled:opacity-40 hover:border-primary/30"
            >
              Next
            </button>
          </div>
        )}
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
