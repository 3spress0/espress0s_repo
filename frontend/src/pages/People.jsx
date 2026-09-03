import { useEffect, useState, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, X, Users, Star, Shield, ChevronLeft, ChevronRight } from 'lucide-react';
import { usersApi } from '../lib/api';
import { formatDate } from '../lib/utils';
import Loading from '../components/Loading';

/**
 * People directory: /people
 *
 * The public profile at /u/:username has existed, but there was no way to find
 * an account without already knowing its handle. This page makes those profiles
 * discoverable — search by username, sort, and click through. It only ever
 * shows what each account already publishes on its own profile.
 */

const sortOptions = [
  { value: 'shared', label: 'Most shared' },
  { value: 'newest', label: 'Newest members' },
  { value: 'name', label: 'Name (A-Z)' },
];

const roleStyles = {
  admin: 'bg-red-500/10 text-red-400 border-red-500/20',
  editor: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  viewer: 'bg-green-500/10 text-green-400 border-green-500/20',
};

function PersonCard({ person }) {
  return (
    <Link
      to={`/u/${encodeURIComponent(person.username)}`}
      className="group flex gap-4 rounded-2xl border border-border bg-surface p-5 transition-colors hover:border-primary/40 hover:bg-surfaceHover"
    >
      <div className="shrink-0 w-14 h-14 rounded-2xl bg-gradient-primary flex items-center justify-center text-white font-bold text-xl shadow-lg shadow-purple-500/20 overflow-hidden">
        {person.avatar_url ? (
          <img
            src={person.avatar_url}
            alt={person.username}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover"
            onError={(e) => { e.target.style.display = 'none'; }}
          />
        ) : (
          person.username?.[0]?.toUpperCase() || 'U'
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-semibold text-textPrimary truncate group-hover:text-primary transition-colors">
            {person.username}
          </h3>
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-medium ${roleStyles[person.role] || roleStyles.viewer}`}>
            <Shield className="w-2.5 h-2.5" />
            {person.role}
          </span>
        </div>

        {person.bio ? (
          <p className="text-sm text-textSecondary mt-1 line-clamp-2">{person.bio}</p>
        ) : (
          <p className="text-sm text-textMuted mt-1 italic">No bio yet.</p>
        )}

        <div className="flex items-center gap-4 mt-2 text-xs text-textMuted">
          <span className="inline-flex items-center gap-1">
            <Star className="w-3.5 h-3.5 text-amber-400" />
            {person.favorites_count} shared
          </span>
          <span>Joined {formatDate(person.created_at)}</span>
        </div>
      </div>
    </Link>
  );
}

export default function People() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [users, setUsers] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);

  const query = searchParams.get('q') || '';
  const sort = searchParams.get('sort') || 'shared';
  const page = parseInt(searchParams.get('page') || '1', 10);

  const [localQuery, setLocalQuery] = useState(query);
  useEffect(() => { setLocalQuery(query); }, [query]);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await usersApi.list({
        q: query || undefined,
        sort,
        page,
        limit: 24,
      });
      setUsers(data.users || []);
      setPagination(data.pagination || { page: 1, total: 0, totalPages: 0 });
    } catch {
      setUsers([]);
      setPagination({ page: 1, total: 0, totalPages: 0 });
    } finally {
      setLoading(false);
    }
  }, [query, sort, page]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const updateParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== 'page') next.set('page', '1');
    setSearchParams(next);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-11 h-11 rounded-2xl bg-gradient-primary flex items-center justify-center shadow-lg shadow-purple-500/20">
          <Users className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-textPrimary">People</h1>
          <p className="text-sm text-textMuted">
            {pagination.total.toLocaleString()} {pagination.total === 1 ? 'member' : 'members'} · discover who's sharing
          </p>
        </div>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); updateParam('q', localQuery.trim()); }} className="relative mb-3">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-textMuted pointer-events-none" />
        <input
          type="text"
          value={localQuery}
          onChange={(e) => setLocalQuery(e.target.value)}
          placeholder="Search people by username…"
          className="w-full pl-12 pr-10 py-3 bg-surface border border-border rounded-xl focus:outline-none focus:border-primary/50 text-sm"
        />
        {localQuery && (
          <button
            type="button"
            onClick={() => { setLocalQuery(''); updateParam('q', ''); }}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-lg text-textMuted hover:text-primary"
            aria-label="Clear search"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </form>

      <div className="flex flex-wrap items-center gap-2 mb-6">
        <select
          value={sort}
          onChange={(e) => updateParam('sort', e.target.value)}
          className="px-3 py-2 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
        >
          {sortOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {query && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10 border border-primary/20 text-xs text-primary">
            "{query}"
            <button onClick={() => updateParam('q', '')} aria-label="Remove filter"><X className="w-3 h-3" /></button>
          </span>
        )}
      </div>

      {loading ? (
        <div>
          <Loading size={32} text="Finding people…" className="mb-6" />
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-28 rounded-2xl bg-surface border border-border animate-pulse" />
            ))}
          </div>
        </div>
      ) : users.length > 0 ? (
        <>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
            {users.map(person => <PersonCard key={person.id} person={person} />)}
          </div>

          {pagination.totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pb-4">
              <button onClick={() => updateParam('page', Math.max(1, page - 1))} disabled={page <= 1}
                className="p-2.5 rounded-xl bg-surface border border-border disabled:opacity-40 hover:border-primary/30 transition-colors">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <div className="flex items-center gap-1">
                {[...Array(Math.min(5, pagination.totalPages))].map((_, i) => {
                  const p = i + 1 + Math.max(0, Math.min(page - 3, pagination.totalPages - 5));
                  if (p > pagination.totalPages) return null;
                  return (
                    <button key={p} onClick={() => updateParam('page', p)}
                      className={`w-9 h-9 rounded-xl text-sm font-medium transition-colors ${
                        p === page ? 'bg-gradient-primary text-white' : 'bg-surface border border-border text-textSecondary hover:border-primary/30'
                      }`}>{p}</button>
                  );
                })}
              </div>
              <button onClick={() => updateParam('page', Math.min(pagination.totalPages, page + 1))} disabled={page >= pagination.totalPages}
                className="p-2.5 rounded-xl bg-surface border border-border disabled:opacity-40 hover:border-primary/30 transition-colors">
                <ChevronRight className="w-4 h-4" />
              </button>
              <span className="text-xs text-textMuted ml-2">Page {pagination.page} / {pagination.totalPages}</span>
            </div>
          )}
        </>
      ) : (
        <div className="text-center py-16 border border-dashed border-border rounded-2xl">
          <Users className="w-8 h-8 text-textMuted mx-auto mb-3" />
          <h3 className="font-semibold text-textPrimary mb-1">No people found</h3>
          <p className="text-sm text-textMuted mb-4">
            {query ? `No accounts match "${query}".` : 'No accounts to show yet.'}
          </p>
          {query && (
            <button onClick={() => updateParam('q', '')} className="px-5 py-2 bg-gradient-primary text-white rounded-xl text-sm font-medium">
              Clear search
            </button>
          )}
        </div>
      )}
    </div>
  );
}
