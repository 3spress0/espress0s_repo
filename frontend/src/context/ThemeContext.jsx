import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useSettings } from './SettingsContext';
import {
  THEMES, DEFAULT_THEME_ID, DEFAULT_LIGHT_THEME_ID, applyTheme, getTheme, hexToTriplet,
} from '../themes';

/**
 * Active colour scheme.
 *
 * Precedence, highest first:
 *   1. the visitor's own choice (localStorage) — only when the admin allows it
 *   2. the admin's site default (`theme_default` / `theme_light_default`)
 *   3. the built-in Midnight scheme
 *
 * "auto" is not a scheme, it is a rule: follow the OS light/dark preference and
 * use the admin's dark or light default accordingly. That keeps one switch
 * meaningful across nine palettes.
 *
 * Motion is treated as part of the theme: `prefers-reduced-motion` always wins
 * over the starfield/aurora settings, because an animated background is exactly
 * what that media query exists to turn off.
 */

const STORAGE_KEY = 'espress0_theme';
const ThemeContext = createContext(null);

function systemPrefersDark() {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return !window.matchMedia('(prefers-color-scheme: light)').matches;
}

function prefersReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null; // private mode / storage disabled
  }
}

export function ThemeProvider({ children }) {
  const { get, loading: settingsLoading } = useSettings();

  const siteDark = get('theme_default', DEFAULT_THEME_ID);
  const siteLight = get('theme_light_default', DEFAULT_LIGHT_THEME_ID);
  const allowUserChoice = get('theme_allow_user_choice', true) !== false;

  // 'auto' | <theme id>
  const [choice, setChoice] = useState(() => readStored() || 'auto');
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);

  // Follow the OS while the choice is 'auto'.
  useEffect(() => {
    if (!window.matchMedia) return;
    const scheme = window.matchMedia('(prefers-color-scheme: light)');
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onScheme = () => setSystemDark(!scheme.matches);
    const onMotion = () => setReducedMotion(motion.matches);
    scheme.addEventListener?.('change', onScheme);
    motion.addEventListener?.('change', onMotion);
    return () => {
      scheme.removeEventListener?.('change', onScheme);
      motion.removeEventListener?.('change', onMotion);
    };
  }, []);

  const effectiveId = useMemo(() => {
    const auto = systemDark ? siteDark : siteLight;
    if (!allowUserChoice) return auto;
    if (!choice || choice === 'auto') return auto;
    return choice;
  }, [choice, allowUserChoice, systemDark, siteDark, siteLight]);

  const theme = useMemo(() => getTheme(effectiveId), [effectiveId]);

  // Paint. Runs before first content paint in practice because App renders the
  // provider at the root; the pre-hydration fallback lives in index.html.
  useEffect(() => {
    applyTheme(theme);
    // Remember just enough for index.html to paint the right background on the
    // next load, before any JS bundle has parsed.
    try {
      localStorage.setItem('espress0_theme_boot', JSON.stringify({
        id: theme.id,
        mode: theme.mode,
        background: hexToTriplet(theme.colors.background),
        textPrimary: hexToTriplet(theme.colors.textPrimary),
      }));
    } catch { /* storage disabled */ }
  }, [theme]);

  const setTheme = useCallback((id) => {
    setChoice(id);
    try {
      if (!id || id === 'auto') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, id);
    } catch { /* storage disabled — the choice still applies for this session */ }
  }, []);

  const value = useMemo(() => ({
    /** The scheme currently painted. */
    theme,
    themeId: theme.id,
    /** What the user picked: 'auto' or a scheme id. */
    choice: allowUserChoice ? choice : 'auto',
    setTheme,
    themes: THEMES,
    allowUserChoice,
    siteDefaults: { dark: siteDark, light: siteLight },
    /** Animation switches, already reconciled with prefers-reduced-motion. */
    effects: {
      reducedMotion,
      starfield: reducedMotion ? false : get('theme_starfield', true) !== false,
      shootingStars: reducedMotion ? false : get('theme_shooting_stars', true) !== false,
      aurora: reducedMotion ? false : get('theme_aurora', true) !== false,
      starDensity: Math.min(300, Math.max(0, Number(get('theme_star_density', 100)) || 100)) / 100,
    },
    settingsLoading,
  }), [theme, choice, allowUserChoice, setTheme, siteDark, siteLight, reducedMotion, get, settingsLoading]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
