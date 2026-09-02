/** @type {import('tailwindcss').Config} */

// Colours resolve to CSS variables written by ThemeProvider (src/themes),
// so `bg-surface`, `text-primary`, `border-border/50` etc. all follow the
// active scheme without a rebuild. The `<alpha-value>` placeholder is what
// keeps opacity modifiers (`bg-primary/10`) working.
const withAlpha = (variable) => `rgb(var(${variable}) / <alpha-value>)`;

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: withAlpha('--c-background'),
        surface: withAlpha('--c-surface'),
        surfaceHover: withAlpha('--c-surface-hover'),
        border: withAlpha('--c-border'),
        textPrimary: withAlpha('--c-text-primary'),
        textSecondary: withAlpha('--c-text-secondary'),
        textMuted: withAlpha('--c-text-muted'),
        primary: withAlpha('--c-primary'),
        primaryHover: withAlpha('--c-primary-hover'),
        secondary: withAlpha('--c-secondary'),
        accent: withAlpha('--c-accent'),
        // Starfield colours, so components can use them as utilities too.
        star: withAlpha('--c-star'),
        starGlow: withAlpha('--c-star-glow'),
        skyTop: withAlpha('--sky-top'),
        skyBottom: withAlpha('--sky-bottom'),
      },
      backgroundImage: {
        'gradient-primary': 'linear-gradient(135deg, rgb(var(--c-primary)) 0%, rgb(var(--c-secondary)) 100%)',
        'gradient-primary-hover': 'linear-gradient(135deg, rgb(var(--c-primary-hover)) 0%, rgb(var(--c-secondary)) 100%)',
        'gradient-subtle': 'linear-gradient(135deg, rgb(var(--c-primary) / 0.15) 0%, rgb(var(--c-secondary) / 0.15) 100%)',
        'gradient-mesh': [
          'radial-gradient(at 40% 20%, rgb(var(--c-primary) / 0.15) 0px, transparent 50%)',
          'radial-gradient(at 80% 0%, rgb(var(--c-secondary) / 0.15) 0px, transparent 50%)',
          'radial-gradient(at 0% 50%, rgb(var(--c-accent) / 0.10) 0px, transparent 50%)',
        ].join(', '),
        'gradient-sky': 'linear-gradient(180deg, rgb(var(--sky-top)) 0%, rgb(var(--sky-bottom)) 100%)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-out',
        'slide-up': 'slideUp 0.5s ease-out',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        }
      }
    },
  },
  plugins: [],
}
