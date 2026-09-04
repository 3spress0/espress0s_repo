import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Package, Users, Shield, Settings, LogIn, UserPlus, Star, Sparkles, Palette, Upload, FolderTree, Tag, FileText, Command, CornerDownLeft, Keyboard, Home, Languages, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useI18n } from '../i18n/index.jsx';
import { searchApi } from '../lib/api';

/**
 * Cmd/Ctrl+K command palette.
 *
 * Two kinds of rows: static commands (navigation, theme, language, admin
 * shortcuts filtered by role) and live catalogue results from
 * /api/search/suggestions as the query changes. Plus a handful of global
 * shortcuts: "/" focuses search (opens the palette), "g b" / "g a" / "g f"
 * go-to chords, "?" shows the shortcut list. Nothing fires while typing in an
 * input, so the editor's Cmd+S and normal typing are untouched.
 */
const FILE_ICON = FileText;

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

const isTyping = (e) => {
  const el = e.target;
  const tag = el?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable;
};

export const SHORTCUTS = [
  { keys: ['⌘/Ctrl', 'K'], label: 'Open command palette' },
  { keys: ['/'], label: 'Search the catalogue' },
  { keys: ['g', 'h'], label: 'Go home' },
  { keys: ['g', 'b'], label: 'Go to Browse' },
  { keys: ['g', 'f'], label: 'Go to your favourites' },
  { keys: ['g', 'a'], label: 'Go to Admin (editors and admins)' },
  { keys: ['?'], label: 'Show this list' },
  { keys: ['Esc'], label: 'Close' },
];

export default function CommandPalette({ onAskOpen }) {
  const navigate = useNavigate();
  const { user, isAdmin, isEditor, logout } = useAuth();
  const themeCtx = useTheme();
  const { t, setLocale, locales } = useI18n();
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [results, setResults] = useState([]);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const chord = useRef({ key: null, at: 0 });
  const debounced = useDebounced(query, 150);

  const go = useCallback((to) => { setOpen(false); setHelp(false); navigate(to); }, [navigate]);

  // ---- static commands -----------------------------------------------------
  const commands = useMemo(() => {
    const list = [
      { id: 'home', label: 'Home', hint: 'g h', icon: Home, run: () => go('/') },
      { id: 'browse', label: t('nav.browse'), hint: 'g b', icon: Package, run: () => go('/browse') },
      { id: 'people', label: t('nav.people'), icon: Users, run: () => go('/people') },
      { id: 'ask', label: t('nav.askAi'), icon: Sparkles, run: () => { setOpen(false); onAskOpen?.(); } },
    ];
    if (user) {
      list.push({ id: 'favorites', label: 'My favourites', hint: 'g f', icon: Star, run: () => go('/account?tab=favorites') });
      list.push({ id: 'account', label: t('nav.account'), icon: Settings, run: () => go('/account') });
      list.push({ id: 'logout', label: t('logout.button'), icon: LogIn, run: () => { setOpen(false); logout(); navigate('/'); } });
    } else {
      list.push({ id: 'login', label: t('nav.login'), icon: LogIn, run: () => go('/login') });
      list.push({ id: 'register', label: t('nav.register'), icon: UserPlus, run: () => go('/register') });
    }
    if (isEditor) {
      list.push({ id: 'admin-items', label: 'Admin: Items', hint: 'g a', icon: Shield, run: () => go('/admin/items') });
      list.push({ id: 'admin-new', label: 'Admin: New item', icon: FileText, run: () => go('/admin/items/new') });
    }
    if (isAdmin) {
      list.push({ id: 'admin-dash', label: 'Admin: Dashboard', icon: Shield, run: () => go('/admin') });
      list.push({ id: 'admin-cats', label: 'Admin: Categories', icon: Tag, run: () => go('/admin/categories') });
      list.push({ id: 'admin-folders', label: 'Admin: Folders', icon: FolderTree, run: () => go('/admin/folders') });
      list.push({ id: 'admin-imports', label: 'Admin: Catalogue import / export', icon: Upload, run: () => go('/admin/imports') });
      list.push({ id: 'admin-users', label: 'Admin: Users', icon: Users, run: () => go('/admin/users') });
      list.push({ id: 'admin-settings', label: 'Admin: Settings', icon: Settings, run: () => go('/admin/settings') });
    }
    if (themeCtx.allowUserChoice) {
      list.push({ id: 'theme-auto', label: 'Theme: match system', icon: Palette, run: () => { themeCtx.setTheme('auto'); setOpen(false); } });
      for (const th of themeCtx.themes) list.push({ id: `theme-${th.id}`, label: `Theme: ${th.label}`, icon: Palette, run: () => { themeCtx.setTheme(th.id); setOpen(false); } });
    }
    list.push({ id: 'lang-auto', label: `${t('common.language')}: automatic`, icon: Languages, run: () => { setLocale(null); setOpen(false); } });
    for (const l of locales) list.push({ id: `lang-${l.code}`, label: `${t('common.language')}: ${l.name}`, icon: Languages, run: () => { setLocale(l.code); setOpen(false); } });
    list.push({ id: 'help', label: 'Keyboard shortcuts', hint: '?', icon: Keyboard, run: () => setHelp(true) });
    return list;
  }, [user, isAdmin, isEditor, themeCtx, t, setLocale, locales, go, logout, navigate, onAskOpen]);

  // ---- live search ---------------------------------------------------------
  useEffect(() => {
    if (!open) return;
    const q = debounced.trim();
    if (q.length < 2) { setResults([]); return; }
    let cancelled = false;
    searchApi.suggestions(q).then((r) => { if (!cancelled) setResults(r.suggestions || []); }).catch(() => { if (!cancelled) setResults([]); });
    return () => { cancelled = true; };
  }, [debounced, open]);

  const q = query.trim().toLowerCase();
  const filtered = q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands;
  const rows = useMemo(() => {
    const out = [];
    if (q.length >= 2) out.push({ id: 'search-all', label: `Search catalogue for “${query.trim()}”`, icon: Search, run: () => go(`/browse?q=${encodeURIComponent(query.trim())}`), group: 'Search' });
    for (const r of results) out.push({ id: `item-${r.slug}`, label: r.name, sub: r.file_type, icon: FILE_ICON, run: () => go(`/file/${r.slug}`), group: 'Catalogue' });
    for (const c of filtered) out.push({ ...c, group: 'Commands' });
    return out;
  }, [q, query, results, filtered, go]);

  useEffect(() => { setActive(0); }, [query, results.length]);
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const openPalette = useCallback((initial = '') => { setQuery(initial); setOpen(true); setHelp(false); setTimeout(() => inputRef.current?.focus(), 0); }, []);

  // ---- global shortcuts ----------------------------------------------------
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); open ? setOpen(false) : openPalette(); return; }
      if (open) {
        if (e.key === 'Escape') { e.preventDefault(); help ? setHelp(false) : setOpen(false); }
        return;
      }
      if (isTyping(e) || mod || e.altKey) return;
      if (e.key === '/') { e.preventDefault(); openPalette(); return; }
      if (e.key === '?') { e.preventDefault(); openPalette(); setHelp(true); return; }
      const now = Date.now();
      if (chord.current.key === 'g' && now - chord.current.at < 1200) {
        chord.current = { key: null, at: 0 };
        const map = { h: '/', b: '/browse', f: user ? '/account?tab=favorites' : '/login', a: isEditor ? (isAdmin ? '/admin' : '/admin/items') : null };
        const to = map[e.key.toLowerCase()];
        if (to) { e.preventDefault(); navigate(to); }
        return;
      }
      if (e.key.toLowerCase() === 'g') chord.current = { key: 'g', at: now };
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, help, openPalette, navigate, user, isAdmin, isEditor]);

  // Let other components (navbar search button) open it.
  useEffect(() => {
    const h = (e) => openPalette(e.detail?.query || '');
    window.addEventListener('espress0:palette', h);
    return () => window.removeEventListener('espress0:palette', h);
  }, [openPalette]);

  if (!open) return null;

  const onInputKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); rows[active]?.run(); }
  };

  let lastGroup = null;
  return (
    <div className="fixed inset-0 z-[110] flex items-start justify-center pt-[12vh] px-4 bg-black/60 backdrop-blur-sm animate-fade-in" onMouseDown={() => setOpen(false)} role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="glass-strong w-full max-w-xl rounded-2xl border border-white/10 shadow-2xl overflow-hidden animate-slide-up" onMouseDown={(e) => e.stopPropagation()}>
        {help ? (
          <div className="p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-textPrimary flex items-center gap-2"><Keyboard className="w-4 h-4 text-primary" /> Keyboard shortcuts</h3>
              <button onClick={() => setHelp(false)} className="p-1.5 rounded-lg hover:bg-surfaceHover text-textMuted"><X className="w-4 h-4" /></button>
            </div>
            <ul className="space-y-2 text-sm">
              {SHORTCUTS.map((s) => (
                <li key={s.label} className="flex items-center justify-between gap-4">
                  <span className="text-textSecondary">{s.label}</span>
                  <span className="flex gap-1">{s.keys.map((k) => <kbd key={k} className="px-1.5 py-0.5 rounded bg-surface border border-border text-[11px] font-mono text-textPrimary">{k}</kbd>)}</span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-textMuted mt-4">Shortcuts are ignored while you type in a field. Cmd+S saves in the item editor.</p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5">
              <Search className="w-4 h-4 text-textMuted flex-shrink-0" />
              <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onInputKey} placeholder="Search the catalogue or type a command…" className="flex-1 bg-transparent text-sm text-textPrimary placeholder:text-textMuted focus:outline-none" autoComplete="off" spellCheck={false} />
              <kbd className="hidden sm:inline px-1.5 py-0.5 rounded bg-surface border border-border text-[10px] font-mono text-textMuted">Esc</kbd>
            </div>
            <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-2" role="listbox">
              {rows.length === 0 && <p className="px-4 py-6 text-sm text-textMuted text-center">Nothing matches.</p>}
              {rows.map((row, i) => {
                const Icon = row.icon;
                const header = row.group !== lastGroup ? row.group : null;
                lastGroup = row.group;
                return (
                  <div key={row.id}>
                    {header && <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-textMuted">{header}</div>}
                    <button data-index={i} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => row.run()}
                      className={`w-full flex items-center gap-3 px-4 py-2 text-sm text-left ${i === active ? 'bg-primary/15 text-textPrimary' : 'text-textSecondary hover:bg-surfaceHover'}`}>
                      <Icon className="w-4 h-4 flex-shrink-0 text-textMuted" />
                      <span className="flex-1 truncate">{row.label}{row.sub && <span className="ml-2 text-[11px] text-textMuted uppercase">{row.sub}</span>}</span>
                      {row.hint && <kbd className="px-1.5 py-0.5 rounded bg-surface border border-border text-[10px] font-mono text-textMuted">{row.hint}</kbd>}
                      {i === active && <CornerDownLeft className="w-3.5 h-3.5 text-textMuted" />}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="px-4 py-2 border-t border-white/5 flex items-center gap-3 text-[11px] text-textMuted">
              <span className="flex items-center gap-1"><Command className="w-3 h-3" /> K to toggle</span>
              <span>↑↓ to move</span><span>↵ to open</span>
              <button onClick={() => setHelp(true)} className="ml-auto hover:text-textPrimary">? shortcuts</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
