import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { favoritesApi } from '../lib/api';
import { LoadingDots } from './Loading';

/**
 * The star on a file page.
 *
 * Two rules shape it:
 *
 *  1. Starring is private. The button only ever sends `is_public` when the
 *     caller asks for it, so the server applies the account's own default
 *     (private) rather than something the UI invented.
 *  2. An anonymous click is a login prompt, not a 401. The visitor is sent to
 *     /login with a redirect back, which is what the download buttons do.
 *
 * The state is optimistic: the star moves immediately and the request follows,
 * so a slow network never feels like a dead button. A failed request moves it
 * back and hands the error to `onError` rather than failing silently.
 */
export default function FavoriteButton({
  itemId,
  slug,
  isFavorite = false,
  count = 0,
  onChange,
  onError,
  variant = 'pill',
  className = '',
}) {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [favorited, setFavorited] = useState(isFavorite);
  const [total, setTotal] = useState(count);
  const [busy, setBusy] = useState(false);

  // The star owns its state so a click can move instantly, but the item page
  // re-fetches after an edit or a login, so a changed prop wins. Tracking the
  // last prop we saw (rather than comparing against local state) is what makes
  // this a one-way sync instead of a fight with the optimistic update.
  const [lastIsFavorite, setLastIsFavorite] = useState(isFavorite);
  const [lastCount, setLastCount] = useState(count);
  if (isFavorite !== lastIsFavorite) {
    setLastIsFavorite(isFavorite);
    setFavorited(isFavorite);
  }
  if (count !== lastCount) {
    setLastCount(count);
    setTotal(count);
  }

  const redirect = typeof window !== 'undefined'
    ? window.location.pathname + window.location.search
    : '/browse';

  const handleClick = async () => {
    if (busy) return;
    if (!isAuthenticated) {
      navigate('/login?redirect=' + encodeURIComponent(redirect));
      return;
    }

    const next = !favorited;
    setFavorited(next);
    setTotal(t => Math.max(0, t + (next ? 1 : -1)));
    setBusy(true);
    try {
      if (next) {
        await favoritesApi.add({ itemId, slug });
      } else {
        await favoritesApi.remove(itemId ?? slug);
      }
      onChange?.(next);
    } catch (e) {
      setFavorited(!next);
      setTotal(t => Math.max(0, t + (next ? -1 : 1)));
      const message = e.response?.data?.error
        || (e.response?.status === 401 ? 'Your session expired - please log in again' : 'Could not update your favourites');
      onError?.(message);
    } finally {
      setBusy(false);
    }
  };

  const label = favorited ? 'Favourited' : 'Favourite';
  const icon = (
    busy
      ? <LoadingDots size={14} />
      : <Star className={`w-4 h-4 ${favorited ? 'fill-amber-400 text-amber-400' : ''}`} />
  );

  if (variant === 'icon') {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        aria-pressed={favorited}
        title={isAuthenticated ? label : 'Log in to favourite this file'}
        aria-label={label}
        className={`p-2.5 rounded-xl border transition-all disabled:opacity-60 ${
          favorited
            ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
            : 'bg-surface border-border text-textSecondary hover:text-amber-400 hover:border-amber-500/30'
        } ${className}`}
      >
        {icon}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      aria-pressed={favorited}
      title={isAuthenticated ? label : 'Log in to favourite this file'}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border transition-all disabled:opacity-60 ${
        favorited
          ? 'bg-amber-500/10 border-amber-500/30 text-amber-400 hover:border-amber-500/50'
          : 'bg-surface border-border text-textSecondary hover:text-amber-400 hover:border-amber-500/30'
      } ${className}`}
    >
      {icon}
      <span>{label}</span>
      {total > 0 && <span className="text-xs text-textMuted">{total.toLocaleString()}</span>}
    </button>
  );
}
