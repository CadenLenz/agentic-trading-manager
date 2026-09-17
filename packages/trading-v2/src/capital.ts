import type { AppDatabase } from '../../database/src/database.js';
import type { VirtualPortfolioLedger } from '../../ledger/src/virtual-ledger.js';
import { makeId, nowIso, roundMoney } from '../../core/src/utils.js';
import { SLEEVES, sleevePolicySchema, type Sleeve, type SleevePolicy } from './model.js';

export function weekKey(date = new Date()): string { const key=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);const d=new Date(key+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10); }
export class StrategyAllocationManager {
  constructor(private readonly db: AppDatabase, private readonly ledger: VirtualPortfolioLedger) {}
  policy(sleeve: Sleeve): SleevePolicy { const row = this.db.raw.prepare('SELECT config_json FROM sleeve_policies WHERE strategy_id=?').get(sleeve) as {config_json:string}; return sleevePolicySchema.parse(JSON.parse(row.config_json)); }
  updatePolicy(sleeve: Sleeve, input: unknown, actor: string): SleevePolicy {
    const config = sleevePolicySchema.parse(input); const previous = this.policy(sleeve);
    if (config.targetWeight !== previous.targetWeight) throw new Error('Use the confirmed account-wide allocation tool for target weights');
    this.db.raw.prepare('UPDATE sleeve_policies SET config_json=?,updated_at=? WHERE strategy_id=?').run(JSON.stringify(config),nowIso(),sleeve);
    this.db.audit(actor,'SLEEVE_POLICY_UPDATED','sleeve',sleeve,{previous,config}); return config;
  }
  setWeight(sleeve: Sleeve, weight: number, actor: string): void {
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error('Weight must be between zero and one');
    const others = SLEEVES.filter(s => s !== sleeve); const oldTotal = others.reduce((n,s)=>n+this.policy(s).targetWeight,0);
    this.db.raw.transaction(()=>{
      for (const s of SLEEVES) { const p=this.policy(s); p.targetWeight=s===sleeve ? weight : oldTotal ? (1-weight)*p.targetWeight/oldTotal : (1-weight)/2; this.db.raw.prepare('UPDATE sleeve_policies SET config_json=?,updated_at=? WHERE strategy_id=?').run(JSON.stringify(p),nowIso(),s); }
      this.db.audit(actor,'ALLOCATION_WEIGHTS_UPDATED','account',null,{sleeve,weight});
    })();
  }
  state(sleeve: Sleeve) {
    const s=this.db.getStrategy(sleeve); if (!s) throw new Error('Unknown sleeve');
    const positions=this.ledger.listPositions(sleeve);
    const options=this.db.raw.prepare('SELECT * FROM option_positions WHERE strategy_id=? AND ABS(contracts)>0').all(sleeve) as Array<{option_id:string;contracts:number;average_premium:number;mark_price:number;collateral:number;reserved_shares:number;instrument_json:string}>;
    const stockValue=positions.reduce((n,p)=>n+p.marketValue,0);
    const optionValue=options.reduce((n,p)=>n+p.contracts*100*p.mark_price,0);
    const optionUnrealized=options.reduce((n,p)=>n+p.contracts*100*(p.mark_price-p.average_premium),0);
    const heldCollateral=options.reduce((n,p)=>n+p.collateral,0);
    const pending=this.db.raw.prepare("SELECT COALESCE(SUM(cash_amount),0) AS cash FROM capital_reservations WHERE strategy_id=? AND status='ACTIVE'").get(sleeve) as {cash:number};
    const currentEquity=roundMoney(s.cash+stockValue+optionValue);
    this.db.raw.prepare('INSERT OR IGNORE INTO strategy_capital(strategy_id,starting_capital,weekly_starting_capital,high_water_mark,week_key) VALUES(?,?,?,?,?)').run(sleeve,currentEquity,currentEquity,currentEquity,weekKey());
    this.db.raw.prepare('UPDATE strategy_capital SET high_water_mark=MAX(high_water_mark,?) WHERE strategy_id=?').run(currentEquity,sleeve);
    const c=this.db.raw.prepare('SELECT * FROM strategy_capital WHERE strategy_id=?').get(sleeve) as {starting_capital:number;weekly_starting_capital:number;high_water_mark:number;killed:number;kill_reason:string|null;week_key:string};
    const drawdown=c.high_water_mark>0 ? Math.max(0,(c.high_water_mark-currentEquity)/c.high_water_mark*100):0;
    if (drawdown>=60 && !c.killed) {
      this.db.raw.prepare('UPDATE strategy_capital SET killed=1,kill_reason=? WHERE strategy_id=?').run('60% emergency drawdown; weekly review/reset required',sleeve);
      this.db.setStrategyEnabled(sleeve,false,'RISK_ENGINE','60% emergency sleeve kill switch');
      this.db.raw.prepare('INSERT INTO risk_events(id,strategy_id,severity,code,message,scope,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(makeId('risk'),sleeve,'CRITICAL','SLEEVE_EMERGENCY_KILL','60% emergency drawdown reached; reduce risk through validated exits and review','STRATEGY','{}',nowIso());
      c.killed=1;
    }
    return {strategy:sleeve,policy:this.policy(sleeve),startingCapital:c.starting_capital,weeklyStartingCapital:c.weekly_starting_capital,highWaterMark:c.high_water_mark,currentEquity,
      cash:s.cash,reservedCapital:roundMoney(heldCollateral+pending.cash),availableCapital:roundMoney(Math.max(0,s.cash-heldCollateral-pending.cash)),
      realizedPnL:this.ledger.getRealizedPnl(sleeve),unrealizedPnL:roundMoney(positions.reduce((n,p)=>n+p.unrealizedPnl,0)+optionUnrealized),drawdown,
      capitalAtRisk:roundMoney(stockValue+options.reduce((n,p)=>n+(p.contracts>0?p.contracts*100*p.mark_price:p.collateral),0)),
      killed:!!c.killed,killReason:c.kill_reason,positions,options};
  }
  weekly(netAccountValue: number, actor='SCHEDULER', date=new Date()) {
    if (!Number.isFinite(netAccountValue) || netAccountValue<0) throw new Error('Trusted net account value required');
    const key=weekKey(date); const targets=SLEEVES.map(s=>({s,target:netAccountValue*this.policy(s).targetWeight,state:this.state(s)}));
    this.db.raw.transaction(()=>{
      // Transfer only free cash, never sell holdings or release pending/option collateral.
      for (const donor of targets) for (const receiver of targets) {
        if (donor.s===receiver.s) continue;
        const a=this.state(donor.s),b=this.state(receiver.s);
        const excess=a.currentEquity-donor.target,deficit=receiver.target-b.currentEquity;
        if (excess<=netAccountValue*this.policy(donor.s).tolerancePercent/100 || deficit<=netAccountValue*this.policy(receiver.s).tolerancePercent/100) continue;
        const amount=roundMoney(Math.min(excess,deficit,a.availableCapital));
        if (amount>0) this.transferCash(donor.s,receiver.s,amount,actor);
      }
      for (const {s,target} of targets) {
        const value=this.state(s);
        this.db.raw.prepare('INSERT INTO strategy_allocations VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(week_key,strategy_id) DO UPDATE SET target_amount=excluded.target_amount,actual_equity=excluded.actual_equity,drift_percent=excluded.drift_percent').run(makeId('allocation'),key,s,netAccountValue,target,value.currentEquity,netAccountValue?(value.currentEquity-target)/netAccountValue*100:0,nowIso());
        this.db.raw.prepare('UPDATE strategy_capital SET weekly_starting_capital=CASE WHEN week_key<>? THEN ? ELSE weekly_starting_capital END,week_key=? WHERE strategy_id=?').run(key,value.currentEquity,key,s);
      }
      this.db.audit(actor,'WEEKLY_ALLOCATION','account',key,{netAccountValue,targets:targets.map(({s,target})=>({strategy:s,target}))});
    })();
    return targets.map(({s,target})=>({strategy:s,target,actual:this.state(s).currentEquity}));
  }
  private transferCash(from:Sleeve,to:Sleeve,amount:number,actor:string):void {
    this.db.raw.prepare('UPDATE strategy_cash SET balance=balance-? WHERE strategy_id=?').run(amount,from);
    this.db.raw.prepare('UPDATE strategy_cash SET balance=balance+? WHERE strategy_id=?').run(amount,to);
    for (const [s,delta] of [[from,-amount],[to,amount]] as const) this.db.raw.prepare('UPDATE strategy_capital SET starting_capital=starting_capital+?,weekly_starting_capital=weekly_starting_capital+?,high_water_mark=MAX(0,high_water_mark+?) WHERE strategy_id=?').run(delta,delta,delta,s);
    this.db.audit(actor,'FREE_CASH_REALLOCATION','account',null,{from,to,amount});
  }
  reset(sleeve:Sleeve,confirmation:string,review:string,actor:string):void {
    if (confirmation!=='RESET '+sleeve || review.trim().length<20) throw new Error('Exact reset phrase and explicit weekly risk review required');
    const state=this.state(sleeve);
    this.db.raw.prepare('UPDATE strategy_capital SET killed=0,kill_reason=NULL,high_water_mark=?,weekly_starting_capital=?,week_key=?,reset_at=? WHERE strategy_id=?').run(state.currentEquity,state.currentEquity,weekKey(),nowIso(),sleeve);
    this.db.audit(actor,'WEEKLY_KILL_RESET','sleeve',sleeve,{review,state});
    // Reset does not resume a sleeve, re-enable LIVE, or change execution policy.
  }
  transferPosition(from:Sleeve,to:Sleeve,symbol:string,quantity:number,reason:string,actor:string):void {
    if(from===to || quantity<=0 || !Number.isFinite(quantity)) throw new Error('Invalid transfer');
    const p=this.ledger.getPosition(from,symbol); if(!p || p.quantity<quantity) throw new Error('Insufficient owned shares');
    const reservations=this.db.raw.prepare("SELECT COALESCE(SUM(shares),0) AS shares FROM capital_reservations WHERE strategy_id=? AND underlying=? AND status='ACTIVE'").get(from,symbol) as {shares:number};
    const covered=this.db.raw.prepare('SELECT COALESCE(SUM(reserved_shares),0) AS shares FROM option_positions WHERE strategy_id=? AND json_extract(instrument_json,\'$.underlying\')=?').get(from,symbol) as {shares:number};
    if(p.quantity-quantity<reservations.shares+covered.shares) throw new Error('Shares are reserved for option coverage');
    this.db.raw.transaction(()=>{
      const existing=this.ledger.getPosition(to,symbol); const total=(existing?.quantity??0)+quantity;
      this.db.raw.prepare('INSERT INTO strategy_positions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(strategy_id,symbol) DO UPDATE SET quantity=excluded.quantity,average_cost=excluded.average_cost').run(to,symbol,total,((existing?.quantity??0)*(existing?.averageCost??0)+quantity*p.averageCost)/total,p.marketPrice,p.sector,p.assetType,nowIso());
      this.db.raw.prepare('UPDATE strategy_positions SET quantity=quantity-? WHERE strategy_id=? AND symbol=?').run(quantity,from,symbol);
      let left=quantity;
      const lots=this.db.raw.prepare('SELECT * FROM strategy_lots WHERE strategy_id=? AND symbol=? AND remaining_quantity>0 ORDER BY opened_at,id').all(from,symbol) as Array<{id:string;remaining_quantity:number;entry_price:number;fees:number;opened_at:string;source_fill_id:string}>;
      for(const l of lots){const q=Math.min(left,l.remaining_quantity); if(q<=0) break; const fees=l.fees*q/l.remaining_quantity; this.db.raw.prepare('UPDATE strategy_lots SET remaining_quantity=remaining_quantity-?,fees=fees-? WHERE id=?').run(q,fees,l.id);this.db.raw.prepare('INSERT INTO strategy_lots VALUES(?,?,?,?,?,?,?,?)').run(makeId('lot'),to,symbol,q,l.entry_price,fees,l.opened_at,l.source_fill_id);left-=q;}
      if(left>0.000001) throw new Error('Lot inconsistency');
      for(const s of [from,to]){
        const b=this.db.raw.prepare('SELECT COALESCE(SUM(remaining_quantity*entry_price+fees),0) AS basis,COALESCE(SUM(remaining_quantity),0) AS quantity FROM strategy_lots WHERE strategy_id=? AND symbol=? AND remaining_quantity>0').get(s,symbol) as {basis:number;quantity:number};
        if(b.quantity<=0.000001)this.db.raw.prepare('DELETE FROM strategy_positions WHERE strategy_id=? AND symbol=?').run(s,symbol);
        else this.db.raw.prepare('UPDATE strategy_positions SET average_cost=? WHERE strategy_id=? AND symbol=?').run(b.basis/b.quantity,s,symbol);
      }
      for(const [s,delta] of [[from,-quantity*p.marketPrice],[to,quantity*p.marketPrice]] as const)this.db.raw.prepare('UPDATE strategy_capital SET starting_capital=starting_capital+?,weekly_starting_capital=weekly_starting_capital+?,high_water_mark=MAX(0,high_water_mark+?) WHERE strategy_id=?').run(delta,delta,delta,s);
      this.db.raw.prepare('INSERT INTO position_assignments VALUES(?,?,?,?,?,?,?,?)').run(makeId('assignment'),symbol,from,to,quantity,reason,actor,nowIso());
      this.db.audit(actor,'POSITION_TRANSFER','position',symbol,{from,to,quantity,reason});
    })();
  }
}
