import {useCallback,useEffect,useState} from 'react';
import {api,post} from '../api';
import {SensitiveActionAuth} from './SensitiveActionAuth';
import {AutonomyPanel} from './AutonomyPanel';
type Readiness={ready:boolean;mode:string;checks:Record<string,boolean>;limitation:string};
const labels:Record<string,string>={calendarVerified:'Exchange calendar freshly verified',correctAccount:'Correct Agentic account',freshAccount:'Account freshly synced',cleanReconciliation:'Account differences resolved',reviewedOpening:'Opening cash reviewed',reviewedOwnership:'Holdings ownership reviewed',robinhoodAvailable:'Robinhood connected',brokerReviewVerified:'Official order review verified',executionCapabilities:'Placement and cancellation available',deterministicRiskHealthy:'Risk safety checks passed for these settings',emergencyStopHealthy:'Emergency STOP available',noUnknownOrders:'No uncertain order outcomes',manualApprovalOnly:'Manual transaction approval configured',pauseReleased:'Global pause deliberately released',stopReleased:'STOP released',maintenanceOff:'Maintenance off'};
export function ManualLivePanel({notify}:{notify:(message:string,tone?:string)=>void}){
  const [data,setData]=useState<Readiness|null>(null),[busy,setBusy]=useState(false),[confirmation,setConfirmation]=useState('');
  const load=useCallback(async()=>setData(await api<Readiness>('/api/v2/readiness')),[]);
  useEffect(()=>{void load().catch(e=>notify(String(e),'danger'));},[load,notify]);
  const action=async(path:string,body:unknown={},message='Check recorded. No order was placed.')=>{setBusy(true);try{await post(path,body);await load();notify(message);}catch(e){notify(e instanceof Error?e.message:String(e),'danger');}finally{setBusy(false);}};
  return <div className="terminal-stack">
    <AutonomyPanel notify={notify}/>
    <section className="panel product-card terminal-panel">
      <p className="eyebrow">ACCOUNT & SAFETY</p><h2>Live readiness checks</h2>
      <p>Sync the account, commission opening holdings and cash, then verify broker review, risk and STOP. These checks support both Manual Live and Autonomous Live.</p>
      <div className="v2-actions"><button className="button secondary" disabled={busy} onClick={()=>void action('/api/v2/reconciliation')}>Sync and check account</button><button className="button secondary" disabled={busy} onClick={()=>void action('/api/v2/commission/check')}>Check official broker review</button><button className="button secondary" disabled={busy} onClick={()=>void action('/api/v2/self-tests')}>Check risk and STOP safety</button></div>
      <p className="muted">Broker review uses an existing holding without placing an order. Safety checks use isolated simulated money. Imported historical basis can remain unavailable; historical P&L is never invented.</p>
      <SensitiveActionAuth notify={notify}/>
      <button className="button secondary" disabled={busy||data?.checks.pauseReleased} onClick={()=>{if(window.confirm('Release global pause? Enabled live modes can submit qualifying orders once their remaining checks pass.'))void action('/api/system/pause',{paused:false},'Global pause released. Execution still requires the selected live mode and all risk checks.');}}>Release global pause</button>
      <details><summary>Manual Live controls</summary>
        <p>Manual Live requires your approval and a separate submission for every trade. Autonomous Live uses the explicit authorization above and proceeds without per-trade approval.</p>
        <p className="safety-note">{data?.mode==='AUTONOMOUS_LIVE'?'AUTONOMOUS LIVE':data?.mode==='LIVE'||data?.mode==='MANUAL_LIVE'?'MANUAL LIVE':'READ ONLY'} · {data?.checks.stopReleased===false?'STOPPED':data?.checks.pauseReleased===false?'PAUSED':data?.checks.cleanReconciliation===false?'RECONCILIATION REQUIRED':data?.ready?'READY':'REVIEW REQUIRED'}</p>
        <div className="assertion-list">{Object.entries(data?.checks??{}).map(([k,v])=><div key={k}><b className="muted">{v?'PASS':'NEEDED'}</b><span>{labels[k]??k}</span></div>)}</div><p>{data?.limitation}</p>
        <label className="field"><span>Type ENABLE LIVE TRADING</span><input value={confirmation} onChange={e=>setConfirmation(e.target.value)} autoComplete="off"/></label>
        <div className="v2-actions"><button className="button primary" disabled={busy||!data?.ready||confirmation!=='ENABLE LIVE TRADING'} onClick={()=>void action('/api/system/mode',{mode:'LIVE',confirmation},'Manual Live enabled. Each trade requires approval and submission.')}>Enable Manual Live</button><button className="button secondary" disabled={busy} onClick={()=>void action('/api/system/mode',{mode:'READ_ONLY'},'Read only enabled. New live orders are blocked.')}>Return to Read only</button></div>
      </details>
    </section>
  </div>;
}
