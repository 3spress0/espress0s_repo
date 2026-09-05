import { useState, useEffect } from 'react';
import { RefreshCw, Shield, Calculator, Eye } from 'lucide-react';
import api from '../lib/api';
import { LoadingDots } from './Loading';

export default function Captcha({ onChange, required = true }) {
  const [captcha, setCaptcha] = useState(null);
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [, setVerified] = useState(false);

  const fetchCaptcha = async () => {
    setLoading(true);
    setError('');
    setAnswer('');
    setVerified(false);
    try {
      const res = await api.get('/captcha');
      setCaptcha(res.data);
    } catch (e) {
      setError('Failed to load CAPTCHA');
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCaptcha();
  }, []);

  const handleAnswerChange = (val) => {
    setAnswer(val);
    if (onChange && captcha) {
      onChange({ id: captcha.id, answer: val, token: null, type: captcha.type });
    }
  };

  const handleRefresh = () => {
    fetchCaptcha();
  };

  if (loading) {
    return (
      <div className="glass rounded-xl p-4 border border-white/5 flex items-center justify-center gap-2 text-sm text-textMuted">
        <LoadingDots size={16} /> Preparing challenge…
      </div>
    );
  }

  if (!captcha) {
    return (
      <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400">
        Failed to load CAPTCHA. <button onClick={fetchCaptcha} className="underline">Retry</button>
      </div>
    );
  }

  if (captcha.type === 'disabled') {
    return (
      <div className="p-3 rounded-xl bg-green-500/10 border border-green-500/20 text-sm text-green-400 flex items-center gap-2">
        <Shield className="w-4 h-4" />
        CAPTCHA disabled (dev mode)
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <label className="text-xs font-medium text-textMuted uppercase tracking-widest flex items-center gap-2">
        <Shield className="w-3 h-3" />
        Security Check {required && <span className="text-red-400">*</span>}
      </label>
      
      <div className="glass rounded-xl border border-white/5 p-4">
        {captcha.type === 'math' ? (
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <Calculator className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium text-textPrimary">Solve:</span>
              </div>
              <div className="text-2xl font-bold font-mono text-textPrimary tracking-wider">
                {captcha.question}
              </div>
              <div className="text-[11px] text-textMuted mt-1">Math CAPTCHA — low resource, no external API</div>
            </div>
            <button
              type="button"
              onClick={handleRefresh}
              className="p-2.5 rounded-xl bg-surface border border-border hover:border-primary/30 text-textMuted hover:text-primary transition-colors"
              title="Refresh CAPTCHA"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        ) : captcha.type === 'svg' ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-textPrimary flex items-center gap-2">
                <Eye className="w-4 h-4 text-primary" />
                {captcha.question}
              </span>
              <button
                type="button"
                onClick={handleRefresh}
                className="p-2 rounded-xl bg-surface border border-border hover:border-primary/30"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
            <div className="flex justify-center p-2 bg-background rounded-xl border border-border">
              <img src={captcha.image} alt="CAPTCHA" className="rounded-lg" />
            </div>
            <div className="text-[11px] text-textMuted">Case-insensitive, 6 characters • SVG generated server-side</div>
          </div>
        ) : null}

        <div className="mt-4">
          <input
            type="text"
            value={answer}
            onChange={(e) => handleAnswerChange(e.target.value)}
            placeholder={captcha.type === 'math' ? 'Enter answer (number)' : 'Enter characters from image'}
            className="w-full px-4 py-3 bg-surface border border-border rounded-xl focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 text-sm font-mono"
            required={required}
            autoComplete="off"
          />
        </div>

        {error && (
          <div className="mt-2 text-xs text-red-400">{error}</div>
        )}

        {captcha.id && (
          <div className="mt-2 text-[10px] text-textMuted font-mono">
            ID: {captcha.id.slice(0, 16)}... • Expires in 5 min • {captcha.type}
          </div>
        )}
      </div>
    </div>
  );
}

// Turnstile component for Cloudflare (optional)
export function TurnstileCaptcha({ siteKey, onVerified }) {
  const [token, setToken] = useState('');

  useEffect(() => {
    if (!siteKey) return;

    // Load Turnstile script
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    document.head.appendChild(script);

    script.onload = () => {
      if (window.turnstile) {
        window.turnstile.render('#turnstile-widget', {
          sitekey: siteKey,
          callback: (t) => {
            setToken(t);
            onVerified && onVerified({ token: t, type: 'turnstile' });
          },
          'expired-callback': () => setToken(''),
          'error-callback': () => setToken(''),
        });
      }
    };

    return () => {
      try { document.head.removeChild(script); } catch {}
    };
    // One widget per site key; onVerified is read through the closure on
    // purpose so a parent re-render does not re-inject the script.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  if (!siteKey) {
    return <div className="text-xs text-textMuted">Turnstile site key not configured</div>;
  }

  return (
    <div className="space-y-3">
      <label className="text-xs font-medium text-textMuted uppercase tracking-widest flex items-center gap-2">
        <Shield className="w-3 h-3" />
        Cloudflare Turnstile
      </label>
      <div id="turnstile-widget" className="flex justify-center p-4 glass rounded-xl border border-white/5"></div>
      {token && <div className="text-xs text-green-400">Verified</div>}
    </div>
  );
}
