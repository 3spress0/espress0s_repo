import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, X, SlidersHorizontal, ChevronLeft, ChevronRight } from 'lucide-react';
import ItemCard from '../components/ItemCard';
import Loading from '../components/Loading';
import { searchApi, categoriesApi, foldersApi } from '../lib/api';

const fileTypes = ['iso', 'exe', 'zip', 'msi', 'pdf', 'img', 'tar', 'gz', 'appimage', '7z'];
const platforms = ['windows', 'linux', 'macos', 'cross-platform'];
const architectures = ['x86', 'x64', 'arm64', 'universal'];
const licenses = [
  { value: 'public-domain', label: 'Public domain' },
  { value: 'redistributable', label: 'Redistributable' },
  { value: 'proprietary', label: 'Proprietary' },
  { value: 'check-license', label: 'Check license' },
  { value: 'internal-only', label: 'Internal only' },
  { value: 'abandonware', label: 'Abandonware' },
];
const sortOptions = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'date', label: 'Newest first' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'name', label: 'Name (A-Z)' },
  { value: 'size', label: 'Size' },
  { value: 'popular', label: 'Most downloaded' },
  { value: 'views', label: 'Most viewed' },
];

export default function Browse() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [results, setResults] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 0 });
  const [categories, setCategories] = useState([]);
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showMore, setShowMore] = useState(false);

  const query = searchParams.get('q') || '';
  const category = searchParams.get('category') || '';
  const folder = searchParams.get('folder') || '';
  const tag = searchParams.get('tag') || '';
  const license = searchParams.get('license_status') || '';
  const featured = searchParams.get('featured') === '1';
  const fileType = searchParams.get('file_type') || '';
  const platform = searchParams.get('platform') || '';
  const arch = searchParams.get('architecture') || '';
  // With no search term, "relevance" is meaningless -- fall back to newest.
  const sort = searchParams.get('sort') || (query ? 'relevance' : 'date');
  const order = searchParams.get('order') || 'desc';
  const page = parseInt(searchParams.get('page') || '1');

  const [localQuery, setLocalQuery] = useState(query);
  const [localTag, setLocalTag] = useState(tag);

  useEffect(() => { setLocalQuery(query); }, [query]);
  useEffect(() => { setLocalTag(tag); }, [tag]);

  useEffect(() => {
    categoriesApi.list().then(d => setCategories(d.categories || [])).catch(() => {});
    foldersApi.list().then(d => setFolders(d.folders || [])).catch(() => {});
  }, []);

  const fetchResults = useCallback(async () => {
    setLoading(true);
    try {
      const data = await searchApi.search({
        q: query || undefined,
        category: category || undefined,
        folder: folder || undefined,
        tag: tag || undefined,
        license_status: license || undefined,
        featured: featured ? 1 : undefined,
        file_type: fileType || undefined,
        platform: platform || undefined,
        architecture: arch || undefined,
        sort, order, page, limit: 24,
      });
      setResults(data.results || []);
      setPagination(data.pagination || { page: 1, total: 0, totalPages: 0 });
    } catch (e) {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query, category, folder, tag, license, featured, fileType, platform, arch, sort, order, page]);

  useEffect(() => { fetchResults(); }, [fetchResults]);

  const updateParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== 'page') next.set('page', '1');
    setSearchParams(next);
  };

  const clearFilters = () => setSearchParams(query ? { q: query } : {});
  const hasExtra = Boolean(tag || license || featured || fileType || arch);
  const activeChips = [
    query && ['q', `"${query}"`],
    category && ['category', `Category: ${categories.find(c => c.slug === category)?.name || category}`],
    folder && ['folder', `Folder: ${folders.find(f => f.slug === folder)?.name || folder}`],
    platform && ['platform', platform],
    fileType && ['file_type', `*.${fileType}`],
    arch && ['architecture', arch],
    license && ['license_status', licenses.find(l => l.value === license)?.label || license],
    tag && ['tag', `#${tag}`],
    featured && ['featured', 'Featured'],
  ].filter(Boolean);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-baseline justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-textPrimary">Browse</h1>
          <p className="text-sm text-textMuted">{pagination.total.toLocaleString()} files</p>
        </div>
      </div>

      {/* One compact toolbar: search + the four selects people actually use */}
      <form onSubmit={(e) => { e.preventDefault(); updateParam('q', localQuery); }} className="relative mb-3">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-textMuted pointer-events-none" />
        <input
          type="text"
          value={localQuery}
          onChange={(e) => setLocalQuery(e.target.value)}
          placeholder="Search files, versions, tags..."
          className="w-full pl-12 pr-4 py-3 bg-surface border border-border rounded-xl focus:outline-none focus:border-primary/50 text-sm"
        />
      </form>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select value={category} onChange={(e) => updateParam('category', e.target.value)}
          className="px-3 py-2 min-h-11 sm:min-h-0 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50">
          <option value="">All categories</option>
          {categories.map(c => <option key={c.id} value={c.slug}>{c.name} ({c.count})</option>)}
        </select>
        <select value={folder} onChange={(e) => updateParam('folder', e.target.value)}
          className="px-3 py-2 min-h-11 sm:min-h-0 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50">
          <option value="">All folders</option>
          <option value="none">Unfiled</option>
          {folders.map(f => <option key={f.id} value={f.slug}>{f.name} ({f.item_count})</option>)}
        </select>
        <select value={platform} onChange={(e) => updateParam('platform', e.target.value)}
          className="px-3 py-2 min-h-11 sm:min-h-0 bg-surface border border-border rounded-xl text-sm capitalize focus:outline-none focus:border-primary/50">
          <option value="">Any platform</option>
          {platforms.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={sort} onChange={(e) => updateParam('sort', e.target.value)}
          className="px-3 py-2 min-h-11 sm:min-h-0 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50">
          {sortOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button
          type="button"
          onClick={() => setShowMore(!showMore)}
          className={`px-3 py-2 min-h-11 sm:min-h-0 rounded-xl border text-sm font-medium flex items-center gap-2 transition-colors ${
            showMore || hasExtra
              ? 'bg-gradient-primary border-transparent text-white'
              : 'bg-surface border-border text-textSecondary hover:border-primary/30'
          }`}
        >
          <SlidersHorizontal className="w-4 h-4" /> More
        </button>
        {activeChips.length > 0 && (
          <button type="button" onClick={clearFilters}
            className="px-3 py-2 min-h-11 sm:min-h-0 text-xs text-textMuted hover:text-primary flex items-center gap-1">
            <X className="w-3 h-3" /> Clear
          </button>
        )}
      </div>

      {/* Active filters as chips: always visible, one click to remove */}
      {activeChips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {activeChips.map(([key, label]) => (
            <button
              key={key}
              onClick={() => updateParam(key, '')}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 min-h-[32px] sm:min-h-0 rounded-full bg-primary/10 border border-primary/20 text-xs text-primary hover:bg-primary/20 transition-colors"
            >
              {label} <X className="w-3 h-3" />
            </button>
          ))}
        </div>
      )}

      {/* Advanced filters: file type, arch, license, tag */}
      {showMore && (
        <div className="rounded-xl border border-border bg-surface p-4 mb-5 space-y-4 animate-fade-in">
          <div>
            <div className="text-[11px] font-medium text-textMuted uppercase tracking-wider mb-2">File type</div>
            <div className="flex flex-wrap gap-1.5">
              {fileTypes.map(ft => (
                <button key={ft} onClick={() => updateParam('file_type', fileType === ft ? '' : ft)}
                  className={`inline-flex items-center px-2.5 py-1 min-h-[36px] sm:min-h-0 rounded-full text-xs uppercase border transition-colors ${
                    fileType === ft ? 'bg-gradient-primary border-transparent text-white' : 'bg-surface border-border text-textSecondary hover:border-primary/30'
                  }`}>{ft}</button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-4">
            <div>
              <div className="text-[11px] font-medium text-textMuted uppercase tracking-wider mb-2">Architecture</div>
              <div className="flex gap-1.5">
                {architectures.map(a => (
                  <button key={a} onClick={() => updateParam('architecture', arch === a ? '' : a)}
                    className={`inline-flex items-center px-2.5 py-1 min-h-[36px] sm:min-h-0 rounded-full text-xs border transition-colors ${
                      arch === a ? 'bg-gradient-primary border-transparent text-white' : 'bg-surface border-border text-textSecondary hover:border-primary/30'
                    }`}>{a}</button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-medium text-textMuted uppercase tracking-wider mb-2">License</div>
              <select value={license} onChange={(e) => updateParam('license_status', e.target.value)}
                className="px-3 py-1.5 min-h-[36px] sm:min-h-0 bg-surface border border-border rounded-lg text-xs focus:outline-none focus:border-primary/50">
                <option value="">Any license</option>
                {licenses.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            <div>
              <div className="text-[11px] font-medium text-textMuted uppercase tracking-wider mb-2">Tag</div>
              <input type="text" value={localTag} onChange={(e) => setLocalTag(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') updateParam('tag', localTag.trim()); }}
                onBlur={() => updateParam('tag', localTag.trim())}
                placeholder="e.g. linux"
                className="px-3 py-1.5 min-h-[36px] sm:min-h-0 bg-surface border border-border rounded-lg text-xs w-36 sm:w-32 focus:outline-none focus:border-primary/50" />
            </div>
            <label className="flex items-center gap-2 text-xs text-textSecondary cursor-pointer select-none">
              <input type="checkbox" checked={featured} onChange={() => updateParam('featured', featured ? '' : '1')} className="accent-purple-500" />
              Featured only
            </label>
            <div>
              <div className="text-[11px] font-medium text-textMuted uppercase tracking-wider mb-2">Order</div>
              <div className="flex gap-1.5">
                {['desc', 'asc'].map(o => (
                  <button key={o} onClick={() => updateParam('order', o)}
                    className={`inline-flex items-center px-2.5 py-1 min-h-[36px] sm:min-h-0 rounded-full text-xs border uppercase transition-colors ${
                      order === o ? 'bg-surface border-primary/50 text-primary' : 'bg-surface border-border text-textSecondary'
                    }`}>{o}</button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Results */}
      {loading ? (
        <div>
          <Loading size={32} text="Searching the catalogue…" className="mb-6" />
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {[...Array(9)].map((_, i) => (
              <div key={i} className="h-24 rounded-xl bg-surface border border-border animate-pulse" />
            ))}
          </div>
        </div>
      ) : results.length > 0 ? (
        <>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
            {results.map(item => <ItemCard key={item.id} item={item} />)}
          </div>

          {pagination.totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pb-4">
              <button onClick={() => updateParam('page', Math.max(1, page - 1))} disabled={page <= 1}
                className="inline-flex items-center justify-center w-11 h-11 sm:w-9 sm:h-9 rounded-xl bg-surface border border-border disabled:opacity-40 hover:border-primary/30 transition-colors">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <div className="flex items-center gap-1">
                {[...Array(Math.min(5, pagination.totalPages))].map((_, i) => {
                  const p = i + 1 + Math.max(0, Math.min(page - 3, pagination.totalPages - 5));
                  if (p > pagination.totalPages) return null;
                  return (
                    <button key={p} onClick={() => updateParam('page', p)}
                      className={`w-11 h-11 sm:w-9 sm:h-9 rounded-xl text-sm font-medium transition-colors ${
                        p === page ? 'bg-gradient-primary text-white' : 'bg-surface border border-border text-textSecondary hover:border-primary/30'
                      }`}>{p}</button>
                  );
                })}
              </div>
              <button onClick={() => updateParam('page', Math.min(pagination.totalPages, page + 1))} disabled={page >= pagination.totalPages}
                className="inline-flex items-center justify-center w-11 h-11 sm:w-9 sm:h-9 rounded-xl bg-surface border border-border disabled:opacity-40 hover:border-primary/30 transition-colors">
                <ChevronRight className="w-4 h-4" />
              </button>
              <span className="text-xs text-textMuted ml-2">Page {pagination.page} / {pagination.totalPages}</span>
            </div>
          )}
        </>
      ) : (
        <div className="text-center py-16 border border-dashed border-border rounded-2xl">
          <Search className="w-8 h-8 text-textMuted mx-auto mb-3" />
          <h3 className="font-semibold text-textPrimary mb-1">No files found</h3>
          <p className="text-sm text-textMuted mb-4">Try a different search term or fewer filters.</p>
          <button onClick={clearFilters} className="px-5 py-2 bg-gradient-primary text-white rounded-xl text-sm font-medium">
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}
