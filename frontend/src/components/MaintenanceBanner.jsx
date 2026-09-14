import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useSettings } from '../context/SettingsContext';
import { operationsApi } from '../lib/api';

const DEFAULT_MESSAGE = 'We are performing maintenance. Downloads may be temporarily unavailable.';

/**
 * Site-wide maintenance notice driven by Admin -> Settings -> General, plus a
 * short server-calculated warning before the deployed reboot timer fires. The
 * latter deliberately exposes no full schedule to anonymous visitors.
 */
export default function MaintenanceBanner() {
  const { get, loading } = useSettings();
  const [scheduledNotice, setScheduledNotice] = useState(null);
  const manuallyEnabled = get('maintenance_mode', false) === true;

  useEffect(() => {
    let alive = true;
    const load = () => operationsApi.notice()
      .then(notice => { if (alive) setScheduledNotice(notice?.active ? notice : null); })
      .catch(() => { if (alive) setScheduledNotice(null); });
    load();
    const interval = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(interval); };
  }, []);

  // Do not flash a disabled fallback banner while public settings are loading.
  if (loading || (!manuallyEnabled && !scheduledNotice)) return null;

  const manualMessage = String(get('maintenance_message', DEFAULT_MESSAGE)).trim() || DEFAULT_MESSAGE;
  const notices = [
    ...(manuallyEnabled ? [{ key: 'manual', title: 'Maintenance notice', message: manualMessage }] : []),
    ...(scheduledNotice ? [{ key: 'scheduled', title: 'Scheduled restart', message: scheduledNotice.message }] : []),
  ];

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
        <div className="text-sm leading-5 text-textSecondary space-y-1">
          {notices.map(notice => (
            <p key={notice.key}>
              <span className="mr-2 font-semibold text-textPrimary">{notice.title}</span>
              {notice.message}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
