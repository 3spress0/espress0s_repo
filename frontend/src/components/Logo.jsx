import { useState } from 'react';

export default function Logo({ size = 36, showText = false, className = '' }) {
  const [hover, setHover] = useState(false);
  const [imgError, setImgError] = useState(false);

  return (
    <div 
      className={`flex items-center gap-3 ${className}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div 
        className="relative rounded-xl flex items-center justify-center shadow-lg transition-all duration-300 overflow-hidden"
        style={{ 
          width: size, 
          height: size,
          background: 'transparent',
          boxShadow: hover ? '0 0 30px rgba(139, 92, 246, 0.4), 0 0 60px rgba(59, 130, 246, 0.2)' : '0 4px 20px rgba(139, 92, 246, 0.2)',
          transform: hover ? 'scale(1.05) rotate(2deg)' : 'scale(1) rotate(0deg)'
        }}
      >
        {!imgError ? (
          <img 
            src="/logo.svg" 
            alt="espress0's repo"
            className="w-full h-full object-contain"
            style={{ background: 'transparent' }}
            onError={() => setImgError(true)}
          />
        ) : (
          // Fallback SVG with transparent bg
          <div 
            className="w-full h-full rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, rgb(var(--c-primary)) 0%, rgb(var(--c-secondary)) 100%)' }}
          >
            <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M8 12C8 8 11 6 16 6C21 6 24 8 24 12C24 16 21 18 16 18C11 18 8 16 8 12Z" fill="white" fillOpacity="0.95"/>
              <path d="M8 16C8 12 11 10 16 10C21 10 24 12 24 16C24 20 21 22 16 22C11 22 8 20 8 16Z" fill="white" fillOpacity="0.7"/>
              <path d="M8 20C8 16 11 14 16 14C21 14 24 16 24 20C24 24 21 26 16 26C11 26 8 24 8 20Z" fill="white" fillOpacity="0.4"/>
              <path d="M14 11C12.5 11 11.5 11.8 11.5 13.2C11.5 14.6 12.5 15.5 14.2 15.5H16.5C16.5 15.5 16.5 13.2 16.5 13.2C16.5 11.8 15.5 11 14 11ZM14.2 17C11.5 17 9.5 15.2 9.5 13.2C9.5 10.8 11.8 9 14.5 9C17.2 9 19 10.8 19 13.2V16H11.5C11.8 17.5 13 18.5 14.8 18.5C15.8 18.5 16.8 18.2 17.5 17.8L18.5 19.2C17.5 20 16 20.5 14.2 20.5V17Z" fill="#6d28d9"/>
            </svg>
          </div>
        )}
        
        <div 
          className="absolute inset-0 rounded-xl blur-xl transition-opacity duration-300 pointer-events-none"
          style={{ 
            background: 'linear-gradient(135deg, rgb(var(--c-primary)) 0%, rgb(var(--c-secondary)) 100%)',
            opacity: hover ? 0.3 : 0,
            zIndex: -1
          }}
        />
      </div>

      {showText && (
        <div className="flex flex-col">
          <span className="font-bold tracking-tight leading-none" style={{ fontSize: size * 0.4 }}>
            espress0's <span className="gradient-text">repo</span>
          </span>
          <span className="text-[10px] text-textMuted font-medium tracking-widest uppercase leading-none mt-1">
            Personal Archive
          </span>
        </div>
      )}
    </div>
  );
}

export function LogoLarge({ className = '' }) {
  const [imgError, setImgError] = useState(false);
  
  return (
    <div className={`flex flex-col items-center gap-4 ${className}`}>
      <div className="w-20 h-20 rounded-2xl overflow-hidden shadow-xl shadow-purple-500/20" style={{ background: 'transparent' }}>
        {!imgError ? (
          <img src="/logo.svg" alt="logo" className="w-full h-full object-contain" onError={() => setImgError(true)} />
        ) : (
          <Logo size={80} />
        )}
      </div>
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight">
          espress0's <span className="gradient-text">repo</span>
        </h1>
        <p className="text-xs text-textMuted tracking-widest uppercase mt-1">Personal Archive • Encrypted • Secure</p>
      </div>
    </div>
  );
}

// Offline SVG icons only - no emoji
export function ItemPlaceholder({ fileType, size = 'medium', className = '' }) {
  const sizeClasses = {
    small: 'w-11 h-11',
    medium: 'w-20 h-20',
    large: 'w-32 h-32',
    card: 'w-full h-48',
  };

  const iconSize = { small: 20, medium: 32, large: 48, card: 40 };

  return (
    <div className={`${sizeClasses[size]} rounded-2xl bg-gradient-to-br from-surface to-surfaceHover border border-white/5 flex flex-col items-center justify-center relative overflow-hidden group ${className}`}>
      <div className="absolute inset-0 bg-gradient-subtle opacity-0 group-hover:opacity-100 transition-opacity" />
      <div className="absolute inset-0 bg-gradient-to-br from-purple-500/10 to-blue-500/10 opacity-50" />
      <div className="relative z-10 text-primary">
        <FileIcon type={fileType} size={iconSize[size]} />
      </div>
      {size !== 'small' && (
        <span className="relative z-10 text-[10px] font-bold tracking-widest uppercase text-textMuted mt-2">
          {fileType || 'FILE'}
        </span>
      )}
      <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-gradient-primary opacity-60" />
    </div>
  );
}

function FileIcon({ type, size = 24 }) {
  const lower = (type || '').toLowerCase();
  const props = { width: size, height: size, className: "text-primary", fill: "none", stroke: "currentColor", strokeWidth: "1.5" };
  
  if (['iso','img','dmg'].includes(lower)) {
    return <svg {...props} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="3" /><path d="M12 2a10 10 0 0 1 10 10" /></svg>;
  }
  if (['mp3','wav','flac','ogg','m4a','aac'].includes(lower)) {
    return <svg {...props} viewBox="0 0 24 24"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>;
  }
  if (['mp4','mkv','avi','webm','mov'].includes(lower)) {
    return <svg {...props} viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="2" /><path d="M10 8l6 4-6 4V8z" /></svg>;
  }
  if (['zip','tar','gz','rar','7z'].includes(lower)) {
    return <svg {...props} viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /><path d="M12 10v6" /><path d="M9 13h6" /></svg>;
  }
  if (['pdf'].includes(lower)) {
    return <svg {...props} viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M10 9H8" /><path d="M10 13H8" /><path d="M10 17H8" /></svg>;
  }
  if (['exe','msi','dmg','app'].includes(lower)) {
    return <svg {...props} viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></svg>;
  }
  return <svg {...props} viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></svg>;
}

export function FileTypeBadge({ type, size = 18, className = '' }) {
  return (
    <span className={`inline-flex items-center justify-center ${className}`}>
      <FileIcon type={type} size={size} />
    </span>
  );
}
