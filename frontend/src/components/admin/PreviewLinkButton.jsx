import { useState } from 'react';
import { Eye, Check, Copy } from 'lucide-react';
import { itemsApi } from '../../lib/api';

/**
 * "Copy preview link" for a draft: mints a signed link (7 days) and puts the
 * absolute URL on the clipboard. Shown only for unpublished entries.
 */
export default function PreviewLinkButton({ itemId, published, className = '', onError }) {
  const [state, setState] = useState('idle'); // idle | busy | copied
  const [expires, setExpires] = useState(null);
  if (published || !itemId) return null;
  const mint = async () => {
    setState('busy');
    try {
      const res = await itemsApi.previewLink(itemId, 24 * 7);
      const url = `${window.location.origin}${res.path}`;
      try { await navigator.clipboard.writeText(url); } catch { window.prompt('Preview link (copy it):', url); }
      setExpires(res.expires_at);
      setState('copied');
      setTimeout(() => setState('idle'), 2500);
    } catch (e) {
      setState('idle');
      onError?.(e.response?.data?.error || 'Could not create a preview link');
    }
  };
  return (
    <button type="button" onClick={mint} disabled={state === 'busy'}
      title={expires ? `Last link expires ${new Date(expires).toLocaleString()}` : 'Share this draft with someone who has no account. Read-only, no downloads, expires in 7 days.'}
      className={`px-4 py-2 rounded-xl text-sm font-medium flex items-center gap-2 border bg-surface border-border text-textSecondary hover:border-primary/30 hover:text-textPrimary disabled:opacity-50 ${className}`}>
      {state === 'copied' ? <Check className="w-4 h-4 text-green-400" /> : state === 'busy' ? <Copy className="w-4 h-4 animate-pulse" /> : <Eye className="w-4 h-4" />}
      {state === 'copied' ? 'Preview link copied' : 'Copy preview link'}
    </button>
  );
}
