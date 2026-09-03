/**
 * The app's one loading language: the `loading_dots_white.gif` dots, with an
 * optional label. Every wait in the product comes from here — full-screen
 * gates, page and panel placeholders, inline button spinners, and the boot
 * screen in index.html — so a short wait and a long one look alike.
 * `Progress.jsx` is the sibling for when the percentage is actually known.
 */

const DOTS_SRC = '/loading_dots_white.gif';

/**
 * @param size        dots diameter in px
 * @param text        label under the dots; pass null for dots only
 * @param fullScreen  paint a blurred overlay over the page instead of inline
 * @param className   extra classes on the wrapper
 */
export default function Loading({ size = 40, text = 'Loading...', fullScreen = false, className = '' }) {
  const content = (
    <div className={`flex flex-col items-center justify-center gap-4 ${className}`} role="status" aria-live="polite">
      <Dots size={size} />
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

/** The dots on their own, with the CSS fallback if the gif ever fails to load. */
export function Dots({ size = 24, className = '' }) {
  return (
    <span className={`inline-flex flex-col items-center ${className}`}>
      <img
        src={DOTS_SRC}
        alt=""
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
      <span className="hidden gap-1.5">
        <span className="w-2.5 h-2.5 rounded-full bg-white animate-bounce" style={{ animationDelay: '0s' }} />
        <span className="w-2.5 h-2.5 rounded-full bg-white animate-bounce" style={{ animationDelay: '0.15s' }} />
        <span className="w-2.5 h-2.5 rounded-full bg-white animate-bounce" style={{ animationDelay: '0.3s' }} />
      </span>
    </span>
  );
}

/** Inline dots for buttons, table cells and captions. */
export function LoadingDots({ size = 24, className = '' }) {
  return <Dots size={size} className={className} />;
}

/**
 * Page-level loading state: centred dots and a label at the width of the page
 * they replace, so a route that fetches on mount does not flash an empty shell.
 */
export function LoadingPanel({ text = 'Loading...', size = 44, className = '' }) {
  return (
    <div className={`max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-20 text-center ${className}`}>
      <Loading size={size} text={text} />
    </div>
  );
}
