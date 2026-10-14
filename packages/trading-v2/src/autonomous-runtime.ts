import type {AgenticManager} from '../../core/src/agentic-manager.js';
import {AutonomousSupervisor,type SupervisorSnapshot,type MonitoredSleeve} from './autonomous-supervisor.js';
import {sleeveExecutionBlocked,suspendAutonomy} from './autonomy.js';
import {SLEEVES,type TradingAccount,type ProposalInput,type OptionInstrument} from './model.js';
import {zonedDate} from './scheduling.js';

export async function refreshOptionMonitoring(m:AgenticManager){
  const db=m.database,at=new Date(),session=db.raw.prepare('SELECT opens_at,closes_at FROM market_sessions WHERE date=?').get(zonedDate(at)) as {opens_at:string;closes_at:string}|undefined;
  if(!session||at.getTime()<Date.parse(session.opens_at)||at.getTime()>=Date.parse(session.closes_at))return;
  const held=m.allocation.state('OPTIONS').options.filter(p=>p.contracts!==0);
  db.setSetting('option_monitor_fault',null);
  for(const p of held){try{
    const i=JSON.parse(p.instrument_json) as OptionInstrument,contracts=Math.abs(p.contracts);
    const probe:ProposalInput={schemaVersion:2,strategy:'OPTIONS',assetClass:'OPTION',symbol:i.underlying,underlying:i.underlying,side:p.contracts>0?'SELL':'BUY',positionEffect:'CLOSE',orderType:'LIMIT',quantity:contracts,dollarAmount:null,limitPrice:Math.max(p.mark_price,.01),stopPrice:null,timeInForce:'DAY',marketHours:'REGULAR',createdAt:at.toISOString(),expiresAt:new Date(at.getTime()+60000).toISOString(),option:{optionId:i.optionId,type:i.type,strike:i.strike,expiration:i.expiration,contracts,strategy:p.contracts>0?(i.type==='CALL'?'LONG_CALL':'LONG_PUT'):(i.type==='CALL'?'COVERED_CALL':'CASH_SECURED_PUT'),maxLoss:0,collateralRequired:p.collateral,estimatedPremium:p.mark_price},researchSummary:'Read-only monitoring probe',thesis:'Observe existing contract; no order',catalyst:'',technicalSetup:'',fundamentalContext:'',riskFactors:['Observation only'],invalidation:'Not an execution proposal',expectedHoldingPeriod:'Monitoring',holdingTradingDays:null,exitPlan:'No order'};
    const q=await m.liveBroker.quote(probe),age=Date.now()-Date.parse(q.asOf),mid=(q.bid+q.ask)/2;
    if(q.option?.optionId!==i.optionId||!Number.isFinite(age)||age< -5000||age>60000||!Number.isFinite(q.price)||q.price<=0||mid<=0)throw new Error('Fresh contract quote unavailable');
    m.analytics.recordOption(i.optionId,q);
    db.setSetting('option_monitor:'+i.optionId,{price:q.price,underlyingPrice:q.underlyingPrice,spreadPercent:100*(q.ask-q.bid)/mid,delta:q.delta,iv:q.iv,asOf:q.asOf});
  }catch{db.setSetting('option_monitor_fault','Fresh option market data unavailable; OPTIONS decisions paused until the next successful poll');}}
}

export function createAutonomousSupervisor(m:AgenticManager){
  const db=m.database;
  return new AutonomousSupervisor(db,{
    snapshot:()=>{
      const now=new Date(),date=zonedDate(now),a=db.getSetting<TradingAccount|null>('broker_account_v2',null);
      const session=db.raw.prepare('SELECT opens_at,closes_at,verified_at FROM market_sessions WHERE date=?').get(date) as {opens_at:string;closes_at:string;verified_at:string}|undefined;
      const verified=!!session&&Date.now()-Date.parse(session.verified_at)<7*86400000;
      const sleeves=Object.fromEntries(SLEEVES.map(s=>{
        const state=m.allocation.state(s);
        const orders=db.raw.prepare("SELECT id,status,cumulative_filled_quantity AS filledQuantity FROM orders WHERE strategy_id=? AND status IN ('PENDING','SUBMITTED','PARTIALLY_FILLED','UNKNOWN')").all(s) as MonitoredSleeve['orders'];
        return [s,{enabled:!!db.getStrategy(s)?.enabled,autonomous:state.policy.executionPolicy==='AUTONOMOUS_RISK_APPROVED'&&!!db.getSetting('autonomous_authorization_v1',null),killed:state.killed,blockedReason:sleeveExecutionBlocked(db,s)?'UNKNOWN_OUTCOME; never resend':s==='OPTIONS'?db.getSetting<string|null>('option_monitor_fault',null)??undefined:undefined,orders,
          positions:[...state.positions.map(p=>({id:p.symbol,quantity:p.quantity,price:p.marketPrice})),...state.options.map(p=>({id:p.option_id,quantity:p.contracts,price:p.mark_price,expiresAt:(JSON.parse(p.instrument_json) as {expiration:string}).expiration,...db.getSetting<{underlyingPrice?:number;spreadPercent?:number;delta?:number;iv?:number}>('option_monitor:'+p.option_id,{})}))],
          materialEvents:[...state.positions.filter(p=>p.averageCost!==null).flatMap(p=>{const r=m.riskConfiguration.effective(s,p.assetType==='ETF'?'ETF':'EQUITY',p.symbol),change=100*(p.marketPrice/p.averageCost!-1);return r.exitMethod==='PERCENT'&&(change<=-r.stopPercent||change>=r.takeProfitPercent)?[p.symbol+':'+(change<0?'STOP_THRESHOLD':'PROFIT_THRESHOLD')]:[];}),...state.options.flatMap(p=>{const i=JSON.parse(p.instrument_json) as {underlying:string},r=m.riskConfiguration.effective(s,'OPTION',i.underlying),change=Math.sign(p.contracts)*100*(p.mark_price/p.average_premium-1);return change<=-r.stopPercent||change>=r.takeProfitPercent?[p.option_id+':'+(change<0?'STOP_THRESHOLD':'PROFIT_THRESHOLD')]:[];})]}];
      })) as SupervisorSnapshot['sleeves'];
      const next=db.raw.prepare('SELECT opens_at FROM market_sessions WHERE opens_at>? ORDER BY opens_at LIMIT 1').get(now.toISOString()) as {opens_at:string}|undefined;
      return {mode:db.getMode(),paused:db.getSetting('global_pause',true),stopped:db.getSetting('stopped',false),reconciled:db.getSetting('reconciliation_clear',false),brokerHealthy:!!a?.healthy,accountAsOf:a?.asOf??null,
        market:{open:verified&&Date.parse(session!.opens_at)<=now.getTime()&&now.getTime()<Date.parse(session!.closes_at),verified,date,closesAt:session?.closes_at??null,nextOpen:next?.opens_at??null,lastSessionOfWeek:now.getUTCDay()===5},sleeves};
    },
    reconcile:async()=>{const result=await m.proposals.reconcile();if(!result.clear)throw new Error('Account reconciliation is unsafe');await refreshOptionMonitoring(m);},
    workerAvailable:async()=>Date.now()>=db.getSetting<number>('codex_usage_retry_after_v1',0)&&!!(await m.codexTasks.status()).usable,
    createReasoning:async r=>m.codexTasks.create(r.message+' Manage existing positions first. Propose at most one qualifying trade with current sourced research, or explain why no trade qualifies. Do not fabricate missing facts.','AUTONOMOUS_SUPERVISOR',{id:r.id,autonomous:r.sleeve}),
    taskStatus:id=>{const status=m.codexTasks.get(id).status;return status==='BLOCKED_USAGE_LIMIT'?'FAILED':status;},
    report:r=>{const kind=r.kind==='WEEKLY'?'WEEKLY_REPORT':r.kind==='DAILY'?'DAILY_REPORT':'OPTIONS_EVENT',scope=r.sleeve??'ACCOUNT';m.analytics.report(kind+':'+scope);m.notifications.emit('autonomous-report:'+kind+':'+scope+':'+r.contextHash,kind,'INFO',{summary:scope+' '+r.reason,scope});},
    onFault:reason=>{suspendAutonomy(db,reason);m.notifications.emit('autonomy-fault:'+reason,'RECONCILIATION_FAILURE','CRITICAL',{summary:reason});},
  });
}
