import {CodexTasks} from './CodexTasks';
import {AccountExperience} from './AccountExperience';
import {ConnectionGuide} from './ConnectionGuide';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BarChart3, Bell, Bot, ChevronLeft, CircleGauge, Eye, History, LayoutDashboard, LogOut, Menu, MessageSquareText, Octagon, Pause, Play, RefreshCw, Scale, Settings, ShieldAlert, SlidersHorizontal, Wifi } from 'lucide-react';
import { api, post } from '../api';
import type { Dashboard, View } from '../types';
import { ActivityView, PerformanceView, ReconciliationView, RiskView, SettingsView, StrategiesView, WatchlistsView } from './Views';
import { AgentChat } from './AgentChat';
import { TradingWorkspace } from './TradingWorkspace';
import {SimulationPanel,RiskConfigurationPanel,NotificationsPanel,AcceptancePanel,OptionsTelemetryPanel} from './PreproductionPanels';
import {EmergencyControls} from './EmergencyControls';
import {PiOperatorEvidence} from './PiOperatorEvidence';
import {SymbolRiskOverrides} from './SymbolRiskOverrides';
import {ManualPreviewEvidence} from './ManualPreviewEvidence';
import {SensitiveActionAuth} from './SensitiveActionAuth';

const nav: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  {id:'strategy-settings',label:'Strategy configuration',icon:SlidersHorizontal},
  {id:'trading',label:'Trade reviews',icon:ShieldAlert},
  {id:'simulation',label:'Simulation',icon:CircleGauge},
  {id:'risk-configuration',label:'Risk limits',icon:ShieldAlert},
  {id:'portfolio',label:'Holdings',icon:BarChart3},
  {id:'options-telemetry',label:'Options',icon:Scale},
  {id:'notifications',label:'Notifications',icon:Bell},
  {id:'connections',label:'Setup & connections',icon:Wifi},
  {id:'acceptance',label:'Pi & readiness',icon:ShieldAlert},
  { id: 'overview', label: 'Account', icon: LayoutDashboard }, { id: 'agents', label: 'Codex Tasks', icon: Bot }, { id: 'strategies', label: 'Strategies', icon: SlidersHorizontal },
  { id: 'watchlists', label: 'Watchlists', icon: Eye }, { id: 'risk', label: 'Risk', icon: ShieldAlert }, { id: 'performance', label: 'Performance', icon: BarChart3 },
  { id: 'reconciliation', label: 'Reconciliation', icon: Scale }, { id: 'activity', label: 'Activity', icon: History }, { id: 'settings', label: 'Settings', icon: Settings },
];

export function ControlRoom({ initial, onLogout }: { initial: Dashboard; onLogout: () => Promise<void> }) {
  const [advanced,setAdvanced]=useState(false);
  const [dashboard, setDashboard] = useState(initial); const [view, setView] = useState<View>(new URLSearchParams(location.search).has('connection')||new URLSearchParams(location.search).has('connectionError')?'connections':'overview'); const [railOpen, setRailOpen] = useState(false); const [chatOpen, setChatOpen] = useState(false); const [refreshing, setRefreshing] = useState(false); const [toast, setToast] = useState<{ tone: string; message: string } | null>(null); const refreshTimer = useRef<number | null>(null);
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
      <nav aria-label="Main navigation">{['overview','agents','strategies','portfolio','options-telemetry','trading','risk-configuration','connections','simulation','notifications'].map(id=>nav.find(n=>n.id===id)!).map((item) => { const Icon = item.icon; return <button key={item.id} aria-current={view === item.id ? 'page' : undefined} className={view === item.id ? 'active' : ''} onClick={() => { setView(item.id); setRailOpen(false); }}><Icon size={17} /><span>{item.label}</span>{item.id === 'risk' && dashboard.recentRisks.length > 0 ? <i>{dashboard.recentRisks.length}</i> : null}</button>; })}<button aria-expanded={advanced} onClick={()=>setAdvanced(!advanced)}><Settings size={17}/><span>More tools</span><span>{advanced?'-':'+'}</span></button>{advanced&&nav.filter(n=>!['overview','agents','strategies','portfolio','options-telemetry','trading','risk-configuration','connections','simulation','notifications'].includes(n.id)).map(item=><button key={item.id} className={view===item.id?'active':''} onClick={()=>{setView(item.id);setRailOpen(false);}}>{item.label}</button>)}</nav>
      <div className="rail-status"><div><span className={`live-dot ${dashboard.health.status}`} /><b>{dashboard.health.status}</b></div><small>{dashboard.health.ready ? 'Manager online' : 'Starting services'}</small></div>
    </aside>
    <section className="app-main">
      <header className="app-topbar">
        <div className="topbar-title"><button aria-label="Open navigation" className="menu-button" onClick={() => setRailOpen(true)}><Menu /></button><div><p className="eyebrow">CONTROL ROOM / {title.toUpperCase()}</p><h1>{title}</h1></div></div>
        <div className="topbar-actions">
          <button className="system-test-button" onClick={()=>void post('/api/v2/simulations',{speed:1}).then(()=>setView('simulation')).catch(e=>notify(String(e),'danger'))}>Test with practice money</button>
          <button className={`mode-chip ${dashboard.mode.toLowerCase()}`} onClick={() => setView('settings')}><span /> {dashboard.mode==='SIMULATION'?'Practice mode':dashboard.mode==='READ_ONLY'?'Read only':'Live mode'}</button>
          {dashboard.maintenance && <span className="maintenance-chip">MAINTENANCE</span>}
          <button className="icon-button" onClick={() => void refresh()} aria-label="Refresh"><RefreshCw size={16} className={refreshing ? 'spin' : ''} /></button>
          <button className="icon-button notification" onClick={() => setView('notifications')} aria-label="Notifications"><Bell size={17} />{dashboard.recentRisks.length ? <i /> : null}</button>
          <button className={`pause-button ${dashboard.globalPause ? 'paused' : ''}`} onClick={() => void setPause().catch(e=>notify(String(e),'danger'))}>{dashboard.globalPause ? <Play size={15} /> : <Pause size={15} />}{dashboard.globalPause ? 'Resume all' : 'Pause all'}</button>
          <button className="emergency-button" onClick={() => void emergency().catch(e=>notify(String(e),'danger'))} title="Emergency stop"><Octagon size={16} /> STOP</button>
          <button className="profile-button" onClick={() => void onLogout()} title="Log out"><span>OP</span><LogOut size={14} /></button>
        </div>
      </header>
      {dashboard.globalPause && <div className="global-banner"><Pause size={15} /><b>GLOBAL PAUSE</b><span>No new autonomous orders. Observation and deterministic risk monitoring continue.</span></div>}
      {dashboard.simulated && <div className="simulation-banner"><CircleGauge size={15} /><b>PRACTICE MODE</b><span>You are using simulated money. Your real Robinhood funds are not shown here.</span></div>}
      <div className="view-scroll">
        {['trading','settings','acceptance','risk','strategy-settings'].includes(view)&&<SensitiveActionAuth notify={notify}/>}
        {view==='simulation'&&<SimulationPanel notify={notify}/>}
        {view==='risk-configuration'&&<><RiskConfigurationPanel notify={notify}/><details className="panel product-card"><summary>Advanced symbol overrides</summary><SymbolRiskOverrides notify={notify}/></details></>}
        {view==='portfolio'&&<AccountExperience dashboard={dashboard} section="positions" navigate={setView} openChat={()=>setChatOpen(true)}/>}
        {view==='options-telemetry'&&<OptionsTelemetryPanel/>}
        {view==='connections'&&<ConnectionGuide notify={notify}/>}
        {view==='notifications'&&<NotificationsPanel notify={notify}/>}
        {view==='acceptance'&&<><AcceptancePanel notify={notify}/><details className="panel product-card"><summary>Advanced commissioning evidence</summary><ManualPreviewEvidence notify={notify}/><PiOperatorEvidence notify={notify}/></details><details className="panel product-card"><summary>Emergency controls & recovery</summary><EmergencyControls notify={notify}/></details></>}
        {view==='trading'&&<TradingWorkspace notify={notify}/>}
        {view === 'overview' && <AccountExperience dashboard={dashboard} section="account" navigate={setView} openChat={()=>setChatOpen(true)}/>}
        {view === 'agents' && <CodexTasks notify={notify} />}
        {view === 'strategies' && <AccountExperience dashboard={dashboard} section="strategies" navigate={setView} openChat={()=>setChatOpen(true)}/>}
        {view === 'watchlists' && <WatchlistsView {...shared} />}
        {view === 'risk' && <RiskView {...shared} />}
        {view === 'performance' && <PerformanceView {...shared} />}
        {view === 'reconciliation' && <ReconciliationView {...shared} />}
        {view === 'activity' && <ActivityView {...shared} />}
        {view === 'strategy-settings' && <StrategiesView {...shared} />}
        {view === 'settings' && <SettingsView {...shared} />}
      </div>
    </section>
    <button aria-label="Open trading agent" className="chat-fab" onClick={() => setChatOpen(true)}><MessageSquareText size={18} /><span>Ask Codex</span></button>
    <AgentChat open={chatOpen} close={() => setChatOpen(false)} refresh={refresh} notify={notify} />
    {toast && <div role="status" className={`toast ${toast.tone}`}><Wifi size={16} /><span>{toast.message}</span></div>}
  </main>;
}
