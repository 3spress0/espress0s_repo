import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Search, Package, Shield, LogOut, Menu, X, User, Settings, Coffee, Users } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import Logo from './Logo';
import ThemePicker from './ThemePicker';
import LanguagePicker from './LanguagePicker';
import { useI18n } from '../i18n/index.jsx';

export default function Navbar({ onAskOpen }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout, isAdmin, isEditor } = useAuth();
  const { get } = useSettings();
  const { t } = useI18n();

  // Last word of the site name keeps the gradient accent.
  const nameWords = String(get('site_name', '')).trim().split(/\s+/);
  const nameLead = nameWords.slice(0, -1).join(' ');
  const nameAccent = nameWords[nameWords.length - 1] || '';
  const navTagline = get('site_tagline', '');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  const isActive = (path) => location.pathname === path || location.pathname.startsWith(path + '/');

  const handleLogoutClick = () => setShowLogoutConfirm(true);
  const confirmLogout = () => {
    logout();
    setShowLogoutConfirm(false);
    setMobileOpen(false);
    navigate('/');
  };

  const navLinks = [
    { path: '/browse', label: t('nav.browse'), icon: Package },
    { path: '/people', label: t('nav.people'), icon: Users },
  ];

  if (isEditor) {
    navLinks.push({ path: isAdmin ? '/admin' : '/admin/items', label: isAdmin ? t('nav.admin') : t('nav.editor'), icon: Shield });
  }

  return (
    <>
      <nav className="sticky top-0 z-50 pt-safe glass-strong border-b border-white/5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Link to="/" className="flex items-center gap-3 group">
              <Logo size={36} />
              <div className="hidden sm:block">
                <h1 className="text-[15px] font-bold leading-none tracking-tight">
                  {nameLead && <>{nameLead} </>}
                  <span className="gradient-text">{nameAccent}</span>
                </h1>
                {navTagline && (
                  <p className="text-[10px] text-textMuted font-medium tracking-widest uppercase">{navTagline}</p>
                )}
              </div>
            </Link>

            <div className="hidden md:flex items-center gap-1 ml-auto">
              {navLinks.map(link => {
                const Icon = link.icon;
                return (
                  <Link
                    key={link.path}
                    to={link.path}
                    className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all ${
                      isActive(link.path) ? 'bg-gradient-primary text-white shadow-lg shadow-purple-500/20' : 'text-textSecondary hover:text-textPrimary hover:bg-surfaceHover'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {link.label}
                  </Link>
                );
              })}

              <button onClick={onAskOpen} className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium text-textSecondary hover:text-textPrimary hover:bg-surfaceHover transition-all">
                <Coffee className="w-4 h-4" />
                Ask AI
              </button>

              <LanguagePicker compact />
              <ThemePicker />

              {user ? (
                <div className="ml-2 flex items-center gap-1">
                  <Link to="/account" className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all ${isActive('/account') ? 'bg-surface border border-primary/30 text-primary' : 'text-textSecondary hover:text-textPrimary hover:bg-surfaceHover'}`}>
                    <Settings className="w-4 h-4" />
                    {user.username}
                  </Link>
                  <button onClick={handleLogoutClick} className="flex items-center gap-2 px-3 py-2 rounded-full text-sm text-textSecondary hover:text-red-400 hover:bg-red-500/10 transition-colors">
                    <LogOut className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div className="ml-2 flex items-center gap-2">
                  <Link to="/login" className="px-4 py-2 rounded-full text-sm font-medium text-textSecondary hover:text-textPrimary hover:bg-surfaceHover transition-all">{t('nav.login')}</Link>
                  <Link to="/register" className="px-4 py-2 rounded-full text-sm font-medium bg-gradient-primary text-white shadow-lg shadow-purple-500/20 hover:shadow-purple-500/30 transition-all">{t('nav.register')}</Link>
                </div>
              )}
            </div>

            <div className="md:hidden flex items-center gap-1">
              {/* Both icon buttons need a 44px touch target on a phone. */}
              <ThemePicker className="max-md:min-w-11 max-md:min-h-11" />
              <button onClick={() => setMobileOpen(!mobileOpen)} aria-label="Menu" className="w-11 h-11 rounded-xl bg-surface border border-border text-textSecondary hover:text-textPrimary flex items-center justify-center">
                {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>
            </div>
          </div>

          {mobileOpen && (
            <div className="md:hidden pt-4 pb-safe border-t border-white/5 animate-fade-in">
              <div className="space-y-1">
                {navLinks.map(link => {
                  const Icon = link.icon;
                  return (
                    <Link key={link.path} to={link.path} onClick={() => setMobileOpen(false)} className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium ${isActive(link.path) ? 'bg-gradient-primary text-white' : 'text-textSecondary hover:text-textPrimary hover:bg-surface'}`}>
                      <Icon className="w-5 h-5" />
                      {link.label}
                    </Link>
                  );
                })}
                <button onClick={() => { onAskOpen(); setMobileOpen(false); }} className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm text-textSecondary hover:text-textPrimary hover:bg-surface">
                  <Coffee className="w-5 h-5" />
                  Ask AI (Barista)
                </button>
                {user ? (
                  <>
                    <Link to="/account" onClick={() => setMobileOpen(false)} className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium ${isActive('/account') ? 'bg-gradient-primary text-white' : 'text-textSecondary hover:text-textPrimary hover:bg-surface'}`}>
                      <Settings className="w-5 h-5" />
                      Account
                    </Link>
                    <button onClick={handleLogoutClick} className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm text-textSecondary hover:text-red-400 hover:bg-red-500/10">
                      <LogOut className="w-5 h-5" />
                      Log Out
                    </button>
                  </>
                ) : (
                  <>
                    <Link to="/login" onClick={() => setMobileOpen(false)} className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm text-textSecondary hover:text-textPrimary hover:bg-surface">
                      <User className="w-5 h-5" />
                      {t('nav.login')}
                    </Link>
                    <Link to="/register" onClick={() => setMobileOpen(false)} className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium bg-gradient-primary text-white">
                      <User className="w-5 h-5" />
                      {t('nav.register')}
                    </Link>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </nav>

      {showLogoutConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
          <div className="glass-strong rounded-3xl border border-white/10 p-8 max-w-md w-full shadow-2xl animate-slide-up">
            <div className="w-12 h-12 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
              <LogOut className="w-6 h-6 text-red-400" />
            </div>
            <h3 className="text-lg font-bold text-textPrimary text-center mb-2">{t('logout.confirmTitle')}</h3>
            <p className="text-sm text-textSecondary text-center mb-6">{t('logout.confirmBody')}</p>
            <div className="flex gap-3">
              <button onClick={() => setShowLogoutConfirm(false)} className="flex-1 px-5 py-3 bg-surface border border-border rounded-xl text-sm font-medium hover:border-primary/30">{t('logout.cancel')}</button>
              <button onClick={confirmLogout} className="flex-1 px-5 py-3 bg-red-500 hover:bg-red-600 text-white rounded-xl text-sm font-medium shadow-lg shadow-red-500/20">{t('logout.button')}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
