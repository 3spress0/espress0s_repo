import { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { User, Mail, Lock, Save, Shield, Eye, EyeOff, FileText, LogOut, AlertTriangle, Check, Coffee, Palette, Star, Globe } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import api from '../lib/api';
import StarryBackground from '../components/StarryBackground';
import ThemePicker from '../components/ThemePicker';
import LanguagePicker from '../components/LanguagePicker';
import { useTheme } from '../context/ThemeContext';
import Logo from '../components/Logo';
import { LoadingDots, LoadingPanel } from '../components/Loading';
import FavoritesPanel from '../components/FavoritesPanel';
import TwoFactorPanel from '../components/TwoFactorPanel';

export default function Account() {
  const themeCtx = useTheme();
  const { user, logout, logoutAll, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // Two views of the same account: the profile form, and the files starred
  // from the catalogue. Favourites live on their own tab rather than below the
  // form, which is already a full page of fields.
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState(() => (['profile', 'favorites', 'security'].includes(searchParams.get('tab')) ? searchParams.get('tab') : 'profile'));
  const mfaForced = searchParams.get('mfa') === 'required';
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    currentPassword: '',
    newPassword: '',
    confirmNewPassword: '',
    avatar_url: '',
    bio: '',
  });

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/login?redirect=/account');
    }
  }, [authLoading, user, navigate]);

  useEffect(() => {
    if (user) {
      fetchProfile();
    }
  }, [user]);

  const fetchProfile = async () => {
    setLoading(true);
    try {
      const res = await api.get('/auth/profile');
      setProfile(res.data);
      setFormData({
        username: res.data.username || '',
        email: res.data.email || '',
        currentPassword: '',
        newPassword: '',
        confirmNewPassword: '',
        avatar_url: res.data.avatar_url || '',
        bio: res.data.bio || '',
      });
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load profile');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setSaving(true);

    try {
      const payload = {};
      if (formData.username && formData.username !== profile.username) payload.username = formData.username;
      if (formData.email && formData.email !== profile.email) payload.email = formData.email;
      if (formData.newPassword) {
        payload.currentPassword = formData.currentPassword;
        payload.newPassword = formData.newPassword;
        payload.confirmNewPassword = formData.confirmNewPassword;
      }
      if (formData.avatar_url !== (profile.avatar_url || '')) payload.avatar_url = formData.avatar_url;
      if (formData.bio !== (profile.bio || '')) payload.bio = formData.bio;

      if (Object.keys(payload).length === 0) {
        setError('No changes to save');
        setSaving(false);
        return;
      }

      // Require current password if changing sensitive fields
      if ((payload.email || payload.newPassword || payload.username) && !formData.currentPassword && !payload.currentPassword) {
        // For username change we allow without current password? But for email/password we require
        if (payload.email || payload.newPassword) {
          payload.currentPassword = formData.currentPassword;
          if (!payload.currentPassword) {
            setError('Current password required to change email or password');
            setSaving(false);
            return;
          }
        }
      }

      if (payload.newPassword && !formData.currentPassword) {
        payload.currentPassword = formData.currentPassword;
      }

      const res = await api.put('/auth/profile', payload);
      setSuccess('Profile updated successfully - encrypted at rest');
      setProfile(res.data.user);
      setFormData(prev => ({
        ...prev,
        currentPassword: '',
        newPassword: '',
        confirmNewPassword: '',
        username: res.data.user.username,
        email: res.data.user.email,
        avatar_url: res.data.user.avatar_url || '',
        bio: res.data.user.bio || '',
      }));
    } catch (e) {
      const details = e.response?.data?.details;
      if (details) {
        setError(details.map(d => `${d.path?.join('.')}: ${d.message}`).join(', '));
      } else {
        setError(e.response?.data?.error || 'Failed to update profile');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleLogoutConfirm = () => {
    if (confirm('Are you sure you want to log out? You will need to login + solve CAPTCHA again to download files.')) {
      logout();
      navigate('/');
    }
  };

  const handleLogoutAll = async () => {
    if (!confirm('Log out of ALL devices and browsers, including this one? Use this if you suspect your account is compromised.')) return;
    try {
      await logoutAll();
      navigate('/login');
    } catch (e) {
      setError(e.response?.data?.error || 'Could not log out everywhere');
    }
  };

  if (authLoading || loading) {
    return <LoadingPanel text="Loading account…" size={48} />;
  }

  if (!user) return null;

  return (
    <div className="relative min-h-dvh">
      <StarryBackground />
      
      <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center gap-3 mb-8">
          <Logo size={40} />
          <div>
            <h1 className="text-3xl font-bold text-textPrimary">Account Customization</h1>
            <p className="text-sm text-textMuted">Manage your espress0's repo profile • Encrypted at rest</p>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-sm text-red-400 flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
            <button onClick={() => setError('')} className="ml-auto text-xs underline">Dismiss</button>
          </div>
        )}

        {success && (
          <div className="mb-6 p-4 rounded-2xl bg-green-500/10 border border-green-500/20 text-sm text-green-400 flex items-start gap-2">
            <Check className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <span>{success}</span>
            <button onClick={() => setSuccess('')} className="ml-auto text-xs underline">Dismiss</button>
          </div>
        )}

        <div className="flex gap-2 mb-6">
          {[
            { id: 'profile', label: 'Profile', icon: User },
            { id: 'favorites', label: 'Favourites', icon: Star },
            { id: 'security', label: 'Security', icon: Shield },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all ${
                tab === id
                  ? 'bg-gradient-primary text-white shadow-lg shadow-purple-500/20'
                  : 'text-textSecondary hover:text-textPrimary hover:bg-surfaceHover'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 space-y-6">
            <div className="glass rounded-3xl border border-white/5 p-6 text-center backdrop-blur-xl">
              <div className="w-20 h-20 mx-auto rounded-2xl bg-gradient-primary flex items-center justify-center text-white font-bold text-2xl shadow-xl shadow-purple-500/20 overflow-hidden">
                {profile?.avatar_url ? (
                  <img src={profile.avatar_url} alt="avatar" loading="lazy" decoding="async" className="w-full h-full object-cover" onError={(e) => e.target.style.display = 'none'} />
                ) : (
                  profile?.username?.[0]?.toUpperCase() || 'U'
                )}
              </div>
              <h3 className="font-bold text-textPrimary mt-4">{profile?.username}</h3>
              <p className="text-xs text-textMuted">{profile?.email}</p>
              <span className={`inline-flex items-center gap-1 mt-3 px-3 py-1 rounded-full border text-xs font-medium ${
                profile?.role === 'admin' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                profile?.role === 'editor' ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' :
                'bg-green-500/10 text-green-400 border-green-500/20'
              }`}>
                <Shield className="w-3 h-3" />
                {profile?.role}
              </span>
              
              <div className="mt-6 space-y-2 text-left text-xs">
                <div className="flex justify-between p-2.5 rounded-xl bg-surface border border-border">
                  <span className="text-textMuted">Encryption</span>
                  <span className="text-green-400 font-medium">{profile?.encryption_version || 'v1'}</span>
                </div>
                <div className="flex justify-between p-2.5 rounded-xl bg-surface border border-border">
                  <span className="text-textMuted">Member since</span>
                  <span className="font-mono text-[11px]">{profile?.created_at ? new Date(profile.created_at).toLocaleDateString() : '—'}</span>
                </div>
                <div className="p-2.5 rounded-xl bg-surface border border-border">
                  <div className="text-[11px] text-textMuted uppercase tracking-widest">Security</div>
                  <div className="mt-1 text-[11px] leading-relaxed text-textSecondary">
                    Email: {profile?.encryption?.email || 'encrypted'}<br/>
                    Password: pepper+bcryptjs<br/>
                    Avatar/Bio: {profile?.encryption?.avatar || 'encrypted'}
                  </div>
                </div>
              </div>

              <div className="mt-6 pt-6 border-t border-white/5 space-y-2">
                <Link to="/browse" className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-surface border border-border rounded-xl text-sm hover:border-primary/30 transition-colors">
                  <Shield className="w-4 h-4" />
                  Browse Repo
                </Link>
                <Link to="/ask" className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-surface border border-border rounded-xl text-sm hover:border-primary/30">
                  <Coffee className="w-4 h-4" />
                  Ask Barista
                </Link>
                {/* The visitor-facing version of this account: avatar, bio and
                    the favourites marked shared. */}
                <Link to={`/u/${profile?.username}`} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-surface border border-border rounded-xl text-sm hover:border-primary/30">
                  <Globe className="w-4 h-4" />
                  View public profile
                </Link>
                <button
                  onClick={handleLogoutConfirm}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 rounded-xl text-sm transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  Log Out
                </button>
                <button
                  onClick={handleLogoutAll}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-surface border border-border text-textSecondary hover:border-red-500/40 hover:text-red-400 rounded-xl text-sm transition-colors"
                >
                  <Shield className="w-4 h-4" />
                  Log out all devices
                </button>
                <p className="text-[11px] text-textMuted">“All devices” invalidates every session on this account, including this browser.</p>
              </div>
            </div>
          </div>

          <div className="lg:col-span-2 space-y-6">
            {tab === 'favorites' ? (
              <FavoritesPanel onError={setError} />
            ) : tab === 'security' ? (
              <>
                {mfaForced && !user?.mfa_enabled && (
                  <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-sm text-amber-200 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <span>This site requires two-factor authentication for admin accounts. Turn it on below to continue using the admin area.</span>
                  </div>
                )}
                <TwoFactorPanel onError={setError} onSuccess={setSuccess} />
              </>
            ) : (
            <>
            {/* Appearance: the scheme is a per-browser preference, so it is not
                part of the profile form and saves the moment it is clicked. */}
            <div className="glass rounded-3xl border border-white/5 p-8 backdrop-blur-xl">
              <h2 className="text-xl font-bold text-textPrimary mb-1 flex items-center gap-2">
                <Palette className="w-5 h-5 text-primary" />
                Appearance
              </h2>
              <p className="text-xs text-textMuted mb-5">
                {themeCtx.allowUserChoice
                  ? 'Applies instantly and is remembered in this browser. "Match system" follows your device.'
                  : 'The administrator has fixed the site theme, so this is a preview only.'}
              </p>
              {themeCtx.allowUserChoice
                ? <ThemePicker variant="grid" />
                : <p className="text-sm text-textSecondary">Current theme: {themeCtx.theme.label}</p>}
              {themeCtx.effects.reducedMotion && (
                <p className="text-[11px] text-textMuted mt-4">
                  Your device asks for reduced motion, so the starfield and aurora animations are paused.
                </p>
              )}
              <div className="mt-6 pt-6 border-t border-white/5">
                <LanguagePicker />
              </div>
            </div>

            <div className="glass rounded-3xl border border-white/5 p-8 backdrop-blur-xl">
              <h2 className="text-xl font-bold text-textPrimary mb-6 flex items-center gap-2">
                <User className="w-5 h-5 text-primary" />
                Customize Account
              </h2>

              <form onSubmit={handleSubmit} className="space-y-6">
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">Username</label>
                    <div className="relative">
                      <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-textMuted" />
                      <input
                        type="text"
                        value={formData.username}
                        onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                        className="w-full pl-10 pr-4 py-3 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
                        placeholder="espress0"
                      />
                    </div>
                    <p className="text-[11px] text-textMuted mt-1">3-30 chars, letters, numbers, _ -</p>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">Email (encrypted at rest)</label>
                    <div className="relative">
                      <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-textMuted" />
                      <input
                        type="email"
                        value={formData.email}
                        onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                        className="w-full pl-10 pr-4 py-3 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
                        placeholder="you@example.com"
                      />
                    </div>
                    <p className="text-[11px] text-textMuted mt-1">AES-256-GCM encrypted + HMAC hash</p>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">Avatar URL (encrypted)</label>
                  <input
                    type="url"
                    value={formData.avatar_url}
                    onChange={(e) => setFormData({ ...formData, avatar_url: e.target.value })}
                    className="w-full px-4 py-3 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
                    placeholder="https://example.com/avatar.jpg"
                  />
                  <p className="text-[11px] text-textMuted mt-1">Image URL for avatar, encrypted at rest. Use transparent PNG.</p>
                  {formData.avatar_url && (
                    <div className="mt-3 flex items-center gap-3">
                      <img src={formData.avatar_url} alt="avatar preview" loading="lazy" decoding="async" className="w-12 h-12 rounded-xl object-cover border border-border" onError={(e) => e.target.style.display = 'none'} />
                      <span className="text-xs text-textMuted">Preview</span>
                    </div>
                  )}
                </div>

                <div>
                  <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">Bio (encrypted)</label>
                  <textarea
                    value={formData.bio}
                    onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
                    rows={3}
                    maxLength={500}
                    className="w-full px-4 py-3 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 resize-none"
                    placeholder="Tell us about yourself..."
                  />
                  <p className="text-[11px] text-textMuted mt-1">{formData.bio.length}/500 • Encrypted with AES-256-GCM</p>
                </div>

                <div className="pt-6 border-t border-white/5">
                  <h3 className="font-semibold text-textPrimary mb-4 flex items-center gap-2">
                    <Lock className="w-4 h-4 text-primary" />
                    Change Password
                  </h3>
                  
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">Current Password (required for email/password change)</label>
                      <div className="relative">
                        <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-textMuted" />
                        <input
                          type={showPassword ? 'text' : 'password'}
                          value={formData.currentPassword}
                          onChange={(e) => setFormData({ ...formData, currentPassword: e.target.value })}
                          className="w-full pl-10 pr-12 py-3 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
                          placeholder="Current password"
                          autoComplete="current-password"
                        />
                        <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-textMuted">
                          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    <div className="grid sm:grid-cols-2 gap-4">
                      <div>
                        <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">New Password</label>
                        <input
                          type={showPassword ? 'text' : 'password'}
                          value={formData.newPassword}
                          onChange={(e) => setFormData({ ...formData, newPassword: e.target.value })}
                          className="w-full px-4 py-3 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
                          placeholder="Min 8 chars, upper, lower, number"
                          autoComplete="new-password"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">Confirm New Password</label>
                        <input
                          type={showPassword ? 'text' : 'password'}
                          value={formData.confirmNewPassword}
                          onChange={(e) => setFormData({ ...formData, confirmNewPassword: e.target.value })}
                          className="w-full px-4 py-3 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
                          placeholder="Confirm new password"
                          autoComplete="new-password"
                        />
                      </div>
                    </div>
                    <p className="text-[11px] text-textMuted">Passwords: pepper (HMAC-SHA256) + bcryptjs cost 12, versioned pepper_v1:</p>
                  </div>
                </div>

                <div className="flex gap-3 pt-6">
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-6 py-3 bg-gradient-primary hover:bg-gradient-primary-hover disabled:opacity-50 text-white rounded-xl font-medium shadow-lg shadow-purple-500/20 flex items-center gap-2 transition-all"
                  >
                    {saving ? <LoadingDots size={16} /> : <Save className="w-4 h-4" />}
                    {saving ? 'Saving...' : 'Save Customization'}
                  </button>
                  <Link to="/" className="px-6 py-3 bg-surface border border-border rounded-xl text-sm hover:border-primary/30 transition-colors">
                    Cancel
                  </Link>
                </div>
              </form>
            </div>
            </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
