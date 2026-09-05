import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Star, Eye, EyeOff, Check, Trash2, RefreshCw, AlertTriangle } from 'lucide-react';
import { reviewsApi } from '../../lib/api';
import Loading from '../../components/Loading';
import { Stars } from '../../components/Reviews';
import { formatDate } from '../../lib/utils';

/**
 * Admin -> Reviews: moderation queue. "Pending" holds reviews the spam
 * filter flagged (links in the comment); editors approve, hide or delete.
 */
const TABS = [
  { id: 'pending', label: 'Pending' },
  { id: 'visible', label: 'Visible' },
  { id: 'hidden', label: 'Hidden' },
];

export default function AdminReviews() {
  const [tab, setTab] = useState('pending');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try { setData(await reviewsApi.adminList({ status: tab, limit: 100 })); }
    catch (err) { setError(err.response?.data?.error || 'Could not load reviews.'); }
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  const act = async (id, fn) => {
    setBusyId(id); setError('');
    try { await fn(); await load(); }
    catch (err) { setError(err.response?.data?.error || 'Action failed.'); }
    finally { setBusyId(null); }
  };

  return (
    <div className="glass rounded-2xl border border-white/5 p-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-lg font-semibold text-textPrimary flex items-center gap-2"><Star className="w-5 h-5 text-amber-400" /> Reviews</h2>
        <button onClick={load} className="text-xs text-textSecondary hover:text-textPrimary inline-flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5" /> Refresh</button>
      </div>

      <div className="flex gap-2 mb-4">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-lg text-sm border ${tab === t.id ? 'bg-primary/20 border-primary/40 text-textPrimary' : 'border-white/10 text-textSecondary hover:text-textPrimary'}`}
          >
            {t.label}{data?.counts ? ` (${data.counts[t.id] ?? 0})` : ''}
          </button>
        ))}
      </div>

      {error && <p className="mb-3 text-sm text-red-400 flex items-center gap-1"><AlertTriangle className="w-4 h-4" />{error}</p>}
      {!data ? <Loading text="Loading reviews…" /> : data.reviews.length === 0 ? (
        <p className="text-sm text-textSecondary">Nothing here.</p>
      ) : (
        <ul className="divide-y divide-white/5">
          {data.reviews.map((r) => (
            <li key={r.id} className="py-3 flex flex-col md:flex-row md:items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Link to={`/item/${r.item?.slug}`} className="font-medium text-primary hover:underline truncate">{r.item?.name || r.item?.slug}</Link>
                  <Stars value={r.rating} size="w-3.5 h-3.5" />
                  <span className="text-xs text-textSecondary">by {r.user?.username} · {formatDate(r.created_at)}</span>
                  {r.hold_reason && <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">{r.hold_reason}</span>}
                </div>
                {r.comment && <p className="mt-1 text-sm text-textSecondary whitespace-pre-wrap break-words">{r.comment}</p>}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {r.status !== 'visible' && (
                  <button disabled={busyId === r.id} onClick={() => act(r.id, () => reviewsApi.setStatus(r.id, 'visible'))} className="px-2.5 py-1.5 rounded-lg text-xs bg-green-500/10 text-green-400 border border-green-500/30 inline-flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Approve</button>
                )}
                {r.status !== 'hidden' && (
                  <button disabled={busyId === r.id} onClick={() => act(r.id, () => reviewsApi.setStatus(r.id, 'hidden'))} className="px-2.5 py-1.5 rounded-lg text-xs bg-amber-500/10 text-amber-400 border border-amber-500/30 inline-flex items-center gap-1"><EyeOff className="w-3.5 h-3.5" /> Hide</button>
                )}
                {r.status === 'hidden' && (
                  <span className="text-xs text-textSecondary inline-flex items-center gap-1"><Eye className="w-3.5 h-3.5" /> hidden</span>
                )}
                <button disabled={busyId === r.id} onClick={() => { if (window.confirm('Delete this review permanently?')) act(r.id, () => reviewsApi.adminRemove(r.id)); }} className="px-2.5 py-1.5 rounded-lg text-xs bg-red-500/10 text-red-400 border border-red-500/30 inline-flex items-center gap-1"><Trash2 className="w-3.5 h-3.5" /> Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
