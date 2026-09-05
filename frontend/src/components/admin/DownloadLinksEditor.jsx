import { useState } from 'react';
import { Plus, Trash2, Star, GripVertical, AlertTriangle, ClipboardPaste, Activity } from 'lucide-react';
import { linkHealthApi } from '../../lib/api';
import { LoadingDots } from '../Loading';

/** Small badge for the health checker's verdict on a saved mirror. */
function HealthBadge({ link }) {
  if (!link?.id) return null; // only mirrors that are saved can be probed
  const s = link.status || 'unknown';
  const cls = s === 'up'
    ? 'bg-green-500/10 border-green-500/30 text-green-400'
    : s === 'down'
      ? 'bg-red-500/10 border-red-500/30 text-red-400'
      : 'bg-amber-500/10 border-amber-500/30 text-amber-400';
  const label = s === 'up' ? `Up${link.http_status ? ` (${link.http_status})` : ''}`
    : s === 'down' ? `Down${link.http_status ? ` (${link.http_status})` : ''}`
    : 'Unknown';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[11px] ${cls}`} title={link.check_error || undefined}>
      <Activity className="w-3 h-3" />
      {label}
      {link.last_checked && <span className="opacity-70">• checked {new Date(link.last_checked.replace(' ', 'T') + 'Z').toLocaleString()}</span>}
    </span>
  );
}

const PROVIDERS = [
  { value: 'external', label: 'External URL' },
  { value: 'gdrive', label: 'Google Drive' },
  { value: 'onedrive', label: 'OneDrive' },
  { value: 'github', label: 'GitHub Releases' },
  { value: 'torrent', label: 'Torrent / magnet' },
  { value: 'local', label: 'Local file' },
];

const STATUSES = [
  { value: 'up', label: 'Up' },
  { value: 'down', label: 'Down' },
  { value: 'unknown', label: 'Unknown' },
  { value: 'checking', label: 'Checking' },
];

function blankLink(sortOrder = 0) {
  return {
    label: '',
    storage_provider: 'external',
    storage_path: '',
    download_url: '',
    file_size: '',
    is_primary: sortOrder === 0,
    is_down: false,
    down_reason: '',
    status: 'up',
    sort_order: sortOrder,
  };
}

/**
 * Work out the provider, a human label and (for Drive/OneDrive) the file id
 * from a pasted URL, so adding a mirror is one paste instead of four fields.
 */
export function describeUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return null;

  // Torrent mirrors: a magnet URI (display name from &dn= when present) or a
  // plain http(s) link to a .torrent file.
  if (/^magnet:\?/i.test(url)) {
    const dn = url.match(/[?&]dn=([^&]+)/)?.[1];
    let name = '';
    try { name = dn ? decodeURIComponent(dn.replace(/\+/g, ' ')) : ''; } catch { name = ''; }
    return { provider: 'torrent', label: name ? `Magnet — ${name}`.slice(0, 100) : 'Magnet link', storage_path: '', file_name: name };
  }

  let host = '';
  let pathname = '';
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    host = parsed.hostname.toLowerCase();
    pathname = parsed.pathname;
  } catch {
    return null;
  }

  const fileNameGuess = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
  if (/\.torrent$/i.test(fileNameGuess)) {
    return { provider: 'torrent', label: `Torrent — ${host.replace(/^www\./, '')}`, storage_path: '', file_name: fileNameGuess };
  }

  if (host.includes('drive.google.com') || host.includes('docs.google.com')) {
    const id = url.match(/\/d\/([A-Za-z0-9_-]{10,})/)?.[1]
      || url.match(/[?&]id=([A-Za-z0-9_-]{10,})/)?.[1]
      || '';
    return { provider: 'gdrive', label: 'Google Drive', storage_path: id, file_name: '' };
  }
  if (host.includes('onedrive.live.com') || host.includes('1drv.ms') || host.includes('sharepoint.com')) {
    return { provider: 'onedrive', label: 'OneDrive', storage_path: '', file_name: '' };
  }
  if (host.includes('github.com') || host.includes('githubusercontent.com')) {
    const repo = pathname.split('/').filter(Boolean).slice(0, 2).join('/');
    return { provider: 'github', label: repo ? `GitHub — ${repo}` : 'GitHub release', storage_path: '', file_name: fileNameGuess };
  }

  const bareHost = host.replace(/^www\./, '');
  return { provider: 'external', label: bareHost, storage_path: '', file_name: fileNameGuess };
}

/**
 * Editor for an item's download mirrors.
 *
 * Every field the backend stores on item_download_links is editable here,
 * including per-mirror status and a "down" reason, so a broken mirror can be
 * flagged without deleting it. The quick-add box at the top turns a pasted URL
 * into a filled-in mirror (provider + label detected from the host).
 */
export default function DownloadLinksEditor({ links, onChange }) {
  const list = links || [];
  const [pasted, setPasted] = useState('');
  const [pasteError, setPasteError] = useState('');
  const [checking, setChecking] = useState(null); // link id currently being probed

  /** Ask the backend to probe this mirror now; updates the row in place. */
  const checkNow = async (index) => {
    const link = list[index];
    if (!link?.id) return;
    setChecking(link.id);
    try {
      const result = await linkHealthApi.checkLink(link.id);
      const next = list.map((l, i) => (i === index ? {
        ...l,
        status: result.status,
        http_status: result.http_status,
        check_error: result.check_error,
        check_duration_ms: result.check_duration_ms,
        last_checked: result.last_checked,
      } : l));
      onChange(next);
    } catch (e) {
      setPasteError(e.response?.data?.error || 'Link check failed');
    } finally {
      setChecking(null);
    }
  };

  const update = (index, field, value) => {
    const next = list.map((l, i) => {
      if (i !== index) return l;
      return { ...l, [field]: value };
    });

    // Only one mirror may be primary.
    if (field === 'is_primary' && value) {
      return onChange(next.map((l, i) => (i === index ? l : { ...l, is_primary: false })));
    }
    onChange(next);
  };

  const remove = (index) => {
    const next = list.filter((_, i) => i !== index);
    // Keep exactly one primary if any links remain.
    if (next.length && !next.some(l => l.is_primary)) next[0] = { ...next[0], is_primary: true };
    onChange(next);
  };

  const move = (index, dir) => {
    const target = index + dir;
    if (target < 0 || target >= list.length) return;
    const next = [...list];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next.map((l, i) => ({ ...l, sort_order: i })));
  };

  /** Paste a URL -> a ready-made mirror row. */
  const addFromUrl = () => {
    const info = describeUrl(pasted);
    if (!info) {
      setPasteError('That is not a valid http(s) URL');
      return;
    }
    setPasteError('');
    const index = list.length;
    onChange([...list, {
      ...blankLink(index),
      label: info.label,
      storage_provider: info.provider,
      storage_path: info.storage_path,
      download_url: pasted.trim(),
      is_primary: index === 0,
    }]);
    setPasted('');
  };

  return (
    <div>
      <div className="rounded-xl border border-border bg-background p-3 mb-4">
        <label className="text-[11px] text-textMuted block mb-1.5 flex items-center gap-1.5">
          <ClipboardPaste className="w-3.5 h-3.5" /> Quick add — paste a download URL
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            value={pasted}
            onChange={(e) => { setPasted(e.target.value); setPasteError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addFromUrl(); } }}
            placeholder="https://drive.google.com/file/d/..., a direct link, or magnet:?xt=urn:btih:..."
            className="flex-1 min-w-[220px] px-3 py-2 bg-surface border border-border rounded-lg text-sm font-mono focus:outline-none focus:border-primary/50"
          />
          <button
            type="button"
            onClick={addFromUrl}
            disabled={!pasted.trim()}
            className="px-4 py-2 bg-gradient-primary text-white rounded-lg text-xs font-medium disabled:opacity-40"
          >
            Add mirror
          </button>
        </div>
        <p className="text-[11px] text-textMuted mt-1.5">
          {pasteError
            ? <span className="text-red-400">{pasteError}</span>
            : 'Provider and label are detected from the link; Google Drive file IDs are extracted automatically.'}
        </p>
      </div>

      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-medium text-textMuted uppercase tracking-widest">
          Download links ({list.length})
        </label>
        <button
          type="button"
          onClick={() => onChange([...list, blankLink(list.length)])}
          className="px-3 py-1.5 bg-gradient-primary text-white rounded-lg text-xs font-medium flex items-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" /> Add link
        </button>
      </div>

      {list.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-5 text-center">
          <AlertTriangle className="w-5 h-5 mx-auto mb-2 text-amber-400" />
          <p className="text-sm text-textSecondary">No download links yet.</p>
          <p className="text-xs text-textMuted mt-1">Visitors will not be able to download this item.</p>
        </div>
      )}

      <div className="space-y-3">
        {list.map((link, index) => (
          <div key={index} className="rounded-xl border border-border bg-surface p-3">
            <div className="flex items-center gap-2 mb-3">
              <div className="flex flex-col">
                <button type="button" onClick={() => move(index, -1)} disabled={index === 0}
                  className="text-textMuted hover:text-textPrimary disabled:opacity-25 leading-none text-xs px-1">▲</button>
                <button type="button" onClick={() => move(index, 1)} disabled={index === list.length - 1}
                  className="text-textMuted hover:text-textPrimary disabled:opacity-25 leading-none text-xs px-1">▼</button>
              </div>
              <GripVertical className="w-4 h-4 text-textMuted" />
              <span className="text-xs font-medium text-textSecondary">Mirror {index + 1}</span>
              <label className="ml-auto flex items-center gap-1.5 text-xs text-textSecondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!link.is_primary}
                  onChange={(e) => update(index, 'is_primary', e.target.checked)}
                  className="accent-purple-500"
                />
                <Star className="w-3 h-3" /> Primary
              </label>
              <button
                type="button"
                onClick={() => remove(index)}
                className="p-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20"
                title="Remove link"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <span className="text-[11px] text-textMuted block mb-1">Label</span>
                <input
                  value={link.label || ''}
                  onChange={(e) => update(index, 'label', e.target.value)}
                  placeholder="Official Ubuntu Releases"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/50"
                />
              </div>
              <div>
                <span className="text-[11px] text-textMuted block mb-1">Provider</span>
                <select
                  value={link.storage_provider || 'external'}
                  onChange={(e) => update(index, 'storage_provider', e.target.value)}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/50"
                >
                  {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2">
                <span className="text-[11px] text-textMuted block mb-1">Download URL</span>
                <input
                  value={link.download_url || ''}
                  onChange={(e) => update(index, 'download_url', e.target.value)}
                  placeholder={link.storage_provider === 'torrent' ? 'magnet:?xt=urn:btih:... or https://.../file.torrent' : 'https://...'}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono focus:outline-none focus:border-primary/50"
                />
              </div>
              <div>
                <span className="text-[11px] text-textMuted block mb-1">Storage path / file ID</span>
                <input
                  value={link.storage_path || ''}
                  onChange={(e) => update(index, 'storage_path', e.target.value)}
                  placeholder="Drive file ID or path"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono focus:outline-none focus:border-primary/50"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-[11px] text-textMuted block mb-1">Size (bytes)</span>
                  <input
                    type="number"
                    value={link.file_size ?? ''}
                    onChange={(e) => update(index, 'file_size', e.target.value)}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/50"
                  />
                </div>
                <div>
                  <span className="text-[11px] text-textMuted block mb-1">Status</span>
                  <select
                    value={link.status || 'up'}
                    onChange={(e) => update(index, 'status', e.target.value)}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/50"
                  >
                    {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="sm:col-span-2">
                <label className="flex items-center gap-2 text-xs text-textSecondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!link.is_down}
                    onChange={(e) => update(index, 'is_down', e.target.checked)}
                    className="accent-red-500"
                  />
                  Mark this mirror as down (blocks downloads, keeps the record)
                </label>
                {link.is_down && (
                  <input
                    value={link.down_reason || ''}
                    onChange={(e) => update(index, 'down_reason', e.target.value)}
                    placeholder="Why is it down? (shown to visitors)"
                    className="mt-2 w-full px-3 py-2 bg-background border border-red-500/30 rounded-lg text-sm focus:outline-none focus:border-red-500/60"
                  />
                )}
              </div>

              {/* Health checker verdict (saved mirrors only). */}
              {link.id && (
                <div className="sm:col-span-2 flex flex-wrap items-center gap-2 pt-1">
                  <HealthBadge link={link} />
                  <button
                    type="button"
                    onClick={() => checkNow(index)}
                    disabled={checking === link.id}
                    className="px-2.5 py-1 rounded-lg bg-surface border border-border text-[11px] text-textSecondary hover:border-primary/40 flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {checking === link.id ? <LoadingDots size={12} /> : <Activity className="w-3 h-3" />}
                    Check now
                  </button>
                  {link.check_error && link.status !== 'up' && (
                    <span className="text-[11px] text-textMuted">{link.check_error}</span>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
