import { AlertTriangle } from 'lucide-react';
import { useSettings } from '../context/SettingsContext';

const DEFAULT_MESSAGE = 'We are performing maintenance. Downloads may be temporarily unavailable.';

/**
 * Site-wide maintenance notice driven by Admin -> Settings -> General.
 *
 * The settings already existed and were public, but nothing rendered them. Keep
 * this directly below the global navigation so every route—including admin,
 * authentication and error pages—shows the same operational notice.
 */
export default function MaintenanceBanner() {
  const { get, loading } = useSettings();
  const enabled = get('maintenance_mode', false) === true;

  // Do not flash a disabled fallback banner while public settings are loading.
  if (loading || !enabled) return null;

  const message = String(get('maintenance_message', DEFAULT_MESSAGE)).trim() || DEFAULT_MESSAGE;

  return (
    <div
      role="alert"
      aria-label="Maintenance notice"
      className="relative z-40 border-b border-amber-400/30 bg-amber-500/15 shadow-lg shadow-amber-950/10"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-start sm:items-center justify-center gap-3">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full border border-amber-400/30 bg-amber-400/10">
          <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden="true" />
        </span>
        <p className="text-sm leading-5 text-textSecondary">
          <span className="mr-2 font-semibold text-textPrimary">Maintenance notice</span>
          {message}
        </p>
      </div>
    </div>
  );
}
