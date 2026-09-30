import {useEffect,useState} from 'react';
import {api,post} from '../api';
import {SensitiveActionAuth} from './SensitiveActionAuth';

const names={SAFE_LONG_TERM:'Safe',AGGRESSIVE_STOCKS:'Aggressive',OPTIONS:'Options'};
type Sleeve=keyof typeof names;
interface Report {
  clear:boolean;warnings:string[];lastRunAt:string|null;mismatches:string[];
  positions:Array<{symbol:string;internal:number;broker:number;averageCost:number|null}>;snapshotComplete:boolean;
  cash:{internal:number;broker:number|null;buyingPower:number|null};
  account:{positions:Array<{symbol:string;quantity:number;averageCost:number|null}>}|null;
  initialImport:{available:boolean;reason:string|null;token:string|null};
}
const money=(n:number|null)=>n===null?'Unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);
export function AccountReconciliation({refresh,notify}:{refresh:()=>Promise<void>;notify:(message:string,tone?:string)=>void}){
  const [data,setData]=useState<Report|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [assignments,setAssignments]=useState<Record<string,string>>({}),[cash,setCash]=useState<Record<Sleeve,string>>({SAFE_LONG_TERM:'',AGGRESSIVE_STOCKS:'',OPTIONS:''}),[review,setReview]=useState(''),[confirmation,setConfirmation]=useState(''),[basisAcknowledged,setBasisAcknowledged]=useState(false);
  const load=async()=>setData(await api<Report>('/api/v2/reconciliation'));
  useEffect(()=>{void load().catch(e=>setError(String(e)));},[]);
  const sync=async()=>{setBusy(true);setError('');try{await post('/api/v2/reconciliation',{});await Promise.all([load(),refresh()]);}catch(e){setError(e instanceof Error?e.message:String(e));await Promise.all([load(),refresh()]).catch(()=>undefined);}finally{setBusy(false);}};
  const importAccount=async()=>{if(!data)return;setBusy(true);setError('');try{
    const result=await post<{clear:boolean}>('/api/v2/reconciliation/import',{token:data.initialImport.token,confirmation,review,...(basisAcknowledged?{basisAcknowledgement:"These holdings were imported from Robinhood and cost basis is currently unavailable."}:{}),assignments:(data.account?.positions??[]).map(p=>({symbol:p.symbol,strategy:assignments[p.symbol]})),cash:Object.fromEntries(Object.entries(cash).map(([s,n])=>[s,Number(n)]))});
    await Promise.all([load(),refresh()]);notify(result.clear?'Opening balance imported and reconciled. Trading remains paused and read only.':'Opening balance recorded; remaining differences still block trading.',result.clear?'success':'warning');
  }catch(e){setError(e instanceof Error?e.message:String(e));await load().catch(()=>undefined);}finally{setBusy(false);}};
  if(!data)return <p role="status">{error||'Loading account differences…'}</p>;
  const cashTotal=Object.values(cash).reduce((n,v)=>n+Number(v||0),0);
  const needsBasisAcknowledgement=data.account?.positions.some(p=>p.averageCost===null);
  const ready=(!needsBasisAcknowledgement||basisAcknowledged)&&!!data.account&&data.account.positions.every(p=>assignments[p.symbol])&&Object.values(cash).every(v=>v!==''&&Number.isFinite(Number(v))&&Number(v)>=0)&&Math.abs(cashTotal-(data.cash.broker??0))<.005&&review.trim().length>=20&&confirmation==='IMPORT VERIFIED ACCOUNT';
  return <div className="page reconciliation-page">
    <div className="section-heading"><div><p className="eyebrow">ACCOUNT INTEGRITY</p><h2>{data.clear?'Your account is reconciled':'Review account differences'}</h2><p className="muted">Compare strategy records with your verified broker account. A sync checks the facts; it does not overwrite ownership.</p></div><button className="button primary" disabled={busy} onClick={()=>void sync()}>{busy?'Working…':'Sync and check'}</button></div>
    <p className="safety-note">Trading stays paused and read only during this review. Importing records does not buy, sell, or enable trading.</p>
    {error&&<p className="negative" role="alert">{error}</p>}
    <section className="panel product-card"><h3>{data.clear?'No current mismatches':'Critical mismatches'}</h3><p className="muted">Last checked {data.lastRunAt?new Date(data.lastRunAt).toLocaleString():'Not yet checked'}</p>
      {!data.snapshotComplete&&<p className="safety-note">Broker quantities and cash below are observed facts, but cost basis is incomplete. Opening-balance import remains blocked.</p>}
      <div className="reconciliation-comparisons">{data.positions.map(p=><article key={p.symbol}><strong>{p.symbol}</strong><dl className="plain-facts"><div><dt>Strategy ledger</dt><dd>{p.internal} shares</dd></div><div><dt>Broker account</dt><dd>{p.broker} shares</dd></div><div><dt>Difference</dt><dd>{p.broker-p.internal} shares</dd></div><div><dt>Broker average cost</dt><dd>{money(p.averageCost)}</dd></div></dl></article>)}<article><strong>Cash</strong><dl className="plain-facts"><div><dt>Strategy ledger</dt><dd>{money(data.cash.internal)}</dd></div><div><dt>Broker cash</dt><dd>{money(data.cash.broker)}</dd></div><div><dt>Difference</dt><dd>{money(data.cash.broker===null?null:data.cash.broker-data.cash.internal)}</dd></div><div><dt>Broker buying power</dt><dd>{money(data.cash.buyingPower)}</dd></div></dl></article></div>
      {data.warnings?.map(w=><p className="safety-note" key={w}>{w}. Quantity and market value remain verified; basis-dependent P&L is unavailable.</p>)}
      {data.mismatches.length>0&&<ul>{data.mismatches.map(m=><li key={m}>{m}</li>)}</ul>}
    </section>
    {!data.clear&&<section className="panel product-card"><h3>Import your opening account balance</h3><p>This one-time review replaces the unused setup cash and records holdings you already own. Broker cost basis is preserved. Each strategy starts from its imported value, so setup money is not counted as a trading loss.</p>
      {!data.initialImport.available?<><p className="safety-note">{data.initialImport.reason}</p><p className="muted">If the snapshot is stale, sync again. An established ledger needs individual verified broker-event review; it cannot be reset here.</p></>:<>
        <div className="opening-holdings">{data.account?.positions.map(p=><label className="field" key={p.symbol}><span>{p.symbol} · {p.quantity} shares · broker average cost {money(p.averageCost)}</span><select aria-label={p.symbol+' strategy owner'} value={assignments[p.symbol]??''} onChange={e=>setAssignments({...assignments,[p.symbol]:e.target.value})}><option value="">Choose a strategy</option>{Object.entries(names).map(([s,name])=><option key={s} value={s}>{name}</option>)}</select></label>)}</div>
        <h4>Assign {money(data.cash.broker)} of existing cash</h4><div className="opening-cash">{Object.entries(names).map(([s,name])=><label className="field" key={s}><span>{name} cash</span><input aria-label={name+' opening cash'} type="number" min="0" step="0.01" value={cash[s as Sleeve]} onChange={e=>setCash({...cash,[s]:e.target.value})}/></label>)}</div><p className="muted">Assigned {money(cashTotal)} · must equal broker cash exactly. These amounts allocate existing cash; they do not transfer money at Robinhood.</p>
        <label className="field"><span>Ownership review</span><textarea aria-label="Opening balance review" placeholder="Explain your strategy assignments and confirm these are existing holdings." value={review} onChange={e=>setReview(e.target.value)}/></label>
        {needsBasisAcknowledgement&&<label className="field"><span><input type="checkbox" checked={basisAcknowledged} onChange={e=>setBasisAcknowledged(e.target.checked)}/> These holdings were imported from Robinhood and cost basis is currently unavailable.</span></label>}
        <p>Proposed cash correction: {money(data.cash.broker===null?null:data.cash.broker-data.cash.internal)}. After confirmation, opening cash will be {money(data.cash.broker)}.</p>
        <SensitiveActionAuth notify={notify}/>
        <label className="field"><span>Type IMPORT VERIFIED ACCOUNT</span><input aria-label="Opening balance confirmation" value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></label>
        <button className="button primary" disabled={busy||!ready} onClick={()=>void importAccount()}>Confirm and import opening balance</button>
      </>}
    </section>}
  </div>;
}
