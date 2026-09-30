import {z} from 'zod';
import type {OfficialRobinhoodConnection} from './connectors.js';
import type {TradingBroker,TradingAccount,ProposalInput,ExecutableOrder} from './model.js';
import {normalizedAccountSchema} from './mcp-binding.js';

const decimal=z.union([z.number(),z.string().regex(/^-?\d+(\.\d+)?$/)]).transform(Number).pipe(z.number().finite());
const envelope=z.object({structuredContent:z.object({data:z.record(z.string(),z.unknown())})});
/** The authenticated official catalog supplies schemas; broker facts never pass through a model. */
export class WorkerRobinhoodBroker implements TradingBroker {
  readonly deterministic=true;
  constructor(readonly connection:OfficialRobinhoodConnection){}
  private async data(tool:string,args:Record<string,unknown>){return envelope.parse(await this.connection.call(tool,args)).structuredContent.data;}
  private async collection(tool:string,key:string,args:Record<string,unknown>){
    const rows:unknown[]=[];const seen=new Set<string>();let cursor:string|undefined;
    for(let page=0;page<100;page++){
      const data=await this.data(tool,{...args,...(cursor?{cursor}:{})});rows.push(...z.array(z.unknown()).parse(data[key]));
      const next=z.string().nullable().optional().parse(data.next);if(!next)return rows;
      if(seen.has(next))throw new Error('Broker pagination repeated a cursor');seen.add(next);cursor=next;
    }
    throw new Error('Broker pagination incomplete');
  }
  async account():Promise<TradingAccount>{
    const started=Date.now(),accountId=process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID;
    if(!accountId)throw new Error('Scoped Agentic account is not configured');
    await this.connection.check('DETERMINISTIC_ACCOUNT_SYNC');
    const accounts=z.array(z.object({account_number:z.string(),agentic_allowed:z.boolean(),state:z.string(),deactivated:z.boolean(),permanently_deactivated:z.boolean(),option_level:z.string()})).parse((await this.data('get_accounts',{})).accounts);
    const matches=accounts.filter(a=>a.account_number===accountId);
    if(matches.length!==1||!matches[0]!.agentic_allowed||matches[0]!.state!=='active'||matches[0]!.deactivated||matches[0]!.permanently_deactivated)throw new Error('Configured account is not an active authorized Agentic account');
    const args={account_number:accountId};
    const portfolio=await this.data('get_portfolio',args);
    if(portfolio.currency!=='USD')throw new Error('Only a USD brokerage snapshot is supported');
    for(const field of ['options_value','futures_value','event_contracts_value','crypto_value','mutual_funds_value','fixed_income_value','pending_deposits'])if(decimal.parse(portfolio[field])!==0)throw new Error('Account contains unsupported assets or pending deposits: '+field);
    const positions=await this.collection('get_equity_positions','positions',args);
    const options=await this.collection('get_option_positions','positions',{...args,nonzero:true});
    const equityOrders=await this.collection('get_equity_orders','orders',args),optionOrders=await this.collection('get_option_orders','orders',args);
    // Never silently discard executions/collateral we cannot yet normalize and reconcile.
    if(options.length||equityOrders.length||optionOrders.length)throw new Error('Broker options/order history requires a reviewed normalization before complete reconciliation');
    // Closed positions can omit cost basis. Verify quantity before requiring held-position facts.
    const nonzero=z.array(z.object({quantity:decimal}).passthrough()).parse(positions).filter(p=>p.quantity!==0);
    const holdings=z.array(z.object({symbol:z.string().min(1),quantity:decimal,average_buy_price:decimal,type:z.literal('long')})).parse(nonzero);
    if(new Set(holdings.map(p=>p.symbol)).size!==holdings.length)throw new Error('Duplicate broker position identity');
    const prices=new Map<string,number>();
    for(let i=0;i<holdings.length;i+=20){
      const symbols=holdings.slice(i,i+20).map(p=>p.symbol);
      const quotes=z.array(z.object({quote:z.object({symbol:z.string(),last_trade_price:decimal,venue_last_trade_time:z.string().datetime(),last_non_reg_trade_price:decimal.nullable(),venue_last_non_reg_trade_time:z.string().datetime().nullable()})})).parse((await this.data('get_equity_quotes',{symbols})).results);
      for(const {quote:q} of quotes){if(!symbols.includes(q.symbol)||prices.has(q.symbol))throw new Error('Broker quote identity mismatch');prices.set(q.symbol,q.last_non_reg_trade_price!==null&&q.venue_last_non_reg_trade_time!==null&&Date.parse(q.venue_last_non_reg_trade_time)>Date.parse(q.venue_last_trade_time)?q.last_non_reg_trade_price:q.last_trade_price);}
    }
    if(Date.now()-started>60000)throw new Error('Account observation exceeded freshness window');
    const level=/^option_level_([0-9]+)$/.exec(matches[0]!.option_level);
    if(!level)throw new Error('Unknown broker options permission level');
    const result=normalizedAccountSchema.parse({accountId,agentic:true,cash:decimal.parse(portfolio.cash),buyingPower:decimal.parse(z.object({buying_power:decimal}).parse(portfolio.buying_power).buying_power),netAccountValue:decimal.parse(portfolio.total_value),optionsLevel:Number(level[1]),asOf:new Date(started).toISOString(),healthy:true,complete:true,positions:holdings.map(p=>({symbol:p.symbol,quantity:p.quantity,averageCost:p.average_buy_price,price:prices.get(p.symbol),assetClass:'EQUITY'})),options:[],orders:[],fills:[]});
    this.connection.validateAccount(accountId);return result;
  }
  async quote(_p:ProposalInput):ReturnType<TradingBroker['quote']>{throw new Error('Execution-grade market data is not commissioned; broker account prices are informational');}
  async preview(_o:ExecutableOrder):ReturnType<TradingBroker['preview']>{throw new Error('Live order preview requires execution-grade quotes and reconciled ownership');}
  async place(_o:ExecutableOrder):ReturnType<TradingBroker['place']>{throw new Error('Live placement remains locked');}
  async cancel(_id:string):ReturnType<TradingBroker['cancel']>{throw new Error('Live cancellation remains locked');}
}
