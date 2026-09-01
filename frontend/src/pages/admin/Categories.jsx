import { useEffect, useState } from 'react';
import { Loader2, AlertCircle, Check } from 'lucide-react';
import { categoriesApi } from '../../lib/api';

/**
 * Read-only category overview. Categories drive the browse filters and the
 * homepage grid, so they are surfaced here; editing them is a separate concern
 * from per-item editing.
 */
export default function AdminCategories() {
  const [categories, setCategories] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    categoriesApi.list()
      .then(d => setCategories(d.categories || []))
      .catch(e => setError(e.response?.data?.error || 'Failed to load categories'));
  }, []);

  if (error) {
    return (
      <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400 flex items-center gap-2">
        <AlertCircle className="w-4 h-4" /> {error}
      </div>
    );
  }

  if (!categories.length) {
    return <div className="text-sm text-textMuted flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading categories...</div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-textMuted">
        Categories drive the browse filters, the homepage grid and item grouping.
      </p>
      <div className="grid md:grid-cols-2 gap-4">
        {categories.map(c => (
          <div key={c.id} className="glass rounded-2xl border border-white/5 p-5 flex items-start gap-4">
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
              style={{ background: c.color ? `${c.color}22` : 'rgb(var(--c-primary) / 0.13)', border: c.color ? `1px solid ${c.color}44` : '1px solid rgb(var(--c-primary) / 0.27)' }}
            >
              {c.icon || '📁'}
            </div>
            <div className="min-w-0">
              <div className="font-medium text-textPrimary">{c.name}</div>
              <div className="text-xs text-textMuted font-mono">{c.slug}</div>
              {c.description && <p className="text-xs text-textSecondary mt-1.5">{c.description}</p>}
              <div className="text-xs text-textMuted mt-2 flex items-center gap-1">
                <Check className="w-3 h-3" /> {c.item_count ?? 0} item{(c.item_count ?? 0) === 1 ? '' : 's'}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
