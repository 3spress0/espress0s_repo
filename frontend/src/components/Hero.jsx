import { Search, ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import StarryBackground from './StarryBackground';
import { useSettings } from '../context/SettingsContext';

export default function Hero({ stats }) {
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const { get } = useSettings();

  const titleWords = String(get('hero_title', '')).trim().split(/\s+/);
  const titleLead = titleWords.slice(0, -1).join(' ');
  const titleAccent = titleWords[titleWords.length - 1] || '';

  const handleSearch = (e) => {
    e.preventDefault();
    if (query.trim()) navigate(`/browse?q=${encodeURIComponent(query.trim())}`);
  };

  return (
    <div className="relative overflow-hidden">
      <StarryBackground />
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 sm:py-20">
        <div className="text-center max-w-3xl mx-auto">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4 animate-slide-up">
            {titleLead && <><span className="text-textPrimary">{titleLead}</span>{' '}</>}
            <span className="gradient-text">{titleAccent}</span>
          </h1>

          <p className="text-base sm:text-lg text-textSecondary max-w-xl mx-auto mb-8 leading-relaxed animate-slide-up" style={{ animationDelay: '0.08s' }}>
            {get('hero_subtitle', '')}
          </p>

          <form onSubmit={handleSearch} className="max-w-xl mx-auto animate-slide-up" style={{ animationDelay: '0.16s' }}>
            <div className="relative flex items-center bg-surface/80 backdrop-blur-xl border border-border rounded-xl overflow-hidden focus-within:border-primary/50 transition-colors">
              <Search className="ml-4 w-4 h-4 text-textMuted flex-shrink-0" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={get('hero_search_placeholder', 'Search files...')}
                className="flex-1 px-3 py-3.5 bg-transparent text-textPrimary placeholder:text-textMuted focus:outline-none text-sm"
              />
              <button type="submit" className="mr-1.5 px-5 py-2 bg-gradient-primary hover:bg-gradient-primary-hover text-white rounded-lg font-medium text-sm flex items-center gap-1.5">
                Search <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </form>

          {/* One slim stat line instead of three floating tiles */}
          {stats && (
            <p className="mt-6 text-xs text-textMuted tracking-wide animate-slide-up" style={{ animationDelay: '0.22s' }}>
              <span className="text-textPrimary font-semibold">{Number(stats.totals.items || 0).toLocaleString()}</span> files
              <span className="mx-2 text-border">|</span>
              <span className="text-textPrimary font-semibold">{stats.totals.totalSizeFormatted || '0 B'}</span> indexed
              <span className="mx-2 text-border">|</span>
              AES-256 at rest
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
