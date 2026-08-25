import { Link } from 'react-router-dom';
import { Home, Search, ArrowLeft, FileQuestion, Sparkles } from 'lucide-react';
import StarryBackground from '../components/StarryBackground';
import { LogoLarge } from '../components/Logo';

export default function NotFound() {
  return (
    <div className="relative min-h-[80vh] flex items-center justify-center overflow-hidden">
      <StarryBackground />
      
      <div className="relative z-10 max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 text-center py-20">
        <div className="glass rounded-3xl border border-white/5 p-10 sm:p-12 shadow-2xl backdrop-blur-xl">
          <div className="flex justify-center mb-8">
            <div className="relative">
              <div className="absolute -inset-4 bg-gradient-primary rounded-full blur-2xl opacity-20 animate-pulse" />
              <div className="relative w-24 h-24 rounded-3xl bg-gradient-primary flex items-center justify-center shadow-xl shadow-purple-500/20">
                <FileQuestion className="w-12 h-12 text-white" />
              </div>
            </div>
          </div>

          <h1 className="text-7xl font-bold tracking-tight mb-4">
            <span className="gradient-text">404</span>
          </h1>
          
          <h2 className="text-2xl font-bold text-textPrimary mb-3">File not found in the archive</h2>
          
          <p className="text-textSecondary mb-8 leading-relaxed">
            The file you're looking for doesn't exist in <span className="text-textPrimary font-medium">espress0's repo</span>.
            It may have been moved, unpublished, or never indexed. All metadata is encrypted at rest.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center mb-10">
            <Link
              to="/"
              className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-gradient-primary hover:bg-gradient-primary-hover text-white rounded-xl font-medium shadow-lg shadow-purple-500/20 hover:shadow-purple-500/30 transition-all"
            >
              <Home className="w-4 h-4" />
              Back to Home
            </Link>
            <Link
              to="/browse"
              className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-surface border border-border hover:border-primary/30 rounded-xl font-medium text-sm transition-all"
            >
              <Search className="w-4 h-4" />
              Browse Repository
            </Link>
          </div>

          <div className="grid sm:grid-cols-2 gap-3 text-left">
            <Link to="/browse?category=operating-systems" className="p-4 rounded-xl bg-surface border border-border hover:border-primary/30 transition-colors group">
              <div className="font-medium text-textPrimary group-hover:text-white text-sm">Operating Systems</div>
              <div className="text-xs text-textMuted mt-1">Ubuntu, Windows, Debian, Arch</div>
            </Link>
            <Link to="/ask" className="p-4 rounded-xl bg-surface border border-border hover:border-primary/30 transition-colors group">
              <div className="font-medium text-textPrimary group-hover:text-white text-sm flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-primary" />
                Ask AI
              </div>
              <div className="text-xs text-textMuted mt-1">Which ISO for Intel PC?</div>
            </Link>
          </div>

          <div className="mt-8 pt-8 border-t border-white/5 flex items-center justify-center gap-2 text-xs text-textMuted">
            <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span>Repository online • Encrypted • CAPTCHA protected</span>
          </div>
        </div>

        <div className="mt-8 flex justify-center">
          <LogoLarge />
        </div>
      </div>
    </div>
  );
}
