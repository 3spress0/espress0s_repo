import { Search, ArrowRight, Database, Shield, Zap } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import StarryBackground from './StarryBackground';
import Logo from './Logo';
import { useSettings } from '../context/SettingsContext';

export default function Hero({ stats, onAskOpen }) {
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const { get } = useSettings();

  // Split the title so the last word keeps the gradient treatment.
  const titleWords = String(get('hero_title', '')).trim().split(/\s+/);
  const titleLead = titleWords.slice(0, -1).join(' ');
  const titleAccent = titleWords[titleWords.length - 1] || '';

  const handleSearch = (e) => {
    e.preventDefault();
    if (query.trim()) {
      navigate(`/browse?q=${encodeURIComponent(query.trim())}`);
    }
  };

  return (
    <div className="relative overflow-hidden">
      <StarryBackground />
      
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-24">
        <div className="text-center max-w-4xl mx-auto">
          <div className="flex justify-center mb-6 animate-slide-up">
            <Logo size={64} />
          </div>

          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight mb-6 animate-slide-up">
            {titleLead && (
              <>
                <span className="text-textPrimary">{titleLead}</span>
                <br />
              </>
            )}
            <span className="gradient-text">{titleAccent}</span>
          </h1>

          <p className="text-lg sm:text-xl text-textSecondary max-w-2xl mx-auto mb-10 leading-relaxed animate-slide-up" style={{ animationDelay: '0.1s' }}>
            {get('hero_subtitle', '')}
          </p>

          <form onSubmit={handleSearch} className="max-w-2xl mx-auto mb-8 animate-slide-up" style={{ animationDelay: '0.2s' }}>
            <div className="relative group">
              <div className="absolute -inset-1 bg-gradient-primary rounded-2xl blur-xl opacity-20 group-hover:opacity-30 group-focus-within:opacity-40 transition-all" />
              <div className="relative flex items-center bg-surface/80 backdrop-blur-xl border border-border rounded-2xl shadow-2xl shadow-black/50 overflow-hidden group-focus-within:border-primary/50 transition-all">
                <Search className="ml-5 w-5 h-5 text-textMuted group-focus-within:text-primary transition-colors flex-shrink-0" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={get('hero_search_placeholder', 'Search files...')}
                  className="flex-1 px-4 py-5 bg-transparent text-textPrimary placeholder:text-textMuted focus:outline-none text-base"
                />
                <button type="submit" className="mr-2 px-6 py-2.5 bg-gradient-primary hover:bg-gradient-primary-hover text-white rounded-xl font-medium text-sm shadow-lg flex items-center gap-2">
                  Search
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </form>

          <div className="grid grid-cols-3 gap-4 max-w-xl mx-auto animate-slide-up" style={{ animationDelay: '0.3s' }}>
            {[
              { icon: Database, label: 'Total Files', value: stats?.totals?.items || '—' },
              { icon: Zap, label: 'Total Size', value: stats?.totals?.totalSizeFormatted || '—' },
              { icon: Shield, label: 'Encrypted', value: get('hero_stat_encryption_label', 'AES-256') },
            ].map((stat, i) => (
              <div key={i} className="glass rounded-2xl p-4 text-center backdrop-blur-md">
                <stat.icon className="w-5 h-5 mx-auto mb-2 text-primary" />
                <div className="text-lg font-bold text-textPrimary">{stat.value}</div>
                <div className="text-xs text-textMuted">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
