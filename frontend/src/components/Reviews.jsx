import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Star, Trash2, Clock, AlertTriangle } from 'lucide-react';
import { reviewsApi } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { formatDate } from '../lib/utils';

/**
 * Ratings and reviews block shown under a published entry.
 *
 * One review per user; saving again replaces it. Reviews with links are held
 * for moderation on the server: the author sees a "pending" badge, nobody
 * else sees the review until an editor approves it.
 */
export function Stars({ value = 0, size = 'w-4 h-4', onChange, hover }) {
  const shown = hover || value;
  return (
    <span className="inline-flex items-center gap-0.5" role={onChange ? 'radiogroup' : undefined} aria-label={`${value || 0} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={`${size} ${n <= shown ? 'text-amber-400 fill-amber-400' : 'text-white/20'} ${onChange ? 'cursor-pointer' : ''}`}
          onClick={onChange ? () => onChange(n) : undefined}
          data-testid={onChange ? `star-${n}` : undefined}
        />
      ))}
    </span>
  );
}

export function RatingBadge({ rating }) {
  if (!rating || !rating.count) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-textSecondary" title={`${rating.count} rating${rating.count === 1 ? '' : 's'}`}>
      <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
      {rating.average} <span className="opacity-60">({rating.count})</span>
    </span>
  );
}

export default function Reviews({ slug, initialSummary }) {
  const { isAuthenticated } = useAuth();
  const [data, setData] = useState({ summary: initialSummary || { average: null, count: 0 }, reviews: [], mine: null });
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let alive = true;
    reviewsApi.list(slug).then((d) => {
      if (!alive) return;
      setData(d);
      if (d.mine) { setRating(d.mine.rating); setComment(d.mine.comment || ''); }
    }).catch(() => {});
    return () => { alive = false; };
  }, [slug]);

  const submit = async (e) => {
    e.preventDefault();
    if (!rating) { setError('Pick a star rating first.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const res = await reviewsApi.save(slug, { rating, comment: comment.trim() || undefined });
      setData(await reviewsApi.list(slug));
      if (res.review.status === 'pending') setNotice('Thanks! Because your review contains a link it will show up once a moderator has looked at it.');
      else if (res.review.status === 'hidden') setNotice('Your review was saved but is hidden by a moderator.');
      else setNotice('Review saved.');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save your review.');
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true); setError('');
    try {
      await reviewsApi.remove(slug);
      setRating(0); setComment(''); setNotice('Review removed.');
      setData(await reviewsApi.list(slug));
    } catch (err) {
      setError(err.response?.data?.error || 'Could not remove your review.');
    } finally { setBusy(false); }
  };

  const { summary, reviews, mine } = data;
  const hist = summary.histogram || {};
  const max = Math.max(1, ...Object.values(hist));

  return (
    <section className="mt-10 glass rounded-2xl border border-white/5 p-6" aria-labelledby="reviews-heading">
      <h2 id="reviews-heading" className="text-lg font-semibold text-textPrimary mb-4 flex items-center gap-2">
        <Star className="w-5 h-5 text-amber-400" /> Ratings & reviews
      </h2>

      <div className="grid md:grid-cols-[auto_1fr] gap-6 mb-6">
        <div className="text-center md:pr-6 md:border-r border-white/10">
          <div className="text-4xl font-bold text-textPrimary">{summary.count ? summary.average : '–'}</div>
          <Stars value={Math.round(summary.average || 0)} />
          <div className="text-xs text-textSecondary mt-1">{summary.count} rating{summary.count === 1 ? '' : 's'}</div>
        </div>
        <div className="space-y-1">
          {[5, 4, 3, 2, 1].map((n) => (
            <div key={n} className="flex items-center gap-2 text-xs text-textSecondary">
              <span className="w-3 text-right">{n}</span>
              <Star className="w-3 h-3 text-amber-400 fill-amber-400" />
              <div className="flex-1 h-2 rounded bg-white/5 overflow-hidden">
                <div className="h-full bg-amber-400/70" style={{ width: `${((hist[n] || 0) / max) * 100}%` }} />
              </div>
              <span className="w-6">{hist[n] || 0}</span>
            </div>
          ))}
        </div>
      </div>

      {isAuthenticated ? (
        <form onSubmit={submit} className="mb-6 p-4 rounded-xl bg-white/[0.03] border border-white/5">
          <div className="flex items-center justify-between gap-3 mb-2">
            <label className="text-sm font-medium text-textPrimary">{mine ? 'Your review' : 'Rate this entry'}</label>
            <span onMouseLeave={() => setHover(0)}>
              <span onMouseOver={(e) => { const t = e.target.closest('[data-testid^="star-"]'); if (t) setHover(Number(t.dataset.testid.slice(5))); }}>
                <Stars value={rating} hover={hover} size="w-6 h-6" onChange={setRating} />
              </span>
            </span>
          </div>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="Optional: what worked, what didn't? (max 2000 characters, at most 2 links)"
            className="w-full rounded-lg bg-black/20 border border-white/10 px-3 py-2 text-sm text-textPrimary placeholder:text-textSecondary/60 focus:outline-none focus:border-primary/50"
          />
          {error && <p className="mt-2 text-xs text-red-400 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" />{error}</p>}
          {notice && <p className="mt-2 text-xs text-green-400">{notice}</p>}
          <div className="mt-3 flex items-center gap-3">
            <button type="submit" disabled={busy} className="px-4 py-2 rounded-lg bg-gradient-primary text-white text-sm font-medium disabled:opacity-50">
              {mine ? 'Update review' : 'Post review'}
            </button>
            {mine && (
              <button type="button" onClick={remove} disabled={busy} className="text-xs text-textSecondary hover:text-red-400 inline-flex items-center gap-1">
                <Trash2 className="w-3.5 h-3.5" /> Remove
              </button>
            )}
            {mine?.status === 'pending' && <span className="ml-auto text-xs text-amber-400 inline-flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> Awaiting moderation</span>}
            {mine?.status === 'hidden' && <span className="ml-auto text-xs text-red-400">Hidden by a moderator</span>}
          </div>
        </form>
      ) : (
        <p className="mb-6 text-sm text-textSecondary"><Link to="/login" className="text-primary hover:underline">Sign in</Link> to leave a rating.</p>
      )}

      {reviews.length === 0 ? (
        <p className="text-sm text-textSecondary">No reviews yet.</p>
      ) : (
        <ul className="space-y-4">
          {reviews.map((r) => (
            <li key={r.id} className="border-t border-white/5 pt-4 first:border-t-0 first:pt-0">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium text-textPrimary">{r.user?.username || 'Anonymous'}</span>
                <Stars value={r.rating} size="w-3.5 h-3.5" />
                <span className="text-xs text-textSecondary ml-auto">{formatDate(r.created_at)}{r.edited ? ' · edited' : ''}</span>
                {r.status !== 'visible' && <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">{r.status}</span>}
              </div>
              {r.comment && <p className="mt-1 text-sm text-textSecondary whitespace-pre-wrap break-words">{r.comment}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
