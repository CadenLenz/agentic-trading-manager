import { useCallback, useEffect, useRef, useState } from 'react';
import { BarChart3, Bell, Bot, ChevronLeft, CircleGauge, Eye, History, LayoutDashboard, LogOut, Menu, MessageSquareText, Octagon, Pause, Play, RefreshCw, Scale, Settings, ShieldAlert, SlidersHorizontal, Wifi } from 'lucide-react';
import { api, post } from '../api';
import type { Dashboard, View } from '../types';
import { ActivityView, AgentsView, OverviewView, PerformanceView, ReconciliationView, RiskView, SettingsView, StrategiesView, WatchlistsView } from './Views';
import { AgentChat } from './AgentChat';
import { TradingWorkspace } from './TradingWorkspace';
import {SimulationPanel,RiskConfigurationPanel,ConnectionsPanel,NotificationsPanel,AcceptancePanel,PortfolioPanel,OptionsTelemetryPanel} from './PreproductionPanels';
import {EmergencyControls} from './EmergencyControls';
import {PiOperatorEvidence} from './PiOperatorEvidence';
import {PortfolioHierarchy} from './PortfolioHierarchy';
import {SymbolRiskOverrides} from './SymbolRiskOverrides';
import {ManualPreviewEvidence} from './ManualPreviewEvidence';
import {OpenAIConnectionSetup} from './OpenAIConnectionSetup';
import {SensitiveActionAuth} from './SensitiveActionAuth';

const nav: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  {id:'trading',label:'Trading Workspace',icon:ShieldAlert},
  {id:'simulation',label:'Simulation',icon:CircleGauge},
  {id:'risk-configuration',label:'Risk Engine',icon:ShieldAlert},
  {id:'portfolio',label:'Portfolio Charts',icon:BarChart3},
  {id:'options-telemetry',label:'Options Telemetry',icon:Scale},
  {id:'notifications',label:'Notifications',icon:Bell},
  {id:'connections',label:'Connections',icon:Wifi},
  {id:'acceptance',label:'Production Readiness',icon:ShieldAlert},
  { id: 'overview', label: 'Overview', icon: LayoutDashboard }, { id: 'agents', label: 'Agents', icon: Bot }, { id: 'strategies', label: 'Strategies', icon: SlidersHorizontal },
  { id: 'watchlists', label: 'Watchlists', icon: Eye }, { id: 'risk', label: 'Risk', icon: ShieldAlert }, { id: 'performance', label: 'Performance', icon: BarChart3 },
  { id: 'reconciliation', label: 'Reconciliation', icon: Scale }, { id: 'activity', label: 'Activity', icon: History }, { id: 'settings', label: 'Settings', icon: Settings },
];

export function ControlRoom({ initial, onLogout }: { initial: Dashboard; onLogout: () => Promise<void> }) {
  const [dashboard, setDashboard] = useState(initial); const [view, setView] = useState<View>('trading'); const [railOpen, setRailOpen] = useState(false); const [chatOpen, setChatOpen] = useState(false); const [refreshing, setRefreshing] = useState(false); const [toast, setToast] = useState<{ tone: string; message: string } | null>(null); const refreshTimer = useRef<number | null>(null);
  const refresh = useCallback(async () => { setRefreshing(true); try { setDashboard(await api<Dashboard>('/api/dashboard')); } catch (cause) { setToast({ tone: 'danger', message: cause instanceof Error ? cause.message : String(cause) }); } finally { setRefreshing(false); } }, []);
  const notify = useCallback((message: string, tone = 'success') => { setToast({ message, tone }); window.setTimeout(() => setToast(null), 4_000); }, []);
  useEffect(() => {
    const events = new EventSource('/api/events', { withCredentials: true });
    events.onmessage = () => { if (refreshTimer.current) window.clearTimeout(refreshTimer.current); refreshTimer.current = window.setTimeout(() => void refresh(), 350); };
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => { events.close(); window.clearInterval(interval); if (refreshTimer.current) window.clearTimeout(refreshTimer.current); };
  }, [refresh]);
  const setPause = async () => { const next = !dashboard.globalPause; await post('/api/system/pause', { paused: next }); notify(next ? 'Autonomous trading paused globally.' : 'Global pause released.'); await refresh(); };
  const emergency = async () => { if (!window.confirm('Emergency stop all autonomous trading and revoke LIVE database confirmation?')) return; await post('/api/system/emergency-stop', {}); notify('Emergency stop engaged. LIVE confirmation revoked.', 'danger'); await refresh(); };
  const title = nav.find((item) => item.id === view)?.label ?? 'Overview';
  const shared = { dashboard, refresh, notify };

  return <main className={`control-shell ${railOpen ? 'rail-open' : ''}`}>
    <aside className="app-rail">
      <button className="brand app-brand" onClick={() => setView('overview')}><span>A</span><strong>Agentic</strong></button>
      <button className="rail-collapse" onClick={() => setRailOpen(false)} aria-label="Collapse navigation"><ChevronLeft /></button>
      <nav>{nav.map((item) => { const Icon = item.icon; return <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => { setView(item.id); setRailOpen(false); }}><Icon size={17} /><span>{item.label}</span>{item.id === 'risk' && dashboard.recentRisks.length > 0 ? <i>{dashboard.recentRisks.length}</i> : null}</button>; })}</nav>
      <div className="rail-status"><div><span className={`live-dot ${dashboard.health.status}`} /><b>{dashboard.health.status}</b></div><small>{dashboard.health.ready ? 'Manager online' : 'Starting services'}</small></div>
    </aside>
    <section className="app-main">
      <header className="app-topbar">
        <div className="topbar-title"><button aria-label="Open navigation" className="menu-button" onClick={() => setRailOpen(true)}><Menu /></button><div><p className="eyebrow">CONTROL ROOM / {title.toUpperCase()}</p><h1>{title}</h1></div></div>
        <div className="topbar-actions">
          <button className="system-test-button" onClick={()=>void post('/api/v2/simulations',{speed:1}).then(()=>setView('simulation')).catch(e=>notify(String(e),'danger'))}>RUN FULL SYSTEM TEST</button>
          <button className={`mode-chip ${dashboard.mode.toLowerCase()}`} onClick={() => setView('settings')}><span /> {dashboard.mode}</button>
          {dashboard.maintenance && <span className="maintenance-chip">MAINTENANCE</span>}
          <button className="icon-button" onClick={() => void refresh()} aria-label="Refresh"><RefreshCw size={16} className={refreshing ? 'spin' : ''} /></button>
          <button className="icon-button notification" onClick={() => setView('notifications')} aria-label="Notifications"><Bell size={17} />{dashboard.recentRisks.length ? <i /> : null}</button>
          <button className={`pause-button ${dashboard.globalPause ? 'paused' : ''}`} onClick={() => void setPause()}>{dashboard.globalPause ? <Play size={15} /> : <Pause size={15} />}{dashboard.globalPause ? 'Resume all' : 'Pause all'}</button>
          <button className="emergency-button" onClick={() => void emergency()} title="Emergency stop"><Octagon size={16} /> STOP</button>
          <button className="profile-button" onClick={() => void onLogout()} title="Log out"><span>OP</span><LogOut size={14} /></button>
        </div>
      </header>
      {dashboard.globalPause && <div className="global-banner"><Pause size={15} /><b>GLOBAL PAUSE</b><span>No new autonomous orders. Observation and deterministic risk monitoring continue.</span></div>}
      {dashboard.simulated && <div className="simulation-banner"><CircleGauge size={15} /><b>SIMULATED DATA</b><span>No values on this screen represent live Robinhood funds or performance.</span></div>}
      <div className="view-scroll">
        <SensitiveActionAuth notify={notify}/>
        {view==='simulation'&&<SimulationPanel notify={notify}/>}
        {view==='risk-configuration'&&<><RiskConfigurationPanel notify={notify}/><SymbolRiskOverrides notify={notify}/></>}
        {view==='portfolio'&&<><PortfolioPanel/><PortfolioHierarchy/></>}
        {view==='options-telemetry'&&<OptionsTelemetryPanel/>}
        {view==='connections'&&<><OpenAIConnectionSetup notify={notify}/><ConnectionsPanel notify={notify}/></>}
        {view==='notifications'&&<NotificationsPanel notify={notify}/>}
        {view==='acceptance'&&<><AcceptancePanel notify={notify}/><ManualPreviewEvidence notify={notify}/><PiOperatorEvidence notify={notify}/><EmergencyControls notify={notify}/></>}
        {view==='trading'&&<TradingWorkspace notify={notify}/>}
        {view === 'overview' && <OverviewView {...shared} openChat={() => setChatOpen(true)} navigate={setView} />}
        {view === 'agents' && <AgentsView {...shared} />}
        {view === 'strategies' && <StrategiesView {...shared} />}
        {view === 'watchlists' && <WatchlistsView {...shared} />}
        {view === 'risk' && <RiskView {...shared} />}
        {view === 'performance' && <PerformanceView {...shared} />}
        {view === 'reconciliation' && <ReconciliationView {...shared} />}
        {view === 'activity' && <ActivityView {...shared} />}
        {view === 'settings' && <SettingsView {...shared} />}
      </div>
    </section>
    <button aria-label="Open trading agent" className="chat-fab" onClick={() => setChatOpen(true)}><MessageSquareText size={18} /><span>Manager</span></button>
    <AgentChat open={chatOpen} close={() => setChatOpen(false)} refresh={refresh} notify={notify} />
    {toast && <div className={`toast ${toast.tone}`}><Wifi size={16} /><span>{toast.message}</span></div>}
  </main>;
}
