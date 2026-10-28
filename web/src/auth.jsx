import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, getToken, setToken } from './api';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(!getToken());

  useEffect(() => {
    if (!getToken()) return;
    api.get('/auth/me').then(setUser).catch(() => setToken(null)).finally(() => setReady(true));
  }, []);

  useEffect(() => {
    const onLogout = () => setUser(null);
    window.addEventListener('autostrad:logout', onLogout);
    return () => window.removeEventListener('autostrad:logout', onLogout);
  }, []);

  const login = useCallback(async (email, password) => {
    const res = await api.post('/auth/login', { email, password });
    setToken(res.token);
    const me = await api.get('/auth/me').catch(() => res.user);
    setUser(me);
    return me;
  }, []);

  const logout = useCallback(() => { setToken(null); setUser(null); }, []);

  // what the signed-in person's role allows, as the server reported it ('bookings.edit', 'helpdesk.system', ...)
  const can = useCallback((cap) => Boolean(user && user.caps && user.caps.includes(cap)), [user]);

  const value = useMemo(() => ({ user, ready, login, logout, can }), [user, ready, login, logout, can]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
