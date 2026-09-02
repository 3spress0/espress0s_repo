import { useEffect, useRef } from 'react';
import { useTheme } from '../context/ThemeContext';

/**
 * The animated sky behind the hero, Ask, Account and 404 pages.
 *
 * Everything it paints comes from the active scheme: the two-stop sky gradient,
 * the star colour, the star glow, the shooting-star trail and the four aurora
 * blobs. That structure (sky / star / star-glow / shooting-star) is borrowed
 * from the Spicetify StarryNight theme's colour.ini, which is what makes a
 * palette swap restyle the whole sky instead of just the buttons.
 *
 * Respects the admin's effect toggles and, above them, prefers-reduced-motion:
 * with motion reduced the canvas is not animated at all — stars are drawn once,
 * static, and shooting stars are skipped.
 */
export default function StarryBackground() {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const { theme, effects } = useTheme();

  const { starfield, shootingStars: shootingEnabled, aurora: auroraEnabled, reducedMotion, starDensity } = effects;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    if (!starfield) {
      // Effects off: clear whatever a previous scheme drew.
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const ctx = canvas.getContext('2d');
    let animationId;
    let stars = [];
    let shooters = [];

    // Read the palette straight off the CSS variables so the canvas always
    // matches whatever ThemeProvider last painted.
    const rs = getComputedStyle(document.documentElement);
    const rgb = (name, fallback) => (rs.getPropertyValue(name).trim() || fallback);
    const STAR = rgb('--c-star', '255 255 255');
    const STAR_GLOW = rgb('--c-star-glow', '139 92 246');
    const SHOOT = rgb('--c-shooting-star', '255 255 255');
    const SHOOT_GLOW = rgb('--c-shooting-star-glow', '255 255 255');

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const initStars = () => {
      stars = [];
      const area = container.offsetWidth * container.offsetHeight;
      const count = Math.floor((area / 3000) * starDensity);
      for (let i = 0; i < count; i++) {
        stars.push({
          x: Math.random() * container.offsetWidth,
          y: Math.random() * container.offsetHeight,
          radius: Math.random() * 1.2 + 0.2,
          opacity: Math.random() * 0.8 + 0.2,
          twinkleSpeed: Math.random() * 0.02 + 0.005,
          twinklePhase: Math.random() * Math.PI * 2,
        });
      }
    };

    const resize = () => {
      canvas.width = container.offsetWidth * dpr;
      canvas.height = container.offsetHeight * dpr;
      canvas.style.width = `${container.offsetWidth}px`;
      canvas.style.height = `${container.offsetHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      initStars();
      if (reducedMotion) drawFrame(0);
    };

    function drawFrame(time) {
      const w = container.offsetWidth;
      const h = container.offsetHeight;
      ctx.clearRect(0, 0, w, h);

      for (const star of stars) {
        const twinkle = reducedMotion
          ? 1
          : Math.sin(time * star.twinkleSpeed + star.twinklePhase) * 0.3 + 0.7;

        ctx.beginPath();
        ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${STAR.replaceAll(' ', ',')}, ${star.opacity * twinkle})`;
        ctx.fill();

        // Bigger stars get a coloured halo — this is where a scheme's
        // star-glow (cream for Starry Night, gold for Amber) shows up.
        if (star.radius > 0.8) {
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.radius * 2.4, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${STAR_GLOW.replaceAll(' ', ',')}, ${star.opacity * twinkle * 0.18})`;
          ctx.fill();
        }
      }

      if (!reducedMotion && shootingEnabled) {
        // More falling stars: frequent spawns, up to 6 streaks at once
        if (Math.random() < 0.03 && shooters.length < 6) {
          shooters.push({
            x: Math.random() * w,
            y: Math.random() * h * 0.5,
            vx: (Math.random() - 0.5) * 6 + 2,
            vy: Math.random() * 3 + 1,
            life: 0,
            maxLife: 60 + Math.random() * 40,
          });
        }

        shooters = shooters.filter(s => s.life < s.maxLife);
        for (const s of shooters) {
          s.x += s.vx;
          s.y += s.vy;
          s.life += 1;
          const opacity = Math.sin((s.life / s.maxLife) * Math.PI);

          const trail = ctx.createLinearGradient(s.x, s.y, s.x - s.vx * 12, s.y - s.vy * 12);
          trail.addColorStop(0, `rgba(${SHOOT.replaceAll(' ', ',')}, ${opacity})`);
          trail.addColorStop(1, `rgba(${SHOOT_GLOW.replaceAll(' ', ',')}, 0)`);

          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(s.x - s.vx * 12, s.y - s.vy * 12);
          ctx.strokeStyle = trail;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }
    }

    resize();

    if (!reducedMotion) {
      let time = 0;
      const animate = () => {
        time += 0.016;
        drawFrame(time);
        animationId = requestAnimationFrame(animate);
      };
      animate();
    }

    window.addEventListener('resize', resize);
    return () => {
      if (animationId) cancelAnimationFrame(animationId);
      window.removeEventListener('resize', resize);
    };
    // theme.id is in the deps so a scheme change re-reads the CSS variables.
  }, [theme.id, starfield, shootingEnabled, reducedMotion, starDensity]);

  const auroraLayer = (index, className, style) => (
    <div
      key={index}
      className={className}
      style={{
        ...style,
        // Aurora animations are decorative; static blobs still read as a sky.
        animation: reducedMotion ? 'none' : style.animation,
      }}
    />
  );

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden pointer-events-none">
      {/* Sky: the scheme's two-stop vertical gradient (StarryNight's sidebar-alt -> sidebar). */}
      <div className="absolute inset-0 bg-gradient-sky opacity-90" />

      {/* Star canvas */}
      <canvas ref={canvasRef} className="absolute inset-0" />

      {/* Aurora blobs, tinted per scheme */}
      {auroraEnabled && (
        <div className="absolute inset-0 opacity-60">
          {auroraLayer(1, 'absolute w-[120%] h-[60%] -top-[20%] -left-[10%] blur-[80px]', {
            background: 'radial-gradient(ellipse at 30% 20%, rgb(var(--aurora-1) / 0.25) 0%, rgb(var(--aurora-1) / 0.10) 30%, transparent 70%)',
            animation: 'aurora1 20s ease-in-out infinite',
          })}
          {auroraLayer(2, 'absolute w-[100%] h-[50%] top-[10%] right-[-10%] blur-[70px]', {
            background: 'radial-gradient(ellipse at 70% 30%, rgb(var(--aurora-2) / 0.20) 0%, rgb(var(--aurora-2) / 0.08) 40%, transparent 70%)',
            animation: 'aurora2 25s ease-in-out infinite',
          })}
          {auroraLayer(3, 'absolute w-[80%] h-[40%] top-[5%] left-[20%] blur-[60px]', {
            background: 'radial-gradient(ellipse at 50% 10%, rgb(var(--aurora-3) / 0.15) 0%, rgb(var(--aurora-3) / 0.05) 30%, transparent 60%)',
            animation: 'aurora3 30s ease-in-out infinite',
          })}
          {auroraLayer(4, 'absolute w-[90%] h-[35%] top-[20%] left-[10%] blur-[90px]', {
            background: 'radial-gradient(ellipse at 20% 50%, rgb(var(--aurora-4) / 0.12) 0%, transparent 60%)',
            animation: 'aurora1 22s ease-in-out infinite reverse',
          })}
        </div>
      )}

      {/* Vignette into the page background so the sky blends with content */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-background/80" />
      <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent opacity-60" />

      <style>{`
        @keyframes aurora1 {
          0%, 100% { transform: translate(0, 0) scale(1) rotate(0deg); opacity: 0.6; }
          25% { transform: translate(20px, -10px) scale(1.05) rotate(1deg); opacity: 0.8; }
          50% { transform: translate(-15px, 5px) scale(0.95) rotate(-1deg); opacity: 0.5; }
          75% { transform: translate(10px, 10px) scale(1.02) rotate(0.5deg); opacity: 0.7; }
        }
        @keyframes aurora2 {
          0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.5; }
          33% { transform: translate(-20px, 15px) scale(1.1); opacity: 0.7; }
          66% { transform: translate(15px, -5px) scale(0.9); opacity: 0.4; }
        }
        @keyframes aurora3 {
          0%, 100% { transform: translate(0, 0) scale(1) skewX(0deg); opacity: 0.4; }
          50% { transform: translate(25px, -15px) scale(1.15) skewX(2deg); opacity: 0.6; }
        }
      `}</style>
    </div>
  );
}
