import { Link } from 'react-router-dom';
import { Download, HardDrive, Cpu, Monitor, Music, Video, FileText, Disc, Package, File, AppWindow } from 'lucide-react';
import { formatBytes, formatRelativeTime } from '../lib/utils';
import { ItemPlaceholder } from './Logo';

export default function ItemCard({ item, featured = false }) {
  const tags = typeof item.tags === 'string' ? (() => { try { return JSON.parse(item.tags); } catch { return []; } })() : (item.tags || []);
  const hasBanner = item.image_url;
  const hasLogo = item.icon_url;
  const bannerIsSvg = hasBanner && item.image_url.toLowerCase().endsWith('.svg');

  return (
    <Link
      to={`/file/${item.slug}`}
      className={`group relative block rounded-2xl border transition-all hover:-translate-y-1 hover:shadow-xl overflow-hidden ${
        featured
          ? 'bg-gradient-to-br from-surface to-surface border-purple-500/30 hover:border-purple-500/50 hover:shadow-purple-500/10 p-[1px]'
          : 'bg-surface border-border hover:border-primary/30 hover:shadow-black/20'
      }`}
    >
      <div className={featured ? 'rounded-2xl bg-surface h-full overflow-hidden' : 'h-full overflow-hidden'}>
        {/* Banner header - different from logo */}
        <div className="relative h-36 overflow-hidden bg-surfaceHover">
          {hasBanner ? (
            <>
              <img 
                src={item.image_url} 
                alt={item.name}
                className={`w-full h-full transition-transform duration-500 group-hover:scale-105 ${bannerIsSvg ? 'object-contain p-4' : 'object-cover'}`}
                style={{ background: bannerIsSvg ? '#1a1a26' : 'transparent' }}
                onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }}
              />
              <div className="hidden w-full h-full items-center justify-center bg-gradient-to-br from-surface to-surfaceHover">
                <ItemPlaceholder fileType={item.file_type} size="medium" />
              </div>
            </>
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-surface to-surfaceHover">
              <ItemPlaceholder fileType={item.file_type} size="medium" />
            </div>
          )}
          
          <div className="absolute inset-0 bg-gradient-to-t from-surface to-transparent opacity-70" />
          
          {/* Logo overlay - small icon in top-left, different from banner */}
          {hasLogo && (
            <div className="absolute top-3 left-3 w-10 h-10 rounded-xl bg-white/90 backdrop-blur-md border border-white/20 flex items-center justify-center shadow-lg overflow-hidden p-1.5">
              <img src={item.icon_url} alt="logo" className="w-full h-full object-contain" onError={(e) => e.target.style.display = 'none'} />
            </div>
          )}
          
          {!hasLogo && hasBanner && (
            <div className="absolute top-3 left-3 w-10 h-10 rounded-xl bg-black/60 backdrop-blur-md border border-white/10 flex items-center justify-center">
              <FileTypeIcon type={item.file_type} size={20} />
            </div>
          )}

          {featured && (
            <div className="absolute top-3 right-3 px-2.5 py-1 rounded-full bg-gradient-primary text-white text-[10px] font-bold tracking-widest uppercase shadow-lg">
              Featured
            </div>
          )}
          
          <div className="absolute bottom-3 left-3 flex gap-2">
            {item.platform && (
              <span className="px-2 py-1 rounded-full bg-black/60 backdrop-blur-md text-white text-[10px] font-medium border border-white/10">
                {item.platform}
              </span>
            )}
            {item.architecture && (
              <span className="px-2 py-1 rounded-full bg-black/60 backdrop-blur-md text-white text-[10px] font-medium border border-white/10">
                {item.architecture}
              </span>
            )}
          </div>
        </div>

        <div className="p-5">
          <div className="flex items-start gap-3 mb-3">
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-textPrimary group-hover:text-white transition-colors line-clamp-1 text-[15px] leading-tight">
                {item.name}
              </h3>
              <p className="text-xs text-textMuted mt-0.5 line-clamp-1">
                {item.version ? `v${item.version}` : ''} {item.file_name ? `• ${item.file_name}` : ''}
              </p>
            </div>
          </div>

          <p className="text-sm text-textSecondary line-clamp-2 mb-4 leading-relaxed min-h-[2.5rem]">
            {item.description}
          </p>

          <div className="flex flex-wrap gap-2 mb-4">
            {item.file_type && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-surfaceHover border border-border text-xs text-textSecondary uppercase font-medium">
                <FileTypeIconSmall type={item.file_type} />
                {item.file_type}
              </span>
            )}
            {item.folder_name && (
              <span
                className="px-2.5 py-1 rounded-full bg-surfaceHover border border-border text-xs text-textSecondary"
                title={`Folder: ${item.folder_name}`}
              >
                {item.folder_icon ? `${item.folder_icon} ` : ''}{item.folder_name}
              </span>
            )}
            {item.download_links_count !== undefined && (
              <span className="px-2.5 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-xs text-blue-400">
                {item.download_links_count} mirrors
              </span>
            )}
            {item.available_links_count !== undefined && item.available_links_count !== item.download_links_count && (
              <span className="px-2.5 py-1 rounded-full bg-green-500/10 border border-green-500/20 text-xs text-green-400">
                {item.available_links_count} up
              </span>
            )}
          </div>

          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-4">
              {tags.slice(0, 3).map((tag, i) => (
                <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                  #{tag}
                </span>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between pt-3 border-t border-white/5">
            <div className="flex items-center gap-3 text-xs text-textMuted">
              <span className="flex items-center gap-1">
                <HardDrive className="w-3 h-3" />
                {formatBytes(item.file_size)}
              </span>
              <span className="flex items-center gap-1">
                <Download className="w-3 h-3" />
                {item.download_count || 0}
              </span>
            </div>
            <span className="text-xs text-textMuted">
              {formatRelativeTime(item.created_at)}
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}

function FileTypeIcon({ type, size = 20 }) {
  const lower = (type || '').toLowerCase();
  if (['iso','img','dmg'].includes(lower)) return <Disc className="text-primary" style={{ width: size, height: size }} />;
  if (['mp3','wav','flac','ogg','m4a','aac'].includes(lower)) return <Music className="text-primary" style={{ width: size, height: size }} />;
  if (['mp4','mkv','avi','webm','mov'].includes(lower)) return <Video className="text-primary" style={{ width: size, height: size }} />;
  if (['zip','tar','gz','rar','7z'].includes(lower)) return <Package className="text-primary" style={{ width: size, height: size }} />;
  if (['pdf','doc','docx','txt'].includes(lower)) return <FileText className="text-primary" style={{ width: size, height: size }} />;
  if (['exe','msi','app'].includes(lower)) return <AppWindow className="text-primary" style={{ width: size, height: size }} />;
  return <File className="text-primary" style={{ width: size, height: size }} />;
}

function FileTypeIconSmall({ type }) {
  const lower = (type || '').toLowerCase();
  if (['mp3','wav','flac','ogg','m4a'].includes(lower)) return <Music className="w-3 h-3" />;
  if (['mp4','mkv','avi','webm','mov'].includes(lower)) return <Video className="w-3 h-3" />;
  if (['pdf','doc','docx','txt'].includes(lower)) return <FileText className="w-3 h-3" />;
  return null;
}
