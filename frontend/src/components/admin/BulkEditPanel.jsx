import { useMemo, useState } from 'react';
import { Archive, Ban, Check, Layers, Star, Trash2 } from 'lucide-react';

/**
 * Bulk edit panel for Admin -> File pages.
 *
 * One place to change any single field across the selection: category, tags,
 * platform, architecture, version, status, folder, and the icon/banner URLs.
 * The value input adapts to the field, and the apply button names exactly what
 * is about to happen to how many rows so nothing is a surprise. Destructive
 * actions (archive, delete) go through `onConfirm` so the page can show its
 * confirmation dialog first.
 */

const FIELDS = [
  { id: 'status', label: 'Status', kind: 'select', options: [
    { value: 'current', label: 'Current' },
    { value: 'legacy', label: 'Legacy' },
    { value: 'deprecated', label: 'Deprecated' },
    { value: 'archived', label: 'Archived' },
    { value: 'unreleased', label: 'Unreleased' },
  ] },
  { id: 'category', label: 'Category', kind: 'select', options: [] },
  { id: 'folder', label: 'Folder', kind: 'select', options: [] },
  { id: 'tags', label: 'Tags (comma separated)', kind: 'text', placeholder: 'lts, server, free' },
  { id: 'platform', label: 'Platform', kind: 'text', placeholder: 'Linux' },
  { id: 'architecture', label: 'Architecture', kind: 'text', placeholder: 'amd64' },
  { id: 'version', label: 'Version', kind: 'text', placeholder: '1.2.3' },
  { id: 'icon_url', label: 'Icon URL (external)', kind: 'url', placeholder: 'https://example.com/icon.png' },
  { id: 'banner_url', label: 'Banner URL (external)', kind: 'url', placeholder: 'https://example.com/banner.png' },
];

const selectClass = 'px-2.5 py-1.5 bg-surface border border-border rounded-lg text-xs text-textSecondary focus:outline-none focus:border-primary/50 min-w-[160px]';

export default function BulkEditPanel({
  count,
  categories = [],
  folders = [],
  busy = false,
  progress = null,
  onApply,
  onConfirm,
}) {
  const [field, setField] = useState('');
  const [value, setValue] = useState('');

  const fields = useMemo(() => FIELDS.map(f => {
    if (f.id === 'category') {
      return { ...f, options: categories.map(c => ({ value: String(c.id), label: c.name })) };
    }
    if (f.id === 'folder') {
      return {
        ...f,
        options: [
          { value: 'none', label: '— Remove from folder —' },
          ...folders.map(f2 => ({ value: String(f2.id), label: f2.name })),
        ],
      };
    }
    return f;
  }), [categories, folders]);

  const active = fields.find(f => f.id === field);
  const plural = count === 1 ? 'page' : 'pages';

  const apply = () => {
    if (!active) return;
    onApply(active.id, value, active.label);
  };

  const quick = [
    { action: 'publish', label: 'Publish', icon: Check, className: 'hover:border-green-500/40' },
    { action: 'unpublish', label: 'Unpublish', icon: Ban, className: 'hover:border-amber-500/40' },
    { action: 'feature', label: 'Feature', icon: Star, className: 'hover:border-primary/40' },
    { action: 'unfeature', label: 'Unfeature', icon: Star, className: 'hover:border-primary/40' },
  ];

  return (
    <div className="glass rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-textSecondary mr-1 font-medium">
          {count} selected
        </span>

        {quick.map(q => (
          <button
            key={q.action}
            onClick={() => onApply(q.action, null, q.label)}
            disabled={busy}
            className={`px-3 py-1.5 rounded-lg text-xs bg-surface border border-border text-textSecondary disabled:opacity-50 flex items-center gap-1.5 ${q.className}`}
          >
            <q.icon className="w-3 h-3" /> {q.label}
          </button>
        ))}

        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

        {/* Field editor: choose what to change, then the new value. */}
        <select
          value={field}
          onChange={(e) => { setField(e.target.value); setValue(''); }}
          disabled={busy}
          className={selectClass}
          aria-label="Field to change"
        >
          <option value="">Change field…</option>
          {fields.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>

        {active && (
          active.kind === 'select' ? (
            <select value={value} onChange={(e) => setValue(e.target.value)} disabled={busy} className={selectClass} aria-label={active.label}>
              <option value="">Choose…</option>
              {active.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <input
              type={active.kind === 'url' ? 'url' : 'text'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) apply(); }}
              placeholder={active.placeholder}
              disabled={busy}
              className="px-2.5 py-1.5 bg-surface border border-border rounded-lg text-xs text-textSecondary focus:outline-none focus:border-primary/50 min-w-[200px] flex-1"
              aria-label={active.label}
            />
          )
        )}

        <button
          onClick={apply}
          disabled={busy || !active || !String(value).trim()}
          className="px-3 py-1.5 rounded-lg text-xs bg-gradient-primary text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Apply
        </button>

        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

        <button
          onClick={() => onConfirm('archive')}
          disabled={busy}
          className="px-3 py-1.5 rounded-lg text-xs bg-surface border border-border hover:border-amber-500/40 text-textSecondary disabled:opacity-50 flex items-center gap-1.5"
        >
          <Archive className="w-3 h-3" /> Archive
        </button>
        <button
          onClick={() => onConfirm('delete')}
          disabled={busy}
          className="px-3 py-1.5 rounded-lg text-xs bg-red-500/10 border border-red-500/30 text-red-400 disabled:opacity-50 flex items-center gap-1.5"
        >
          <Trash2 className="w-3 h-3" /> Delete
        </button>
      </div>

      {progress ? (
        <div className="max-w-md">{progress}</div>
      ) : (
        <p className="text-[11px] text-textMuted flex items-center gap-1.5">
          <Layers className="w-3 h-3" />
          Archive keeps the {plural} but marks them archived and unpublishes them; delete removes them permanently.
        </p>
      )}
    </div>
  );
}
