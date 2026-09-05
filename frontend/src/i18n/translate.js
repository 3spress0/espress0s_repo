/**
 * Pure part of the i18n layer: the locale registry, detection and
 * `translate`. No React and no JSON imports here (ESLint's parser does not
 * know import attributes yet), so it can be unit-tested with node --test.
 * index.jsx registers the bundled locale files at startup.
 */
export const LOCALES = {};

/** Register a locale table; `_meta.code` is the key. */
export function registerLocale(table) {
  const code = table?._meta?.code;
  if (!code) throw new Error('locale table needs _meta.code');
  LOCALES[code] = table;
  return code;
}
export const DEFAULT_LOCALE = 'en';
export const STORAGE_KEY = 'espress0_locale';

export function detectLocale() {
  if (typeof navigator === 'undefined') return DEFAULT_LOCALE;
  for (const tag of navigator.languages || [navigator.language]) {
    const base = String(tag || '').toLowerCase().split('-')[0];
    if (LOCALES[base]) return base;
  }
  return DEFAULT_LOCALE;
}

function lookup(table, path) {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), table);
}

function interpolate(str, vars) {
  if (!vars) return str;
  return str.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
}

/** Pure translate function for use outside React (tests, utils). */
export function translate(locale, key, vars) {
  const tables = [LOCALES[locale], LOCALES[DEFAULT_LOCALE]];
  const plural = vars && typeof vars.count === 'number' && vars.count !== 1;
  for (const table of tables) {
    if (!table) continue;
    const hit = (plural && lookup(table, `${key}_plural`)) || lookup(table, key);
    if (typeof hit === 'string') return interpolate(hit, vars);
  }
  return key;
}

