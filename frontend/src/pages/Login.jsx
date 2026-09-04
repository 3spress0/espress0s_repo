import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Shield, Eye, EyeOff, Lock, User, AlertCircle, Bug, KeyRound } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import Captcha from '../components/Captcha';
import { LoadingDots } from '../components/Loading';

export default function Login() {
  const { get } = useSettings();
  const showDevPanel = !!get('show_dev_credentials_panel', false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [captcha, setCaptcha] = useState({ id: '', answer: '', token: '' });
  const [captchaKey, setCaptchaKey] = useState(0); // to force refresh
  const { login, verifyMfa } = useAuth();
  const navigate = useNavigate();
  // Second step for accounts with two-factor on: the password step handed us
  // a short-lived mfaToken, now we need a code from the authenticator app.
  const [mfa, setMfa] = useState(null); // { mfaToken }
  const [code, setCode] = useState('');

  const afterLogin = (data) => navigate(data?.user?.role === 'viewer' ? '/account' : '/admin');

  const handleMfaSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await verifyMfa(mfa.mfaToken, code.trim());
      afterLogin(data);
    } catch (err) {
      const data = err.response?.data;
      if (data?.restart) { setMfa(null); setCode(''); setCaptchaKey(k => k + 1); }
      setError(data?.error || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const data = await login(username, password, captcha);
      if (data?.mfaRequired) { setMfa({ mfaToken: data.mfaToken }); return; }
      afterLogin(data);
    } catch (err) {
      const data = err.response?.data;
      if (data?.captchaRequired) {
        setError(data.error + ': ' + (data.details || 'Please solve new CAPTCHA'));
        setCaptchaKey(k => k + 1); // refresh captcha
      } else {
        setError(data?.error || 'Login failed');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[90vh] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-primary flex items-center justify-center shadow-xl shadow-purple-500/20">
            <Shield className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-textPrimary">Welcome Back</h1>
          <p className="text-sm text-textMuted mt-1">Sign in to espress0's repo</p>
        </div>

        <div className="glass rounded-3xl border border-white/5 p-5 sm:p-8 shadow-2xl">
          {mfa ? (
          <form onSubmit={handleMfaSubmit} className="space-y-5">
            <div>
              <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">Two-factor code</label>
              <div className="relative">
                <KeyRound className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-textMuted" />
                <input
                  type="text"
                  inputMode="numeric"
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456 or a recovery code"
                  className="w-full pl-10 pr-4 py-3 bg-surface border border-border rounded-xl focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 text-sm font-mono tracking-widest"
                  required
                  autoComplete="one-time-code"
                />
              </div>
              <p className="text-xs text-textMuted mt-2">Open your authenticator app and enter the 6-digit code for this site. Lost the device? Use one of your recovery codes.</p>
            </div>
            {error && (
              <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-gradient-primary hover:bg-gradient-primary-hover disabled:opacity-50 text-white rounded-xl font-medium shadow-lg shadow-purple-500/20 transition-all flex items-center justify-center gap-2"
            >
              {loading ? <><LoadingDots size={16} /> Verifying...</> : 'Verify'}
            </button>
            <button type="button" onClick={() => { setMfa(null); setCode(''); setError(''); setCaptchaKey(k => k + 1); }} className="w-full text-xs text-textMuted hover:text-textPrimary">
              Back to password
            </button>
          </form>
          ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">Username or Email</label>
              <div className="relative">
                <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-textMuted" />
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin or you@example.com"
                  className="w-full pl-10 pr-4 py-3 bg-surface border border-border rounded-xl focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 text-sm"
                  required
                  autoComplete="username"
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">Password</label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-textMuted" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-10 pr-12 py-3 bg-surface border border-border rounded-xl focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 text-sm"
                  required
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2.5 rounded-lg text-textMuted hover:text-textPrimary"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <Captcha key={captchaKey} onChange={setCaptcha} required={true} />

            {error && (
              <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-gradient-primary hover:bg-gradient-primary-hover disabled:opacity-50 text-white rounded-xl font-medium shadow-lg shadow-purple-500/20 hover:shadow-purple-500/30 transition-all flex items-center justify-center gap-2"
            >
              {loading ? <><LoadingDots size={16} /> Signing in...</> : 'Sign In'}
            </button>
          </form>
          )}

          <div className="mt-6 pt-6 border-t border-white/5 space-y-4">
            <div className="text-center">
              <p className="text-sm text-textMuted">
                Don't have an account?{' '}
                <Link to="/register" className="text-primary hover:text-primaryHover font-medium">
                  Create account
                </Link>
              </p>
            </div>

            {/* Development aid only. Off by default - an admin can turn it on
                from /admin/settings, and it must never ship enabled. */}
            {showDevPanel && (
              <div className="glass rounded-xl p-3 border border-amber-500/20 bg-amber-500/5">
                <h4 className="text-xs font-semibold text-amber-300 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                  <Bug className="w-3 h-3" />
                  Development mode
                </h4>
                <div className="text-xs space-y-1 font-mono">
                  <div className="text-textSecondary">CAPTCHA is required on every sign-in.</div>
                  <div className="text-[11px] text-textMuted mt-2">
                    Credentials come from your server environment - they are never printed here.
                  </div>
                  <div className="text-[11px] text-textMuted">
                    Turn this panel off in Admin  Site Settings.
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center justify-center text-xs">
              <Link to="/" className="text-textMuted hover:text-primary transition-colors">
                Back
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
