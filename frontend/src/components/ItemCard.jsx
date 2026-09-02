import { Link } from 'react-router-dom';
import { Download, Star } from 'lucide-react';
import { formatBytes, formatRelativeTime } from '../lib/utils';
import { FileTypeBadge } from './Logo';

// Compact list-friendly card: icon + name + one-line description + one meta row.
// No big banner placeholders -- a wall of identical gray boxes was pure clutter.
export default function ItemCard({ item, featured = false }) {
  const meta = [
    item.platform,
    item.architecture,
    item.version ? `v${item.version}` : null,
    formatBytes(item.file_size),
  ].filter(Boolean).join(' · ');

  return (
    <Link
      to={`/file/${item.slug}`}
      className={`group flex gap-3 rounded-xl border bg-surface p-4 transition-colors hover:border-primary/40 hover:bg-surfaceHover ${
        featured ? 'border-purple-500/30' : 'border-border'
      }`}
    >
      <div className="shrink-0 w-11 h-11 rounded-lg bg-surfaceHover border border-border flex items-center justify-center overflow-hidden">
        {item.icon_url ? (
          <img src={item.icon_url} alt="" className="w-7 h-7 object-contain" onError={(e) => { e.target.style.display = 'none'; e.target.parentElement.dataset.empty = '1'; }} />
        ) : (
          <FileTypeBadge type={item.file_type} size={18} />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2">
          <h3 className="flex-1 font-semibold text-textPrimary group-hover:text-primary transition-colors truncate text-sm">
            {item.name}
          </h3>
          {featured && <Star className="w-3.5 h-3.5 shrink-0 text-purple-400 fill-purple-400" />}
        </div>
        <p className="text-xs text-textMuted mt-0.5 truncate">{meta}</p>
        <p className="text-[13px] text-textSecondary line-clamp-1 mt-1.5">
          {item.description}
        </p>
        <div className="flex items-center gap-3 mt-2 text-[11px] text-textMuted">
          {item.file_type && <span className="uppercase font-medium tracking-wide">{item.file_type}</span>}
          {item.folder_name && <span className="truncate">{item.folder_name}</span>}
          <span className="flex items-center gap-1 ml-auto shrink-0">
            <Download className="w-3 h-3" />
            {item.download_count || 0}
          </span>
          <span className="shrink-0">{formatRelativeTime(item.created_at)}</span>
        </div>
      </div>
    </Link>
  );
}
