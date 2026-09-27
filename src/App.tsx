import { useCallback, useEffect, useState } from 'react';
import { api, post, setCsrf, ApiError } from './api';
import type { Dashboard } from './types';
import { LoginScreen, SetupWizard, type SetupStatus } from './components/Onboarding';
import { ControlRoom } from './components/ControlRoom';

type Phase = 'loading' | 'setup' | 'login' | 'ready' | 'error';

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');

  const loadDashboard = useCallback(async () => {
    const next = await api<Dashboard>('/api/dashboard');
    setDashboard(next); setPhase('ready');
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      const status = await api<SetupStatus>('/api/setup/status');
      setSetup(status);
      if (!status.complete) { setPhase('setup'); return; }
      try {
        const session = await api<{ csrf: string }>('/api/auth/session'); setCsrf(session.csrf); await loadDashboard();
      } catch (cause) { if(cause instanceof ApiError&&cause.status===401)setPhase('login');else throw cause; }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setPhase('error'); }
  }, [loadDashboard]);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  if (phase === 'loading') return <div className="boot"><div className="boot-mark">A</div><p>Opening your account…</p></div>;
  if (phase === 'error') return <div className="fatal"><span>CONNECTION INTERRUPTED</span><h1>The app is not responding</h1><p>{error}</p><button onClick={() => { setPhase('loading'); void bootstrap(); }}>Retry</button></div>;
  if (phase === 'setup' && setup) return <SetupWizard status={setup} onComplete={(csrf) => { setCsrf(csrf); void loadDashboard(); }} />;
  if (phase === 'login') return <LoginScreen onAuthenticated={(csrf) => { setCsrf(csrf); void loadDashboard(); }} />;
  if (!dashboard) return null;
  return <ControlRoom initial={dashboard} onLogout={async () => { await post('/api/auth/logout', {}); setCsrf(''); setDashboard(null); setPhase('login'); }} />;
}
