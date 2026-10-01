import type {AgenticManager} from '../../core/src/agentic-manager.js';
import {AutonomousSupervisor,type SupervisorSnapshot,type MonitoredSleeve} from './autonomous-supervisor.js';
import {autonomousAuthorized,revokeAutonomy} from './autonomy.js';
import {SLEEVES,type TradingAccount} from './model.js';
import {zonedDate} from './scheduling.js';

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
        return [s,{enabled:!!db.getStrategy(s)?.enabled,autonomous:autonomousAuthorized(db,s),killed:state.killed,orders,
          positions:[...state.positions.map(p=>({id:p.symbol,quantity:p.quantity,price:p.marketPrice})),...state.options.map(p=>({id:p.option_id,quantity:p.contracts,price:p.mark_price,expiresAt:(JSON.parse(p.instrument_json) as {expiration:string}).expiration,...db.getSetting<{underlyingPrice?:number;spreadPercent?:number;delta?:number;iv?:number}>('option_monitor:'+p.option_id,{})}))],
          materialEvents:[...state.positions.filter(p=>p.averageCost!==null).flatMap(p=>{const r=m.riskConfiguration.effective(s,p.assetType==='ETF'?'ETF':'EQUITY',p.symbol),change=100*(p.marketPrice/p.averageCost!-1);return r.exitMethod==='PERCENT'&&(change<=-r.stopPercent||change>=r.takeProfitPercent)?[p.symbol+':'+(change<0?'STOP_THRESHOLD':'PROFIT_THRESHOLD')]:[];}),...state.options.flatMap(p=>{const i=JSON.parse(p.instrument_json) as {underlying:string},r=m.riskConfiguration.effective(s,'OPTION',i.underlying),change=Math.sign(p.contracts)*100*(p.mark_price/p.average_premium-1);return change<=-r.stopPercent||change>=r.takeProfitPercent?[p.option_id+':'+(change<0?'STOP_THRESHOLD':'PROFIT_THRESHOLD')]:[];})]}];
      })) as SupervisorSnapshot['sleeves'];
      const next=db.raw.prepare('SELECT opens_at FROM market_sessions WHERE opens_at>? ORDER BY opens_at LIMIT 1').get(now.toISOString()) as {opens_at:string}|undefined;
      return {mode:db.getMode(),paused:db.getSetting('global_pause',true),stopped:db.getSetting('stopped',false),reconciled:db.getSetting('reconciliation_clear',false),brokerHealthy:!!a?.healthy,accountAsOf:a?.asOf??null,
        market:{open:verified&&Date.parse(session!.opens_at)<=now.getTime()&&now.getTime()<Date.parse(session!.closes_at),verified,date,closesAt:session?.closes_at??null,nextOpen:next?.opens_at??null,lastSessionOfWeek:now.getUTCDay()===5},sleeves};
    },
    reconcile:async()=>{const result=await m.proposals.reconcile();if(!result.clear)throw new Error('Account reconciliation is unsafe');},
    workerAvailable:async()=>!!(await m.codexTasks.status()).usable,
    createReasoning:async r=>m.codexTasks.create(r.message+' Manage existing positions first. Propose at most one qualifying trade with current sourced research, or explain why no trade qualifies. Do not fabricate missing facts.','AUTONOMOUS_SUPERVISOR',{id:r.id,autonomous:r.sleeve}),
    taskStatus:id=>{const status=m.codexTasks.get(id).status;return status==='BLOCKED_USAGE_LIMIT'?'FAILED':status;},
    report:r=>{const kind=r.kind==='WEEKLY'?'WEEKLY_REPORT':r.kind==='DAILY'?'DAILY_REPORT':'OPTIONS_EVENT',scope=r.sleeve??'ACCOUNT';m.analytics.report(kind+':'+scope);m.notifications.emit('autonomous-report:'+kind+':'+scope+':'+r.contextHash,kind,'INFO',{summary:scope+' '+r.reason,scope});},
    onFault:reason=>{revokeAutonomy(db,reason);m.notifications.emit('autonomy-fault:'+reason,'RECONCILIATION_FAILURE','CRITICAL',{summary:reason});},
  });
}
