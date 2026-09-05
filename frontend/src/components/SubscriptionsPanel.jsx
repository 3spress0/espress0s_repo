import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, Tag, FileText, Trash2, Plus } from 'lucide-react';
import { subscriptionsApi } from '../lib/api';
import Loading from './Loading';

/** The signed-in user's followed entries and tags. */
export default function SubscriptionsPanel({ onError }) {
  const [subs, setSubs] = useState(null);
  const [tag, setTag] = useState('');
  const load = useCallback(() => subscriptionsApi.list().then(r => setSubs(r.subscriptions || [])).catch(e => onError?.(e.response?.data?.error || 'Failed to load subscriptions')), [onError]);
  useEffect(() => { load(); }, [load]);
  const remove = async (id) => { try { await subscriptionsApi.remove(id); load(); } catch (e) { onError?.(e.response?.data?.error || 'Failed'); } };
  const addTag = async (e) => { e.preventDefault(); if (!tag.trim()) return; try { await subscriptionsApi.followTag(tag.trim()); setTag(''); load(); } catch (err) { onError?.(err.response?.data?.error || 'Failed'); } };
  if (!subs) return <Loading text="Loading subscriptions…" />;
  return (
    <div className="glass rounded-3xl border border-white/5 p-8 backdrop-blur-xl space-y-4">
      <h2 className="text-xl font-bold text-textPrimary flex items-center gap-2"><Bell className="w-5 h-5 text-primary" /> Following</h2>
      <p className="text-xs text-textMuted">Entries and tags you follow. Deliveries go to your personal webhooks below that are set to <em>subscriptions only</em>. Use the Follow button on any entry page to add one.</p>
      <form onSubmit={addTag} className="flex gap-2">
        <input value={tag} onChange={e => setTag(e.target.value)} placeholder="Follow a tag, e.g. retro" className="flex-1 px-3 py-2 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50" />
        <button type="submit" className="px-3 py-2 rounded-xl bg-surface border border-border text-sm hover:border-primary/30 flex items-center gap-1"><Plus className="w-4 h-4" /> Tag</button>
      </form>
      {subs.length === 0 ? <p className="text-sm text-textMuted">Nothing followed yet.</p> : (
        <ul className="divide-y divide-white/5">
          {subs.map(s => (
            <li key={s.id} className="flex items-center gap-3 py-2 text-sm">
              {s.kind === 'tag' ? <Tag className="w-4 h-4 text-textMuted" /> : <FileText className="w-4 h-4 text-textMuted" />}
              {s.kind === 'tag' ? <span className="flex-1">tag: <span className="font-mono">{s.tag}</span></span>
                : <Link to={`/file/${s.item?.slug}`} className="flex-1 hover:text-primary truncate">{s.item?.name || `#${s.item_id}`}{s.item && !s.item.published && <span className="ml-2 text-[11px] text-textMuted">(draft)</span>}</Link>}
              <button onClick={() => remove(s.id)} className="p-1.5 rounded-lg text-textMuted hover:text-red-400" title="Unfollow"><Trash2 className="w-4 h-4" /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
