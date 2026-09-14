import { useCallback, useEffect, useState } from 'react';
import {
  Activity, AlertTriangle, Check, Clock, Copy, History, RefreshCw, Server, Terminal,
} from 'lucide-react';
import { operationsApi } from '../../lib/api';
import Loading from '../../components/Loading';

function dateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function duration(total) {
  if (!Number.isFinite(total)) return '—';
  const seconds = Math.max(0, Math.floor(total));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

const AUTO_UPDATE_TONE = {
  updated: 'text-green-400', idle: 'text-blue-400', checking: 'text-blue-400',
  updating: 'text-amber-400', deferred: 'text-amber-400', paused: 'text-amber-400',
  skipped: 'text-amber-400', error: 'text-red-400', failed: 'text-red-400',
};

function StatusPill({ good, children }) {
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${good
      ? 'bg-green-500/10 border border-green-500/30 text-green-400'
      : 'bg-amber-500/10 border border-amber-500/30 text-amber-400'}`}
    >
      {children}
    </span>
  );
}

function HostCommand({ children }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* the command remains selectable when clipboard access is blocked */ }
  };
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-background p-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-textSecondary">{children}</code>
      <button type="button" onClick={copy} className="shrink-0 rounded p-1.5 text-textMuted hover:bg-surfaceHover hover:text-primary" title="Copy command">
        {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

/**
 * Admin-only, read-only host operations view. Host controls stay on the shell:
 * exposing a reboot/disable endpoint through the website would turn an admin
 * browser session into a path to privileged systemctl access.
 */
export default function Operations() {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setInfo(await operationsApi.status());
      setError('');
    } catch (e) {
      setError(e.response?.data?.error || 'Could not load host operations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading && !info) return <Loading fullScreen text="Loading host operations…" />;
  if (!info) {
    return (
      <div className="glass rounded-2xl border border-red-500/20 bg-red-500/5 p-6 text-center">
        <AlertTriangle className="mx-auto mb-2 h-8 w-8 text-red-400" />
        <p className="text-sm text-red-400">{error || 'Could not load host operations.'}</p>
        <button type="button" onClick={load} className="mt-3 rounded-xl border border-border bg-surface px-4 py-2 text-sm hover:border-primary/30">Retry</button>
      </div>
    );
  }

  const reboot = info.reboot || {};
  const window = reboot.window || {};
  const runtime = reboot.runtime;
  const health = info.health || {};
  const auto = info.autoUpdate;
  const enabled = reboot.enabled === true;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-xl font-bold text-textPrimary">
            <Activity className="h-5 w-5 text-primary" /> Operations & maintenance
          </h2>
          <p className="mt-1 text-sm text-textMuted">
            Read-only host status, scheduled maintenance and recovery evidence. Refreshed every 30 seconds.
          </p>
        </div>
        <button type="button" onClick={load} className="rounded-xl border border-border bg-surface p-2.5 hover:border-primary/30" title="Refresh">
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {error && <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-400">{error}</div>}

      <div className={`rounded-2xl border p-5 ${enabled ? 'border-primary/30 bg-primary/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface border border-border"><Clock className="h-5 w-5 text-primary" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold text-textPrimary">Scheduled host reboot</h3>
              <StatusPill good={enabled}>{enabled ? 'Enabled' : 'Not enabled'}</StatusPill>
              {runtime?.available && <StatusPill good={runtime.active}>{runtime.active ? 'Timer active' : 'Timer inactive'}</StatusPill>}
            </div>
            <p className="mt-1 text-sm text-textSecondary">
              {reboot.schedule || '00:30 and 12:30 local time'}{info.timeZone ? ` · server timezone: ${info.timeZone}` : ''}
            </p>
          </div>
        </div>

        {enabled ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Metric label="Next restart" value={dateTime(window.nextAt)} detail={window.workDeferred ? 'Maintenance window is active' : 'Calculated from the fixed timer'} />
            <Metric label="Last timer trigger" value={dateTime(runtime?.lastTriggeredAt || reboot.lastScheduledReboot?.at)} detail={reboot.lastScheduledReboot?.message || 'No recorded reboot yet'} />
            <Metric label="Work guard" value={`${window.guardMinutes || reboot.guardMinutes || 60} minutes`} detail="Updates, imports and link scans defer before reboot" />
          </div>
        ) : (
          <p className="mt-4 text-sm text-amber-400">
            The deployment record has no active reboot timer. Enable it by running the production deploy without <code className="font-mono">--no-scheduled-reboot</code>.
          </p>
        )}
        {runtime?.available === false && (
          <p className="mt-3 text-xs text-textMuted">Live systemd state is unavailable on this runtime; the deployment record is shown instead.</p>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="glass rounded-2xl border border-white/5 p-6">
          <h3 className="flex items-center gap-2 font-semibold text-textPrimary"><Server className="h-4 w-4 text-primary" /> Post-reboot health</h3>
          <div className="mt-4 space-y-3 text-sm">
            <div className="flex items-center justify-between gap-4"><span className="text-textMuted">Serving health endpoint</span><StatusPill good={health.status === 'ok'}>{health.status === 'ok' ? 'Healthy' : 'Unknown'}</StatusPill></div>
            <Row label="Application started" value={dateTime(health.appStartedAt)} />
            <Row label="Application uptime" value={duration(health.appUptimeSeconds)} />
            <Row label="Host booted" value={dateTime(health.hostBootedAt)} />
            <Row label="Host uptime" value={duration(health.hostUptimeSeconds)} />
            <div className="flex items-center justify-between gap-4"><span className="text-textMuted">Restarted after current boot</span><StatusPill good={health.restartedAfterHostBoot}>{health.restartedAfterHostBoot ? 'Confirmed' : 'Cannot confirm'}</StatusPill></div>
          </div>
        </section>

        <section className="glass rounded-2xl border border-white/5 p-6">
          <h3 className="flex items-center gap-2 font-semibold text-textPrimary"><Activity className="h-4 w-4 text-primary" /> Background work</h3>
          {auto ? (
            <div className="mt-4 rounded-xl border border-border bg-surfaceHover p-3 text-sm">
              <div className="flex items-center justify-between gap-3"><span className="font-medium text-textPrimary">Auto-update</span><span className={AUTO_UPDATE_TONE[auto.state] || 'text-textSecondary'}>{auto.state || 'unknown'}</span></div>
              <p className="mt-1 text-xs text-textMuted">{auto.message || 'No updater message recorded.'}</p>
              {auto.at && <p className="mt-1 text-xs text-textMuted">Updated {dateTime(auto.at)}</p>}
            </div>
          ) : <p className="mt-4 text-sm text-textMuted">No auto-updater status has been recorded on this host.</p>}

          <div className="mt-3 space-y-2">
            {(info.activities || []).length ? info.activities.map(activity => (
              <div key={activity.id} className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm">
                <div className="font-medium text-textPrimary">{activity.label}</div>
                <div className="mt-1 text-xs text-textMuted">Started {dateTime(activity.startedAt)} · {activity.type}</div>
              </div>
            )) : <p className="text-sm text-textMuted">No long-running import, restore or link scan is active.</p>}
          </div>
          {window.workDeferred && <p className="mt-3 text-xs text-amber-400">New nonessential work is deferred until after {dateTime(window.nextAt)}.</p>}
        </section>
      </div>

      <section className="glass rounded-2xl border border-white/5 p-6">
        <h3 className="flex items-center gap-2 font-semibold text-textPrimary"><History className="h-4 w-4 text-primary" /> Maintenance event history</h3>
        <p className="mt-1 text-xs text-textMuted">Reboot and application lifecycle events survive an application restart.</p>
        {(info.events || []).length ? (
          <ol className="mt-4 divide-y divide-white/5">
            {info.events.map((event, index) => (
              <li key={`${event.at}-${event.type}-${index}`} className="flex flex-wrap gap-x-4 gap-y-1 py-3 text-sm">
                <time className="w-44 shrink-0 text-xs text-textMuted">{dateTime(event.at)}</time>
                <div className="min-w-0 flex-1"><span className="font-medium capitalize text-textPrimary">{event.type.replaceAll('-', ' ')}</span><span className="ml-2 text-textSecondary">{event.message}</span></div>
                <span className="text-xs text-textMuted">{event.source}</span>
              </li>
            ))}
          </ol>
        ) : <p className="mt-4 text-sm text-textMuted">No maintenance events have been recorded yet. The first scheduled reboot will add one.</p>}
      </section>

      <section className="glass rounded-2xl border border-white/5 p-6">
        <h3 className="flex items-center gap-2 font-semibold text-textPrimary"><Terminal className="h-4 w-4 text-primary" /> Host controls</h3>
        <p className="mt-1 text-sm text-textMuted">For safety, host controls stay in the shell. This website can inspect but never reboot or reconfigure the server.</p>
        <div className="mt-4 grid gap-2">
          <HostCommand>sudo systemctl list-timers espress0-repo-reboot.timer</HostCommand>
          <HostCommand>sudo systemctl disable --now espress0-repo-reboot.timer</HostCommand>
          <HostCommand>sudo ./espress0 deploy --scheduled-reboot</HostCommand>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, detail }) {
  return <div className="rounded-xl border border-border bg-surfaceHover p-3"><div className="text-xs uppercase tracking-widest text-textMuted">{label}</div><div className="mt-1 font-medium text-textPrimary">{value}</div><div className="mt-1 text-xs text-textMuted">{detail}</div></div>;
}

function Row({ label, value }) {
  return <div className="flex items-center justify-between gap-4"><span className="text-textMuted">{label}</span><span className="text-right text-textSecondary">{value}</span></div>;
}
