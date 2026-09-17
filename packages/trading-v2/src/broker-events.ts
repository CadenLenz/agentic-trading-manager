import {z} from 'zod';
import type {AppDatabase} from '../../database/src/database.js';
import type {VirtualPortfolioLedger} from '../../ledger/src/virtual-ledger.js';
import {makeId,nowIso,roundMoney} from '../../core/src/utils.js';
import {sleeveSchema} from './model.js';
import type {PortfolioAnalytics} from './analytics.js';
const base={id:z.string().min(1).max(200),accountId:z.string().min(1),strategy:sleeveSchema,observedAt:z.string().datetime(),sourceReference:z.string().min(5).max(2000)};
export const brokerEventSchema=z.discriminatedUnion('type',[
  z.object({...base,type:z.literal('TRANSFER_EQUITY'),symbol:z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/),quantity:z.number().positive(),averageCost:z.number().nonnegative(),mark:z.number().positive(),assetClass:z.enum(['EQUITY','ETF'])}).strict(),
  z.object({...base,type:z.literal('CASH_FLOW'),amount:z.number().finite().refine(n=>n!==0)}).strict(),
  z.object({...base,type:z.literal('EXTERNAL_EQUITY_FILL'),symbol:z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/),quantity:z.number().positive(),price:z.number().positive(),fees:z.number().nonnegative(),side:z.enum(['BUY','SELL'])}).strict(),
  z.object({...base,type:z.literal('SPLIT'),symbol:z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/),ratio:z.number().positive()}).strict(),
  z.object({...base,type:z.enum(['EXPIRATION','ASSIGNMENT','EXERCISE']),optionId:z.string().min(1),contracts:z.number().int().positive()}).strict(),
]);
export class BrokerEventService{
  constructor(readonly db:AppDatabase,readonly ledger:VirtualPortfolioLedger,readonly analytics:PortfolioAnalytics){}
  ingest(input:unknown,actor:string){const e=brokerEventSchema.parse(input);const existing=this.db.raw.prepare('SELECT * FROM broker_events WHERE id=?').get(e.id);if(existing)return existing;
    this.db.raw.prepare('INSERT INTO broker_events VALUES(?,?,?,?,?,?,?)').run(e.id,e.accountId,e.type,JSON.stringify(e),'REVIEW_REQUIRED',actor,nowIso());this.db.setSetting('reconciliation_clear',false);this.db.setSetting('global_pause',true);this.db.audit(actor,'BROKER_EVENT_RECEIVED','broker_event',e.id,{event:e});return e;
  }
  apply(id:string,actor:string,confirmation:string,review:string){
    if(confirmation!=='APPLY VERIFIED BROKER EVENT'||review.length<20)throw new Error('Explicit verified-event review required');
    const row=this.db.raw.prepare('SELECT body_json,status FROM broker_events WHERE id=?').get(id) as {body_json:string;status:string}|undefined;if(!row)throw new Error('Broker event not found');if(row.status==='APPLIED')return {duplicate:true};
    const e=brokerEventSchema.parse(JSON.parse(row.body_json)),a=this.db.getSetting<{accountId:string;complete:boolean;asOf:string}|null>('broker_account_v2',null);
    if(this.db.getMode()!=='SIMULATION'&&(!a?.complete||a.accountId!==e.accountId||a.accountId!==process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID||Date.now()-Date.parse(a.asOf)>120000))throw new Error('Fresh scoped READ_ONLY broker evidence required');
    if(this.db.getMode()==='LIVE')throw new Error('Pause into READ_ONLY before importing external events');
    this.db.raw.transaction(()=>{
      const previous=this.ledger.listPositions(e.strategy);
      if(e.type==='TRANSFER_EQUITY'){
        if(this.ledger.getPosition(e.strategy,e.symbol))throw new Error('Import into existing ownership requires explicit lot-by-lot review');
        this.db.raw.prepare('INSERT INTO strategy_positions VALUES(?,?,?,?,?,?,?,?)').run(e.strategy,e.symbol,e.quantity,e.averageCost,e.mark,'External verified',e.assetClass,e.observedAt);
        this.db.raw.prepare('INSERT INTO strategy_lots VALUES(?,?,?,?,?,?,?,?)').run(makeId('lot'),e.strategy,e.symbol,e.quantity,e.averageCost,0,e.observedAt,e.id);
        this.capitalFlow(e.strategy,e.quantity*e.mark);
      }else if(e.type==='CASH_FLOW'){
        if(this.ledger.getCash(e.strategy)+e.amount<0)throw new Error('Cash flow would borrow');this.db.raw.prepare('UPDATE strategy_cash SET balance=balance+? WHERE strategy_id=?').run(e.amount,e.strategy);this.capitalFlow(e.strategy,e.amount);
      }else if(e.type==='EXTERNAL_EQUITY_FILL'){
        const orderId=this.ledger.createOrder({idempotencyKey:'external:'+e.id,strategyId:e.strategy,symbol:e.symbol,side:e.side,quantity:e.quantity,orderType:'MARKET',mode:this.db.getMode(),source:'VERIFIED_EXTERNAL_EVENT'});
        this.ledger.applyFill({brokerFillId:e.id,orderId,quantity:e.quantity,price:e.price,fees:e.fees,executedAt:e.observedAt});
      }else if(e.type==='SPLIT'){
        if(!this.ledger.getPosition(e.strategy,e.symbol))throw new Error('Split ownership missing');
        if(this.db.raw.prepare("SELECT id FROM capital_reservations WHERE underlying=? AND status='ACTIVE'").get(e.symbol)||this.db.raw.prepare("SELECT option_id FROM option_positions WHERE contracts<>0 AND json_extract(instrument_json,'$.underlying')=?").get(e.symbol))throw new Error('Adjusted options/pending orders require verified deliverables; do not infer a split');
        this.db.raw.prepare('UPDATE strategy_positions SET quantity=quantity*?,average_cost=average_cost/?,market_price=market_price/? WHERE strategy_id=? AND symbol=?').run(e.ratio,e.ratio,e.ratio,e.strategy,e.symbol);
        this.db.raw.prepare('UPDATE strategy_lots SET remaining_quantity=remaining_quantity*?,entry_price=entry_price/? WHERE strategy_id=? AND symbol=?').run(e.ratio,e.ratio,e.strategy,e.symbol);
      }else{
        const p=this.db.raw.prepare('SELECT * FROM option_positions WHERE option_id=? AND strategy_id=?').get(e.optionId,e.strategy) as {contracts:number;average_premium:number;instrument_json:string}|undefined;
        if(!p||Math.abs(p.contracts)<e.contracts)throw new Error('Option event ownership mismatch');
        if(this.db.raw.prepare("SELECT id FROM capital_reservations WHERE status='ACTIVE' AND proposal_id IN (SELECT id FROM proposals WHERE json_extract(body_json,'$.option.optionId')=?)").get(e.optionId))throw new Error('Resolve pending option orders before lifecycle event');
        const i=JSON.parse(p.instrument_json) as {underlying:string;type:'CALL'|'PUT';strike:number;expiration:string};
        if(e.type==='ASSIGNMENT'&&p.contracts>=0||e.type==='EXERCISE'&&p.contracts<=0)throw new Error('Option direction invalid for event');
        if(e.type==='EXPIRATION'&&Date.parse(e.observedAt)<Date.parse(i.expiration+'T20:00:00Z'))throw new Error('Expiry event precedes verified expiration');
        if(e.type!=='EXPIRATION'){
          const side=i.type==='CALL'?(p.contracts>0?'BUY':'SELL'):(p.contracts>0?'SELL':'BUY'),quantity=e.contracts*100;
          const physicalOrder=this.ledger.createOrder({idempotencyKey:'physical:'+e.id,strategyId:e.strategy,symbol:i.underlying,side,quantity,orderType:'MARKET',mode:this.db.getMode(),source:'VERIFIED_'+e.type});
          this.ledger.applyFill({brokerFillId:e.id+':physical',orderId:physicalOrder,quantity,price:i.strike,fees:0,executedAt:e.observedAt});
        }
        let left=e.contracts,basis=0;const lots=this.db.raw.prepare('SELECT id,contracts,premium FROM option_lots WHERE option_id=? AND contracts<>0 ORDER BY opened_at,id').all(e.optionId) as Array<{id:string;contracts:number;premium:number}>;
        for(const lot of lots){const n=Math.min(left,Math.abs(lot.contracts));basis+=n*100*lot.premium;this.db.raw.prepare('UPDATE option_lots SET contracts=contracts-? WHERE id=?').run(Math.sign(p.contracts)*n,lot.id);left-=n;if(!left)break;}if(left)throw new Error('Option lots incomplete');
        this.db.raw.prepare('INSERT INTO economic_event_pnl VALUES(?,?,?,?,?,?)').run(makeId('event-pnl'),e.strategy,i.underlying,roundMoney(p.contracts>0?-basis:basis),e.id,e.observedAt);
        const remaining=p.contracts-Math.sign(p.contracts)*e.contracts;
        this.db.raw.prepare('UPDATE option_positions SET contracts=?,collateral=?,reserved_shares=?,updated_at=? WHERE option_id=?').run(remaining,remaining<0&&i.type==='PUT'?Math.abs(remaining)*100*i.strike:0,remaining<0&&i.type==='CALL'?Math.abs(remaining)*100:0,nowIso(),e.optionId);
      }
      this.db.raw.prepare("UPDATE broker_events SET status='APPLIED',actor=? WHERE id=?").run(actor,id);this.db.setSetting('reconciliation_clear',false);
      this.analytics.snapshot(e.type,e.type==='CASH_FLOW'?e.amount:e.type==='TRANSFER_EQUITY'?e.quantity*e.mark:0);
      this.db.audit(actor,'BROKER_EVENT_APPLIED','broker_event',id,{before:previous,after:this.ledger.listPositions(e.strategy),event:e,review,economicLedgerOnly:true});
    })();return {applied:true,reconciliationRequired:true};
  }
  private capitalFlow(strategy:string,amount:number){this.db.raw.prepare('UPDATE strategy_capital SET starting_capital=starting_capital+?,weekly_starting_capital=weekly_starting_capital+?,high_water_mark=MAX(0,high_water_mark+?) WHERE strategy_id=?').run(amount,amount,amount,strategy);}
}
