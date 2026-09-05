import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, Download, Star, Users, Link2, Webhook, RefreshCw, AlertTriangle } from 'lucide-react';
import { adminApi } from '../../lib/api';
import Loading from '../../components/Loading';

/**
 * Admin -> Analytics: usage dashboard built from what the app already
 * records (download counters, the events table, reviews, users, link health,
 * webhook deliveries, import runs and in-process request metrics). Pure
 * CSS bar charts - no charting dependency.
 */
const WINDOWS = [7, 30, 90, 365];

function Bars({ data, color = 'bg-primary/70', height = 'h-24', label }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((a, d) => a + d.value, 0);
  return (
    <div>
      {label && <div className="flex items-baseline justify-between mb-1"><span className="text-xs text-textMuted uppercase tracking-widest">{label}</span><span className="text-sm font-semibold text-textPrimary">{total}</span></div>}
      <div className={`flex items-end gap-px ${height}`} role="img" aria-label={`${label || 'series'}: ${total} over ${data.length} days`}>
        {data.map((d) => (
          <div key={d.day} className="flex-1 flex flex-col justify-end h-full" title={`${d.day}: ${d.value}`}>
            <div className={`${color} rounded-t-sm min-h-px`} style={{ height: `${(d.value / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-textMuted mt-1"><span>{data[0]?.day}</span><span>{data[data.length - 1]?.day}</span></div>
    </div>
  );
}

function Ranked({ rows, valueKey, nameKey = 'name', linkKey, suffix = '' }) {
  if (!rows?.length) return <p className="text-xs text-textMuted">No data yet.</p>;
  const max = Math.max(1, ...rows.map((r) => Number(r[valueKey]) || 0));
  return (
    <ul className="space-y-1.5">
      {rows.map((r, i) => (
        <li key={`${r[nameKey]}-${i}`} className="text-xs">
          <div className="flex justify-between gap-2 mb-0.5">
            {linkKey && r[linkKey] ? <Link to={`/file/${r[linkKey]}`} className="text-textPrimary hover:text-primary truncate">{r[nameKey]}</Link> : <span className="text-textPrimary truncate">{r[nameKey]}</span>}
            <span className="text-textSecondary flex-shrink-0">{r[valueKey]}{suffix}</span>
          </div>
          <div className="h-1.5 rounded bg-white/5 overflow-hidden"><div className="h-full bg-primary/60" style={{ width: `${((Number(r[valueKey]) || 0) / max) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

function Card({ title, icon: Icon, children, className = '' }) {
  return (
    <div className={`glass rounded-2xl p-5 border border-white/5 ${className}`}>
      <h3 className="text-sm font-bold text-textPrimary mb-3 flex items-center gap-2">{Icon && <Icon className="w-4 h-4 text-primary" />}{title}</h3>
      {children}
    </div>
  );
}

const Pills = ({ obj, colors = {} }) => (
  <div className="flex flex-wrap gap-2">
    {Object.entries(obj || {}).map(([k, v]) => (
      <span key={k} className={`px-2 py-0.5 rounded-full text-xs border ${colors[k] || 'border-white/10 text-textSecondary'}`}>{k}: <b>{v}</b></span>
    ))}
    {!Object.keys(obj || {}).length && <span className="text-xs text-textMuted">none</span>}
  </div>
);

export default function AdminAnalytics() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    adminApi.analytics(days)
      .then((d) => { if (alive) { setData(d); setError(''); } })
      .catch((e) => { if (alive) setError(e.response?.data?.error || 'Could not load analytics.'); });
    return () => { alive = false; };
  }, [days, tick]);

  if (!data && !error) return <Loading fullScreen text="Crunching the numbers…" />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-textPrimary flex items-center gap-2"><BarChart3 className="w-5 h-5 text-primary" /> Analytics</h2>
        <div className="flex items-center gap-2">
          {WINDOWS.map((w) => (
            <button key={w} onClick={() => setDays(w)} className={`px-3 py-1.5 rounded-lg text-xs border ${days === w ? 'bg-primary/20 border-primary/40 text-textPrimary' : 'border-white/10 text-textSecondary hover:text-textPrimary'}`}>{w}d</button>
          ))}
          <button onClick={() => setTick((t) => t + 1)} className="text-xs text-textSecondary hover:text-textPrimary inline-flex items-center gap-1 ml-2" title="Reload"><RefreshCw className="w-3.5 h-3.5" /></button>
        </div>
      </div>
      {error && <p className="text-sm text-red-400 flex items-center gap-1"><AlertTriangle className="w-4 h-4" />{error}</p>}
      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {[
              { label: 'Downloads (all time)', value: data.downloads.total },
              { label: 'Published files', value: data.catalog.totals?.published ?? '–' },
              { label: 'Users', value: data.users.total },
              { label: 'Visible reviews', value: data.reviews.byStatus.visible || 0 },
              { label: 'Requests since start', value: data.requests.totalRequests },
            ].map((c) => (
              <div key={c.label} className="glass rounded-2xl p-5 border border-white/5">
                <div className="text-2xl font-bold text-textPrimary">{c.value}</div>
                <div className="text-xs text-textMuted uppercase tracking-widest">{c.label}</div>
              </div>
            ))}
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <Card title={`Catalogue activity, last ${data.range.days} days`} icon={BarChart3}>
              <div className="space-y-4">
                <Bars data={data.catalog.itemsPerDay} label="Pages created" />
                <Bars data={data.catalog.updatesPerDay} label="Pages updated" color="bg-secondary/70" height="h-16" />
              </div>
            </Card>
            <Card title="Events" icon={Link2}>
              <div className="space-y-4">
                <Bars data={data.activity['link.down']} label="Links went down" color="bg-red-400/70" height="h-16" />
                <Bars data={data.activity['link.recovered']} label="Links recovered" color="bg-green-400/70" height="h-16" />
                <Pills obj={Object.fromEntries(data.eventTypes.map((e) => [e.type, e.n]))} />
              </div>
            </Card>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            <Card title="Top downloads" icon={Download}><Ranked rows={data.downloads.top} valueKey="download_count" linkKey="slug" /></Card>
            <Card title="Downloads by category" icon={Download}><Ranked rows={data.downloads.byCategory} valueKey="downloads" /></Card>
            <Card title="Downloads by platform / storage" icon={Download}>
              <Ranked rows={data.downloads.byPlatform} valueKey="downloads" nameKey="platform" />
              <div className="mt-4"><Ranked rows={data.downloads.byProvider} valueKey="downloads" nameKey="provider" /></div>
            </Card>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            <Card title="Reviews" icon={Star}>
              <div className="text-3xl font-bold text-textPrimary mb-1">{data.reviews.averageRating ?? '–'} <span className="text-sm font-normal text-textSecondary">avg of {data.reviews.byStatus.visible || 0}</span></div>
              <Pills obj={data.reviews.byStatus} colors={{ pending: 'border-amber-500/30 text-amber-400', hidden: 'border-red-500/30 text-red-400', visible: 'border-green-500/30 text-green-400' }} />
              <div className="mt-4"><Bars data={data.reviews.perDay} label="New reviews" color="bg-amber-400/70" height="h-16" /></div>
              {data.reviews.byStatus.pending > 0 && <Link to="/admin/reviews" className="text-xs text-primary hover:underline mt-2 inline-block">Moderate {data.reviews.byStatus.pending} pending →</Link>}
            </Card>
            <Card title="Top rated" icon={Star}><Ranked rows={data.reviews.topRated} valueKey="average" linkKey="slug" suffix=" ★" /></Card>
            <Card title="Users" icon={Users}>
              <Pills obj={data.users.byRole} />
              <div className="mt-4"><Bars data={data.users.signupsPerDay} label="Sign-ups" color="bg-blue-400/70" height="h-16" /></div>
              <div className="mt-3 text-xs text-textSecondary">{data.users.favorites} favourites · {data.users.subscriptions} subscriptions</div>
            </Card>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            <Card title="Link health" icon={Link2}>
              <Pills obj={data.links.byStatus} colors={{ up: 'border-green-500/30 text-green-400', down: 'border-red-500/30 text-red-400' }} />
              <div className="mt-2 text-xs text-textSecondary">{data.links.total} mirrors total</div>
            </Card>
            <Card title="Webhooks" icon={Webhook}>
              <div className="text-xs text-textSecondary mb-2">{data.webhooks.active} active</div>
              <Pills obj={data.webhooks.deliveries} colors={{ delivered: 'border-green-500/30 text-green-400', failed: 'border-red-500/30 text-red-400' }} />
              <div className="mt-4"><Bars data={data.webhooks.perDay} label="Deliveries" color="bg-purple-400/70" height="h-16" /></div>
            </Card>
            <Card title="Imports" icon={RefreshCw}>
              <Pills obj={data.imports.catalog} />
              <div className="mt-3 text-xs text-textSecondary">{data.imports.scheduledJobs} scheduled jobs</div>
              <ul className="mt-2 space-y-1 text-xs">
                {data.imports.lastRuns.map((j) => <li key={j.id} className="flex justify-between gap-2"><span className="text-textPrimary truncate">{j.name}</span><span className="text-textSecondary flex-shrink-0">{j.last_status || 'never'}{j.last_run_at ? ` · ${j.last_run_at.slice(0, 16)}` : ''}</span></li>)}
              </ul>
            </Card>
          </div>

          <Card title="Request metrics (since process start)">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mb-3">
              {[['Errors', data.requests.totalErrors], ['Error rate', data.requests.errorRate], ['Avg response', data.requests.avgResponseTime], ['Downloads served', data.requests.downloads]].map(([k, v]) => (
                <div key={k}><div className="text-textMuted uppercase tracking-widest">{k}</div><div className="text-textPrimary font-semibold">{v}</div></div>
              ))}
            </div>
            <Ranked rows={data.requests.topEndpoints} valueKey="count" nameKey="endpoint" />
            <p className="text-[11px] text-textMuted mt-3">Deeper process metrics live under <Link to="/admin/monitoring" className="text-primary hover:underline">Monitoring</Link>.</p>
          </Card>
        </>
      )}
    </div>
  );
}
