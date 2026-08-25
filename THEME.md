# Theme — espress0's repo

## Primary Colors for Theming

**Brand Identity:** Dark futuristic UI with smooth purple → blue gradient

### 2 Primary Colors

1. **Purple — `#8b5cf6`** (Violet 500)
   - Primary brand color
   - Used for: logo, gradient start, active states, featured badges, primary buttons, highlights, focus rings
   - Tailwind: `primary: #8b5cf6`, `primaryHover: #7c3aed`, `accent: #a855f7`
   - RGB: `139, 92, 246`

2. **Blue — `#3b82f6`** (Blue 500)
   - Secondary brand color, gradient end
   - Used for: gradient end, secondary actions, secondary icons, links, popular badge
   - Tailwind: `secondary: #3b82f6`
   - RGB: `59, 130, 246`

### Gradient

```css
/* Primary gradient — used consistently */
background: linear-gradient(135deg, #8b5cf6 0%, #3b82f6 100%);
/* Hover */
background: linear-gradient(135deg, #7c3aed 0%, #2563eb 100%);
/* Subtle background */
background: linear-gradient(135deg, rgba(139, 92, 246, 0.15) 0%, rgba(59, 130, 246, 0.15) 100%);
/* Text */
background: linear-gradient(135deg, #8b5cf6 0%, #3b82f6 100%);
-webkit-background-clip: text;
```

### Full Palette

```js
// tailwind.config.js
colors: {
  background: '#0a0a0f',      // Dark bg
  surface: '#12121a',         // Cards
  surfaceHover: '#1a1a26',    // Hover
  border: '#232334',          // Borders
  textPrimary: '#f1f1f3',     // Main text
  textSecondary: '#a1a1b5',   // Secondary
  textMuted: '#6b6b80',       // Muted
  primary: '#8b5cf6',         // Purple primary
  primaryHover: '#7c3aed',    // Purple hover
  secondary: '#3b82f6',       // Blue secondary
  accent: '#a855f7',          // Accent purple
}
```

### Usage Guidelines

- **Dark background:** `#0a0a0f` everywhere, not pure black
- **Glassmorphism:** `background: rgba(18,18,26,0.8); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.05)`
- **Rounded:** Cards `rounded-2xl`, buttons `rounded-xl` or `rounded-full`
- **Shadows:** `shadow-lg shadow-purple-500/20` for gradient buttons
- **No neon:** Avoid excessive glow, use subtle `opacity-20` blur for hover
- **Consistency:** Gradient for branding, highlights, active states, buttons, important UI

### Logo

- Uses same gradient `#8b5cf6 → #3b82f6`
- Stylized `e` with coffee bean / repo layers (3 stacked ellipses)
- SVG offline, no external deps
- See `frontend/src/components/Logo.jsx`

### Starry Background (Homepage)

- Canvas stars with twinkle + shooting stars
- Northern lights: 4 radial gradients (purple, blue, green, pink) with blur 60-90px, animated 20-30s
- See `frontend/src/components/StarryBackground.jsx`

### AI — Barista

- **Name:** Barista
- **Purpose:** Easily find files in espress0's repo
- **Icon:** Coffee icon (lucide-react, offline)
- **Color:** Gradient primary
- **Description:** "Your personal file finder barista — like a coffee barista, but for ISOs, tools, and docs"
