import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import en from './locales/en.json';
import nl from './locales/nl.json';
import { LOCALES, DEFAULT_LOCALE, STORAGE_KEY, detectLocale, translate, registerLocale } from './translate.js';

// Bundled languages. Add a JSON file in ./locales and register it here.
registerLocale(en);
registerLocale(nl);

export { LOCALES, DEFAULT_LOCALE, STORAGE_KEY, detectLocale, translate };

/**
 * i18n scaffolding. Deliberately dependency-free (the frontend has seven
 * runtime deps and we would rather keep it that way): a context, JSON locale
 * files, `t('a.b.c', { vars })` with {{placeholders}} and a `_plural` suffix
 * for count === 1 vs other, and locale-aware date/number helpers built on Intl.
 *
 * `en` is the source of truth. Missing keys fall back to English, then to the
 * key itself, so a half-translated locale never blanks the UI. Add a language
 * by dropping a JSON file in ./locales and registering it in LOCALES.
 *
 * Resolution order for the active locale:
 *   1. the user's explicit choice (localStorage `espress0_locale`)
 *   2. the browser's languages, first one we have
 *   3. English
 */
const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [choice, setChoice] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) || null; } catch { return null; }
  });
  const locale = choice && LOCALES[choice] ? choice : detectLocale();

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = LOCALES[locale]?._meta?.dir || 'ltr';
  }, [locale]);

  const setLocale = useCallback((next) => {
    // null/'auto' clears the override and follows the browser again.
    const value = next && LOCALES[next] ? next : null;
    setChoice(value);
    try { value ? localStorage.setItem(STORAGE_KEY, value) : localStorage.removeItem(STORAGE_KEY); } catch { /* private mode */ }
  }, []);

  const value = useMemo(() => ({
    locale,
    choice, // null when following the browser
    setLocale,
    locales: Object.values(LOCALES).map((l) => l._meta),
    t: (key, vars) => translate(locale, key, vars),
    formatDate: (d, opts = { year: 'numeric', month: 'short', day: 'numeric' }) => (d ? new Intl.DateTimeFormat(locale, opts).format(new Date(d)) : ''),
    formatNumber: (n, opts) => new Intl.NumberFormat(locale, opts).format(n ?? 0),
    formatRelative: (d) => {
      if (!d) return '';
      const diff = (new Date(d).getTime() - Date.now()) / 1000;
      const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
      const steps = [[60, 'second'], [3600, 'minute'], [86400, 'hour'], [604800, 'day'], [2629800, 'week'], [31557600, 'month'], [Infinity, 'year']];
      let unit = 'second'; let div = 1;
      for (const [limit, u] of steps) { unit = u; if (Math.abs(diff) < limit) break; div = limit; }
      return rtf.format(Math.round(diff / div), unit);
    },
  }), [locale, choice, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}

/** Shorthand: `const t = useT();` */
export const useT = () => useI18n().t;
