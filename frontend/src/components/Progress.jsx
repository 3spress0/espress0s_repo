import { LoadingDots } from './Loading';

/**
 * Progress indicator for long-running admin work (bulk edits, health checks,
 * imports, dashboard loads).
 *
 * Two shapes on purpose: when the caller knows how far along it is, pass
 * `value` (0-100) and get a determinate bar; when it only knows that something
 * is still running, omit it and get the site's standard loading dots plus a
 * pulsing track. Both use the same `loading_dots_white.gif` as everywhere else
 * so the app has one loading language.
 */
export default function Progress({ value = null, label = 'Working…', sublabel = null, tone = 'primary' }) {
  const determinate = typeof value === 'number' && Number.isFinite(value);
  const pct = determinate ? Math.min(Math.max(value, 0), 100) : null;

  const barTone = tone === 'danger'
    ? 'bg-red-500/70'
    : tone === 'success'
      ? 'bg-green-500/70'
      : 'bg-gradient-primary';

  return (
    <div className="w-full" role="status" aria-live="polite">
      <div className="flex items-center gap-2 mb-1.5">
        {!determinate && <LoadingDots size={16} />}
        <span className="text-xs text-textSecondary">{label}</span>
        {determinate && <span className="text-xs text-textMuted ml-auto tabular-nums">{Math.round(pct)}%</span>}
        {sublabel && (
          <span className={`text-[11px] text-textMuted ${determinate ? '' : 'ml-auto'}`}>{sublabel}</span>
        )}
      </div>
      <div className="h-1.5 w-full rounded-full bg-surface border border-border overflow-hidden">
        {determinate ? (
          <div className={`h-full ${barTone} transition-all duration-300`} style={{ width: `${pct}%` }} />
        ) : (
          <div className={`h-full w-1/3 ${barTone} animate-progress-indeterminate`} />
        )}
      </div>
      <style>{`
        @keyframes progress-indeterminate {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(320%); }
        }
        .animate-progress-indeterminate { animation: progress-indeterminate 1.2s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .animate-progress-indeterminate { animation: none; width: 100%; opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}
