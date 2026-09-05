import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Star, Shield, Calendar, ArrowLeft, Package, Globe, Lock, User as UserIcon } from 'lucide-react';
import { usersApi } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { formatDate } from '../lib/utils';
import ItemCard from '../components/ItemCard';
import Loading from '../components/Loading';
import StarryBackground from '../components/StarryBackground';

/**
 * Public account page: /u/:username
 *
 * Anyone can open it - no login - so it shows exactly what the account chose
 * to share and nothing else. The API returns no email and only favourites
 * whose `is_public` flag the owner set, so "what you see here" and "what they
 * shared" are the same set by construction rather than by filtering in the UI.
 *
 * Viewing your own profile is the useful test of that: the copy changes to
 * point at the account page, because a list that looks short to you is usually
 * private favourites, not a bug.
 */
export default function Profile() {
  const { username } = useParams();
  const { user } = useAuth();
  const [profile, setProfile] = useState(null);
  const [favorites, setFavorites] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const isOwnProfile = Boolean(user && profile && user.username === profile.username);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setProfile(null);
    setFavorites([]);

    usersApi.profile(username)
      .then(data => {
        if (cancelled) return;
        setProfile(data);
        return usersApi.favorites(username, { page: 1, limit: 24 });
      })
      .then(data => {
        if (cancelled || !data) return;
        setFavorites(data.favorites || []);
        setPagination(data.pagination || { page: 1, total: 0, totalPages: 0 });
      })
      .catch(e => {
        if (cancelled) return;
        setError(e.response?.data?.error || 'Could not load this profile');
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [username]);

  const loadPage = (page) => {
    setLoading(true);
    usersApi.favorites(username, { page, limit: 24 })
      .then(data => {
        setFavorites(data.favorites || []);
        setPagination(data.pagination || { page, total: 0, totalPages: 0 });
      })
      .catch(e => setError(e.response?.data?.error || 'Could not load favourites'))
      .finally(() => setLoading(false));
  };

  const roleStyles = {
    admin: 'bg-red-500/10 text-red-400 border-red-500/20',
    editor: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    viewer: 'bg-green-500/10 text-green-400 border-green-500/20',
  };

  return (
    <div className="relative min-h-dvh">
      <StarryBackground />

      <div className="relative max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link to="/browse" className="inline-flex items-center gap-2 text-sm text-textSecondary hover:text-primary transition-colors mb-6">
          <ArrowLeft className="w-4 h-4" />
          Back to browse
        </Link>

        {loading && !profile ? (
          <Loading size={36} text="Loading profile…" className="py-20" />
        ) : error ? (
          <div className="glass rounded-3xl border border-white/5 p-12 text-center">
            <h1 className="text-2xl font-bold text-textPrimary mb-2">Profile not found</h1>
            <p className="text-sm text-textMuted mb-6">{error}</p>
            <Link to="/browse" className="px-6 py-2.5 bg-gradient-primary text-white rounded-xl inline-flex items-center gap-2">
              <Package className="w-4 h-4" />
              Browse the catalogue
            </Link>
          </div>
        ) : profile ? (
          <>
            <div className="glass rounded-3xl border border-white/5 p-8 backdrop-blur-xl mb-6">
              <div className="flex flex-col sm:flex-row gap-6">
                <div className="w-20 h-20 sm:w-24 sm:h-24 mx-auto sm:mx-0 rounded-2xl bg-gradient-primary flex items-center justify-center text-white font-bold text-3xl shadow-xl shadow-purple-500/20 overflow-hidden flex-shrink-0">
                  {profile.avatar_url ? (
                    <img
                      src={profile.avatar_url}
                      alt={profile.username}
                      loading="lazy"
                      decoding="async"
                      className="w-full h-full object-cover"
                      onError={(e) => { e.target.style.display = 'none'; }}
                    />
                  ) : (
                    profile.username?.[0]?.toUpperCase() || 'U'
                  )}
                </div>

                <div className="flex-1 min-w-0 text-center sm:text-left">
                  <div className="flex flex-wrap items-center justify-center sm:justify-start gap-3">
                    <h1 className="text-3xl font-bold text-textPrimary">{profile.username}</h1>
                    <span className={`inline-flex items-center gap-1 px-3 py-1 rounded-full border text-xs font-medium ${roleStyles[profile.role] || roleStyles.viewer}`}>
                      <Shield className="w-3 h-3" />
                      {profile.role}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center justify-center sm:justify-start gap-4 mt-2 text-xs text-textMuted">
                    <span className="inline-flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5" />
                      Joined {formatDate(profile.created_at)}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Star className="w-3.5 h-3.5" />
                      {profile.favorites_count} shared file{profile.favorites_count === 1 ? '' : 's'}
                    </span>
                  </div>

                  {profile.bio ? (
                    <p className="text-sm text-textSecondary mt-4 whitespace-pre-wrap">{profile.bio}</p>
                  ) : (
                    <p className="text-sm text-textMuted mt-4 italic">No bio yet.</p>
                  )}

                  {isOwnProfile && (
                    <div className="mt-5 p-3 rounded-xl bg-primary/5 border border-primary/20 text-xs text-textSecondary inline-flex items-start gap-2 text-left">
                      <UserIcon className="w-3.5 h-3.5 shrink-0 mt-0.5 text-primary" />
                      <span>
                        This is your public profile. Only favourites you mark <strong className="text-amber-400">Shared</strong> appear
                        here —{' '}
                        <Link to="/account" className="text-primary hover:underline">manage them in your account</Link>.
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-baseline justify-between mb-4">
              <h2 className="text-xl font-bold text-textPrimary flex items-center gap-2">
                <Star className="w-5 h-5 text-amber-400" />
                Favourite files
              </h2>
              <span className="text-sm text-textMuted">{pagination.total} shared</span>
            </div>

            {loading ? (
              <Loading size={32} text="Loading favourites…" className="py-12" />
            ) : favorites.length === 0 ? (
              <div className="glass rounded-2xl border border-white/5 p-12 text-center">
                <div className="mx-auto w-12 h-12 rounded-2xl bg-surface border border-border flex items-center justify-center mb-4">
                  {isOwnProfile ? <Lock className="w-5 h-5 text-textMuted" /> : <Globe className="w-5 h-5 text-textMuted" />}
                </div>
                <p className="font-medium text-textPrimary">No shared favourites</p>
                <p className="text-sm text-textMuted mt-1 mb-5">
                  {isOwnProfile
                    ? 'Favourites are private until you share them. Open the Favourites tab in your account to publish one.'
                    : `${profile.username} has not shared any favourites yet.`}
                </p>
                {isOwnProfile ? (
                  <Link to="/account?tab=favorites" className="px-5 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium inline-flex items-center gap-2 shadow-lg shadow-primary/25">
                    <Star className="w-4 h-4" />
                    Open my favourites
                  </Link>
                ) : (
                  <Link to="/browse" className="px-5 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium inline-flex items-center gap-2 shadow-lg shadow-purple-500/20">
                    <Package className="w-4 h-4" />
                    Browse the catalogue
                  </Link>
                )}
              </div>
            ) : (
              <>
                <div className="grid sm:grid-cols-2 gap-3">
                  {favorites.map(item => <ItemCard key={item.id} item={item} />)}
                </div>

                {pagination.totalPages > 1 && (
                  <div className="flex items-center justify-between gap-3 mt-6">
                    <button
                      onClick={() => loadPage(pagination.page - 1)}
                      disabled={pagination.page <= 1}
                      className="px-4 py-2 rounded-xl bg-surface border border-border text-sm disabled:opacity-40 hover:border-primary/30"
                    >
                      Previous
                    </button>
                    <span className="text-sm text-textMuted">Page {pagination.page} of {pagination.totalPages}</span>
                    <button
                      onClick={() => loadPage(pagination.page + 1)}
                      disabled={pagination.page >= pagination.totalPages}
                      className="px-4 py-2 rounded-xl bg-surface border border-border text-sm disabled:opacity-40 hover:border-primary/30"
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
