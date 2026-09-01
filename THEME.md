# Theme — espress0's repo

## How theming works

Every colour the UI paints with is a CSS custom property on `<html>`. Tailwind
reads the same variables (`rgb(var(--c-primary) / <alpha-value>)`), so
`bg-primary/10`, `text-textMuted`, `border-border` and friends all follow the
active scheme. Switching a theme is one style write — no rebuild, no reload, no
per-component conditionals.

| Piece | File |
| --- | --- |
| Scheme registry (all palettes) | `frontend/src/themes/index.js` |
| Active scheme, `auto`, motion rules | `frontend/src/context/ThemeContext.jsx` |
| Picker (navbar dropdown + gallery) | `frontend/src/components/ThemePicker.jsx` |
| Variable defaults, glass, gradients | `frontend/src/index.css` |
| Tailwind → variable mapping | `frontend/tailwind.config.js` |
| Themed starfield | `frontend/src/components/StarryBackground.jsx` |
| Pre-mount flash guard | `frontend/index.html` |

**Precedence:** the visitor's choice (localStorage) → the admin's site default
(`theme_default` / `theme_light_default`) → built-in Midnight.
`auto` is not a palette, it is a rule: follow the OS light/dark preference and
use the admin's dark or light default accordingly.

### Adding a scheme

Append one entry to `THEMES` in `frontend/src/themes/index.js`:

```js
{
  id: 'my-scheme',
  label: 'My Scheme',
  description: 'One line shown in the picker.',
  mode: 'dark',                        // or 'light' — drives color-scheme + glass opacity
  colors: { background, surface, surfaceHover, border,
            textPrimary, textSecondary, textMuted,
            primary, primaryHover, secondary, accent },
  sky: { top: '#000000', bottom: '#142b44' },   // hero gradient, top -> bottom
  star: '#ffffff',
  starGlow: '#fff3c4',
  shootingStar: '#ffffff',
  shootingStarGlow: '#fff3c4',
  aurora: ['#…', '#…', '#…', '#…'],             // four background blobs
}
```

That is the whole job. The navbar picker, the account gallery and the admin
default-scheme dropdowns are generated from the registry.

Keep `primary` dark/saturated enough for white text — gradient buttons render
white labels on `primary → secondary`.

## Schemes

| id | Name | Mode | Character |
| --- | --- | --- | --- |
| `midnight` | Midnight | dark | House style: violet → blue on near-black (default) |
| `starrynight` | Starry Night | dark | Deep navy sky, cream starlight |
| `galaxy` | Galaxy | dark | Magenta nebula over deep space |
| `cotton-candy` | Cotton Candy | dark | Pink → blue dusk |
| `forest` | Forest | dark | Pine dark with mint starlight |
| `sunrise` | Sunrise | dark | Red → amber horizon |
| `amber` | Amber | dark | Golden stars, warm horizon |
| `sky` | Sky | light | Bright daytime blue |
| `daybreak` | Daybreak | light | House palette inverted for daylight |

The seven dark schemes other than Midnight, and the Sky light scheme, are
adapted from the **Spicetify StarryNight** theme
([spicetify/spicetify-themes](https://github.com/spicetify/spicetify-themes),
MIT, © 2019 morpheusthewhite). Its `color.ini` splits a scheme into a two-stop
"sky" plus star / star-glow / shooting-star colours; that structure is kept
here, which is what lets the starfield restyle itself per palette instead of
staying violet forever.

## Admin controls

Admin → Site Settings → **Theme & effects** (`group_name: 'theme'`):

| Setting | Meaning |
| --- | --- |
| `theme_default` | Scheme for visitors on a dark device (visual dropdown) |
| `theme_light_default` | Scheme for visitors on a light device |
| `theme_allow_user_choice` | Off = hide the navbar picker and force the defaults |
| `theme_starfield` | Twinkling stars on/off |
| `theme_shooting_stars` | Shooting stars on/off |
| `theme_aurora` | Aurora blobs on/off |
| `theme_star_density` | 0–300 %, for weak devices |

Visitors switch schemes from the palette icon in the navbar, or from the gallery
on `/account`. The choice is per browser (localStorage), never a server write.

## Accessibility & performance

- `prefers-reduced-motion: reduce` overrides every effect setting: stars are
  drawn once and left static, shooting stars and aurora animations are skipped,
  and a global CSS rule collapses transitions.
- `color-scheme` is set from the scheme's `mode`, so native scrollbars, form
  controls and `<select>` popups match.
- The canvas is drawn at `min(devicePixelRatio, 2)` and re-reads its colours
  from the CSS variables on a scheme change.
- `index.html` restores the last scheme's background before React mounts, so a
  reload on a light theme doesn't flash black.

## Brand defaults (Midnight)

**Brand identity:** dark futuristic UI with a violet → blue gradient.

1. **Purple — `#8b5cf6`** — logo, gradient start, active states, featured
   badges, primary buttons, focus rings. `primaryHover: #7c3aed`.
2. **Blue — `#3b82f6`** — gradient end, secondary actions, links.

```css
background: linear-gradient(135deg, rgb(var(--c-primary)) 0%, rgb(var(--c-secondary)) 100%);
```

```js
// the Midnight entry of THEMES
background: '#0a0a0f', surface: '#12121a', surfaceHover: '#1a1a26',
border: '#232334', textPrimary: '#f1f1f3', textSecondary: '#a1a1b5',
textMuted: '#6b6b80', primary: '#8b5cf6', primaryHover: '#7c3aed',
secondary: '#3b82f6', accent: '#a855f7',
```

### Usage guidelines

- **Glassmorphism:** use the `.glass` / `.glass-strong` classes — they derive
  from `--c-surface` and `--glass-alpha`, so they stay correct on light schemes.
- **Rounded:** cards `rounded-2xl`, buttons `rounded-xl` or `rounded-full`.
- **No hardcoded hex** in components. Use Tailwind tokens or `rgb(var(--c-…))`;
  the only exception is per-category colours, which admins choose in the DB.
- **No neon:** avoid heavy glow; subtle blur on hover.

### Logo

- Gradient follows `--c-primary → --c-secondary`, so it recolours per scheme.
- Stylised `e` with coffee bean / repo layers (3 stacked ellipses), SVG, offline.
- See `frontend/src/components/Logo.jsx`.

### AI — Barista

- **Name:** Barista
- **Purpose:** easily find files in espress0's repo
- **Icon:** Coffee (lucide-react, offline)
- **Colour:** gradient primary
