import { useEffect, useRef, useState } from 'react';
import { Palette, Check, Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

/** A scheme's sky gradient plus its three key colours, at ~40px. */
export function ThemeSwatch({ theme, size = 40 }) {
  return (
    <span
      className="relative inline-flex items-end justify-center rounded-lg overflow-hidden border border-white/10 flex-shrink-0"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(180deg, ${theme.sky.top} 0%, ${theme.sky.bottom} 100%)`,
      }}
      aria-hidden="true"
    >
      {/* two "stars" so the sky reads as a sky */}
      <span className="absolute rounded-full" style={{ width: 2, height: 2, top: '25%', left: '30%', background: theme.star }} />
      <span className="absolute rounded-full" style={{ width: 3, height: 3, top: '45%', left: '65%', background: theme.star, boxShadow: `0 0 4px ${theme.starGlow}` }} />
      <span className="flex gap-0.5 mb-1">
        {[theme.colors.primary, theme.colors.secondary, theme.colors.accent].map((c, i) => (
          <span key={i} className="rounded-full" style={{ width: 6, height: 6, background: c }} />
        ))}
      </span>
    </span>
  );
}

const MODE_ICON = { dark: Moon, light: Sun };

/**
 * Scheme picker.
 *
 * `variant="menu"` is the navbar dropdown; `variant="grid"` is the larger
 * gallery used on the account page and in admin settings. Both are generated
 * from the THEMES registry, so a new palette needs no UI work.
 */
export default function ThemePicker({ variant = 'menu', value, onChange, includeAuto = true }) {
  const { themes, choice, setTheme, themeId, allowUserChoice } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Controlled (admin settings) or self-driving (navbar / account).
  const selected = value !== undefined ? value : choice;
  const apply = (id) => (onChange ? onChange(id) : setTheme(id));

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (variant === 'menu' && !allowUserChoice && !onChange) return null;

  const options = [
    ...(includeAuto ? [{ id: 'auto', label: 'Match system', description: 'Follow the light/dark setting of your device.', auto: true }] : []),
    ...themes,
  ];

  if (variant === 'grid') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {options.map(opt => {
          const active = selected === opt.id;
          const Icon = opt.auto ? Monitor : MODE_ICON[opt.mode];
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => apply(opt.id)}
              className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                active ? 'border-primary/60 bg-primary/10' : 'border-border bg-background hover:border-primary/30'
              }`}
            >
              {opt.auto ? (
                <span className="w-10 h-10 rounded-lg border border-border bg-surface flex items-center justify-center flex-shrink-0">
                  <Monitor className="w-4 h-4 text-textSecondary" />
                </span>
              ) : (
                <ThemeSwatch theme={opt} />
              )}
              <span className="min-w-0">
                <span className="text-sm font-medium text-textPrimary flex items-center gap-1.5">
                  {opt.label}
                  {Icon && <Icon className="w-3 h-3 text-textMuted" />}
                  {active && <Check className="w-3.5 h-3.5 text-primary" />}
                </span>
                <span className="block text-[11px] text-textMuted leading-snug mt-0.5">{opt.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  const current = themes.find(t => t.id === themeId);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title={`Theme: ${current?.label || 'default'}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Change colour theme"
        className="p-2 rounded-xl text-textMuted hover:text-primary hover:bg-surfaceHover transition-colors flex items-center gap-1.5"
      >
        <Palette className="w-[18px] h-[18px]" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-72 max-h-[70vh] overflow-y-auto glass-strong rounded-2xl border border-white/10 p-2 shadow-2xl z-50"
        >
          <p className="px-2 py-1.5 text-[10px] uppercase tracking-widest text-textMuted">Theme</p>
          {options.map(opt => {
            const active = selected === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => { apply(opt.id); setOpen(false); }}
                className={`w-full flex items-center gap-3 px-2 py-2 rounded-xl text-left transition-colors ${
                  active ? 'bg-primary/15' : 'hover:bg-surfaceHover'
                }`}
              >
                {opt.auto ? (
                  <span className="w-8 h-8 rounded-lg border border-border bg-surface flex items-center justify-center flex-shrink-0">
                    <Monitor className="w-3.5 h-3.5 text-textSecondary" />
                  </span>
                ) : (
                  <ThemeSwatch theme={opt} size={32} />
                )}
                <span className="min-w-0 flex-1">
                  <span className="text-sm text-textPrimary flex items-center gap-1.5">
                    {opt.label}
                    {!opt.auto && opt.mode === 'light' && <Sun className="w-3 h-3 text-textMuted" />}
                  </span>
                  <span className="block text-[11px] text-textMuted truncate">{opt.description}</span>
                </span>
                {active && <Check className="w-4 h-4 text-primary flex-shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
