import { createContext, useContext, useState, useEffect } from 'react';
import { authApi } from '../lib/api';

/**
 * Cookie-only auth context.
 *
 * The session lives in an httpOnly cookie set by the server; nothing useful is
 * kept in localStorage any more. On boot we always ask /auth/me who we are -
 * the browser attaches the session cookie itself - and fetch/refresh the CSRF
 * cookie so mutating calls work on restored sessions too.
 */
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authApi.csrf().catch(() => {});
    authApi.me()
      .then(data => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (username, password, captcha = {}) => {
    const data = await authApi.login({ 
      username, 
      password,
      captchaId: captcha.id,
      captchaAnswer: captcha.answer,
      captchaToken: captcha.token,
    });
    setUser(data.user);
    return data;
  };

  const register = async (username, email, password, confirmPassword, captcha = {}) => {
    const data = await authApi.register({ 
      username, 
      email, 
      password, 
      confirmPassword,
      captchaId: captcha.id,
      captchaAnswer: captcha.answer,
      captchaToken: captcha.token,
    });
    setUser(data.user);
    return data;
  };

  const logout = async () => {
    try { await authApi.logout(); } catch { /* already gone - clear locally anyway */ }
    setUser(null);
  };

  /** Kill every session for this account, everywhere, then log out locally. */
  const logoutAll = async () => {
    await authApi.logoutAll();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ 
      user, 
      loading, 
      login, 
      register,
      logout, 
      logoutAll,
      isAdmin: user?.role === 'admin',
      // Staff = editor or admin: may create/edit content and see drafts.
      isEditor: user?.role === 'admin' || user?.role === 'editor',
      role: user?.role || null,
      isAuthenticated: !!user 
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
