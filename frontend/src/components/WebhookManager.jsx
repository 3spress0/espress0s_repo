import { useCallback, useEffect, useState } from 'react';
import { Webhook, Plus, Trash2, Edit, X, Send, RefreshCw, Copy, Check, AlertTriangle, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { webhooksApi } from '../lib/api';
import Loading, { LoadingDots } from './Loading';

/**
 * Webhook manager, shared by the admin panel (site-wide hooks, `scope="admin"`)
 * and the Account page (personal hooks, `scope="me"`). Personal hooks only
 * receive events about public items; the server enforces that.
 */
const EVENT_LABELS = {
  'item.created': 'New file page',
  'item.updated': 'File page updated',
  'item.published': 'Published',
  'item.unpublished': 'Unpublished',
  'item.deleted': 'Deleted',
  'link.down': 'Download link went down',
  'link.recovered': 'Download link recovered',
  'import.completed': 'Catalogue import applied',
};
const ADMIN_ONLY_EVENTS = new Set(['item.unpublished', 'item.deleted', 'import.completed']);

function StatusDot({ hook }) {
  if (!hook.active) return <span className="inline-flex items-center gap-1 text-xs text-textMuted"><Clock className="w-3 h-3" /> paused</span>;
  if (hook.last_status === 'error') return <span className="inline-flex items-center gap-1 text-xs text-red-400"><XCircle className="w-3 h-3" /> failing ({hook.failure_count})</span>;
  if (hook.last_status === 'ok') return <span className="inline-flex items-center gap-1 text-xs text-emerald-400"><CheckCircle2 className="w-3 h-3" /> ok</span>;
  return <span className="text-xs text-textMuted">never delivered</span>;
}

function SecretReveal({ secret, onDone }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20 space-y-2">
      <p className="text-sm text-amber-200 font-medium">Signing secret - shown once</p>
      <p className="text-xs text-textMuted">Every delivery carries <code>X-Espress0-Signature: sha256=HMAC(secret, body)</code>. Verify it on your side.</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 break-all font-mono text-xs text-textPrimary bg-surface border border-border rounded-lg px-3 py-2">{secret}</code>
        <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(secret); setCopied(true); } catch {} }} className="p-2 rounded-lg hover:bg-surfaceHover text-textMuted">
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      <button type="button" onClick={onDone} className="text-xs text-textMuted hover:text-textPrimary">I saved it</button>
    </div>
  );
}

export default function WebhookManager({ scope = 'admin' }) {
  const apiFor = scope === 'admin' ? webhooksApi.admin : webhooksApi.me;
  const [hooks, setHooks] = useState([]);
  const [eventTypes, setEventTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // 'new' | hook
  const [form, setForm] = useState({ name: '', url: '', events: [], filter_mode: 'all' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [secret, setSecret] = useState(null);
  const [detail, setDetail] = useState(null); // { webhook, deliveries }
  const [testing, setTesting] = useState(null);

  const notify = (kind, message) => { setToast({ kind, message }); setTimeout(() => setToast(t => (t?.message === message ? null : t)), 4000); };

  const load = useCallback(async () => {
    try {
      const data = await apiFor.list();
      setHooks(data.webhooks || []);
      setEventTypes((data.events || []).filter(e => scope === 'admin' || !ADMIN_ONLY_EVENTS.has(e)));
    } catch (e) { notify('error', e.response?.data?.error || 'Failed to load webhooks'); }
    finally { setLoading(false); }
  }, [apiFor, scope]);
  useEffect(() => { load(); }, [load]);

  const openEditor = (hook = null) => {
    setError(''); setSecret(null);
    setEditing(hook || 'new');
    setForm(hook ? { name: hook.name, url: hook.url, events: hook.events, filter_mode: hook.filter_mode || 'all' } : { name: '', url: '', events: [], filter_mode: 'all' });
  };
  const toggleEvent = (ev) => setForm(f => ({ ...f, events: f.events.includes(ev) ? f.events.filter(x => x !== ev) : [...f.events, ev] }));

  const save = async (e) => {
    e?.preventDefault(); setSaving(true); setError('');
    try {
      if (editing === 'new') {
        const res = await apiFor.create(form);
        setSecret(res.webhook.secret);
        notify('success', `Webhook “${form.name}” created`);
      } else {
        await apiFor.update(editing.id, form);
        notify('success', 'Webhook saved');
        setEditing(null);
      }
      await load();
    } catch (err) { setError(err.response?.data?.error || 'Save failed'); }
    finally { setSaving(false); }
  };

  const remove = async (hook) => {
    if (!confirm(`Delete webhook “${hook.name}”?`)) return;
    try { await apiFor.remove(hook.id); notify('success', 'Deleted'); if (detail?.webhook.id === hook.id) setDetail(null); await load(); }
    catch (err) { notify('error', err.response?.data?.error || 'Delete failed'); }
  };
  const toggleActive = async (hook) => {
    try { await apiFor.update(hook.id, { active: !hook.active }); await load(); }
    catch (err) { notify('error', err.response?.data?.error || 'Update failed'); }
  };
  const rotate = async (hook) => {
    if (!confirm('Rotate the signing secret? Your receiver must be updated.')) return;
    try { const res = await apiFor.update(hook.id, { rotateSecret: true }); setEditing(hook); setForm({ name: hook.name, url: hook.url, events: hook.events }); setSecret(res.webhook.secret); }
    catch (err) { notify('error', err.response?.data?.error || 'Rotate failed'); }
  };
  const sendTest = async (hook) => {
    setTesting(hook.id);
    try {
      const res = await apiFor.test(hook.id);
      notify(res.ok ? 'success' : 'error', res.ok ? `Ping delivered (HTTP ${res.status}, ${res.duration_ms} ms)` : `Ping failed: ${res.error}`);
      await load(); if (detail?.webhook.id === hook.id) openDetail(hook);
    } catch (err) { notify('error', err.response?.data?.error || 'Test failed'); }
    finally { setTesting(null); }
  };
  const openDetail = async (hook) => {
    try { setDetail(await apiFor.get(hook.id)); } catch (err) { notify('error', err.response?.data?.error || 'Failed to load deliveries'); }
  };
  const redeliver = async (deliveryId) => {
    try { await apiFor.redeliver(detail.webhook.id, deliveryId); notify('success', 'Queued for redelivery'); setTimeout(() => openDetail(detail.webhook), 800); }
    catch (err) { notify('error', err.response?.data?.error || 'Redeliver failed'); }
  };

  if (loading) return <Loading text="Loading webhooks…" />;

  return (
    <div className="space-y-6">
      {toast && (
        <div className={`p-3 rounded-xl text-sm border ${toast.kind === 'error' ? 'bg-red-500/10 border-red-500/20 text-red-300' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'}`}>{toast.message}</div>
      )}

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-textPrimary flex items-center gap-2"><Webhook className="w-5 h-5 text-primary" /> Webhooks</h2>
          <p className="text-sm text-textMuted mt-1">
            POST a signed JSON payload to your URL when something happens.
            {scope === 'me' ? ' Personal hooks receive events about public file pages only.' : ' Retries with backoff for up to six hours; every attempt is logged.'}
          </p>
        </div>
        <button onClick={() => openEditor()} className="px-4 py-2 bg-gradient-primary text-white rounded-xl text-sm font-medium flex items-center gap-2 shadow-lg shadow-purple-500/20"><Plus className="w-4 h-4" /> New webhook</button>
      </div>

      {editing && (
        <form onSubmit={save} className="glass rounded-2xl border border-white/5 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-textPrimary">{editing === 'new' ? 'New webhook' : `Edit “${editing.name}”`}</h3>
            <button type="button" onClick={() => { setEditing(null); setSecret(null); }} className="p-1.5 rounded-lg hover:bg-surfaceHover text-textMuted"><X className="w-4 h-4" /></button>
          </div>
          {secret ? <SecretReveal secret={secret} onDone={() => { setEditing(null); setSecret(null); }} /> : (
            <>
              <div className="grid sm:grid-cols-2 gap-3">
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Name (e.g. Discord alerts)" required className="px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50" />
                <input value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/hook" type="url" required className="px-3 py-2.5 bg-surface border border-border rounded-xl text-sm font-mono focus:outline-none focus:border-primary/50" />
              </div>
              <div>
                <div className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2">Events</div>
                <div className="flex flex-wrap gap-2">
                  {eventTypes.map(ev => (
                    <button type="button" key={ev} onClick={() => toggleEvent(ev)}
                      className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${form.events.includes(ev) ? 'bg-primary/20 border-primary/40 text-textPrimary' : 'bg-surface border-border text-textSecondary hover:border-primary/30'}`}>
                      {EVENT_LABELS[ev] || ev} <span className="opacity-50 font-mono">{ev}</span>
                    </button>
                  ))}
                </div>
              </div>
              {scope !== 'admin' && (
                <div>
                  <div className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2">Scope</div>
                  <div className="flex flex-wrap gap-2">
                    {[['all', 'Every public entry'], ['subscribed', 'Only entries and tags I follow']].map(([v, label]) => (
                      <button type="button" key={v} onClick={() => setForm(f => ({ ...f, filter_mode: v }))}
                        className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${form.filter_mode === v ? 'bg-primary/20 border-primary/40 text-textPrimary' : 'bg-surface border-border text-textSecondary hover:border-primary/30'}`}>{label}</button>
                    ))}
                  </div>
                </div>
              )}
              {error && <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-300 flex gap-2"><AlertTriangle className="w-4 h-4 mt-0.5" /> {error}</div>}
              <div className="flex gap-2">
                <button type="submit" disabled={saving || !form.events.length} className="px-5 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium disabled:opacity-50">{saving ? <LoadingDots size={14} /> : (editing === 'new' ? 'Create' : 'Save')}</button>
                {editing !== 'new' && <button type="button" onClick={() => rotate(editing)} className="px-4 py-2.5 text-sm text-textMuted hover:text-textPrimary inline-flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5" /> Rotate secret</button>}
              </div>
            </>
          )}
        </form>
      )}

      {hooks.length === 0 ? (
        <div className="glass rounded-2xl border border-white/5 p-8 text-center text-sm text-textMuted">No webhooks yet.</div>
      ) : (
        <div className="space-y-2">
          {hooks.map(hook => (
            <div key={hook.id} className="glass rounded-2xl border border-white/5 p-4 flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-[200px]">
                <div className="font-medium text-textPrimary flex items-center gap-2">{hook.name} <StatusDot hook={hook} /></div>
                <div className="text-xs font-mono text-textMuted truncate">{hook.url}</div>
                <div className="flex flex-wrap gap-1 mt-1">{hook.events.map(ev => <span key={ev} className="px-2 py-0.5 rounded-full bg-surface border border-border text-[10px] text-textSecondary">{EVENT_LABELS[ev] || ev}</span>)}</div>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => openDetail(hook)} title="Deliveries" className="px-3 py-1.5 rounded-lg text-xs bg-surface border border-border hover:border-primary/30">Deliveries</button>
                <button onClick={() => sendTest(hook)} disabled={testing === hook.id} title="Send test" className="p-2 rounded-lg hover:bg-surfaceHover text-textMuted hover:text-primary">{testing === hook.id ? <LoadingDots size={12} /> : <Send className="w-4 h-4" />}</button>
                <button onClick={() => toggleActive(hook)} title={hook.active ? 'Pause' : 'Resume'} className="px-2 py-1.5 rounded-lg text-xs text-textMuted hover:text-textPrimary">{hook.active ? 'Pause' : 'Resume'}</button>
                <button onClick={() => openEditor(hook)} title="Edit" className="p-2 rounded-lg hover:bg-surfaceHover text-textMuted hover:text-primary"><Edit className="w-4 h-4" /></button>
                <button onClick={() => remove(hook)} title="Delete" className="p-2 rounded-lg hover:bg-surfaceHover text-textMuted hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {detail && (
        <div className="glass rounded-2xl border border-white/5 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-textPrimary">Recent deliveries · {detail.webhook.name}</h3>
            <button onClick={() => setDetail(null)} className="p-1.5 rounded-lg hover:bg-surfaceHover text-textMuted"><X className="w-4 h-4" /></button>
          </div>
          {detail.deliveries.length === 0 ? <p className="text-sm text-textMuted">Nothing delivered yet.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-textMuted uppercase tracking-widest text-[10px]"><tr><th className="text-left p-2">Event</th><th className="text-left p-2">Status</th><th className="text-left p-2">HTTP</th><th className="text-left p-2">Tries</th><th className="text-left p-2">When</th><th className="p-2"></th></tr></thead>
                <tbody>
                  {detail.deliveries.map(d => (
                    <tr key={d.id} className="border-t border-white/5">
                      <td className="p-2 font-mono">{d.event_type}</td>
                      <td className={`p-2 ${d.status === 'delivered' ? 'text-emerald-400' : d.status === 'failed' ? 'text-red-400' : 'text-amber-300'}`}>{d.status}{d.error ? ` · ${d.error}` : ''}</td>
                      <td className="p-2">{d.response_status ?? '—'}</td>
                      <td className="p-2">{d.attempts}</td>
                      <td className="p-2 text-textMuted">{new Date(d.last_attempt_at || d.created_at).toLocaleString()}</td>
                      <td className="p-2 text-right"><button onClick={() => redeliver(d.id)} className="text-textMuted hover:text-primary">Redeliver</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
