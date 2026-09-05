import { useEffect, useState } from 'react';
import { History, X } from 'lucide-react';
import ItemCard from './ItemCard';
import { getRecentlyViewed, clearRecentlyViewed, onRecentlyViewedChange } from '../lib/recentlyViewed';

/** "Recently viewed" strip. Renders nothing until there is history. */
export default function RecentlyViewed({ limit = 6, title = 'Recently viewed', className = '' }) {
  const [items, setItems] = useState(getRecentlyViewed);
  useEffect(() => onRecentlyViewedChange(setItems), []);
  if (items.length === 0) return null;
  return (
    <section className={className}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-textPrimary flex items-center gap-2">
          <History className="w-4 h-4 text-amber-400" /> {title}
        </h2>
        <button onClick={clearRecentlyViewed} className="text-xs text-textMuted hover:text-textPrimary flex items-center gap-1" title="Clear history (this browser only)">
          <X className="w-3.5 h-3.5" /> Clear
        </button>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {items.slice(0, limit).map((item) => <ItemCard key={item.slug} item={item} />)}
      </div>
      <p className="text-[11px] text-textMuted mt-2">Kept in this browser only; nothing is sent to the server.</p>
    </section>
  );
}
