import { useMemo, useState } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';

/**
 * Catalogue filter + sort panel for Admin -> File pages.
 *
 * Options come from `/admin/catalog/facets`, so the dropdowns list values that
 * actually exist in the database (with counts) instead of a hard-coded list
 * that drifts. Sort columns mirror the server's allow-list.
 */

const SORTS = [
  { id: 'updated_at', label: 'Recently updated' },
  { id: 'created_at', label: 'Recently added' },
  { id: 'name', label: 'Name' },
  { id: 'release_date', label: 'Release date' },
  { id: 'file_size', label: 'File size' },
  { id: 'download_count', label: 'Downloads' },
  { id: 'view_count', label: 'Views' },
  { id: 'status', label: 'Status' },
  { id: 'version', label: 'Version' },
];

const STATUSES = [
  { id: 'current', label: 'Current' },
  { id: 'legacy', label: 'Legacy' },
  { id: 'deprecated', label: 'Deprecated' },
  { id: 'archived', label: 'Archived' },
  { id: 'unreleased', label: 'Unreleased' },
];

const LINK_HEALTH = [
  { id: 'up', label: 'All mirrors up' },
  { id: 'down', label: 'A mirror is down' },
  { id: 'unknown', label: 'Not checked yet' },
  { id: 'checking', label: 'Checking' },
  { id: 'missing', label: 'No download links' },
];

const MISSING = [
  { id: 'icon', label: 'Missing icon' },
  { id: 'banner', label: 'Missing banner' },
  { id: 'checksum', label: 'Missing SHA-256' },
  { id: 'description', label: 'Missing description' },
  { id: 'version', label: 'Missing version' },
  { id: 'release_date', label: 'Missing release date' },
  { id: 'links', label: 'No download links' },
];

const selectClass = 'w-full px-2.5 py-2 bg-surface border border-border rounded-lg text-xs text-textSecondary focus:outline-none focus:border-primary/50';
const labelClass = 'text-[10px] uppercase tracking-widest text-textMuted mb-1 block';

function Field({ label, children }) {
  return (
    <label className="block min-w-[130px]">
      <span className={labelClass}>{label}</span>
      {children}
    </label>
  );
}

export default function CatalogFilters({ facets = {}, value, onChange, onReset, resultCount, loading }) {
  const [open, setOpen] = useState(false);

  const set = (key, v) => onChange({ ...value, [key]: v || '' });
  const activeCount = useMemo(
    () => Object.entries(value).filter(([k, v]) => v && k !== 'q' && k !== 'sort' && k !== 'order' && k !== 'page').length,
    [value]
  );

  return (
    <div className="glass rounded-xl border border-white/5">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <button
          onClick={() => setOpen(o => !o)}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
            open || activeCount ? 'border-primary/40 text-primary bg-primary/10' : 'border-border text-textSecondary hover:border-primary/30'
          }`}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          Filters
          {activeCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-primary/20 text-primary text-[10px] tabular-nums">{activeCount}</span>
          )}
        </button>

        <Field label="Sort by">
          <select value={value.sort || 'updated_at'} onChange={(e) => onChange({ ...value, sort: e.target.value, page: 1 })} className={selectClass}>
            {SORTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </Field>

        <Field label="Order">
          <select value={value.order || 'desc'} onChange={(e) => onChange({ ...value, order: e.target.value, page: 1 })} className={selectClass}>
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </Field>

        <div className="ml-auto flex items-center gap-3">
          {typeof resultCount === 'number' && (
            <span className="text-xs text-textMuted tabular-nums">
              {loading ? 'Searching…' : `${resultCount.toLocaleString()} match${resultCount === 1 ? '' : 'es'}`}
            </span>
          )}
          {activeCount > 0 && (
            <button onClick={onReset} className="flex items-center gap-1 text-xs text-textMuted hover:text-red-400">
              <X className="w-3 h-3" /> Clear filters
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="grid gap-3 px-3 pb-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 border-t border-white/5 pt-3">
          <Field label="Category">
            <select value={value.category || ''} onChange={(e) => set('category', e.target.value)} className={selectClass}>
              <option value="">Any</option>
              {(facets.categories || []).map(c => (
                <option key={c.value} value={c.value}>{c.label} ({c.count})</option>
              ))}
            </select>
          </Field>

          <Field label="Tag">
            <select value={value.tag || ''} onChange={(e) => set('tag', e.target.value)} className={selectClass}>
              <option value="">Any</option>
              {(facets.tags || []).map(t => (
                <option key={t.value} value={t.label || t.value}>{t.label || t.value} ({t.count})</option>
              ))}
            </select>
          </Field>

          <Field label="Platform">
            <select value={value.platform || ''} onChange={(e) => set('platform', e.target.value)} className={selectClass}>
              <option value="">Any</option>
              {(facets.platforms || []).map(p => (
                <option key={p.value} value={p.value}>{p.value} ({p.count})</option>
              ))}
            </select>
          </Field>

          <Field label="Architecture">
            <select value={value.architecture || ''} onChange={(e) => set('architecture', e.target.value)} className={selectClass}>
              <option value="">Any</option>
              {(facets.architectures || []).map(a => (
                <option key={a.value} value={a.value}>{a.value} ({a.count})</option>
              ))}
            </select>
          </Field>

          <Field label="Status">
            <select value={value.status || ''} onChange={(e) => set('status', e.target.value)} className={selectClass}>
              <option value="">Any</option>
              {STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </Field>

          <Field label="Version">
            <select value={value.version || ''} onChange={(e) => set('version', e.target.value)} className={selectClass}>
              <option value="">Any</option>
              {(facets.versions || []).map(v => (
                <option key={v.value} value={v.value}>{v.value} ({v.count})</option>
              ))}
            </select>
          </Field>

          <Field label="Storage provider">
            <select value={value.storage_provider || ''} onChange={(e) => set('storage_provider', e.target.value)} className={selectClass}>
              <option value="">Any</option>
              {(facets.storage_providers || []).map(p => (
                <option key={p.value} value={p.value}>{p.value} ({p.count})</option>
              ))}
            </select>
          </Field>

          <Field label="Published">
            <select value={value.published || ''} onChange={(e) => set('published', e.target.value)} className={selectClass}>
              <option value="">Any</option>
              <option value="true">Published</option>
              <option value="false">Drafts</option>
            </select>
          </Field>

          <Field label="Link health">
            <select value={value.link_health || ''} onChange={(e) => set('link_health', e.target.value)} className={selectClass}>
              <option value="">Any</option>
              {LINK_HEALTH.map(h => <option key={h.id} value={h.id}>{h.label}</option>)}
            </select>
          </Field>

          <Field label="Missing">
            <select value={value.missing || ''} onChange={(e) => set('missing', e.target.value)} className={selectClass}>
              <option value="">Any</option>
              {MISSING.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </Field>

          <Field label="Released from">
            <input
              type="date"
              value={value.release_from || ''}
              onChange={(e) => set('release_from', e.target.value)}
              className={selectClass}
            />
          </Field>

          <Field label="Released to">
            <input
              type="date"
              value={value.release_to || ''}
              onChange={(e) => set('release_to', e.target.value)}
              className={selectClass}
            />
          </Field>
        </div>
      )}
    </div>
  );
}

export { SORTS, STATUSES, LINK_HEALTH, MISSING };
