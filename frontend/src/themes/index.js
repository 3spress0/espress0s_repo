/**
 * Colour schemes.
 *
 * Every colour the UI paints with comes from a CSS custom property on <html>,
 * so a scheme swap is one style write — no rebuild, no page reload, no
 * per-component conditionals. Tailwind reads the same variables (see
 * tailwind.config.js), which is why `bg-primary/10` still works.
 *
 * Colour values are stored as "R G B" triplets because Tailwind's
 * `rgb(var(--c-primary) / <alpha-value>)` needs the channels unwrapped.
 *
 * Several palettes are adapted from the Spicetify **StarryNight** theme
 * (https://github.com/spicetify/spicetify-themes, MIT, © 2019 morpheusthewhite).
 * Its colour.ini splits a scheme into "sky" (a two-stop vertical gradient),
 * star, star glow and shooting-star colours — that idea is kept here, which is
 * what lets the starfield restyle itself per scheme.
 *
 * Adding a scheme: append an entry below. Nothing else needs to change; the
 * navbar picker, the account page and the admin settings dropdown are all
 * generated from THEMES.
 */

/** #rrggbb -> "r g b" */
export function hexToTriplet(hex) {
  const clean = String(hex).replace('#', '').trim();
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  const n = parseInt(full, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

export const THEMES = [
  {
    id: 'midnight',
    label: 'Midnight',
    description: 'The house style — violet to blue on near-black.',
    mode: 'dark',
    colors: {
      background: '#0a0a0f',
      surface: '#12121a',
      surfaceHover: '#1a1a26',
      border: '#232334',
      textPrimary: '#f1f1f3',
      textSecondary: '#a1a1b5',
      textMuted: '#6b6b80',
      primary: '#8b5cf6',
      primaryHover: '#7c3aed',
      secondary: '#3b82f6',
      accent: '#a855f7',
    },
    sky: { top: '#05050a', bottom: '#151533' },
    star: '#ffffff',
    starGlow: '#8b5cf6',
    shootingStar: '#ffffff',
    shootingStarGlow: '#c4b5fd',
    aurora: ['#8b5cf6', '#3b82f6', '#10b981', '#a855f7'],
  },
  {
    id: 'starrynight',
    label: 'Starry Night',
    description: 'Deep navy sky with cream starlight. After StarryNight (Base).',
    mode: 'dark',
    colors: {
      background: '#0b1524',
      surface: '#152238',
      surfaceHover: '#1c2c47',
      border: '#24344f',
      textPrimary: '#ffffff',
      textSecondary: '#adb5bd',
      textMuted: '#71809a',
      primary: '#4687d6',
      primaryHover: '#3a72b8',
      secondary: '#7f9fd6',
      accent: '#fff3c4',
    },
    sky: { top: '#000000', bottom: '#142b44' },
    star: '#ffffff',
    starGlow: '#fff3c4',
    shootingStar: '#ffffff',
    shootingStarGlow: '#fff3c4',
    aurora: ['#4687d6', '#152238', '#7f9fd6', '#fff3c4'],
  },
  {
    id: 'galaxy',
    label: 'Galaxy',
    description: 'Magenta nebula over deep space. After StarryNight (Galaxy).',
    mode: 'dark',
    colors: {
      background: '#0b0424',
      surface: '#1a0b3b',
      surfaceHover: '#241056',
      border: '#35186b',
      textPrimary: '#ffe4f2',
      textSecondary: '#c7b3e8',
      textMuted: '#8f7ab8',
      primary: '#b133c9',
      primaryHover: '#9526ab',
      secondary: '#6a5cff',
      accent: '#ff8ad8',
    },
    sky: { top: '#00076f', bottom: '#b133c9' },
    star: '#ffffff',
    starGlow: '#ffe4f2',
    shootingStar: '#ffe4f2',
    shootingStarGlow: '#ff8ad8',
    aurora: ['#b133c9', '#00076f', '#6a5cff', '#ff8ad8'],
  },
  {
    id: 'cotton-candy',
    label: 'Cotton Candy',
    description: 'Pink to blue dusk. After StarryNight (Cotton-candy).',
    mode: 'dark',
    colors: {
      background: '#1a1024',
      surface: '#2a1838',
      surfaceHover: '#38204a',
      border: '#472a5c',
      textPrimary: '#fff4f8',
      textSecondary: '#e3b9d6',
      textMuted: '#a888b8',
      primary: '#c2418a',
      primaryHover: '#a83375',
      secondary: '#509be1',
      accent: '#ffa0ad',
    },
    sky: { top: '#ff71b2', bottom: '#509be1' },
    star: '#ffffff',
    starGlow: '#ffd3e6',
    shootingStar: '#ffffff',
    shootingStarGlow: '#d3e9ff',
    aurora: ['#ff71b2', '#509be1', '#9f45b0', '#ffa0ad'],
  },
  {
    id: 'forest',
    label: 'Forest',
    description: 'Pine dark with mint starlight. After StarryNight (Forest).',
    mode: 'dark',
    colors: {
      background: '#05120a',
      surface: '#0d1f14',
      surfaceHover: '#132c1d',
      border: '#1b3a26',
      textPrimary: '#eefaf1',
      textSecondary: '#a7c6b1',
      textMuted: '#6d8a77',
      primary: '#2f9e63',
      primaryHover: '#268352',
      secondary: '#6f6bc7',
      accent: '#dbf9f4',
    },
    sky: { top: '#000000', bottom: '#14442b' },
    star: '#ffffff',
    starGlow: '#dbf9f4',
    shootingStar: '#ffffff',
    shootingStarGlow: '#c4c6ff',
    aurora: ['#14442b', '#2f9e63', '#6f6bc7', '#dbf9f4'],
  },
  {
    id: 'sunrise',
    label: 'Sunrise',
    description: 'Red to amber horizon. After StarryNight (Sunrise).',
    mode: 'dark',
    colors: {
      background: '#170b0c',
      surface: '#261315',
      surfaceHover: '#341b1d',
      border: '#4a2426',
      textPrimary: '#fff3ea',
      textSecondary: '#e0b9ae',
      textMuted: '#a8837a',
      primary: '#e0403f',
      primaryHover: '#c22f2f',
      secondary: '#e08b2a',
      accent: '#ffca6b',
    },
    sky: { top: '#ffae41', bottom: '#f83d41' },
    star: '#fff6e5',
    starGlow: '#ffe9b0',
    shootingStar: '#ffffff',
    shootingStarGlow: '#ffca6b',
    aurora: ['#f83d41', '#ffae41', '#c49c48', '#ff7a59'],
  },
  {
    id: 'amber',
    label: 'Amber',
    description: 'Golden stars over a warm horizon. After StarryNight (Orange).',
    mode: 'dark',
    colors: {
      background: '#120c05',
      surface: '#20160a',
      surfaceHover: '#2d1f0f',
      border: '#3f2a10',
      textPrimary: '#fdf6e3',
      textSecondary: '#d9c39a',
      textMuted: '#9c8760',
      primary: '#d97f26',
      primaryHover: '#b96a1d',
      secondary: '#c9a227',
      accent: '#ffe234',
    },
    sky: { top: '#000000', bottom: '#e69138' },
    star: '#ffe234',
    starGlow: '#fff3ad',
    shootingStar: '#fff099',
    shootingStarGlow: '#fffcea',
    aurora: ['#e69138', '#ffe234', '#c37728', '#f9f7db'],
  },
  {
    id: 'sky',
    label: 'Sky',
    description: 'Bright daytime blue. Light scheme, after StarryNight (Sky).',
    mode: 'light',
    colors: {
      background: '#eef6ff',
      surface: '#ffffff',
      surfaceHover: '#e3eeff',
      border: '#c9dcf5',
      textPrimary: '#040a18',
      textSecondary: '#324a70',
      textMuted: '#6b83a6',
      primary: '#1e48a9',
      primaryHover: '#173a8c',
      secondary: '#2f8fd0',
      accent: '#6b94f5',
    },
    sky: { top: '#1e48a9', bottom: '#62cff4' },
    star: '#ffffff',
    starGlow: '#d3e9ff',
    shootingStar: '#ffffff',
    shootingStarGlow: '#ffffff',
    aurora: ['#62cff4', '#6b94f5', '#1e48a9', '#95b3f8'],
  },
  {
    id: 'daybreak',
    label: 'Daybreak',
    description: 'The house palette, inverted for daylight. Light scheme.',
    mode: 'light',
    colors: {
      background: '#f7f7fb',
      surface: '#ffffff',
      surfaceHover: '#eef0f8',
      border: '#dfe1ee',
      textPrimary: '#14141c',
      textSecondary: '#4a4a63',
      textMuted: '#7a7a92',
      primary: '#6d28d9',
      primaryHover: '#5b21b6',
      secondary: '#2563eb',
      accent: '#7c3aed',
    },
    sky: { top: '#7aa7ff', bottom: '#dbe7ff' },
    star: '#ffffff',
    starGlow: '#c4b5fd',
    shootingStar: '#ffffff',
    shootingStarGlow: '#a5b4fc',
    aurora: ['#a78bfa', '#93c5fd', '#6ee7b7', '#f0abfc'],
  },
];

export const DEFAULT_THEME_ID = 'midnight';
export const DEFAULT_LIGHT_THEME_ID = 'daybreak';

export function getTheme(id) {
  return THEMES.find(t => t.id === id) || THEMES.find(t => t.id === DEFAULT_THEME_ID);
}

export const DARK_THEMES = THEMES.filter(t => t.mode === 'dark');
export const LIGHT_THEMES = THEMES.filter(t => t.mode === 'light');

/**
 * Write a scheme onto an element (normally <html>) as CSS variables.
 * Returns the theme that was applied.
 */
export function applyTheme(theme, el = document.documentElement) {
  const t = typeof theme === 'string' ? getTheme(theme) : theme;
  if (!t || !el) return null;

  const set = (name, hex) => el.style.setProperty(name, hexToTriplet(hex));

  for (const [key, hex] of Object.entries(t.colors)) {
    // camelCase -> kebab-case: surfaceHover -> --c-surface-hover
    const varName = `--c-${key.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}`;
    set(varName, hex);
  }

  set('--sky-top', t.sky.top);
  set('--sky-bottom', t.sky.bottom);
  set('--c-star', t.star);
  set('--c-star-glow', t.starGlow);
  set('--c-shooting-star', t.shootingStar);
  set('--c-shooting-star-glow', t.shootingStarGlow);
  t.aurora.forEach((hex, i) => set(`--aurora-${i + 1}`, hex));

  // Glass panels need more opacity on light schemes or they wash out.
  el.style.setProperty('--glass-alpha', t.mode === 'light' ? '0.85' : '0.72');
  el.style.setProperty('--glass-strong-alpha', t.mode === 'light' ? '0.94' : '0.88');
  el.style.setProperty('--hairline', t.mode === 'light' ? '0 0 0' : '255 255 255');
  el.style.setProperty('--hairline-alpha', t.mode === 'light' ? '0.08' : '0.06');

  el.dataset.theme = t.id;
  el.dataset.themeMode = t.mode;
  // Native form controls, scrollbars and <select> popups follow this.
  el.style.colorScheme = t.mode;

  return t;
}
