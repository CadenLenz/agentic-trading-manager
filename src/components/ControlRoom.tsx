import {CodexTasks} from './CodexTasks';

import {AccountExperience} from './AccountExperience';

import {ConnectionGuide} from './ConnectionGuide';

import { useCallback, useEffect, useRef, useState } from 'react';

import { BarChart3, Bell, Bot, ChevronLeft, ChevronRight, CircleGauge, Eye, History, LayoutDashboard, LogOut, MoreHorizontal, MessageSquareText, Octagon, Pause, Play, RefreshCw, Scale, Settings, ShieldAlert, SlidersHorizontal, Wifi } from 'lucide-react';

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

  { id: 'overview', label: 'Overview', icon: LayoutDashboard }, { id: 'agents', label: 'Codex', icon: Bot }, { id: 'strategies', label: 'Strategies', icon: SlidersHorizontal },

  { id: 'watchlists', label: 'Watchlists', icon: Eye }, { id: 'risk', label: 'Risk', icon: ShieldAlert }, { id: 'performance', label: 'Performance', icon: BarChart3 },

  { id: 'reconciliation', label: 'Reconciliation', icon: Scale }, { id: 'activity', label: 'Activity', icon: History }, { id: 'settings', label: 'Settings', icon: Settings },

];



export function ControlRoom({ initial, onLogout }: { initial: Dashboard; onLogout: () => Promise<void> }) {

  const [controlsOpen,setControlsOpen]=useState(false);
  const [chatPrompt,setChatPrompt]=useState('');
  const openCodex=(prompt='')=>{setChatPrompt(prompt);setChatOpen(true);};

  const [dashboard, setDashboard] = useState(initial); const [view, setView] = useState<View>(new URLSearchParams(location.search).has('connection')||new URLSearchParams(location.search).has('connectionError')?'connections':'overview'); const [chatOpen, setChatOpen] = useState(false); const [refreshing, setRefreshing] = useState(false); const [toast, setToast] = useState<{ tone: string; message: string } | null>(null); const refreshTimer = useRef<number | null>(null);

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

  const navigate = (next: View) => { setView(next); window.scrollTo({top:0,behavior:'instant'}); };

  const primary = ['overview','portfolio','strategies','agents'];

  const inMore = !primary.includes(view);

  const title = view === 'more' ? 'More' : nav.find((item) => item.id === view)?.label ?? 'Overview';

  const shared = { dashboard, refresh, notify };



  return <main className="control-shell">

    <aside className="app-rail">

      <button className="brand app-brand" onClick={() => navigate('overview')}><span>A</span><strong>Agentic<small>Your trading workspace</small></strong></button>

      <nav aria-label="Main navigation">{primary.map(id=>nav.find(n=>n.id===id)!).map(item=>{const Icon=item.icon;return <button key={item.id} aria-current={view===item.id?'page':undefined} className={view===item.id?'active':''} onClick={()=>navigate(item.id)}><Icon size={19}/><span>{item.label}</span></button>;})}<button aria-current={inMore?'page':undefined} className={inMore?'active':''} onClick={()=>navigate('more')}><MoreHorizontal size={19}/><span>More</span></button></nav>

      <div className="rail-shortcuts"><span className="card-kicker">WORKSPACE</span><button onClick={()=>navigate('trading')}><ShieldAlert size={16}/>Trade reviews</button><button onClick={()=>navigate('connections')}><Wifi size={16}/>Connections</button></div>

      <div className="rail-status"><div><span className={`live-dot ${dashboard.health.status}`} /><b>{dashboard.health.ready?'Manager online':'Needs attention'}</b></div><button className="rail-logout" onClick={()=>void onLogout()}><LogOut size={15}/> Log out</button></div>

    </aside>

    <section className="app-main">

      <header className="app-topbar">

        <div className="topbar-title">{inMore&&view!=='more'&&<button className="icon-button back-tool" aria-label="Back to More" onClick={()=>navigate('more')}><ChevronLeft size={19}/></button>}<div><p className="eyebrow">AGENTIC / YOUR WORKSPACE</p><h1>{title}</h1></div></div>

        <div className="topbar-actions"><button className="icon-button refresh-control" onClick={()=>void refresh()} aria-label="Refresh"><RefreshCw size={17} className={refreshing?'spin':''}/></button><button className="control-status" aria-expanded={controlsOpen} onClick={()=>setControlsOpen(!controlsOpen)}><span className="status-dot"/>{dashboard.globalPause?'Trading paused':dashboard.mode==='READ_ONLY'?'Read only':dashboard.simulated?'Practice mode':'Trading controls'}</button><button className="emergency-button" onClick={()=>void emergency().catch(e=>notify(String(e),'danger'))} title="Emergency stop"><Octagon size={16}/> STOP</button></div>

      </header>

      {controlsOpen&&<section className="controls-sheet panel" aria-label="Trading controls"><div className="section-heading"><h2>Trading controls</h2><button onClick={()=>setControlsOpen(false)}>Close</button></div><p>{dashboard.mode==='READ_ONLY'?'Read only · real orders are disabled.':dashboard.simulated?'Practice mode · simulated money only.':'Live mode · all execution gates still apply.'} {dashboard.globalPause?'New autonomous orders are paused. Monitoring continues.':''}{dashboard.maintenance?' Maintenance is active.':''}</p><div className="control-sheet-actions"><button className="button secondary" onClick={()=>void setPause().catch(e=>notify(String(e),'danger'))}>{dashboard.globalPause?<Play size={16}/>:<Pause size={16}/>} {dashboard.globalPause?'Release global pause':'Pause all trading'}</button><button className="button secondary" onClick={()=>{navigate('settings');setControlsOpen(false);}}>Mode & settings</button><button className="button secondary" onClick={()=>{navigate('acceptance');setControlsOpen(false);}}>Safety & recovery</button></div></section>}

      {dashboard.simulated&&<div className="practice-strip">Practice account · simulated money</div>}

      <div className="view-scroll" key={view}>

        {view==='more'&&<div className="tools-home product-stack"><div className="page-intro"><h2>Your workspace, organized.</h2><p>Trading tools, account settings, and the details behind the decisions.</p></div><div className="tools-grid">{[

          {title:'Trading & research',description:'Review ideas and monitor what you own.',ids:['trading','options-telemetry','watchlists','performance']},

          {title:'Account & safety',description:'Connections, limits, and account differences.',ids:['connections','reconciliation','risk-configuration','risk']},

          {title:'Manage your workspace',description:'Preferences, strategy settings, and activity.',ids:['strategy-settings','notifications','activity','settings']},

          {title:'Advanced',description:'Practice runs, device checks, and recovery.',ids:['simulation','acceptance']}

        ].map(group=><section className="panel tool-group" key={group.title}><h3>{group.title}</h3><p>{group.description}</p>{group.ids.map(id=>nav.find(n=>n.id===id)!).map(item=>{const Icon=item.icon;return <button key={item.id} onClick={()=>navigate(item.id)}><Icon size={18}/><span>{item.label}</span><ChevronRight size={16}/></button>;})}</section>)}</div><div className="workspace-footer"><button onClick={()=>void onLogout()}><LogOut size={16}/> Log out</button><span>{dashboard.health.ready?'Manager online':'Manager needs attention'} · {dashboard.mode==='READ_ONLY'?'Read only':dashboard.simulated?'Practice mode':'Live mode'}</span></div></div>}



        {['trading','settings','acceptance','risk','strategy-settings'].includes(view)&&<details className="authorization-disclosure panel"><summary>Authorize a protected change</summary><SensitiveActionAuth notify={notify}/></details>}

        {view==='simulation'&&<SimulationPanel notify={notify}/>}

        {view==='risk-configuration'&&<><RiskConfigurationPanel notify={notify}/><details className="panel product-card"><summary>Advanced symbol overrides</summary><SymbolRiskOverrides notify={notify}/></details></>}

        {view==='portfolio'&&<AccountExperience dashboard={dashboard} section="positions" navigate={navigate} openChat={openCodex}/>}

        {view==='options-telemetry'&&<OptionsTelemetryPanel/>}

        {view==='connections'&&<ConnectionGuide notify={notify}/>}

        {view==='notifications'&&<NotificationsPanel notify={notify}/>}

        {view==='acceptance'&&<><AcceptancePanel notify={notify}/><details className="panel product-card"><summary>Advanced commissioning evidence</summary><ManualPreviewEvidence notify={notify}/><PiOperatorEvidence notify={notify}/></details><details className="panel product-card"><summary>Emergency controls & recovery</summary><EmergencyControls notify={notify}/></details></>}

        {view==='trading'&&<TradingWorkspace notify={notify}/>}

        {view === 'overview' && <AccountExperience dashboard={dashboard} section="account" navigate={navigate} openChat={openCodex}/>}

        {view === 'agents' && <CodexTasks notify={notify} />}

        {view === 'strategies' && <AccountExperience dashboard={dashboard} section="strategies" navigate={navigate} openChat={openCodex}/>}

        {view === 'watchlists' && <WatchlistsView {...shared} />}

        {view === 'risk' && <RiskView {...shared} />}

        {view === 'performance' && <PerformanceView {...shared} />}

        {view === 'reconciliation' && <ReconciliationView {...shared} />}

        {view === 'activity' && <ActivityView {...shared} />}

        {view === 'strategy-settings' && <StrategiesView {...shared} />}

        {view === 'settings' && <SettingsView {...shared} />}

      </div>

    </section>

    <nav className="mobile-navigation" aria-label="Mobile navigation">{[...primary,'more'].map(id=>{const item=nav.find(n=>n.id===id),Icon=item?.icon??MoreHorizontal,active=id==='more'?inMore:view===id;return <button key={id} className={active?'active':''} aria-current={active?'page':undefined} onClick={()=>navigate(id as View)}><Icon size={21}/><span>{item?.label??'More'}</span></button>;})}</nav>

    <button aria-label="Open trading agent" className="chat-fab" onClick={() => openCodex()}><MessageSquareText size={18} /><span>Ask Codex</span></button>

    <AgentChat initialPrompt={chatPrompt} open={chatOpen} close={() => setChatOpen(false)} refresh={refresh} notify={notify} />

    {toast && <div role="status" className={`toast ${toast.tone}`}><Wifi size={16} /><span>{toast.message}</span></div>}

  </main>;

}

