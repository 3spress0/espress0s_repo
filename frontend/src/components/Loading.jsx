export default function Loading({ size = 40, text = 'Loading...', fullScreen = false }) {
  const content = (
    <div className="flex flex-col items-center justify-center gap-4">
      <img 
        src="/loading_dots_white.gif" 
        alt="Loading"
        width={size}
        height={size}
        className="opacity-80"
        style={{ imageRendering: 'auto' }}
        onError={(e) => {
          // Fallback to CSS dots if gif fails
          e.target.style.display = 'none';
          e.target.nextSibling.style.display = 'flex';
        }}
      />
      <div className="hidden gap-1.5">
        <div className="w-2.5 h-2.5 rounded-full bg-white animate-bounce" style={{ animationDelay: '0s' }} />
        <div className="w-2.5 h-2.5 rounded-full bg-white animate-bounce" style={{ animationDelay: '0.15s' }} />
        <div className="w-2.5 h-2.5 rounded-full bg-white animate-bounce" style={{ animationDelay: '0.3s' }} />
      </div>
      {text && <p className="text-sm text-textMuted animate-pulse">{text}</p>}
    </div>
  );

  if (fullScreen) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
        {content}
      </div>
    );
  }

  return content;
}

export function LoadingDots({ size = 24 }) {
  return (
    <img 
      src="/loading_dots_white.gif" 
      alt="Loading"
      width={size}
      height={size}
      className="opacity-70"
    />
  );
}
