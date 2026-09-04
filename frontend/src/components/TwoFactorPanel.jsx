import { useEffect, useMemo, useState } from 'react';
import { KeyRound, ShieldCheck, ShieldOff, Copy, Check, RefreshCw } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { authApi } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { LoadingDots } from '../components/Loading';

/**
 * Two-factor authentication (TOTP) for the signed-in account.
 *
 * Off  -> "Turn on" runs setup, shows a QR code + the secret, asks for the
 *         first code, then shows the recovery codes exactly once.
 * On   -> shows how many recovery codes are left, lets the user regenerate
 *         them (needs a code) or turn 2FA off (needs password + code).
 *
 * The QR code is rendered client-side as an SVG from the otpauth URI; the
 * secret never goes to a third party.
 */
function QrSvg({ text, size = 200 }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const cell = size / n;
    let rects = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) rects += `<rect x="${(c * cell).toFixed(2)}" y="${(r * cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}"/>`;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
  }, [text, size]);
  return <img alt="Scan with your authenticator app" width={size} height={size} className="rounded-xl" src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} />;
}

function CopyButton({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch {} }}
      className="inline-flex items-center gap-1 text-xs text-textMuted hover:text-textPrimary"
    >
      {done ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} {done ? 'Copied' : label}
    </button>
  );
}

function RecoveryCodes({ codes }) {
  return (
    <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20 space-y-3">
      <p className="text-sm text-amber-200 font-medium">Save these recovery codes now - they are shown only once.</p>
      <p className="text-xs text-textMuted">Each one signs you in a single time if you lose your authenticator. Keep them somewhere other than the device you use for the app.</p>
      <div className="grid grid-cols-2 gap-1 font-mono text-sm text-textPrimary">
        {codes.map(c => <div key={c}>{c}</div>)}
      </div>
      <CopyButton text={codes.join('\n')} label="Copy all" />
    </div>
  );
}

export default function TwoFactorPanel({ onError, onSuccess }) {
  const { patchUser } = useAuth();
  const [state, setState] = useState(null); // { enabled, recoveryCodesLeft }
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(null); // { secret, otpauth }
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [recovery, setRecovery] = useState(null);
  const [mode, setMode] = useState(null); // 'disable' | 'regen'

  const refresh = async () => {
    try { setState(await authApi.mfa.status()); } catch { setState({ enabled: false, recoveryCodesLeft: 0 }); }
  };
  useEffect(() => { refresh(); }, []);

  const run = async (fn) => {
    setBusy(true); onError?.(''); onSuccess?.('');
    try { await fn(); } catch (e) { onError?.(e.response?.data?.error || 'Something went wrong'); } finally { setBusy(false); }
  };

  const startSetup = () => run(async () => { setRecovery(null); setSetup(await authApi.mfa.setup()); setCode(''); });
  const confirmSetup = (e) => { e.preventDefault(); run(async () => {
    const res = await authApi.mfa.enable(code.trim());
    setRecovery(res.recoveryCodes); setSetup(null); setCode(''); patchUser({ mfa_enabled: true });
    onSuccess?.('Two-factor authentication is on.'); await refresh();
  }); };
  const disable = (e) => { e.preventDefault(); run(async () => {
    await authApi.mfa.disable(password, code.trim());
    setMode(null); setCode(''); setPassword(''); setRecovery(null); patchUser({ mfa_enabled: false });
    onSuccess?.('Two-factor authentication is off.'); await refresh();
  }); };
  const regen = (e) => { e.preventDefault(); run(async () => {
    const res = await authApi.mfa.recoveryCodes(code.trim());
    setRecovery(res.recoveryCodes); setMode(null); setCode(''); await refresh();
  }); };

  if (!state) return <div className="text-sm text-textMuted"><LoadingDots size={14} /></div>;

  const codeInput = (
    <input
      type="text" inputMode="numeric" autoComplete="one-time-code" required
      value={code} onChange={e => setCode(e.target.value)} placeholder="6-digit code"
      className="w-full px-4 py-3 bg-surface border border-border rounded-xl focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 text-sm font-mono tracking-widest"
    />
  );

  return (
    <div className="glass rounded-3xl border border-white/5 p-8 backdrop-blur-xl space-y-5">
      <div>
        <h2 className="text-xl font-bold text-textPrimary mb-1 flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-primary" /> Two-factor authentication
        </h2>
        <p className="text-sm text-textMuted">
          A code from an authenticator app (Aegis, 1Password, Google Authenticator, ...) is asked for after your password.
          {' '}{state.enabled
            ? <span className="inline-flex items-center gap-1 text-emerald-400"><ShieldCheck className="w-3.5 h-3.5" /> On · {state.recoveryCodesLeft} recovery code{state.recoveryCodesLeft === 1 ? '' : 's'} left</span>
            : <span className="inline-flex items-center gap-1 text-textMuted"><ShieldOff className="w-3.5 h-3.5" /> Off</span>}
        </p>
      </div>

      {recovery && <RecoveryCodes codes={recovery} />}

      {!state.enabled && !setup && (
        <button type="button" onClick={startSetup} disabled={busy}
          className="px-5 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium shadow-lg shadow-purple-500/20 disabled:opacity-50">
          {busy ? <LoadingDots size={14} /> : 'Turn on'}
        </button>
      )}

      {setup && (
        <form onSubmit={confirmSetup} className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-5 items-start">
            <QrSvg text={setup.otpauth} />
            <div className="space-y-3 text-sm">
              <p className="text-textSecondary">1. Scan the code with your authenticator app.</p>
              <div>
                <p className="text-textMuted text-xs mb-1">Can't scan? Enter this key by hand:</p>
                <code className="block break-all font-mono text-xs text-textPrimary bg-surface border border-border rounded-lg px-3 py-2">{setup.secret.match(/.{1,4}/g).join(' ')}</code>
                <CopyButton text={setup.secret} label="Copy key" />
              </div>
              <p className="text-textSecondary">2. Enter the 6-digit code it shows to confirm.</p>
              {codeInput}
              <div className="flex gap-2">
                <button type="submit" disabled={busy} className="px-5 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium disabled:opacity-50">
                  {busy ? <LoadingDots size={14} /> : 'Confirm & enable'}
                </button>
                <button type="button" onClick={() => { setSetup(null); setCode(''); }} className="px-4 py-2.5 text-sm text-textMuted hover:text-textPrimary">Cancel</button>
              </div>
            </div>
          </div>
        </form>
      )}

      {state.enabled && !mode && (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => { setMode('regen'); setCode(''); setRecovery(null); }}
            className="px-4 py-2.5 bg-surface border border-border rounded-xl text-sm hover:border-primary/30 inline-flex items-center gap-2">
            <RefreshCw className="w-4 h-4" /> New recovery codes
          </button>
          <button type="button" onClick={() => { setMode('disable'); setCode(''); setPassword(''); setRecovery(null); }}
            className="px-4 py-2.5 bg-surface border border-red-500/30 text-red-300 rounded-xl text-sm hover:bg-red-500/10 inline-flex items-center gap-2">
            <ShieldOff className="w-4 h-4" /> Turn off
          </button>
        </div>
      )}

      {mode === 'regen' && (
        <form onSubmit={regen} className="space-y-3 max-w-sm">
          <p className="text-sm text-textSecondary">Enter a current code to replace your recovery codes. The old ones stop working.</p>
          {codeInput}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="px-5 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium disabled:opacity-50">Generate</button>
            <button type="button" onClick={() => setMode(null)} className="px-4 py-2.5 text-sm text-textMuted hover:text-textPrimary">Cancel</button>
          </div>
        </form>
      )}

      {mode === 'disable' && (
        <form onSubmit={disable} className="space-y-3 max-w-sm">
          <p className="text-sm text-textSecondary">Confirm with your password and a current code (or a recovery code).</p>
          <input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="Password"
            className="w-full px-4 py-3 bg-surface border border-border rounded-xl focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 text-sm" />
          {codeInput}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="px-5 py-2.5 bg-red-500/80 hover:bg-red-500 text-white rounded-xl text-sm font-medium disabled:opacity-50">Turn off 2FA</button>
            <button type="button" onClick={() => setMode(null)} className="px-4 py-2.5 text-sm text-textMuted hover:text-textPrimary">Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
