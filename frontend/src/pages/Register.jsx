import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Shield, Eye, EyeOff, Lock, User, Mail, AlertCircle, Check, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import Captcha from '../components/Captcha';
import { LoadingDots } from '../components/Loading';

export default function Register() {
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [passwordStrength, setPasswordStrength] = useState({ score: 0, feedback: [] });
  const [captcha, setCaptcha] = useState({ id: '', answer: '', token: '' });
  const [captchaKey, setCaptchaKey] = useState(0);
  const { register } = useAuth();
  const navigate = useNavigate();

  const checkPasswordStrength = (pwd) => {
    let score = 0;
    const feedback = [];
    if (pwd.length >= 8) score++; else feedback.push('At least 8 characters');
    if (/[a-z]/.test(pwd)) score++; else feedback.push('Lowercase letter');
    if (/[A-Z]/.test(pwd)) score++; else feedback.push('Uppercase letter');
    if (/[0-9]/.test(pwd)) score++; else feedback.push('Number');
    if (/[^a-zA-Z0-9]/.test(pwd)) { score++; feedback.push('Special char (bonus)'); }
    return { score, feedback, maxScore: 5 };
  };

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (field === 'password') {
      setPasswordStrength(checkPasswordStrength(value));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    if (formData.password !== formData.confirmPassword) {
      setError("Passwords don't match");
      setLoading(false);
      return;
    }

    try {
      await register(formData.username, formData.email, formData.password, formData.confirmPassword, captcha);
      navigate('/');
    } catch (err) {
      const data = err.response?.data;
      if (data?.captchaRequired) {
        setError(data.error + ': ' + (data.details || 'CAPTCHA failed'));
        setCaptchaKey(k => k + 1);
      } else {
        const details = data?.details;
        if (details) {
          setError(details.map(d => d.message).join(', '));
        } else {
          setError(data?.error || 'Registration failed');
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const strength = passwordStrength;
  const strengthLabels = ['Very Weak', 'Weak', 'Fair', 'Good', 'Strong', 'Very Strong'];
  const strengthColors = ['bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-blue-500', 'bg-green-500', 'bg-emerald-500'];

  return (
    <div className="min-h-[90vh] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-primary flex items-center justify-center shadow-xl shadow-purple-500/20">
            <Shield className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-textPrimary">Create Account</h1>
          <p className="text-sm text-textMuted mt-1">Join espress0's repo archive</p>
        </div>

        <div className="glass rounded-3xl border border-white/5 p-8 shadow-2xl">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">Username *</label>
              <div className="relative">
                <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-textMuted" />
                <input
                  type="text"
                  value={formData.username}
                  onChange={(e) => handleChange('username', e.target.value)}
                  placeholder="espress0"
                  pattern="[a-zA-Z0-9_-]+"
                  minLength={3}
                  maxLength={30}
                  className="w-full pl-10 pr-4 py-3 bg-surface border border-border rounded-xl focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 text-sm"
                  required
                />
              </div>
              <p className="text-[11px] text-textMuted mt-1">Letters, numbers, _ and - only, 3-30 chars</p>
            </div>

            <div>
              <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">Email *</label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-textMuted" />
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => handleChange('email', e.target.value)}
                  placeholder="you@example.com"
                  className="w-full pl-10 pr-4 py-3 bg-surface border border-border rounded-xl focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 text-sm"
                  required
                />
              </div>
              <p className="text-[11px] text-textMuted mt-1">Encrypted at rest with AES-256-GCM</p>
            </div>

            <div>
              <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">Password *</label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-textMuted" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={formData.password}
                  onChange={(e) => handleChange('password', e.target.value)}
                  placeholder="••••••••"
                  minLength={8}
                  className="w-full pl-10 pr-12 py-3 bg-surface border border-border rounded-xl focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 text-sm"
                  required
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-textMuted hover:text-textPrimary">
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {formData.password && (
                <div className="mt-3 space-y-2">
                  <div className="flex gap-1">
                    {[...Array(5)].map((_, i) => (
                      <div key={i} className={`h-1 flex-1 rounded-full transition-all ${i < strength.score ? strengthColors[strength.score] : 'bg-surfaceHover'}`} />
                    ))}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-textMuted">Strength: <span className="font-medium text-textPrimary">{strengthLabels[strength.score] || 'Very Weak'}</span></span>
                    <span className="text-xs text-textMuted">{strength.score}/5</span>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">Confirm Password *</label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-textMuted" />
                <input
                  type={showConfirm ? 'text' : 'password'}
                  value={formData.confirmPassword}
                  onChange={(e) => handleChange('confirmPassword', e.target.value)}
                  placeholder="••••••••"
                  className={`w-full pl-10 pr-12 py-3 bg-surface border rounded-xl focus:outline-none focus:ring-2 text-sm ${
                    formData.confirmPassword && formData.password !== formData.confirmPassword
                      ? 'border-red-500/50 focus:border-red-500/50 focus:ring-red-500/20'
                      : formData.confirmPassword && formData.password === formData.confirmPassword
                      ? 'border-green-500/50 focus:border-green-500/50 focus:ring-green-500/20'
                      : 'border-border focus:border-primary/50 focus:ring-primary/20'
                  }`}
                  required
                />
                <div className="absolute right-10 top-1/2 -translate-y-1/2">
                  {formData.confirmPassword && (
                    formData.password === formData.confirmPassword ? <Check className="w-4 h-4 text-green-400" /> : <X className="w-4 h-4 text-red-400" />
                  )}
                </div>
                <button type="button" onClick={() => setShowConfirm(!showConfirm)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-textMuted hover:text-textPrimary">
                  {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
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

            <div className="glass rounded-xl p-3 border border-white/5 text-xs text-textMuted">
              <p className="font-medium text-textSecondary mb-1">Security:</p>
              <ul className="space-y-1 list-disc list-inside">
                <li>Passwords: pepper (HMAC) + bcryptjs cost 12</li>
                <li>Email: AES-256-GCM encrypted at rest</li>
                <li>CAPTCHA: math/svg by default, no external API</li>
                <li>Rate limited: 5 registrations/hour</li>
              </ul>
            </div>

            <button type="submit" disabled={loading || (formData.password && formData.password !== formData.confirmPassword)} className="w-full py-3 bg-gradient-primary hover:bg-gradient-primary-hover disabled:opacity-50 text-white rounded-xl font-medium shadow-lg shadow-purple-500/20 transition-all flex items-center justify-center gap-2">
              {loading ? <><LoadingDots size={16} /> Creating account...</> : 'Create Account'}
            </button>
          </form>

          <div className="mt-6 pt-6 border-t border-white/5 text-center space-y-2">
            <p className="text-sm text-textMuted">
              Already have an account? <Link to="/login" className="text-primary hover:text-primaryHover font-medium">Sign in</Link>
            </p>
            <Link to="/" className="text-xs text-textMuted hover:text-primary inline-block">Back to repository</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
