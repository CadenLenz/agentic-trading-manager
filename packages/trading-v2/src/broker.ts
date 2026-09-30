import type { AppDatabase } from '../../database/src/database.js';
import type { VirtualPortfolioLedger } from '../../ledger/src/virtual-ledger.js';
import type { MarketDataProvider } from '../../market-data/src/provider.js';
import { makeId, nowIso } from '../../core/src/utils.js';
import { SLEEVES, type TradingBroker, type TradingAccount, type ProposalInput, type TrustedQuote, type ExecutableOrder, type OptionInstrument } from './model.js';

/** Synthetic account and quotes only. Option fixtures must be installed by an operator, not chat. */
export class SimulationTradingBroker implements TradingBroker {
  readonly deterministic = true;
  constructor(private readonly db: AppDatabase, private readonly ledger: VirtualPortfolioLedger, private readonly market: MarketDataProvider) {}
  async account(): Promise<TradingAccount> {
    const owned=this.ledger.listPositions();
    const positions=this.ledger.aggregatePositions().map(p=>({symbol:p.symbol,quantity:p.quantity,averageCost:owned.some(v=>v.symbol===p.symbol&&v.averageCost===null)?null:owned.filter(v=>v.symbol===p.symbol).reduce((n,v)=>n+v.quantity*v.averageCost!,0)/p.quantity,price:p.quantity?p.marketValue/p.quantity:0,assetClass:owned.find(v=>v.symbol===p.symbol)?.assetType==='ETF'?'ETF' as const:'EQUITY' as const}));
    const options=this.db.raw.prepare('SELECT option_id AS optionId,contracts,average_premium AS averagePremium,mark_price AS price,collateral FROM option_positions WHERE contracts<>0').all() as TradingAccount['options'];
    const cash=SLEEVES.reduce((n,s)=>n+this.ledger.getCash(s),0);
    const held=options.reduce((n,p)=>n+p.collateral,0);
    const pending=this.db.raw.prepare("SELECT COALESCE(SUM(cash_amount),0) AS total FROM capital_reservations WHERE status='ACTIVE'").get() as {total:number};
    const orders=this.db.raw.prepare("SELECT o.broker_order_id AS id,e.idempotency_key AS clientOrderId,o.status,o.cumulative_filled_quantity AS filledQuantity FROM executions_v2 e JOIN orders o ON o.id=e.order_id WHERE e.status='PENDING' AND o.broker_order_id IS NOT NULL").all() as TradingAccount['orders'];
    return {accountId:'SIMULATION',agentic:true,cash,buyingPower:Math.max(0,cash-held-pending.total),netAccountValue:cash+positions.reduce((n,p)=>n+p.quantity*p.price,0)+options.reduce((n,p)=>n+p.contracts*100*p.price,0),optionsLevel:2,asOf:nowIso(),healthy:true,complete:true,positions,options,orders,fills:[]};
  }
  async quote(p: Pick<ProposalInput,'symbol'> & {option:{optionId:string}|null}): Promise<TrustedQuote> {
    if(p.option) {
      const fixture=this.db.raw.prepare('SELECT body_json,premium FROM simulation_option_instruments WHERE option_id=?').get(p.option.optionId) as {body_json:string;premium:number}|undefined;
      if(!fixture) throw new Error('No operator-owned synthetic option instrument fixture installed');
      const option=JSON.parse(fixture.body_json) as OptionInstrument;
      return {symbol:p.symbol,price:fixture.premium,bid:fixture.premium*0.99,ask:fixture.premium*1.01,volume:10000,asOf:nowIso(),tradingEligible:false,option,openInterest:1000,underlyingVolume:1000000,earningsWithinHolding:false,provenance:'SYNTHETIC_FIXTURE'};
    }
    const q=await this.market.getQuote(p.symbol); return {...q,tradingEligible:false,sector:'Simulation',earningsWithinHolding:false,provenance:'SYNTHETIC_FIXTURE'};
  }
  async preview(order:ExecutableOrder) {
    const q=await this.quote(order);
    const price=order.limitPrice??(order.side==='BUY'?q.ask:q.bid);
    return {approved:true,asOf:nowIso(),estimatedCost:price*order.quantity*(order.option?100:1),collateralRequired:order.option&&order.side==='SELL'&&order.positionEffect==='OPEN'&&order.option.type==='PUT'?order.option.strike*100*order.quantity:0,reason:'Synthetic preview only'};
  }
  async place(order:ExecutableOrder):ReturnType<TradingBroker['place']> {
    const q=await this.quote(order);
    const price=order.side==='BUY'?q.ask:q.bid;
    const id=makeId('sim');
    if(order.limitPrice!==null && (order.side==='BUY'?price>order.limitPrice:price<order.limitPrice)) return {id,status:'ACCEPTED' as const,fills:[]};
    return {id,status:'ACCEPTED' as const,fills:[{id:id+':fill',brokerOrderId:id,quantity:order.quantity,price,fees:0,executedAt:nowIso()}]};
  }
  async cancel(_id:string) { return {cancelled:true}; }
}

/** No LLM-mediated trading fallback. A verified official typed binding must implement TradingBroker. */
export class UnavailableLiveBroker implements TradingBroker {
  readonly deterministic=false;
  private fail():never {throw new Error('LIVE blocked: verified deterministic official Robinhood MCP binding is not installed. Codex authentication alone is not an execution capability.');}
  async account():Promise<TradingAccount>{return this.fail();}
  async quote(_p:ProposalInput):Promise<TrustedQuote>{return this.fail();}
  async preview(_p:ExecutableOrder){return this.fail();}
  async place(_p:ExecutableOrder){return this.fail();}
  async cancel(_id:string){return this.fail();}
}
