import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Search, Plus, Edit, Trash2, Eye, X, Link2, ImageIcon } from 'lucide-react';
import { adminApi, itemsApi } from '../../lib/api';
import ItemEditor from '../../components/admin/ItemEditor';

function formatSize(bytes) {
  if (!bytes) return '—';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

export default function AdminItems() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null); // item object being edited
  const [creating, setCreating] = useState(false);
  const [loadingId, setLoadingId] = useState(null);

  const load = useCallback(async (q = '') => {
    try {
      const data = await adminApi.items({ q, limit: 200 });
      setItems(data.items || []);
    } catch (e) {
      console.error('Failed to load items', e);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

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

  const closeEditor = () => {
    setEditing(null);
    setCreating(false);
    if (id) navigate('/admin/items');
  };

  const onSaved = async () => {
    closeEditor();
    await load(query);
  };

  const handleDelete = async (item) => {
    if (!window.confirm(`Delete "${item.name}"? This cannot be undone.`)) return;
    try {
      await itemsApi.delete(item.id);
      await load(query);
    } catch (e) {
      window.alert(e.response?.data?.error || 'Delete failed');
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
            placeholder="Search files by name or slug..."
            className="w-full pl-10 pr-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
          />
        </div>
        <button onClick={() => load(query)} className="px-5 py-2.5 bg-surface border border-border rounded-xl text-sm hover:border-primary/30">
          Search
        </button>
        <button
          onClick={() => { setCreating(true); setEditing(null); }}
          className="px-5 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium shadow-lg shadow-purple-500/20 flex items-center gap-2"
        >
          <Plus className="w-4 h-4" /> Add File
        </button>
      </div>

      <div className="glass rounded-2xl border border-white/5 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface border-b border-border text-xs text-textMuted uppercase tracking-widest">
              <tr>
                <th className="text-left p-4 font-medium">Name</th>
                <th className="text-left p-4 font-medium">Type</th>
                <th className="text-left p-4 font-medium">Size</th>
                <th className="text-left p-4 font-medium">Links</th>
                <th className="text-left p-4 font-medium">Media</th>
                <th className="text-left p-4 font-medium">Status</th>
                <th className="text-right p-4 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.id} className="border-b border-white/5 hover:bg-surface/50 transition-colors">
                  <td className="p-4">
                    <div className="font-medium text-textPrimary truncate max-w-xs">{item.name}</div>
                    <div className="text-xs text-textMuted">{item.slug}</div>
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
                    <span className={`px-2 py-1 rounded-full text-xs ${item.published ? 'bg-green-500/10 text-green-400' : 'bg-amber-500/10 text-amber-400'}`}>
                      {item.published ? 'Published' : 'Draft'}
                    </span>
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
                        onClick={() => handleDelete(item)}
                        title="Delete"
                        className="p-2 hover:bg-surfaceHover rounded-lg text-textMuted hover:text-red-400 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={7} className="p-8 text-center text-textMuted text-sm">No files found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

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
              <div className="bg-surface border border-border rounded-2xl p-10 text-center text-textMuted text-sm">Loading item...</div>
            ) : (
              <ItemEditor item={creating ? null : editing} onSaved={onSaved} onClose={closeEditor} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
