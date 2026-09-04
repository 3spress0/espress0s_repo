import { lazy, Suspense, useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Download, HardDrive, Calendar, Tag, Shield, Cpu, Monitor, FileType, Hash, ExternalLink, ArrowLeft, Eye, Clock, Music, Video, Play, Image as ImageIcon, Disc, File, Link2, Star, Lock, AlertTriangle, Pencil, Folder } from 'lucide-react';
import { itemsApi } from '../lib/api';
import { formatBytes, formatDate, startDownload } from '../lib/utils';
import { ItemPlaceholder } from '../components/Logo';
import Markdown from '../lib/markdown.jsx';
import { useAuth } from '../context/AuthContext';
import FavoriteButton from '../components/FavoriteButton';
import Loading, { LoadingDots } from '../components/Loading';

const REQ_LABEL = { os: 'OS', runtime: 'Runtime', hardware: 'Hardware', dependency: 'Depends on', other: 'Other' };

// The editor is ~1k lines and only appears when an admin clicks "Edit this
// page", so it is not worth putting in the bundle every visitor parses.
const ItemEditor = lazy(() => import('../components/admin/ItemEditor'));

export default function ItemDetail() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { isAuthenticated, isEditor, loading: authLoading } = useAuth();
  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [favoriteError, setFavoriteError] = useState('');

  useEffect(() => {
    setLoading(true);
    itemsApi.get(slug)
      .then(setItem)
      .catch(err => setError(err.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [slug]);

  // Auth is an httpOnly cookie - fetch() with credentials sends it for us;
  // no token ever touches JS-readable storage.
  const handleDownload = async (linkId = null) => {
    if (!isAuthenticated) {
      navigate('/login?redirect=' + encodeURIComponent(window.location.pathname));
      return;
    }
    try {
      const baseUrl = linkId ? `/api/download/${item.id}/${linkId}` : `/api/download/${item.id}`;
      const response = await fetch(`${baseUrl}?json=1`, {
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json', 'X-Requested-With': 'fetch' }
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Download failed' }));
        if (response.status === 401) { navigate('/login?redirect=' + encodeURIComponent(window.location.pathname)); return; }
        if (response.status === 503) { alert(`Mirror down: ${err.reason || err.error}`); return; }
        throw new Error(err.error || 'Download failed');
      }
      const data = await response.json();
      if (data.downloadUrl) {
        startDownload(data.downloadUrl, data.fileName);
      }
    } catch (e) {
      alert(`Download failed: ${e.message}`);
    }
  };

  const handlePreview = async () => {
    if (!item) return;
    if (!isAuthenticated) {
      navigate('/login?redirect=' + encodeURIComponent(window.location.pathname));
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      if (item.file_size && item.file_size > 50 * 1024 * 1024) {
        setPreviewError('File too large for preview (max 50MB). Please download directly.');
        setPreviewLoading(false);
        return;
      }
      const response = await fetch(`/api/preview/${item.id}`, { credentials: 'same-origin' });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Preview failed' }));
        if (response.status === 401) { navigate('/login'); throw new Error('Login required for preview'); }
        throw new Error(err.error || 'Preview failed');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
    } catch (e) {
      setPreviewError(e.message);
    } finally {
      setPreviewLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Loading size={36} text="Loading this page…" className="mb-8" />
        <div className="animate-pulse space-y-6">
          <div className="h-8 bg-surface rounded w-1/4" />
          <div className="h-64 bg-surface rounded-3xl" />
          <div className="h-96 bg-surface rounded-3xl" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-20 text-center">
        <h1 className="text-2xl font-bold text-textPrimary mb-2">File not found</h1>
        <p className="text-textMuted mb-6">{error}</p>
        <Link to="/browse" className="px-6 py-2.5 bg-gradient-primary text-white rounded-xl inline-flex items-center gap-2">
          <ArrowLeft className="w-4 h-4" />
          Browse repository
        </Link>
      </div>
    );
  }

  if (!item) return null;

  const downloadLinks = item.download_links || [];
  const availableLinks = item.available_links || downloadLinks.filter(l => !l.is_down && l.status !== 'down');
  const downLinks = downloadLinks.filter(l => l.is_down || l.status === 'down');
  const hasMultipleMirrors = downloadLinks.length > 1;
  const primaryLink = item.primary_download || availableLinks.find(l => l.is_primary) || availableLinks[0] || downloadLinks.find(l => l.is_primary) || downloadLinks[0];
  
  const isAudio = ['mp3','wav','flac','ogg','m4a','aac'].includes(item.file_type?.toLowerCase());
  const isVideo = ['mp4','webm','mkv','avi','mov'].includes(item.file_type?.toLowerCase());
  const isImage = ['jpg','jpeg','png','gif','webp','svg'].includes(item.file_type?.toLowerCase());
  const isMedia = isAudio || isVideo || isImage;
  const canPreview = isMedia && (!item.file_size || item.file_size <= 50 * 1024 * 1024);

  const licenseColors = {
    'public-domain': 'bg-green-500/10 text-green-400 border-green-500/20',
    'redistributable': 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    'proprietary': 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    'check-license': 'bg-red-500/10 text-red-400 border-red-500/20',
    'internal-only': 'bg-gray-500/10 text-gray-400 border-gray-500/20',
    'abandonware': 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  };

  const providerIcons = { 'gdrive': 'G', 'onedrive': 'O', 'external': 'E', 'github': 'GH', 'local': 'L' };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 pb-28 md:pb-8">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <Link to="/browse" className="inline-flex items-center gap-2 text-sm text-textSecondary hover:text-primary transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Back to browse
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          <FavoriteButton
            itemId={item.id}
            slug={item.slug}
            isFavorite={item.is_favorite}
            count={item.favorites_count}
            onError={(message) => setFavoriteError(message)}
          />

          {/* Admins edit the page they are looking at - no detour through /admin. */}
          {isEditor && !editing && (
            <button
              onClick={() => setEditing(true)}
              className="px-4 py-2 bg-gradient-primary text-white rounded-xl text-sm font-medium shadow-lg shadow-purple-500/20 flex items-center gap-2"
            >
              <Pencil className="w-4 h-4" />
              Edit this page
            </button>
          )}
        </div>
      </div>

      {favoriteError && (
        <div className="mb-6 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{favoriteError}</span>
          <button onClick={() => setFavoriteError('')} className="ml-auto text-xs underline">Dismiss</button>
        </div>
      )}

      {editing && (
        <div className="mb-6">
          <div className="mb-3 p-3 rounded-xl bg-purple-500/10 border border-purple-500/20 text-sm text-purple-300 flex items-center gap-2">
            <Pencil className="w-4 h-4 flex-shrink-0" />
            <span>You are editing this page. Changes are visible to all visitors as soon as you save.</span>
          </div>
          <Suspense fallback={<Loading text="Loading the editor…" />}>
          <ItemEditor
            item={item}
            onClose={() => setEditing(false)}
            onSaved={async () => {
              setEditing(false);
              const fresh = await itemsApi.get(slug).catch(() => null);
              if (fresh) setItem(fresh);
            }}
          />
          </Suspense>
        </div>
      )}

      <div className="glass rounded-3xl border border-white/5 overflow-hidden mb-6">
        <div className="h-1 w-full bg-gradient-primary" />
        {(item.image_url || item.icon_url) && (
          <div className="relative h-52 sm:h-64 md:h-80 overflow-hidden bg-surfaceHover">
            <img src={item.image_url || item.icon_url} alt={item.name} decoding="async" className="w-full h-full object-cover" onError={(e) => e.target.style.display = 'none'} />
            <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/50 to-transparent" />
            <div className="absolute bottom-4 left-4 right-4 sm:left-8 sm:right-8">
              <h1 className="text-3xl sm:text-4xl font-bold text-white leading-tight drop-shadow-lg">{item.name}</h1>
              <p className="text-white/80 mt-2 drop-shadow">{item.description}</p>
            </div>
          </div>
        )}
        <div className="p-4 sm:p-6 lg:p-8">
          <div className="flex flex-col md:flex-row gap-6">
            {!(item.image_url || item.icon_url) && (
              <div className="w-20 h-20 rounded-2xl bg-gradient-subtle border border-white/5 flex items-center justify-center flex-shrink-0">
                <FileTypeIcon type={item.file_type} size={36} />
              </div>
            )}
            <div className="flex-1 min-w-0">
              {!(item.image_url || item.icon_url) && (
                <>
                  <div className="flex flex-wrap items-start gap-3 mb-3">
                    <h1 className="text-3xl font-bold text-textPrimary leading-tight">{item.name}</h1>
                    {item.featured ? <span className="px-3 py-1 rounded-full bg-gradient-primary text-white text-xs font-bold uppercase tracking-widest">Featured</span> : null}
                  </div>
                  <p className="text-textSecondary text-lg leading-relaxed mb-4">{item.description}</p>
                </>
              )}
              <div className="flex flex-wrap gap-2">
                {item.category_name && (
                  <Link to={`/browse?category=${item.category_slug}`} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surfaceHover border border-border text-xs font-medium hover:border-primary/30 hover:text-primary transition-colors">
                    <Tag className="w-3 h-3" />
                    {item.category_name}
                  </Link>
                )}
                {item.folder_name && (
                  <Link to={`/browse?folder=${item.folder_slug}`} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surfaceHover border border-border text-xs font-medium hover:border-primary/30 hover:text-primary transition-colors">
                    <Folder className="w-3 h-3" style={item.folder_color ? { color: item.folder_color } : undefined} />
                    {item.folder_name}
                  </Link>
                )}
                {item.version && <span className="px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-xs font-medium text-primary">v{item.version}</span>}
                <span className={`px-3 py-1.5 rounded-full border text-xs font-medium ${licenseColors[item.license_status] || licenseColors['check-license']}`}>{item.license_status}</span>
                {hasMultipleMirrors && <span className="px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-xs font-medium text-blue-400 flex items-center gap-1"><Link2 className="w-3 h-3" />{downloadLinks.length} mirrors, {availableLinks.length} up</span>}
                {downLinks.length > 0 && <span className="px-3 py-1.5 rounded-full bg-red-500/10 border border-red-500/20 text-xs font-medium text-red-400 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{downLinks.length} down</span>}
              </div>
            </div>

            <div className="md:w-72 flex-shrink-0 space-y-3">
              {authLoading ? (
                <div className="glass rounded-2xl border border-white/5 p-4 text-center">
                  <LoadingDots size={32} className="mb-2" />
                  <p className="text-xs text-textMuted">Checking login...</p>
                </div>
              ) : !isAuthenticated ? (
                <div className="glass rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 text-center">
                  <Lock className="w-8 h-8 mx-auto mb-2 text-amber-400" />
                  <p className="text-sm font-medium text-amber-300">Login required to download</p>
                  <p className="text-xs text-amber-200/60 mt-1">All downloads require authentication</p>
                  <Link to={`/login?redirect=/file/${item.slug}`} className="mt-3 inline-flex items-center gap-2 px-5 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium">
                    <Lock className="w-4 h-4" />Login to Download
                  </Link>
                </div>
              ) : availableLinks.length === 0 && downloadLinks.length > 0 ? (
                <div className="glass rounded-2xl border border-red-500/20 bg-red-500/5 p-4 text-center">
                  <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-red-400" />
                  <p className="text-sm font-medium text-red-300">All mirrors down</p>
                  <p className="text-xs text-red-200/60 mt-1">{downLinks.length} mirrors marked as down</p>
                </div>
              ) : (
                <button onClick={() => handleDownload()} className="w-full flex items-center justify-center gap-2 px-6 py-4 bg-gradient-primary hover:bg-gradient-primary-hover text-white rounded-2xl font-semibold shadow-xl shadow-purple-500/20 hover:shadow-purple-500/30 transition-all hover:-translate-y-0.5">
                  <Download className="w-5 h-5" />Download {primaryLink ? `• ${primaryLink.label}` : ''}
                </button>
              )}

              {canPreview && (
                <button onClick={handlePreview} disabled={previewLoading} className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-surface border border-border hover:border-primary/30 rounded-2xl font-medium text-sm transition-all disabled:opacity-50">
                  {previewLoading ? <><LoadingDots size={16} /> Loading...</> : <><Play className="w-4 h-4" />Preview {isAudio ? 'Audio' : isVideo ? 'Video' : 'Media'}</>}
                </button>
              )}
              
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="glass rounded-xl p-3 text-center border border-white/5">
                  <div className="text-textMuted flex items-center justify-center gap-1 mb-1"><Eye className="w-3 h-3" /> Views</div>
                  <div className="font-bold text-textPrimary">{item.view_count || 0}</div>
                </div>
                <div className="glass rounded-xl p-3 text-center border border-white/5">
                  <div className="text-textMuted flex items-center justify-center gap-1 mb-1"><Download className="w-3 h-3" /> Downloads</div>
                  <div className="font-bold text-textPrimary">{item.download_count || 0}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {downloadLinks.length > 0 && (
        <div className="glass rounded-2xl border border-white/5 p-6 mb-6">
          <h3 className="font-semibold text-textPrimary mb-4 flex items-center gap-2">
            <Link2 className="w-5 h-5 text-primary" />
            Download Mirrors ({downloadLinks.length} total, {availableLinks.length} up, {downLinks.length} down)
          </h3>
          
          <div className="grid sm:grid-cols-2 gap-3">
            {downloadLinks.map((link) => {
              const isDown = link.is_down || link.status === 'down';
              return (
                <div
                  key={link.id}
                  className={`group relative flex items-center gap-3 p-4 rounded-xl border transition-all ${
                    isDown ? 'bg-red-500/5 border-red-500/20 opacity-75' :
                    link.is_primary ? 'bg-gradient-to-br from-primary/10 to-blue-500/10 border-primary/30 hover:border-primary/50 hover:shadow-purple-500/10 hover:-translate-y-0.5' 
                    : 'bg-surface border-border hover:border-primary/30 hover:shadow-black/20 hover:-translate-y-0.5'
                  }`}
                >
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-bold text-xs flex-shrink-0 ${
                    isDown ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
                    link.is_primary ? 'bg-gradient-primary text-white shadow-lg' : 'bg-surfaceHover border border-border text-textSecondary'
                  }`}>
                    {isDown ? '!' : providerIcons[link.storage_provider] || link.storage_provider[0]?.toUpperCase()}
                  </div>
                  
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`font-medium text-sm truncate ${isDown ? 'text-textMuted line-through' : 'text-textPrimary group-hover:text-white'}`}>{link.label}</span>
                      {link.is_primary && !isDown && <Star className="w-3 h-3 text-amber-400 fill-amber-400" />}
                      {isDown && <span className="px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 text-[9px] font-bold uppercase">Down</span>}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-textMuted mt-0.5">
                      <span className="capitalize">{link.storage_provider}</span>
                      <span>•</span>
                      <span>{link.file_size ? formatBytes(link.file_size) : formatBytes(item.file_size)}</span>
                      <span>•</span>
                      <span>{link.download_count || 0} dl</span>
                    </div>
                    {isDown && link.down_reason && (
                      <div className="text-xs text-red-400/80 mt-1 truncate">Reason: {link.down_reason}</div>
                    )}
                  </div>
                  
                  {!isDown ? (
                    <button onClick={() => handleDownload(link.id)} className="p-2 rounded-xl bg-surfaceHover border border-border group-hover:border-primary/30 group-hover:text-primary transition-all">
                      <Download className="w-4 h-4" />
                    </button>
                  ) : (
                    <div className="p-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400">
                      <AlertTriangle className="w-4 h-4" />
                    </div>
                  )}
                  
                  {link.is_primary && !isDown && (
                    <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-[9px] font-bold uppercase">Primary</div>
                  )}
                </div>
              );
            })}
          </div>
          
          {!isAuthenticated && (
            <div className="mt-4 p-3 rounded-xl bg-amber-500/5 border border-amber-500/20 text-xs text-amber-300/80 flex items-center gap-2">
              <Lock className="w-4 h-4" />
              <span><strong>Login required:</strong> You must be logged in to download. All mirrors encrypted at rest.</span>
            </div>
          )}
        </div>
      )}

      {(previewUrl || previewError) && (
        <div className="glass rounded-2xl border border-white/5 p-6 mb-6">
          <h3 className="font-semibold text-textPrimary mb-4 flex items-center gap-2"><Play className="w-4 h-4 text-primary" />Media Preview</h3>
          {previewError ? <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400">{previewError}</div> : previewUrl && (
            <div className="space-y-3">
              {isAudio && <audio controls src={previewUrl} className="w-full" />}
              {isVideo && <video controls src={previewUrl} className="w-full rounded-xl max-h-96" />}
              {isImage && <img src={previewUrl} alt="Preview" loading="lazy" decoding="async" className="w-full rounded-xl max-h-96 object-contain" />}
              <p className="text-xs text-textMuted">Preview from {item.storage_provider} (max 50MB, login required). <button onClick={() => { URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }} className="ml-2 text-primary hover:underline">Close</button></p>
            </div>
          )}
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {item.long_description && (
            <div className="glass rounded-2xl border border-white/5 p-6">
              <h2 className="font-semibold text-textPrimary mb-3">About</h2>
              {/* Admin-authored markdown, rendered as React elements (no raw HTML). */}
              <Markdown>{item.long_description}</Markdown>
            </div>
          )}
          {item.changelog && (
            <div className="glass rounded-2xl border border-white/5 p-6">
              <h2 className="font-semibold text-textPrimary mb-3">Changelog</h2>
              <Markdown>{item.changelog}</Markdown>
            </div>
          )}
          {Array.isArray(item.requirements) && item.requirements.length > 0 && (
            <div className="glass rounded-2xl border border-white/5 p-6">
              <h2 className="font-semibold text-textPrimary mb-4 flex items-center gap-2"><Cpu className="w-4 h-4 text-primary" />Requirements</h2>
              <ul className="space-y-2 text-sm">
                {item.requirements.map((r, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-[11px] uppercase tracking-wide text-textMuted w-24 flex-shrink-0">{REQ_LABEL[r.type] || 'Other'}</span>
                    <span className="text-textPrimary font-medium">{r.name}</span>
                    {r.version && <span className="font-mono text-xs text-textSecondary">{r.version}</span>}
                    {r.optional && <span className="text-[11px] px-1.5 py-0.5 rounded bg-surface border border-border text-textMuted">optional</span>}
                    {r.note && <span className="text-xs text-textMuted">— {r.note}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="glass rounded-2xl border border-white/5 p-6">
            <h2 className="font-semibold text-textPrimary mb-4 flex items-center gap-2"><FileType className="w-4 h-4 text-primary" />File Details</h2>
            <div className="grid sm:grid-cols-2 gap-4 text-sm">
              <DetailRow icon={FileType} label="File Name" value={item.file_name} mono />
              <DetailRow icon={HardDrive} label="File Size" value={`${formatBytes(item.file_size)} (${item.file_size?.toLocaleString() || 0} bytes)`} />
              <DetailRow icon={FileType} label="File Type" value={item.file_type?.toUpperCase()} />
              <DetailRow icon={Monitor} label="Platform" value={item.platform} />
              <DetailRow icon={Cpu} label="Architecture" value={item.architecture} />
              <DetailRow icon={Calendar} label="Release Date" value={formatDate(item.release_date)} />
              <DetailRow icon={Clock} label="Added" value={formatDate(item.created_at)} />
              <DetailRow icon={Tag} label="Category" value={item.category_name} />
              {item.folder_name && <DetailRow icon={Folder} label="Folder" value={item.folder_name} />}
            </div>
            {item.sha256 && (
              <div className="mt-6 pt-6 border-t border-white/5">
                <h3 className="text-xs font-medium text-textMuted uppercase tracking-widest mb-3 flex items-center gap-2"><Hash className="w-3 h-3" />Checksums</h3>
                <div className="bg-surface rounded-xl p-3 border border-border">
                  <div className="text-[11px] text-textMuted mb-1">SHA-256</div>
                  <code className="text-xs font-mono text-textPrimary break-all">{item.sha256}</code>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="space-y-6">
          <div className="glass rounded-2xl border border-white/5 p-6">
            <h3 className="font-semibold text-textPrimary mb-4">Download Info</h3>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between"><span className="text-textMuted">Mirrors</span><span className="font-medium text-textPrimary">{downloadLinks.length} ({availableLinks.length} up)</span></div>
              <div className="flex justify-between"><span className="text-textMuted">Login Required</span><span className="font-medium text-amber-400">Yes</span></div>
              <div className="flex justify-between"><span className="text-textMuted">Encrypted</span><span className="font-medium text-green-400">AES-256-GCM</span></div>
              <div className="flex justify-between"><span className="text-textMuted">Favourited by</span><span className="font-medium text-textPrimary">{(item.favorites_count || 0).toLocaleString()}</span></div>
              {isAuthenticated && item.favorite_is_public && (
                <div className="flex justify-between"><span className="text-textMuted">On your profile</span><span className="font-medium text-amber-400">Shared</span></div>
              )}

              {/* Accounts that shared this file. Only public favourites appear,
                  so every name here is a profile its owner chose to publish. */}
              {item.shared_by?.length > 0 && (
                <div className="pt-1">
                  <div className="text-textMuted mb-2">Shared by</div>
                  <div className="flex flex-wrap gap-1.5">
                    {item.shared_by.map(account => (
                      <Link
                        key={account.id}
                        to={`/u/${account.username}`}
                        title={`${account.username}'s profile`}
                        className="w-8 h-8 rounded-full bg-surfaceHover border border-border overflow-hidden hover:border-amber-500/40 transition-colors flex items-center justify-center text-[11px] font-bold text-textSecondary"
                      >
                        {account.avatar_url ? (
                          <img
                            src={account.avatar_url}
                            alt={account.username}
                            loading="lazy"
                            decoding="async"
                            className="w-full h-full object-cover"
                            onError={(e) => { e.target.style.display = 'none'; }}
                          />
                        ) : (
                          account.username[0]?.toUpperCase()
                        )}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Phones: the primary action stays one thumb-tap away no matter how
          far down the page the reader is. The 5xl header card sits below the
          fold on a small phone, so without this the Download button is a
          scroll away on the page that matters most. Hidden at md+ where the
          header button is already reachable. */}
      {(downloadLinks.length > 0 || !isAuthenticated) && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-surface md:hidden">
          <div className="px-4 pt-3 pb-safe">
            {authLoading ? (
              <div className="flex items-center justify-center gap-2 py-2 text-sm text-textMuted">
                <LoadingDots size={16} /> Checking login…
              </div>
            ) : !isAuthenticated ? (
              <Link
                to={`/login?redirect=${encodeURIComponent(`/file/${item.slug}`)}`}
                className="flex items-center justify-center gap-2 w-full py-3 bg-gradient-primary text-white rounded-xl font-semibold text-sm"
              >
                <Lock className="w-4 h-4" /> Login to Download
              </Link>
            ) : availableLinks.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-3 text-sm font-medium text-red-400">
                <AlertTriangle className="w-4 h-4" /> All mirrors down
              </div>
            ) : (
              <button
                onClick={() => handleDownload()}
                className="flex items-center justify-center gap-2 w-full py-3 bg-gradient-primary active:bg-gradient-primary-hover text-white rounded-xl font-semibold text-sm"
              >
                <Download className="w-5 h-5" />
                <span className="truncate">Download{primaryLink ? ` • ${primaryLink.label}` : ''}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailRow({ icon: Icon, label, value, mono }) {
  if (!value) return null;
  return (
    <div className="flex gap-3">
      <div className="w-8 h-8 rounded-lg bg-surface border border-border flex items-center justify-center flex-shrink-0">
        <Icon className="w-4 h-4 text-textMuted" />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-textMuted uppercase tracking-wide">{label}</div>
        <div className={`text-sm font-medium text-textPrimary mt-0.5 ${mono ? 'font-mono text-xs break-all' : ''}`}>{value}</div>
      </div>
    </div>
  );
}

function FileTypeIcon({ type, size = 36 }) {
  const lower = (type || '').toLowerCase();
  if (['iso','img','dmg'].includes(lower)) return <Disc className="text-primary" style={{ width: size, height: size }} />;
  if (['mp3','wav','flac','ogg','m4a','aac'].includes(lower)) return <Music className="text-primary" style={{ width: size, height: size }} />;
  if (['mp4','mkv','avi','webm','mov'].includes(lower)) return <Video className="text-primary" style={{ width: size, height: size }} />;
  return <File className="text-primary" style={{ width: size, height: size }} />;
}
