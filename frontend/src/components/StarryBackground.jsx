import { useEffect, useRef } from 'react';

export default function StarryBackground() {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    let animationId;
    let stars = [];
    let shootingStars = [];

    const resize = () => {
      canvas.width = container.offsetWidth;
      canvas.height = container.offsetHeight;
      initStars();
    };

    const initStars = () => {
      stars = [];
      const count = Math.floor((canvas.width * canvas.height) / 3000); // density
      for (let i = 0; i < count; i++) {
        stars.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          radius: Math.random() * 1.2 + 0.2,
          opacity: Math.random() * 0.8 + 0.2,
          twinkleSpeed: Math.random() * 0.02 + 0.005,
          twinklePhase: Math.random() * Math.PI * 2,
        });
      }
    };

    const drawStars = (time) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      stars.forEach(star => {
        const twinkle = Math.sin(time * star.twinkleSpeed + star.twinklePhase) * 0.3 + 0.7;
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${star.opacity * twinkle})`;
        ctx.fill();
        
        // Glow for larger stars
        if (star.radius > 0.8) {
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.radius * 2, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(139, 92, 246, ${star.opacity * twinkle * 0.15})`;
          ctx.fill();
        }
      });

      // Shooting stars occasionally
      if (Math.random() < 0.005 && shootingStars.length < 2) {
        shootingStars.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height * 0.5,
          vx: (Math.random() - 0.5) * 4 + 2,
          vy: Math.random() * 2 + 1,
          life: 0,
          maxLife: 60 + Math.random() * 40,
        });
      }

      shootingStars = shootingStars.filter(s => s.life < s.maxLife);
      shootingStars.forEach(s => {
        s.x += s.vx;
        s.y += s.vy;
        s.life++;
        const progress = s.life / s.maxLife;
        const opacity = Math.sin(progress * Math.PI);
        
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - s.vx * 5, s.y - s.vy * 5);
        ctx.strokeStyle = `rgba(255, 255, 255, ${opacity})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      });
    };

    let time = 0;
    const animate = () => {
      time += 0.016;
      drawStars(time);
      animationId = requestAnimationFrame(animate);
    };

    resize();
    animate();

    window.addEventListener('resize', resize);

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden pointer-events-none">
      {/* Star canvas */}
      <canvas ref={canvasRef} className="absolute inset-0" />

      {/* Northern lights - animated gradients */}
      <div className="absolute inset-0 opacity-60">
        {/* Light 1 - Purple */}
        <div 
          className="absolute w-[120%] h-[60%] -top-[20%] -left-[10%] blur-[80px] animate-pulse-slow"
          style={{
            background: `radial-gradient(ellipse at 30% 20%, rgba(139, 92, 246, 0.25) 0%, rgba(139, 92, 246, 0.1) 30%, transparent 70%)`,
            animation: 'aurora1 20s ease-in-out infinite'
          }}
        />
        {/* Light 2 - Blue */}
        <div 
          className="absolute w-[100%] h-[50%] top-[10%] right-[-10%] blur-[70px]"
          style={{
            background: `radial-gradient(ellipse at 70% 30%, rgba(59, 130, 246, 0.2) 0%, rgba(59, 130, 246, 0.08) 40%, transparent 70%)`,
            animation: 'aurora2 25s ease-in-out infinite'
          }}
        />
        {/* Light 3 - Greenish aurora */}
        <div 
          className="absolute w-[80%] h-[40%] top-[5%] left-[20%] blur-[60px]"
          style={{
            background: `radial-gradient(ellipse at 50% 10%, rgba(16, 185, 129, 0.15) 0%, rgba(16, 185, 129, 0.05) 30%, transparent 60%)`,
            animation: 'aurora3 30s ease-in-out infinite'
          }}
        />
        {/* Light 4 - Pink */}
        <div 
          className="absolute w-[90%] h-[35%] top-[20%] left-[10%] blur-[90px]"
          style={{
            background: `radial-gradient(ellipse at 20% 50%, rgba(168, 85, 247, 0.12) 0%, transparent 60%)`,
            animation: 'aurora1 22s ease-in-out infinite reverse'
          }}
        />
      </div>

      {/* Subtle vignette */}
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
