import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Search, Filter, X, SlidersHorizontal, ChevronLeft, ChevronRight, Folder } from 'lucide-react';
import ItemCard from '../components/ItemCard';
import { searchApi, categoriesApi, foldersApi, itemsApi } from '../lib/api';

const fileTypes = ['iso', 'exe', 'zip', 'pdf', 'dmg', 'msi', 'tar', 'gz', 'img'];
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
  { value: 'date', label: 'Date Added' },
  { value: 'updated', label: 'Recently Updated' },
  { value: 'name', label: 'Name' },
  { value: 'size', label: 'Size' },
  { value: 'popular', label: 'Most Downloaded' },
  { value: 'views', label: 'Most Viewed' },
];

export default function Browse() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [results, setResults] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 0 });
  const [categories, setCategories] = useState([]);
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(false);

  const query = searchParams.get('q') || '';
  const category = searchParams.get('category') || '';
  const folder = searchParams.get('folder') || '';
  const tag = searchParams.get('tag') || '';
  const license = searchParams.get('license_status') || '';
  const featured = searchParams.get('featured') === '1';
  const fileType = searchParams.get('file_type') || '';
  const platform = searchParams.get('platform') || '';
  const arch = searchParams.get('architecture') || '';
  const sort = searchParams.get('sort') || 'relevance';
  const order = searchParams.get('order') || 'desc';
  const page = parseInt(searchParams.get('page') || '1');

  const [localQuery, setLocalQuery] = useState(query);
  const [localTag, setLocalTag] = useState(tag);

  useEffect(() => {
    setLocalQuery(query);
  }, [query]);
  useEffect(() => {
    setLocalTag(tag);
  }, [tag]);

  useEffect(() => {
    categoriesApi.list().then(d => setCategories(d.categories || [])).catch(() => {});
    foldersApi.list().then(d => setFolders(d.folders || [])).catch(() => {});
  }, []);

  const fetchResults = useCallback(async () => {
    setLoading(true);
    try {
      const params = {
        q: query || undefined,
        category: category || undefined,
        folder: folder || undefined,
        tag: tag || undefined,
        license_status: license || undefined,
        featured: featured ? 1 : undefined,
        file_type: fileType || undefined,
        platform: platform || undefined,
        architecture: arch || undefined,
        sort,
        order,
        page,
        limit: 18,
      };
      const data = await searchApi.search(params);
      setResults(data.results || []);
      setPagination(data.pagination || { page: 1, total: 0, totalPages: 0 });
    } catch (e) {
      console.error(e);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query, category, folder, tag, license, featured, fileType, platform, arch, sort, order, page]);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  const updateParam = (key, value) => {
    const newParams = new URLSearchParams(searchParams);
    if (value) newParams.set(key, value);
    else newParams.delete(key);
    if (key !== 'page') newParams.set('page', '1');
    setSearchParams(newParams);
  };

  const clearFilters = () => {
    setSearchParams({ q: query });
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    updateParam('q', localQuery);
  };

  const hasFilters = category || folder || tag || license || featured || fileType || platform || arch;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-textPrimary mb-2">Browse Repository</h1>
        <p className="text-textSecondary">Search and filter through {pagination.total} files</p>
      </div>

      {/* Search + controls */}
      <div className="flex flex-col lg:flex-row gap-4 mb-6">
        <form onSubmit={handleSearchSubmit} className="flex-1 relative group">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-textMuted group-focus-within:text-primary transition-colors" />
          <input
            type="text"
            value={localQuery}
            onChange={(e) => setLocalQuery(e.target.value)}
            placeholder="Search by name, description, version, tags..."
            className="w-full pl-12 pr-4 py-3.5 bg-surface border border-border rounded-2xl focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 transition-all text-sm"
          />
        </form>

        <div className="flex gap-2">
          <select
            value={sort}
            onChange={(e) => updateParam('sort', e.target.value)}
            className="px-4 py-3.5 bg-surface border border-border rounded-2xl text-sm focus:outline-none focus:border-primary/50"
          >
            {sortOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`px-5 py-3.5 rounded-2xl border text-sm font-medium flex items-center gap-2 transition-all ${
              showFilters || hasFilters
                ? 'bg-gradient-primary border-transparent text-white shadow-lg shadow-purple-500/20'
                : 'bg-surface border-border text-textSecondary hover:border-primary/30 hover:text-textPrimary'
            }`}
          >
            <SlidersHorizontal className="w-4 h-4" />
            Filters
            {hasFilters && <span className="w-2 h-2 rounded-full bg-white animate-pulse" />}
          </button>
        </div>
      </div>

      {/* Filters panel */}
      {showFilters && (
        <div className="glass rounded-2xl border border-white/5 p-6 mb-6 animate-fade-in">
          <div className="flex items-center justify-between mb-6">
            <h3 className="font-semibold text-textPrimary flex items-center gap-2">
              <Filter className="w-4 h-4" />
              Filters
            </h3>
            <div className="flex gap-2">
              {hasFilters && (
                <button onClick={clearFilters} className="text-xs text-textMuted hover:text-primary flex items-center gap-1">
                  <X className="w-3 h-3" />
                  Clear all
                </button>
              )}
              <button onClick={() => setShowFilters(false)} className="p-1 hover:bg-surfaceHover rounded-lg">
                <X className="w-4 h-4 text-textMuted" />
              </button>
            </div>
          </div>

          {/* Row of extra filters: folder, tag, license, featured */}
          <div className="flex flex-wrap items-end gap-4 mb-6 pb-5 border-b border-white/5">
            <div className="min-w-[160px]">
              <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">Folder</label>
              <div className="relative">
                <Folder className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-textMuted pointer-events-none" />
                <select
                  value={folder}
                  onChange={(e) => updateParam('folder', e.target.value)}
                  className="w-full pl-8 pr-4 py-2 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50 appearance-none"
                >
                  <option value="">All folders</option>
                  <option value="none">Unfiled</option>
                  {folders.map(f => (
                    <option key={f.id} value={f.slug}>{f.icon ? `${f.icon} ` : ''}{f.name} ({f.item_count})</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="min-w-[160px]">
              <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">Tag</label>
              <input
                type="text"
                value={localTag}
                onChange={(e) => setLocalTag(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') updateParam('tag', localTag.trim()); }}
                onBlur={() => updateParam('tag', localTag.trim())}
                placeholder="e.g. linux"
                className="w-full px-3 py-2 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
              />
            </div>

            <div className="min-w-[170px]">
              <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">License</label>
              <select
                value={license}
                onChange={(e) => updateParam('license_status', e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
              >
                <option value="">Any license</option>
                {licenses.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>

            <button
              onClick={() => updateParam('featured', featured ? '' : '1')}
              className={`px-4 py-2 rounded-xl text-sm font-medium border transition-all ${
                featured ? 'bg-gradient-primary border-transparent text-white' : 'bg-surface border-border text-textSecondary hover:border-primary/30'
              }`}
            >
              ★ Featured only
            </button>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            <div>
              <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-3 block">Category</label>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                <button
                  onClick={() => updateParam('category', '')}
                  className={`w-full text-left px-3 py-2 rounded-xl text-sm transition-all ${!category ? 'bg-gradient-primary text-white' : 'bg-surfaceHover hover:bg-surface border border-border text-textSecondary'}`}
                >
                  All Categories
                </button>
                {categories.map(cat => (
                  <button
                    key={cat.id}
                    onClick={() => updateParam('category', cat.slug)}
                    className={`w-full text-left px-3 py-2 rounded-xl text-sm transition-all flex items-center justify-between ${
                      category === cat.slug ? 'bg-gradient-primary text-white' : 'bg-surfaceHover hover:bg-surface border border-border text-textSecondary'
                    }`}
                  >
                    <span>{cat.name}</span>
                    <span className="text-xs opacity-70">{cat.count}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-3 block">File Type</label>
              <div className="flex flex-wrap gap-2">
                {fileTypes.map(ft => (
                  <button
                    key={ft}
                    onClick={() => updateParam('file_type', fileType === ft ? '' : ft)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium uppercase border transition-all ${
                      fileType === ft ? 'bg-gradient-primary border-transparent text-white' : 'bg-surface border-border text-textSecondary hover:border-primary/30'
                    }`}
                  >
                    {ft}
                  </button>
                ))}
              </div>

              <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-3 mt-6 block">Platform</label>
              <div className="flex flex-wrap gap-2">
                {platforms.map(p => (
                  <button
                    key={p}
                    onClick={() => updateParam('platform', platform === p ? '' : p)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all capitalize ${
                      platform === p ? 'bg-gradient-primary border-transparent text-white' : 'bg-surface border-border text-textSecondary hover:border-primary/30'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-3 block">Architecture</label>
              <div className="flex flex-wrap gap-2">
                {architectures.map(a => (
                  <button
                    key={a}
                    onClick={() => updateParam('architecture', arch === a ? '' : a)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                      arch === a ? 'bg-gradient-primary border-transparent text-white' : 'bg-surface border-border text-textSecondary hover:border-primary/30'
                    }`}
                  >
                    {a}
                  </button>
                ))}
              </div>

              <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-3 mt-6 block">Sort Order</label>
              <div className="flex gap-2">
                {['desc', 'asc'].map(o => (
                  <button
                    key={o}
                    onClick={() => updateParam('order', o)}
                    className={`px-4 py-2 rounded-xl text-xs font-medium border transition-all uppercase ${
                      order === o ? 'bg-surface border-primary/50 text-primary' : 'bg-surfaceHover border-border text-textSecondary'
                    }`}
                  >
                    {o === 'desc' ? '↓ Desc' : '↑ Asc'}
                  </button>
                ))}
              </div>
            </div>

            <div className="glass rounded-xl p-4 border border-white/5">
              <h4 className="font-medium text-textPrimary text-sm mb-2">Active Filters</h4>
              {hasFilters || query ? (
                <div className="space-y-2 text-xs">
                  {query && <div className="flex items-center justify-between bg-surface rounded-lg px-3 py-2"><span>Search: "{query}"</span><button onClick={() => updateParam('q', '')}><X className="w-3 h-3" /></button></div>}
                  {category && <div className="flex items-center justify-between bg-surface rounded-lg px-3 py-2"><span>Category: {category}</span><button onClick={() => updateParam('category', '')}><X className="w-3 h-3" /></button></div>}
                  {folder && <div className="flex items-center justify-between bg-surface rounded-lg px-3 py-2"><span>Folder: {folders.find(f => f.slug === folder)?.name || folder}</span><button onClick={() => updateParam('folder', '')}><X className="w-3 h-3" /></button></div>}
                  {tag && <div className="flex items-center justify-between bg-surface rounded-lg px-3 py-2"><span>Tag: {tag}</span><button onClick={() => updateParam('tag', '')}><X className="w-3 h-3" /></button></div>}
                  {license && <div className="flex items-center justify-between bg-surface rounded-lg px-3 py-2"><span>License: {licenses.find(l => l.value === license)?.label || license}</span><button onClick={() => updateParam('license_status', '')}><X className="w-3 h-3" /></button></div>}
                  {featured && <div className="flex items-center justify-between bg-surface rounded-lg px-3 py-2"><span>Featured only</span><button onClick={() => updateParam('featured', '')}><X className="w-3 h-3" /></button></div>}
                  {fileType && <div className="flex items-center justify-between bg-surface rounded-lg px-3 py-2"><span>Type: {fileType}</span><button onClick={() => updateParam('file_type', '')}><X className="w-3 h-3" /></button></div>}
                  {platform && <div className="flex items-center justify-between bg-surface rounded-lg px-3 py-2"><span>Platform: {platform}</span><button onClick={() => updateParam('platform', '')}><X className="w-3 h-3" /></button></div>}
                  {arch && <div className="flex items-center justify-between bg-surface rounded-lg px-3 py-2"><span>Arch: {arch}</span><button onClick={() => updateParam('architecture', '')}><X className="w-3 h-3" /></button></div>}
                </div>
              ) : (
                <p className="text-xs text-textMuted">No filters active</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Results */}
      {loading ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(9)].map((_, i) => (
            <div key={i} className="h-48 rounded-2xl bg-surface border border-border animate-pulse" />
          ))}
        </div>
      ) : results.length > 0 ? (
        <>
          <div className="flex items-center justify-between mb-4 text-sm text-textMuted">
            <span>Found {pagination.total} files • Page {pagination.page} of {pagination.totalPages}</span>
            <span>{results.length} shown</span>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            {results.map(item => (
              <ItemCard key={item.id} item={item} />
            ))}
          </div>

          {/* Pagination */}
          {pagination.totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => updateParam('page', Math.max(1, page - 1))}
                disabled={page <= 1}
                className="p-2.5 rounded-xl bg-surface border border-border disabled:opacity-50 hover:border-primary/30 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              
              <div className="flex items-center gap-1">
                {[...Array(Math.min(5, pagination.totalPages))].map((_, i) => {
                  const p = i + 1 + Math.max(0, Math.min(page - 3, pagination.totalPages - 5));
                  if (p > pagination.totalPages) return null;
                  return (
                    <button
                      key={p}
                      onClick={() => updateParam('page', p)}
                      className={`w-10 h-10 rounded-xl text-sm font-medium transition-all ${
                        p === page ? 'bg-gradient-primary text-white shadow-lg shadow-purple-500/20' : 'bg-surface border border-border text-textSecondary hover:border-primary/30'
                      }`}
                    >
                      {p}
                    </button>
                  );
                })}
              </div>

              <button
                onClick={() => updateParam('page', Math.min(pagination.totalPages, page + 1))}
                disabled={page >= pagination.totalPages}
                className="p-2.5 rounded-xl bg-surface border border-border disabled:opacity-50 hover:border-primary/30 transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="text-center py-20 glass rounded-3xl border border-white/5">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-surface border border-border flex items-center justify-center">
            <Search className="w-8 h-8 text-textMuted" />
          </div>
          <h3 className="text-lg font-semibold text-textPrimary mb-2">No files found</h3>
          <p className="text-sm text-textMuted mb-6 max-w-md mx-auto">
            Try adjusting your search or filters. The repository contains {categories.reduce((a, c) => a + (c.count || 0), 0)} files across {categories.length} categories.
          </p>
          <button onClick={clearFilters} className="px-6 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium shadow-lg shadow-purple-500/20 hover:shadow-purple-500/30 transition-all">
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}
