import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Search, Package, Shield, LogOut, Menu, X, User, Settings, Coffee, Users, ChevronDown, Star } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import Logo from './Logo';
import ThemePicker from './ThemePicker';

/**
 * The top bar.
 *
 * Layout: brand and primary navigation on the left, the tools people reach for
 * on every page (search, Ask AI, theme, account) on the right. Everything is
 * drawn from the theme tokens, so it follows the light schemes as well as the
 * dark ones - no hard-coded purple shadows.
 *
 * Three things it does that plain markup cannot:
 *  - it listens to scroll so it can tighten and gain a shadow once the page is
 *    moving, which keeps it readable over any hero;
 *  - it collapses to a hamburger below md, and that panel gets the same
 *    commands the desktop bar shows (search included, which the old one lost);
 *  - the account cluster is a real menu, so "Log out" has a visible label
 *    instead of being an unlabeled icon, and Escape/outside-click close it.
 */
export default function Navbar({ onAskOpen }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout, isAdmin, isEditor, role } = useAuth();
  const { get } = useSettings();

  // Last word of the site name keeps the gradient accent.
  const nameWords = String(get('site_name', '')).trim().split(/\s+/);
  const nameLead = nameWords.slice(0, -1).join(' ');
  const nameAccent = nameWords[nameWords.length - 1] || '';
  const navTagline = get('site_tagline', '');
  const searchPlaceholder = get('hero_search_placeholder', 'Search files...');

  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const menuButtonRef = useRef(null);
  const accountButtonRef = useRef(null);
  const accountRef = useRef(null);
  const cancelLogoutRef = useRef(null);

  const isActive = (path) => location.pathname === path || location.pathname.startsWith(path + '/');
  const openPalette = () => window.dispatchEvent(new CustomEvent('espress0:palette'));

  const handleLogoutClick = () => {
    setAccountOpen(false);
    setShowLogoutConfirm(true);
  };
  const confirmLogout = () => {
    logout();
    setShowLogoutConfirm(false);
    setMobileOpen(false);
    navigate('/');
  };

  // Set once on mount so a page loaded mid-scroll does not paint the wrong bar.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Navigating closes both dropdowns; a menu left open behind a new page is
  // the kind of state people only notice once it bites them.
  useEffect(() => {
    setMobileOpen(false);
    setAccountOpen(false);
  }, [location.pathname]);

  // Escape closes the topmost open layer, and hands focus back to the button
  // that opened it.
  useEffect(() => {
    if (!mobileOpen && !accountOpen && !showLogoutConfirm) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (showLogoutConfirm) { setShowLogoutConfirm(false); return; }
      if (accountOpen) { setAccountOpen(false); accountButtonRef.current?.focus(); return; }
      setMobileOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen, accountOpen, showLogoutConfirm]);

  // Same outside-click rule ThemePicker uses, so menus behave identically.
  useEffect(() => {
    if (!accountOpen) return undefined;
    const onDown = (e) => { if (accountRef.current && !accountRef.current.contains(e.target)) setAccountOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [accountOpen]);

  // The dialog opens with focus on Cancel: a stray Enter should never log
  // anyone out.
  useEffect(() => {
    if (showLogoutConfirm) cancelLogoutRef.current?.focus();
  }, [showLogoutConfirm]);

  const navLinks = [
    { path: '/browse', label: 'Browse', icon: Package },
    { path: '/people', label: 'People', icon: Users },
  ];

  if (isEditor) {
    navLinks.push({ path: isAdmin ? '/admin' : '/admin/items', label: isAdmin ? 'Admin' : 'Editor', icon: Shield });
  }

  const initial = (user?.username || '?').trim().charAt(0).toUpperCase() || '?';
  const roleLabel = role === 'admin' ? 'Admin' : role === 'editor' ? 'Editor' : null;

  const linkClass = (active) => `flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap shrink-0 transition-all ${
    active
      ? 'bg-gradient-primary text-white shadow-lg shadow-primary/25'
      : 'text-textSecondary hover:text-textPrimary hover:bg-surfaceHover'
  }`;

  return (
    <>
      <nav
        aria-label="Main"
        className={`sticky top-0 z-50 pt-safe glass-strong border-b transition-all duration-300 ${
          scrolled ? 'border-border/70 shadow-[0_10px_30px_-16px_rgb(0_0_0/0.65)]' : 'border-border/40'
        }`}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className={`flex items-center gap-2 transition-all duration-300 ${scrolled ? 'h-14' : 'h-16'}`}>
            {/* ---- Brand ---- */}
            <Link to="/" className="flex items-center gap-3 group shrink-0" aria-label={`${nameLead} ${nameAccent}`.trim() || 'Home'}>
              <Logo size={scrolled ? 32 : 36} />
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

            {/* ---- Primary navigation ---- */}
            <div className="hidden md:flex items-center gap-1 ml-2">
              {navLinks.map(link => {
                const Icon = link.icon;
                return (
                  <Link
                    key={link.path}
                    to={link.path}
                    aria-current={isActive(link.path) ? 'page' : undefined}
                    className={linkClass(isActive(link.path))}
                  >
                    <Icon className="w-4 h-4" />
                    {link.label}
                  </Link>
                );
              })}
            </div>

            {/* ---- Tools ---- */}
            <div className="ml-auto flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={openPalette}
                title="Search and commands (Ctrl/⌘ K)"
                aria-label="Search files and run commands"
                className="hidden md:flex items-center gap-2 h-10 w-32 lg:w-60 xl:w-72 min-w-0 pl-3.5 pr-2 rounded-full bg-surface/60 border border-border/60 text-sm text-textMuted hover:text-textPrimary hover:border-primary/40 hover:bg-surfaceHover transition-all"
              >
                <Search className="w-4 h-4 shrink-0" />
                <span className="truncate">{searchPlaceholder}</span>
                <kbd className="ml-auto hidden xl:inline-flex px-1.5 py-0.5 rounded bg-surface border border-border text-[10px] font-mono text-textMuted">⌘K</kbd>
              </button>

              <button
                type="button"
                onClick={onAskOpen}
                className="hidden sm:flex items-center gap-2 h-10 px-3 lg:px-4 rounded-full text-sm font-medium bg-gradient-subtle border border-primary/25 text-textPrimary hover:border-primary/50 hover:bg-surfaceHover transition-all"
              >
                <Coffee className="w-4 h-4 text-primary shrink-0" />
                <span className="hidden lg:inline">Ask AI</span>
              </button>

              <ThemePicker className="max-md:hidden" />

              {user ? (
                <div className="relative shrink-0 hidden md:block" ref={accountRef}>
                  <button
                    type="button"
                    ref={accountButtonRef}
                    onClick={() => setAccountOpen(o => !o)}
                    aria-expanded={accountOpen}
                    aria-haspopup="menu"
                    aria-label={`Account menu for ${user.username}`}
                    className={`flex items-center gap-2 h-10 pl-1.5 pr-2.5 rounded-full border transition-all ${
                      isActive('/account')
                        ? 'bg-surface border-primary/40 text-textPrimary'
                        : accountOpen
                          ? 'bg-surfaceHover border-border text-textPrimary'
                          : 'border-transparent text-textSecondary hover:text-textPrimary hover:bg-surfaceHover'
                    }`}
                  >
                    <span aria-hidden="true" className="w-7 h-7 rounded-full bg-gradient-primary grid place-items-center text-[12px] font-bold text-white">
                      {initial}
                    </span>
                    <span className="hidden lg:inline max-w-[9rem] truncate text-sm font-medium">{user.username}</span>
                    <ChevronDown aria-hidden="true" className={`w-3.5 h-3.5 transition-transform duration-200 ${accountOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {accountOpen && (
                    <div role="menu" aria-label="Account" className="absolute right-0 mt-2 w-60 glass-strong rounded-2xl border border-border/60 p-2 shadow-2xl animate-fade-in">
                      <div className="px-3 pt-2 pb-3 mb-1 border-b border-border/50">
                        <p className="text-sm font-semibold text-textPrimary truncate">{user.username}</p>
                        <p className="text-xs text-textMuted">{roleLabel ? `${roleLabel} account` : 'Signed in'}</p>
                      </div>
                      <Link
                        role="menuitem"
                        to="/account"
                        onClick={() => setAccountOpen(false)}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-textSecondary hover:text-textPrimary hover:bg-surfaceHover transition-colors"
                      >
                        <Settings className="w-4 h-4" />
                        Account
                      </Link>
                      <Link
                        role="menuitem"
                        to="/account?tab=favorites"
                        onClick={() => setAccountOpen(false)}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-textSecondary hover:text-textPrimary hover:bg-surfaceHover transition-colors"
                      >
                        <Star className="w-4 h-4" />
                        My favourites
                      </Link>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={handleLogoutClick}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-textSecondary hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <LogOut className="w-4 h-4" />
                        Log out
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-1 sm:gap-2 shrink-0">
                  <Link to="/login" className="px-3 lg:px-4 py-2 rounded-full text-sm font-medium text-textSecondary hover:text-textPrimary hover:bg-surfaceHover transition-all">Login</Link>
                  <Link to="/register" className="px-3 lg:px-4 py-2 rounded-full text-sm font-medium bg-gradient-primary text-white shadow-lg shadow-primary/25 hover:shadow-primary/40 transition-all">Register</Link>
                </div>
              )}

              {/* Both icon buttons need a 44px touch target on a phone. */}
              <div className="md:hidden flex items-center gap-1 shrink-0">
                <ThemePicker className="max-md:min-w-11 max-md:min-h-11" />
                <button
                  type="button"
                  ref={menuButtonRef}
                  onClick={() => setMobileOpen(o => !o)}
                  aria-label="Menu"
                  aria-expanded={mobileOpen}
                  aria-controls="mobile-nav"
                  className="w-11 h-11 rounded-xl bg-surface border border-border text-textSecondary hover:text-textPrimary flex items-center justify-center"
                >
                  {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
                </button>
              </div>
            </div>
          </div>

          {mobileOpen && (
            <div
              id="mobile-nav"
              className="md:hidden pt-4 pb-safe border-t border-border/40 animate-fade-in max-h-[calc(100dvh-4rem)] overflow-y-auto"
            >
              <button
                type="button"
                onClick={() => { openPalette(); setMobileOpen(false); }}
                className="w-full flex items-center gap-3 px-4 py-3 mb-2 rounded-xl text-sm text-textMuted bg-surface border border-border/60"
              >
                <Search className="w-5 h-5" />
                {searchPlaceholder}
              </button>

              <div className="space-y-1">
                {navLinks.map(link => {
                  const Icon = link.icon;
                  return (
                    <Link
                      key={link.path}
                      to={link.path}
                      onClick={() => setMobileOpen(false)}
                      aria-current={isActive(link.path) ? 'page' : undefined}
                      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium ${
                        isActive(link.path) ? 'bg-gradient-primary text-white' : 'text-textSecondary hover:text-textPrimary hover:bg-surface'
                      }`}
                    >
                      <Icon className="w-5 h-5" />
                      {link.label}
                    </Link>
                  );
                })}
                <button
                  type="button"
                  onClick={() => { onAskOpen(); setMobileOpen(false); }}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm text-textSecondary hover:text-textPrimary hover:bg-surface"
                >
                  <Coffee className="w-5 h-5" />
                  Ask AI
                </button>
                {user ? (
                  <>
                    <Link
                      to="/account"
                      onClick={() => setMobileOpen(false)}
                      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium ${
                        isActive('/account') ? 'bg-gradient-primary text-white' : 'text-textSecondary hover:text-textPrimary hover:bg-surface'
                      }`}
                    >
                      <Settings className="w-5 h-5" />
                      Account
                    </Link>
                    <Link to="/account?tab=favorites" onClick={() => setMobileOpen(false)} className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm text-textSecondary hover:text-textPrimary hover:bg-surface">
                      <Star className="w-5 h-5" />
                      My favourites
                    </Link>
                    <button type="button" onClick={handleLogoutClick} className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm text-textSecondary hover:text-red-400 hover:bg-red-500/10">
                      <LogOut className="w-5 h-5" />
                      Log out
                    </button>
                  </>
                ) : (
                  <>
                    <Link to="/login" onClick={() => setMobileOpen(false)} className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm text-textSecondary hover:text-textPrimary hover:bg-surface">
                      <User className="w-5 h-5" />
                      Login
                    </Link>
                    <Link to="/register" onClick={() => setMobileOpen(false)} className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium bg-gradient-primary text-white">
                      <User className="w-5 h-5" />
                      Register
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
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="logout-title"
            aria-describedby="logout-body"
            className="glass-strong rounded-3xl border border-border/60 p-8 max-w-md w-full shadow-2xl animate-slide-up"
          >
            <div className="w-12 h-12 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
              <LogOut className="w-6 h-6 text-red-400" />
            </div>
            <h3 id="logout-title" className="text-lg font-bold text-textPrimary text-center mb-2">Confirm log out?</h3>
            <p id="logout-body" className="text-sm text-textSecondary text-center mb-6">You will need to log in again to download files.</p>
            <div className="flex gap-3">
              <button ref={cancelLogoutRef} type="button" onClick={() => setShowLogoutConfirm(false)} className="flex-1 px-5 py-3 bg-surface border border-border rounded-xl text-sm font-medium hover:border-primary/30">Cancel</button>
              <button type="button" onClick={confirmLogout} className="flex-1 px-5 py-3 bg-red-500 hover:bg-red-600 text-white rounded-xl text-sm font-medium shadow-lg shadow-red-500/20">Log out</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
