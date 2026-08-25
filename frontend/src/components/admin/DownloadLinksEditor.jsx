import { Plus, Trash2, Star, GripVertical, AlertTriangle } from 'lucide-react';

const PROVIDERS = [
  { value: 'external', label: 'External URL' },
  { value: 'gdrive', label: 'Google Drive' },
  { value: 'onedrive', label: 'OneDrive' },
  { value: 'github', label: 'GitHub Releases' },
  { value: 'local', label: 'Local file' },
];

const STATUSES = [
  { value: 'up', label: 'Up' },
  { value: 'down', label: 'Down' },
  { value: 'unknown', label: 'Unknown' },
  { value: 'checking', label: 'Checking' },
];

function blankLink(sortOrder = 0) {
  return {
    label: '',
    storage_provider: 'external',
    storage_path: '',
    download_url: '',
    file_size: '',
    is_primary: sortOrder === 0,
    is_down: false,
    down_reason: '',
    status: 'up',
    sort_order: sortOrder,
  };
}

/**
 * Editor for an item's download mirrors.
 *
 * Every field the backend stores on item_download_links is editable here,
 * including per-mirror status and a "down" reason, so a broken mirror can be
 * flagged without deleting it.
 */
export default function DownloadLinksEditor({ links, onChange }) {
  const list = links || [];

  const update = (index, field, value) => {
    const next = list.map((l, i) => {
      if (i !== index) return l;
      return { ...l, [field]: value };
    });

    // Only one mirror may be primary.
    if (field === 'is_primary' && value) {
      return onChange(next.map((l, i) => (i === index ? l : { ...l, is_primary: false })));
    }
    onChange(next);
  };

  const remove = (index) => {
    const next = list.filter((_, i) => i !== index);
    // Keep exactly one primary if any links remain.
    if (next.length && !next.some(l => l.is_primary)) next[0] = { ...next[0], is_primary: true };
    onChange(next);
  };

  const move = (index, dir) => {
    const target = index + dir;
    if (target < 0 || target >= list.length) return;
    const next = [...list];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next.map((l, i) => ({ ...l, sort_order: i })));
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-medium text-textMuted uppercase tracking-widest">
          Download links ({list.length})
        </label>
        <button
          type="button"
          onClick={() => onChange([...list, blankLink(list.length)])}
          className="px-3 py-1.5 bg-gradient-primary text-white rounded-lg text-xs font-medium flex items-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" /> Add link
        </button>
      </div>

      {list.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-5 text-center">
          <AlertTriangle className="w-5 h-5 mx-auto mb-2 text-amber-400" />
          <p className="text-sm text-textSecondary">No download links yet.</p>
          <p className="text-xs text-textMuted mt-1">Visitors will not be able to download this item.</p>
        </div>
      )}

      <div className="space-y-3">
        {list.map((link, index) => (
          <div key={index} className="rounded-xl border border-border bg-surface p-3">
            <div className="flex items-center gap-2 mb-3">
              <div className="flex flex-col">
                <button type="button" onClick={() => move(index, -1)} disabled={index === 0}
                  className="text-textMuted hover:text-textPrimary disabled:opacity-25 leading-none text-xs px-1">▲</button>
                <button type="button" onClick={() => move(index, 1)} disabled={index === list.length - 1}
                  className="text-textMuted hover:text-textPrimary disabled:opacity-25 leading-none text-xs px-1">▼</button>
              </div>
              <GripVertical className="w-4 h-4 text-textMuted" />
              <span className="text-xs font-medium text-textSecondary">Mirror {index + 1}</span>
              <label className="ml-auto flex items-center gap-1.5 text-xs text-textSecondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!link.is_primary}
                  onChange={(e) => update(index, 'is_primary', e.target.checked)}
                  className="accent-purple-500"
                />
                <Star className="w-3 h-3" /> Primary
              </label>
              <button
                type="button"
                onClick={() => remove(index)}
                className="p-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20"
                title="Remove link"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <span className="text-[11px] text-textMuted block mb-1">Label</span>
                <input
                  value={link.label || ''}
                  onChange={(e) => update(index, 'label', e.target.value)}
                  placeholder="Official Ubuntu Releases"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/50"
                />
              </div>
              <div>
                <span className="text-[11px] text-textMuted block mb-1">Provider</span>
                <select
                  value={link.storage_provider || 'external'}
                  onChange={(e) => update(index, 'storage_provider', e.target.value)}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/50"
                >
                  {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2">
                <span className="text-[11px] text-textMuted block mb-1">Download URL</span>
                <input
                  value={link.download_url || ''}
                  onChange={(e) => update(index, 'download_url', e.target.value)}
                  placeholder="https://..."
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono focus:outline-none focus:border-primary/50"
                />
              </div>
              <div>
                <span className="text-[11px] text-textMuted block mb-1">Storage path / file ID</span>
                <input
                  value={link.storage_path || ''}
                  onChange={(e) => update(index, 'storage_path', e.target.value)}
                  placeholder="Drive file ID or path"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono focus:outline-none focus:border-primary/50"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-[11px] text-textMuted block mb-1">Size (bytes)</span>
                  <input
                    type="number"
                    value={link.file_size ?? ''}
                    onChange={(e) => update(index, 'file_size', e.target.value)}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/50"
                  />
                </div>
                <div>
                  <span className="text-[11px] text-textMuted block mb-1">Status</span>
                  <select
                    value={link.status || 'up'}
                    onChange={(e) => update(index, 'status', e.target.value)}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/50"
                  >
                    {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="sm:col-span-2">
                <label className="flex items-center gap-2 text-xs text-textSecondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!link.is_down}
                    onChange={(e) => update(index, 'is_down', e.target.checked)}
                    className="accent-red-500"
                  />
                  Mark this mirror as down (blocks downloads, keeps the record)
                </label>
                {link.is_down && (
                  <input
                    value={link.down_reason || ''}
                    onChange={(e) => update(index, 'down_reason', e.target.value)}
                    placeholder="Why is it down? (shown to visitors)"
                    className="mt-2 w-full px-3 py-2 bg-background border border-red-500/30 rounded-lg text-sm focus:outline-none focus:border-red-500/60"
                  />
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
