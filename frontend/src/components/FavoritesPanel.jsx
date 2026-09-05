import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Star, Globe, Lock, Trash2, ExternalLink, Package, Loader2, AlertTriangle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import api, { favoritesApi } from '../lib/api';
import { formatBytes, formatDate } from '../lib/utils';
import { FileTypeBadge } from './Logo';
import { LoadingDots } from './Loading';
import { proxyImageUrl } from '../lib/imageProxy';

/**
 * "Favourites" tab of the account page.
 *
 * The list is the user's own, private and shared rows together; the only thing
 * the public profile can see is a row whose `is_public` flag is on, so the
 * toggle on each line is the whole sharing model in one control.
 *
 * The checkbox at the top is a starting point, not a bulk edit: it decides
 * where *new* favourites begin. Flipping it leaves everything already starred
 * exactly as it was - unsharing your list must not be a surprise side effect of
 * a setting you changed for next time.
 */
export default function FavoritesPanel({ onError }) {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 0 });
  const [counts, setCounts] = useState({ total: 0, public: 0 });
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [defaultPublic, setDefaultPublic] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);

  const fetchFavorites = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const data = await favoritesApi.list({ page, limit: 12 });
      setItems(data.favorites || []);
      setPagination(data.pagination || { page: 1, total: 0, totalPages: 0 });
      setCounts(data.counts || { total: 0, public: 0 });
    } catch (e) {
      onError?.(e.response?.data?.error || 'Could not load your favourites');
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => { fetchFavorites(1); }, [fetchFavorites]);

  // The default lives on the profile, so read it where the profile is read.
  useEffect(() => {
    api.get('/auth/profile')
      .then(res => setDefaultPublic(Boolean(res.data.favorites_default_public)))
      .catch(() => {});
  }, []);

  const toggleVisibility = async (item) => {
    const next = !item.is_public;
    setBusyId(item.id);
    // Optimistic: the row moves now and the request catches up.
    setItems(prev => prev.map(f => (f.id === item.id ? { ...f, is_public: next } : f)));
    setCounts(c => ({ ...c, public: Math.max(0, c.public + (next ? 1 : -1)) }));
    try {
      await favoritesApi.setVisibility(item.id, next);
    } catch (e) {
      setItems(prev => prev.map(f => (f.id === item.id ? { ...f, is_public: !next } : f)));
      setCounts(c => ({ ...c, public: Math.max(0, c.public + (next ? -1 : 1)) }));
      onError?.(e.response?.data?.error || 'Could not change who can see that favourite');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (item) => {
    setBusyId(item.id);
    const snapshot = items;
    setItems(prev => prev.filter(f => f.id !== item.id));
    setCounts(c => ({
      total: Math.max(0, c.total - 1),
      public: Math.max(0, c.public - (item.is_public ? 1 : 0)),
    }));
    try {
      await favoritesApi.remove(item.id);
      // Filling the hole left on the last page keeps the list from looking
      // truncated after a removal.
      if (items.length === 1 && pagination.page > 1) fetchFavorites(pagination.page - 1);
    } catch (e) {
      setItems(snapshot);
      onError?.(e.response?.data?.error || 'Could not remove that favourite');
      setCounts(c => ({
        total: c.total + 1,
        public: c.public + (item.is_public ? 1 : 0),
      }));
    } finally {
      setBusyId(null);
    }
  };

  const saveDefault = async (value) => {
    setDefaultPublic(value);
    setSavingDefault(true);
    try {
      const res = await api.put('/auth/profile', { favorites_default_public: value });
      setDefaultPublic(Boolean(res.data.user?.favorites_default_public));
    } catch (e) {
      setDefaultPublic(!value);
      onError?.(e.response?.data?.error || 'Could not save that setting');
    } finally {
      setSavingDefault(false);
    }
  };

  return (
    <div className="glass rounded-3xl border border-white/5 p-8 backdrop-blur-xl">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-1">
        <h2 className="text-xl font-bold text-textPrimary flex items-center gap-2">
          <Star className="w-5 h-5 text-amber-400" />
          Favourites
        </h2>
        <div className="flex items-center gap-2 text-xs">
          <span className="px-2.5 py-1 rounded-full bg-surface border border-border text-textSecondary">
            {counts.total} total
          </span>
          <span className="px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400">
            {counts.public} shared
          </span>
        </div>
      </div>
      <p className="text-xs text-textMuted mb-5">
        Files you starred. Only the ones you mark <span className="text-amber-400">Shared</span> appear on your
        public profile at{' '}
        <Link to={`/u/${user?.username}`} className="text-primary hover:underline">
          /u/{user?.username}
        </Link>
        .
      </p>

      <label className="flex items-start gap-3 p-3.5 rounded-xl bg-surface border border-border mb-6 cursor-pointer">
        <input
          type="checkbox"
          checked={defaultPublic}
          disabled={savingDefault}
          onChange={(e) => saveDefault(e.target.checked)}
          className="mt-0.5 w-4 h-4 rounded accent-primary"
        />
        <span className="text-xs leading-relaxed">
          <span className="block font-medium text-textPrimary">New favourites start shared</span>
          <span className="block text-textMuted mt-0.5">
            Off by default, so a star is a private act. This only changes where future favourites begin —
            the {counts.total} file{counts.total === 1 ? '' : 's'} above keep the setting you gave them.
          </span>
        </span>
        {savingDefault && <Loader2 className="w-3.5 h-3.5 ml-auto text-textMuted animate-spin" />}
      </label>

      {loading ? (
        <div className="py-12 text-center">
          <LoadingDots size={32} />
          <p className="text-xs text-textMuted mt-2">Loading your favourites…</p>
        </div>
      ) : items.length === 0 ? (
        <div className="py-12 text-center">
          <div className="w-12 h-12 mx-auto rounded-2xl bg-surface border border-border flex items-center justify-center mb-3">
            <Star className="w-5 h-5 text-textMuted" />
          </div>
          <p className="text-sm font-medium text-textPrimary">No favourites yet</p>
          <p className="text-xs text-textMuted mt-1 mb-4">
            Star a file from its page and it shows up here.
          </p>
          <Link to="/browse" className="inline-flex items-center gap-2 px-4 py-2 bg-gradient-primary text-white rounded-xl text-sm font-medium shadow-lg shadow-purple-500/20">
            <Package className="w-4 h-4" />
            Browse the catalogue
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(item => (
            <div key={item.id} className="flex items-center gap-3 p-3 rounded-xl bg-surface border border-border">
              <div className="shrink-0 w-10 h-10 rounded-lg bg-surfaceHover border border-border flex items-center justify-center overflow-hidden">
                {item.icon_url || item.image_url ? (
                  <img
                    src={proxyImageUrl(item.icon_url || item.image_url)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="w-6 h-6 object-contain"
                    onError={(e) => { e.target.style.display = 'none'; }}
                  />
                ) : (
                  <FileTypeBadge type={item.file_type} size={16} />
                )}
              </div>

              <div className="flex-1 min-w-0">
                <Link to={`/file/${item.slug}`} className="text-sm font-medium text-textPrimary hover:text-primary truncate block">
                  {item.name}
                </Link>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-textMuted mt-0.5">
                  {item.version && <span>v{item.version}</span>}
                  {item.file_size ? <span>{formatBytes(item.file_size)}</span> : null}
                  {item.category_name && <span className="truncate">{item.category_name}</span>}
                  <span>{formatDate(item.favorited_at)}</span>
                  {/* A favourite can outlive a published file; say so rather
                      than showing a card that leads nowhere for others. */}
                  {!item.published && (
                    <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 text-[10px] uppercase font-bold">
                      Unpublished
                    </span>
                  )}
                </div>
              </div>

              <button
                onClick={() => toggleVisibility(item)}
                disabled={busyId === item.id}
                title={item.is_public ? 'Shared on your profile — click to make private' : 'Private — click to share on your profile'}
                className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium transition-colors disabled:opacity-60 ${
                  item.is_public
                    ? 'bg-amber-500/10 border-amber-500/30 text-amber-400 hover:border-amber-500/50'
                    : 'bg-surfaceHover border-border text-textMuted hover:text-textSecondary'
                }`}
              >
                {busyId === item.id
                  ? <LoadingDots size={12} />
                  : (item.is_public ? <Globe className="w-3 h-3" /> : <Lock className="w-3 h-3" />)}
                {item.is_public ? 'Shared' : 'Private'}
              </button>

              <Link
                to={`/file/${item.slug}`}
                className="shrink-0 p-2 rounded-lg border border-border text-textMuted hover:text-primary hover:border-primary/30 transition-colors"
                title="Open this file's page"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </Link>

              <button
                onClick={() => remove(item)}
                disabled={busyId === item.id}
                className="shrink-0 p-2 rounded-lg border border-border text-textMuted hover:text-red-400 hover:border-red-500/30 transition-colors disabled:opacity-60"
                title="Remove from favourites"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between gap-3 mt-6 pt-4 border-t border-white/5">
          <button
            onClick={() => fetchFavorites(pagination.page - 1)}
            disabled={pagination.page <= 1 || loading}
            className="px-3 py-1.5 rounded-lg bg-surface border border-border text-xs disabled:opacity-40 hover:border-primary/30"
          >
            Previous
          </button>
          <span className="text-xs text-textMuted">
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <button
            onClick={() => fetchFavorites(pagination.page + 1)}
            disabled={pagination.page >= pagination.totalPages || loading}
            className="px-3 py-1.5 rounded-lg bg-surface border border-border text-xs disabled:opacity-40 hover:border-primary/30"
          >
            Next
          </button>
        </div>
      )}

      {counts.total > 0 && (
        <p className="mt-6 pt-4 border-t border-white/5 text-[11px] text-textMuted flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            Sharing a favourite publishes the file's name and details on your profile. It never shares your
            email address, and it does not reveal download mirrors — those still need a login.
          </span>
        </p>
      )}
    </div>
  );
}
