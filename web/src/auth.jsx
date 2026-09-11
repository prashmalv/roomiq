import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api.js';

const Ctx = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, window: null, settings: null });

  const refresh = useCallback(async () => {
    try {
      const me = await api.get('/api/auth/me');
      setState({ loading: false, user: me.user, window: me.window, settings: me.settings });
    } catch {
      setState({ loading: false, user: null, window: null, settings: null });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const login = async (email, password) => {
    await api.post('/api/auth/login', { email, password });
    await refresh();
  };
  // Registering signs the new employee in, so the session is live immediately.
  const register = async (payload) => {
    await api.post('/api/auth/register', payload);
    await refresh();
  };
  const logout = async () => {
    await api.post('/api/auth/logout');
    setState({ loading: false, user: null, window: null, settings: null });
  };

  return <Ctx.Provider value={{ ...state, refresh, login, register, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
