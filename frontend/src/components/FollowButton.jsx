import { useEffect, useState } from 'react';
import { Bell, BellOff, BellRing } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { subscriptionsApi } from '../lib/api';

/**
 * Follow / unfollow one entry. Followed entries feed the user's personal
 * webhooks that are set to "subscriptions only" (Account -> Notifications).
 */
export default function FollowButton({ slug, tags = [], onError }) {
  const { isAuthenticated } = useAuth();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showTags, setShowTags] = useState(false);

  const load = () => subscriptionsApi.status(slug).then(setStatus).catch(() => setStatus(null));
  useEffect(() => { if (isAuthenticated && slug) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [isAuthenticated, slug]);
  if (!isAuthenticated || !status) return null;

  const toggle = async () => {
    setBusy(true);
    try {
      if (status.subscribed) await subscriptionsApi.remove(status.subscription_id);
      else await subscriptionsApi.followItem(slug);
      await load();
    } catch (e) { onError?.(e.response?.data?.error || 'Could not update subscription'); }
    finally { setBusy(false); }
  };
  const followTag = async (tag) => {
    setBusy(true);
    try { await subscriptionsApi.followTag(tag); await load(); setShowTags(false); }
    catch (e) { onError?.(e.response?.data?.error || 'Could not follow tag'); }
    finally { setBusy(false); }
  };

  const viaTag = status.via_tags?.length > 0;
  const Icon = status.subscribed ? BellRing : viaTag ? Bell : BellOff;
  return (
    <div className="relative inline-flex items-center gap-1">
      <button onClick={toggle} disabled={busy}
        title={status.subscribed ? 'Stop following this entry' : viaTag ? `Following via tag: ${status.via_tags.join(', ')}` : 'Get notified about updates and link changes'}
        className={`px-4 py-2 rounded-xl text-sm font-medium flex items-center gap-2 border transition-colors ${status.subscribed || viaTag ? 'bg-primary/10 border-primary/30 text-primary' : 'bg-surface border-border text-textSecondary hover:border-primary/30 hover:text-textPrimary'}`}>
        <Icon className="w-4 h-4" />
        {status.subscribed ? 'Following' : viaTag ? 'Following (tag)' : 'Follow'}
      </button>
      {tags.length > 0 && (
        <button onClick={() => setShowTags(v => !v)} className="px-2 py-2 rounded-xl text-xs text-textMuted hover:text-textPrimary border border-transparent hover:border-border" title="Follow a tag instead">tag ▾</button>
      )}
      {showTags && (
        <div className="absolute top-full left-0 mt-1 z-20 glass-strong rounded-xl border border-white/10 p-2 min-w-[180px] shadow-xl">
          <p className="text-[11px] text-textMuted px-2 pb-1">Follow every entry tagged…</p>
          {tags.map(t => {
            const on = status.via_tags?.includes(String(t).toLowerCase());
            return <button key={t} disabled={on || busy} onClick={() => followTag(t)} className="w-full text-left px-2 py-1.5 rounded-lg text-sm hover:bg-surfaceHover disabled:opacity-50">{t}{on ? ' ✓' : ''}</button>;
          })}
        </div>
      )}
    </div>
  );
}
