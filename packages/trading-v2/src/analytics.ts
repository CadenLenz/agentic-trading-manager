import type {AppDatabase} from '../../database/src/database.js';
import type {VirtualPortfolioLedger} from '../../ledger/src/virtual-ledger.js';
import {makeId,nowIso,roundMoney} from '../../core/src/utils.js';
import {StrategyAllocationManager} from './capital.js';
import {pacificPeriodStart} from './periods.js';
import {SLEEVES,type TrustedQuote} from './model.js';
export class PortfolioAnalytics{
  constructor(readonly db:AppDatabase,readonly ledger:VirtualPortfolioLedger,readonly allocation:StrategyAllocationManager){}
  private verifiedSince(since:string,mode:string,account:string){const opening=this.db.getSetting<{accountId:string;at:string}|null>('initial_account_import_v2',null);return mode!=='SIMULATION'&&opening?.accountId===account&&opening.at>since?opening.at:since;}
  snapshot(reason:string,externalFlow=0,at=nowIso()){
    const sleeves=SLEEVES.map(s=>this.allocation.state(s)),a=this.db.getSetting<{accountId:string;buyingPower:number}|null>('broker_account_v2',null),id=makeId('snapshot');
    const cash=sleeves.reduce((n,s)=>n+s.cash,0),equity=sleeves.reduce((n,s)=>n+s.currentEquity,0);
    this.db.raw.transaction(()=>{this.db.raw.prepare('INSERT INTO portfolio_snapshots VALUES(?,?,?,?,?,?,?,?,?)').run(id,this.db.getMode()==='SIMULATION'?'SIMULATION':a?.accountId??'UNVERIFIED',this.db.getMode(),equity,cash,a?.buyingPower??null,externalFlow,reason,at);
      for(const s of sleeves){this.db.raw.prepare('INSERT INTO strategy_snapshots VALUES(?,?,?,?,?,?,?,?)').run(makeId('ss'),id,s.strategy,s.currentEquity,s.cash,s.realizedPnL,s.unrealizedPnL,at);
        for(const p of s.positions)this.db.raw.prepare('INSERT INTO position_snapshots VALUES(?,?,?,?,?,?,?,?,?)').run(makeId('ps'),id,s.strategy,p.symbol,p.quantity,p.marketPrice,p.marketValue,p.unrealizedPnl,at);
        for(const o of s.options)this.db.raw.prepare('INSERT INTO position_snapshots VALUES(?,?,?,?,?,?,?,?,?)').run(makeId('ps'),id,s.strategy,o.option_id,o.contracts,o.mark_price,o.contracts*100*o.mark_price,o.contracts*100*(o.mark_price-o.average_premium),at);
      }
    })();return {id,equity,cash,at};
  }
  series(period='1D',strategy?:string,instrument?:string){
    const days:Record<string,number>={'1D':1,'1W':7,'1M':31,'3M':93,'1Y':366,ALL:36500};if(!(period in days))throw new Error('Unsupported chart period');
    const mode=this.db.getMode(),account=mode==='SIMULATION'?'SIMULATION':this.db.getSetting<{accountId:string}|null>('broker_account_v2',null)?.accountId??'UNVERIFIED',since=this.verifiedSince(new Date(Date.now()-days[period]!*86400000).toISOString(),mode,account);
    let rows:Array<{at:string;value:number}>;
    if(instrument)rows=this.db.raw.prepare('SELECT s.created_at AS at,s.value FROM position_snapshots s JOIN portfolio_snapshots p ON p.id=s.portfolio_id WHERE p.mode=? AND p.account_id=? AND s.created_at>=? AND s.strategy_id=? AND s.instrument_id=? ORDER BY s.created_at').all(mode,account,since,strategy,instrument) as typeof rows;
    else if(strategy)rows=this.db.raw.prepare('SELECT s.created_at AS at,s.equity AS value FROM strategy_snapshots s JOIN portfolio_snapshots p ON p.id=s.portfolio_id WHERE p.mode=? AND p.account_id=? AND s.created_at>=? AND s.strategy_id=? ORDER BY s.created_at').all(mode,account,since,strategy) as typeof rows;
    else rows=this.db.raw.prepare('SELECT created_at AS at,equity AS value FROM portfolio_snapshots WHERE mode=? AND account_id=? AND created_at>=? ORDER BY created_at').all(mode,account,since) as typeof rows;
    const stride=Math.max(1,Math.ceil(rows.length/500)),points=rows.filter((_,i)=>i%stride===0||i===rows.length-1);
    return {period,points,simulated:mode==='SIMULATION',coverage:'RECORDED_SNAPSHOTS_ONLY',firstObserved:rows[0]?.at??null,source:'Attributed ledger equity; not underlying price history'};
  }
  performance(since:string){
    const mode=this.db.getMode(),account=mode==='SIMULATION'?'SIMULATION':this.db.getSetting<{accountId:string}|null>('broker_account_v2',null)?.accountId??'UNVERIFIED';
    since=this.verifiedSince(since,mode,account);
    const rows=this.db.raw.prepare('SELECT equity,external_flow,created_at FROM portfolio_snapshots WHERE mode=? AND account_id=? AND created_at>=? ORDER BY created_at').all(mode,account,since) as Array<{equity:number;external_flow:number;created_at:string}>;
    if(rows.length<2)return {beginning:null,end:rows.at(-1)?.equity??null,pnl:null,returnPercent:null,coverage:'INSUFFICIENT_SNAPSHOTS'};
    const beginning=rows[0]!.equity,end=rows.at(-1)!.equity,flow=rows.slice(1).reduce((n,r)=>n+r.external_flow,0),pnl=roundMoney(end-beginning-flow);
    return {beginning,end,externalFlow:flow,pnl,returnPercent:beginning?100*pnl/beginning:null,coverage:'SINCE_FIRST_RECORDED_SNAPSHOT',firstObserved:rows[0]!.created_at};
  }
  recordOption(optionId:string,q:TrustedQuote){if(!q.option||q.option.optionId!==optionId)throw new Error('Telemetry contract identity mismatch');
    const body={optionId,...q,simulated:q.provenance==='SYNTHETIC_FIXTURE',source:q.provenance??'UNVERIFIED',observedAt:q.asOf};
    this.db.raw.prepare('INSERT INTO option_telemetry VALUES(?,?,?,?)').run(makeId('ot'),optionId,JSON.stringify(body),nowIso());return body;
  }
  optionDetail(optionId:string){
    const position=this.db.raw.prepare('SELECT * FROM option_positions WHERE option_id=?').get(optionId) as {contracts:number;average_premium:number;mark_price:number;collateral:number;instrument_json:string}|undefined;
    const telemetry=this.db.raw.prepare('SELECT body_json FROM option_telemetry WHERE option_id=? ORDER BY rowid DESC LIMIT 1000').all(optionId) as Array<{body_json:string}>;
    const observations=telemetry.reverse().map(r=>JSON.parse(r.body_json)),latest=observations.at(-1)??{};
    const proposals=this.db.raw.prepare("SELECT id FROM proposals WHERE json_extract(body_json,'$.option.optionId')=? ORDER BY rowid").all(optionId) as Array<{id:string}>;
    const ids=proposals.map(p=>p.id),related=ids.length?this.db.raw.prepare("SELECT e.*,p.body_json,p.state FROM executions_v2 e JOIN proposals p ON p.id=e.proposal_id WHERE json_extract(e.order_json,'$.option.optionId')=?").all(optionId):[];
    const fills=this.db.raw.prepare("SELECT f.* FROM fills f JOIN executions_v2 e ON e.order_id=f.order_id WHERE json_extract(e.order_json,'$.option.optionId')=? ORDER BY f.executed_at").all(optionId);
    const instrument=position?JSON.parse(position.instrument_json):latest.option??null;
    const contracts=position?.contracts??0,premium=position?.average_premium??null,mark=position?.mark_price??null;
    const details=proposals.map(p=>{const row=this.db.raw.prepare('SELECT body_json,state,created_at FROM proposals WHERE id=?').get(p.id) as {body_json:string;state:string;created_at:string};return {id:p.id,...JSON.parse(row.body_json),state:row.state,recordedAt:row.created_at,risk:this.db.raw.prepare('SELECT * FROM risk_decisions_v2 WHERE proposal_id=? ORDER BY created_at').all(p.id),lifecycle:this.db.raw.prepare('SELECT * FROM proposal_transitions WHERE proposal_id=? ORDER BY rowid').all(p.id)};});
    const tradeFills=this.db.raw.prepare("SELECT f.*,json_extract(p.body_json,'$.positionEffect') AS effect,json_extract(p.body_json,'$.side') AS side FROM fills f JOIN executions_v2 e ON e.order_id=f.order_id JOIN proposals p ON p.id=e.proposal_id WHERE json_extract(e.order_json,'$.option.optionId')=? ORDER BY f.executed_at").all(optionId) as Array<{executed_at:string;price:number;quantity:number;effect:string;side:string}>;
    const entries=tradeFills.filter(f=>f.effect==='OPEN'),entryQuantity=entries.reduce((n,f)=>n+f.quantity,0),entryPrice=entryQuantity?entries.reduce((n,f)=>n+f.quantity*f.price,0)/entryQuantity:null;
    const realized=this.db.raw.prepare("SELECT COALESCE(SUM(amount),0) AS value FROM (SELECT r.amount FROM realized_pnl r JOIN executions_v2 e ON e.order_id=r.order_id WHERE json_extract(e.order_json,'$.option.optionId')=? UNION ALL SELECT ep.amount FROM economic_event_pnl ep JOIN broker_events b ON b.id=ep.event_id WHERE json_extract(b.body_json,'$.optionId')=?)").get(optionId,optionId) as {value:number};
    const opening=details.find(d=>d.positionEffect==='OPEN') as {option?:{maxLoss?:number}}|undefined,configuredMaxLoss=opening?.option?.maxLoss;
    const lifecycleRow=this.db.raw.prepare("SELECT body_json FROM broker_events WHERE status='APPLIED' AND type IN ('EXPIRATION','ASSIGNMENT','EXERCISE') AND json_extract(body_json,'$.optionId')=? ORDER BY created_at DESC LIMIT 1").get(optionId) as {body_json:string}|undefined;
    const lifecycleEvent=lifecycleRow?JSON.parse(lifecycleRow.body_json) as {type:string;observedAt:string;contracts:number}:null;
    const entryAt=entries[0]?.executed_at??null,exitAt=contracts===0?(tradeFills.filter(f=>f.effect==='CLOSE').at(-1)?.executed_at??lifecycleEvent?.observedAt??null):null;
    const entryUnderlying=entryAt?observations.filter(o=>o.asOf<=entryAt&&entryAt&&Date.parse(entryAt)-Date.parse(o.asOf)<60000).at(-1)?.underlyingPrice??null:null;
    const markers=[...tradeFills.map((f,i)=>({at:f.executed_at,price:f.price as number|null,quantity:f.quantity,kind:f.effect==='OPEN'?(i===0?'ENTRY':'ADD'):contracts===0&&i===tradeFills.length-1&&!lifecycleEvent?'FINAL_CLOSE':'PARTIAL_EXIT'})),...(lifecycleEvent?[{at:lifecycleEvent.observedAt,price:null,quantity:lifecycleEvent.contracts,kind:lifecycleEvent.type}]:[])];
    const basisPremium=entryPrice??premium,mid=typeof latest.bid==='number'&&typeof latest.ask==='number'?(latest.bid+latest.ask)/2:null;
    return {optionId,instrument,position:position??null,contracts,currentMark:mark,bid:latest.bid??null,ask:latest.ask??null,spreadPercent:mid?100*(latest.ask-latest.bid)/mid:null,openInterest:latest.openInterest??null,contractVolume:latest.volume??null,maximumLoss:typeof configuredMaxLoss==='number'?configuredMaxLoss:null,marketValue:mark===null?null:contracts*100*mark,unrealizedPnL:premium===null||mark===null?null:contracts*100*(mark-premium),breakEven:instrument&&basisPremium!==null?instrument.strike+(instrument.type==='CALL'?basisPremium:-basisPremium):null,
      entryPrice,realizedPnL:realized.value,unrealizedPercent:premium&&mark!==null?Math.sign(contracts)*(mark/premium-1)*100:null,premiumPaid:entries.filter(f=>f.side==='BUY').reduce((n,f)=>n+f.price*f.quantity*100,0),premiumReceived:entries.filter(f=>f.side==='SELL').reduce((n,f)=>n+f.price*f.quantity*100,0),collateral:position?.collateral??null,entryAt,exitAt,tradeDurationMs:entryAt?Date.parse(exitAt??nowIso())-Date.parse(entryAt):null,underlyingPriceAtEntry:entryUnderlying,currentUnderlyingPrice:latest.underlyingPrice??null,markers,proposalDetails:details,
      pnlVsUnderlying:entryPrice===null?[]:observations.filter(o=>o.underlyingPrice!==undefined&&entryAt&&o.asOf>=entryAt).map(o=>({at:o.asOf,underlyingPrice:o.underlyingPrice,mark:o.price,perContractPnL:(entries[0]?.side==='SELL'?-1:1)*(o.price-entryPrice)*100,source:'Recorded paired observations; per-contract mark change, not total realized P&L'})),
      dte:instrument?Math.ceil((Date.parse(instrument.expiration+'T20:00:00Z')-Date.now())/86400000):null,
      delta:latest.delta??null,gamma:latest.gamma??null,theta:latest.theta??null,vega:latest.vega??null,iv:latest.iv??null,ivRank:null,latest,observations,fills,executions:related,proposalIds:ids,assignmentRisk:contracts<0?'Short options can be assigned; explicit event review required':'Long exercise requires verified shares/cash',unavailableValuesAreNull:true};
  }
  report(kind:string){
    const at=nowIso(),weekly=kind==='WEEKLY_REPORT',since=pacificPeriodStart(weekly?'WEEK':'DAY');
    const states=SLEEVES.map(s=>this.allocation.state(s)),account=this.db.getSetting<{asOf:string;netAccountValue:number}|null>('broker_account_v2',null);
    const orders=this.db.raw.prepare('SELECT * FROM orders WHERE created_at>=? ORDER BY created_at').all(since),fills=this.db.raw.prepare('SELECT * FROM fills WHERE executed_at>=? ORDER BY executed_at').all(since);
    const events=this.db.raw.prepare('SELECT * FROM risk_events WHERE created_at>=? ORDER BY created_at').all(since);
    const safeMaterial=weekly||states[0]!.killed||states[0]!.drawdown>=5||orders.some(o=>(o as {strategy_id:string}).strategy_id==='SAFE_LONG_TERM');
    const realized=this.db.raw.prepare('SELECT strategy_id,symbol,SUM(amount) AS pnl FROM (SELECT strategy_id,symbol,amount,created_at FROM realized_pnl UNION ALL SELECT strategy_id,symbol,amount,created_at FROM economic_event_pnl) WHERE created_at>=? GROUP BY strategy_id,symbol ORDER BY pnl DESC').all(since) as Array<{strategy_id:string;symbol:string;pnl:number}>;
    const body={kind,at,mode:this.db.getMode(),simulated:this.db.getMode()==='SIMULATION',account,accountFresh:!!account&&Date.now()-Date.parse(account.asOf)<120000,performance:this.performance(since),realizedPnL:this.ledger.getRealizedPnl(undefined,since),unrealizedPnL:states.some(s=>s.unrealizedPnL===null)?null:states.reduce((n,s)=>n+s.unrealizedPnL!,0),
      safe:safeMaterial?states[0]:'SAFE: monitoring; no exceptional recorded event.',aggressive:states[1],options:{...states[2],contracts:states[2]!.options.map(o=>this.optionDetail(o.option_id))},
      orders,fills,riskEvents:events,largestWinner:realized.find(r=>r.pnl>0)??null,largestLoser:realized.filter(r=>r.pnl<0).at(-1)??null,
      allocation:states.map(s=>({strategy:s.strategy,targetWeight:s.policy.targetWeight,actualEquity:s.currentEquity,driftPercent:account?.netAccountValue?100*s.currentEquity/account.netAccountValue-100*s.policy.targetWeight:null})),
      reasoning:this.db.raw.prepare('SELECT body_json,state FROM proposals WHERE created_at>=?').all(since),missingDataPolicy:'Null/unavailable rather than invented; performance covers recorded snapshots only'};
    this.db.raw.prepare('INSERT INTO trading_reports VALUES(?,?,?,?,?)').run(makeId('report'),kind,at.slice(0,10),JSON.stringify(body),at);return body;
  }
}
