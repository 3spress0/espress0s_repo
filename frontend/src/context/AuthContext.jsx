import { createContext, useContext, useState, useEffect } from 'react';
import { authApi } from '../lib/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('espress0_token');
    if (!token) {
      setLoading(false);
      return;
    }

    authApi.me()
      .then(data => setUser(data.user))
      .catch(() => {
        localStorage.removeItem('espress0_token');
      })
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
    localStorage.setItem('espress0_token', data.token);
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
    localStorage.setItem('espress0_token', data.token);
    setUser(data.user);
    return data;
  };

  const logout = () => {
    localStorage.removeItem('espress0_token');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ 
      user, 
      loading, 
      login, 
      register,
      logout, 
      isAdmin: user?.role === 'admin',
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
