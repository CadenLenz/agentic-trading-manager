import {z} from 'zod';
import type {OfficialRobinhoodConnection} from './connectors.js';
import type {TradingBroker,TradingAccount,ProposalInput,ExecutableOrder} from './model.js';
import {normalizeOfficialOrder,officialOrderArguments,brokerReference} from './official-orders.js';
import {normalizedAccountSchema} from './mcp-binding.js';

const decimal=z.union([z.number(),z.string().regex(/^-?\d+(\.\d+)?$/)]).transform(Number).pipe(z.number().finite());
const envelope=z.object({structuredContent:z.object({data:z.record(z.string(),z.unknown())})});
export interface IncompleteBrokerObservation {accountId:string;cash:number;buyingPower:number;netAccountValue:number;asOf:string;positions:Array<{symbol:string;quantity:number;averageCost:number|null}>}
export class BrokerBasisUnavailable extends Error {
  readonly statusCode=409;
  constructor(readonly observation:IncompleteBrokerObservation,readonly symbols:string[]){super('Robinhood cost basis is not yet available for '+symbols.join(', ')+'. Sync again after Robinhood has populated it. Trading remains blocked.');}
}
/** The authenticated official catalog supplies schemas; broker facts never pass through a model. */
export class WorkerRobinhoodBroker implements TradingBroker {
  readonly deterministic=true;
  constructor(readonly connection:OfficialRobinhoodConnection){}
  private async data(tool:string,args:Record<string,unknown>){return envelope.parse(await this.connection.call(tool,args,tool.startsWith("review_"))).structuredContent.data;}
  private async collection(tool:string,key:string,args:Record<string,unknown>){
    const rows:unknown[]=[];const seen=new Set<string>();let cursor:string|undefined;
    for(let page=0;page<100;page++){
      const data=await this.data(tool,{...args,...(cursor?{cursor}:{})});
      if(tool==='get_equity_tax_lots'&&data.symbol!==args.symbol)throw new Error('Broker tax-lot identity mismatch');
      rows.push(...z.array(z.unknown()).parse(data[key]===null?[]:data[key]));
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
    for(const field of ['futures_value','event_contracts_value','crypto_value','mutual_funds_value','fixed_income_value','pending_deposits'])if(decimal.parse(portfolio[field])!==0)throw new Error('Account contains unsupported assets or pending deposits: '+field);
    const positions=await this.collection('get_equity_positions','positions',args);
    const options=await this.collection('get_option_positions','positions',{...args,nonzero:true});
    const equityOrders=await this.collection('get_equity_orders','orders',args),optionOrders=await this.collection('get_option_orders','orders',args);
    // Never silently discard executions/collateral we cannot yet normalize and reconcile.
    const normalizedOrders=[...equityOrders.map(o=>normalizeOfficialOrder(o)),...optionOrders.map(o=>normalizeOfficialOrder(o,true))];
    const known=this.connection.db.raw.prepare('SELECT broker_order_id FROM executions_v2 WHERE broker_order_id IS NOT NULL').all() as Array<{broker_order_id:string}>;
    const selectedOrders=normalizedOrders.filter(o=>!['FILLED','REJECTED','CANCELLED'].includes(o.order.status)||known.some(k=>k.broker_order_id===o.order.id));
    const normalizedOptions=[];
    for(const input of options){
      const p=z.object({option_id:z.string(),quantity:decimal,type:z.enum(['long','short']),average_price:decimal,trade_value_multiplier:decimal,pending_exercise_quantity:decimal,pending_assignment_quantity:decimal,pending_expiration_quantity:decimal}).parse(input);
      if(p.quantity===0)continue;
      if(p.quantity<0||p.trade_value_multiplier!==100||p.pending_exercise_quantity!==0||p.pending_assignment_quantity!==0||p.pending_expiration_quantity!==0)throw new Error('Option lifecycle event or adjusted contract requires verified-event review');
      const i=await this.optionInstrument(p.option_id),q=z.array(z.object({quote:z.object({instrument_id:z.string(),mark_price:decimal})})).length(1).parse((await this.data('get_option_quotes',{instrument_ids:[p.option_id]})).results)[0]!.quote;
      if(q.instrument_id!==p.option_id)throw new Error('Option quote identity mismatch');
      normalizedOptions.push({optionId:p.option_id,contracts:p.quantity*(p.type==='short'?-1:1),averagePremium:Math.abs(p.average_price)/100,price:q.mark_price,collateral:p.type==='short'&&i.type==='PUT'?p.quantity*i.strike*100:0});
    }
    // Closed positions can omit cost basis. Verify quantity before requiring held-position facts.
    const nonzero=z.array(z.object({quantity:decimal}).passthrough()).parse(positions).filter(p=>p.quantity!==0);
    const holdings=z.array(z.object({symbol:z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/),quantity:decimal.pipe(z.number().positive()),average_buy_price:decimal.nullable().optional(),type:z.literal('long')})).parse(nonzero);
    if(new Set(holdings.map(p=>p.symbol)).size!==holdings.length)throw new Error('Duplicate broker position identity');

    for(const p of holdings){if(p.average_buy_price!==undefined&&p.average_buy_price!==null)continue;
      const lots=z.array(z.object({open_lot_id:z.string().min(1),quantity:decimal.pipe(z.number().positive()),cost_per_share:decimal.pipe(z.number().nonnegative()).nullable().optional(),tax_cost_basis:decimal.pipe(z.number().nonnegative()).nullable().optional()})).parse(await this.collection('get_equity_tax_lots','tax_lots',{...args,symbol:p.symbol}));
      if(new Set(lots.map(l=>l.open_lot_id)).size!==lots.length)throw new Error('Duplicate broker tax-lot identity');
      const quantity=lots.reduce((n,l)=>n+l.quantity,0);
      if(!lots.length||Math.abs(quantity-p.quantity)>.000001||lots.some(l=>(l.tax_cost_basis===undefined||l.tax_cost_basis===null)&&(l.cost_per_share===undefined||l.cost_per_share===null))){continue;}
      const basis=lots.reduce((n,l)=>n+(l.tax_cost_basis??l.quantity*l.cost_per_share!),0);
      if(!Number.isFinite(basis)||basis<0)throw new Error('Invalid broker tax-lot basis');
      p.average_buy_price=basis/quantity;
    }
    const prices=new Map<string,number>();
    for(let i=0;i<holdings.length;i+=20){
      const symbols=holdings.slice(i,i+20).map(p=>p.symbol);
      const quotes=z.array(z.object({quote:z.object({symbol:z.string(),last_trade_price:decimal,venue_last_trade_time:z.string().datetime(),last_non_reg_trade_price:decimal.nullable(),venue_last_non_reg_trade_time:z.string().datetime().nullable()})})).parse((await this.data('get_equity_quotes',{symbols})).results);
      for(const {quote:q} of quotes){if(!symbols.includes(q.symbol)||prices.has(q.symbol))throw new Error('Broker quote identity mismatch');prices.set(q.symbol,q.last_non_reg_trade_price!==null&&q.venue_last_non_reg_trade_time!==null&&Date.parse(q.venue_last_non_reg_trade_time)>Date.parse(q.venue_last_trade_time)?q.last_non_reg_trade_price:q.last_trade_price);}
    }
    if(Date.now()-started>60000)throw new Error('Account observation exceeded freshness window');
    const level=/^option_level_([0-9]+)$/.exec(matches[0]!.option_level);
    if(!level)throw new Error('Unknown broker options permission level');
    const result=normalizedAccountSchema.parse({accountId,agentic:true,cash:decimal.parse(portfolio.cash),buyingPower:decimal.parse(z.object({buying_power:decimal}).parse(portfolio.buying_power).buying_power),netAccountValue:decimal.parse(portfolio.total_value),optionsLevel:Number(level[1]),asOf:new Date(started).toISOString(),healthy:true,complete:true,positions:holdings.map(p=>({symbol:p.symbol,quantity:p.quantity,averageCost:p.average_buy_price??null,basisStatus:p.average_buy_price==null?"UNAVAILABLE_EXTERNAL":"KNOWN",price:prices.get(p.symbol),assetClass:'EQUITY'})),options:normalizedOptions,orders:selectedOrders.map(o=>o.order),fills:selectedOrders.flatMap(o=>o.fills).map(f=>{const v=this.connection.db.getSetting<Record<string,{accountId:string;quantity:number;price:number;executedAt:string;fees:number}>>('verified_fill_fees_v2',{})[f.id];return f.fees===null&&v&&v.accountId===accountId&&v.quantity===f.quantity&&v.price===f.price&&v.executedAt===f.executedAt?{...f,fees:v.fees}:f;})});
    this.connection.validateAccount(accountId);return result;
  }
  private async optionInstrument(id:string){
    const rows=z.array(z.object({id:z.string(),chain_symbol:z.string(),underlying_type:z.literal('equity'),strike_price:decimal,type:z.enum(['call','put']),expiration_date:z.string(),trade_value_multiplier:decimal,state:z.string(),tradability:z.string()})).parse(await this.collection('get_option_instruments','instruments',{ids:id}));
    if(rows.length!==1||rows[0]!.id!==id||rows[0]!.trade_value_multiplier!==100)throw new Error('Standard equity option identity/multiplier unverified');
    const i=rows[0]!;return {optionId:id,underlying:i.chain_symbol,type:i.type.toUpperCase() as 'CALL'|'PUT',strike:i.strike_price,expiration:i.expiration_date,multiplier:100 as const,state:i.state,tradability:i.tradability};
  }
  async quote(p:ProposalInput):ReturnType<TradingBroker['quote']>{
    await this.connection.check('EXECUTION_QUOTE');const symbol=p.underlying??p.symbol;
    const raw=z.array(z.object({quote:z.object({symbol:z.string(),last_trade_price:decimal,bid_price:decimal,ask_price:decimal,venue_bid_time:z.string().datetime(),venue_ask_time:z.string().datetime(),state:z.string(),has_traded:z.boolean()})})).length(1).parse((await this.data('get_equity_quotes',{symbols:[symbol]})).results)[0]!.quote;
    const fundamentals=z.array(z.object({symbol:z.string(),volume:decimal.nullable(),average_volume_2_weeks:decimal.nullable(),market_cap:decimal.nullable(),pe_ratio:decimal.nullable(),sector:z.string()})).length(1).parse((await this.data('get_equity_fundamentals',{symbols:[symbol],bounds:'regular'})).results)[0]!;
    const tradability=z.array(z.object({symbol:z.string(),tradeable:z.boolean(),country:z.string().optional(),fractional_tradability:z.string().optional(),internal_halt_reason:z.string().optional()})).length(1).parse((await this.data('get_equity_tradability',{account_number:process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID,symbols:[symbol]})).results)[0]!;
    if(raw.symbol!==symbol||fundamentals.symbol!==symbol||tradability.symbol!==symbol)throw new Error('Quote/fundamentals/tradability identity mismatch');
    const classification=this.connection.db.getSetting<Record<string,{assetClass:'EQUITY'|'ETF';usListed:boolean;leveraged:boolean}>>('verified_instruments_v2',{})[symbol];
    const common={symbol:p.symbol,price:raw.last_trade_price,bid:raw.bid_price,ask:raw.ask_price,volume:fundamentals.volume??0,asOf:new Date(Math.min(Date.parse(raw.venue_bid_time),Date.parse(raw.venue_ask_time))).toISOString(),tradingEligible:raw.state==='active'&&raw.has_traded&&tradability.tradeable&&!tradability.internal_halt_reason&&(Number.isInteger(p.quantity)||tradability.fractional_tradability==='tradable'),usListed:classification?.usListed===true,leveraged:classification?.leveraged!==false,assetClass:p.option?'OPTION' as const:classification?.assetClass,sector:fundamentals.sector,provenance:'OFFICIAL_MCP_REVIEWED_BINDING',...(fundamentals.market_cap!==null?{marketCap:fundamentals.market_cap}:{}),...(fundamentals.pe_ratio!==null?{valuationPE:fundamentals.pe_ratio}:{}),...(fundamentals.volume!==null&&fundamentals.average_volume_2_weeks!==null&&fundamentals.average_volume_2_weeks>0?{relativeVolume:fundamentals.volume/fundamentals.average_volume_2_weeks}:{})};
    const horizon=p.holdingTradingDays===null?null:Math.ceil(p.holdingTradingDays*7/5)+3;
    if(horizon!==null&&horizon<=31){const events=z.array(z.object({symbol:z.string(),report:z.object({date:z.string().nullable(),verified:z.boolean()}).nullable()})).parse((await this.data('get_earnings_calendar',{start_date:new Date().toISOString().slice(0,10),days:Math.max(1,horizon)})).results);Object.assign(common,{earningsWithinHolding:events.some(e=>e.symbol===symbol)});}
    if(!p.option)return common;
    const i=await this.optionInstrument(p.option.optionId),q=z.array(z.object({quote:z.object({instrument_id:z.string(),mark_price:decimal,bid_price:decimal,ask_price:decimal,updated_at:z.string().datetime(),volume:z.number().nonnegative(),open_interest:z.number().nonnegative(),delta:decimal.nullable(),gamma:decimal.nullable(),theta:decimal.nullable(),vega:decimal.nullable(),implied_volatility:decimal.nullable()})})).length(1).parse((await this.data('get_option_quotes',{instrument_ids:[i.optionId]})).results)[0]!.quote;
    if(q.instrument_id!==i.optionId||i.underlying!==symbol)throw new Error('Option identity mismatch');
    const {state,tradability:optionTradability,...instrument}=i;
    return {...common,price:q.mark_price,bid:q.bid_price,ask:q.ask_price,asOf:q.updated_at,volume:q.volume,option:instrument,assetClass:'OPTION',tradingEligible:common.tradingEligible&&state==='active'&&optionTradability==='tradable',underlyingPrice:raw.last_trade_price,underlyingVolume:fundamentals.volume??0,openInterest:q.open_interest,...Object.fromEntries(Object.entries({delta:q.delta,gamma:q.gamma,theta:q.theta,vega:q.vega,iv:q.implied_volatility}).filter(([,v])=>v!==null))};
  }
  async preview(o:ExecutableOrder):ReturnType<TradingBroker['preview']>{
    const accountId=process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID!;
    const args=officialOrderArguments(o,accountId),raw=await this.data(o.option?'review_option_order':'review_equity_order',args);
    const checks=z.record(z.string(),z.unknown()).parse(raw.order_checks);
    if(decimal.parse(raw.quantity)!==o.quantity||raw.type!==o.orderType.toLowerCase())throw new Error('Broker preview quantity/type mismatch');
    let estimatedCost=o.quantity*(o.limitPrice??0)*(o.option?100:1),collateralRequired=0,approved=Object.keys(checks).length===0;
    if(o.option){
      if(raw.account_number!==accountId||JSON.stringify(raw.legs)!==JSON.stringify(args.legs)||raw.direction!==args.direction)throw new Error('Broker option preview identity mismatch');
      const c=z.object({account_number:z.string(),cash:z.object({amount:decimal.nullable(),direction:z.string(),infinite:z.boolean()}),equities:z.array(z.object({symbol:z.string(),quantity:decimal,uncovered_shares:decimal})).nullable()}).parse(raw.collateral);
      if(c.account_number!==accountId||c.cash.infinite||c.cash.amount===null)approved=false;
      if(!['debit','credit'].includes(c.cash.direction))throw new Error('Unknown broker collateral direction');
      collateralRequired=c.cash.direction==='debit'?c.cash.amount??0:0;
      if(c.equities?.some(e=>e.uncovered_shares!==0||e.symbol!==o.underlying))approved=false;
      estimatedCost+=raw.fees?decimal.parse(z.record(z.string(),z.unknown()).parse(raw.fees).total_fee):0;
      if(!raw.fees)approved=false;
    }else{
      if(raw.symbol!==o.symbol||raw.side!==o.side.toLowerCase())throw new Error('Broker preview symbol/side mismatch');
      if(o.orderType==='MARKET'){const q=z.object({symbol:z.string(),ask_price:decimal,bid_price:decimal}).parse(raw.quote_data);if(q.symbol!==o.symbol)throw new Error('Preview quote mismatch');estimatedCost=o.quantity*(o.side==='BUY'?q.ask_price:q.bid_price);}
    }
    this.connection.db.setSetting('manual_preview_capability_v2',{accountId,catalogHash:this.connection.db.getSetting('official_mcp_catalog_hash',''),at:new Date().toISOString(),approved,assetClass:o.assetClass});
    return {approved,asOf:new Date().toISOString(),estimatedCost,collateralRequired,reason:approved?'Official broker review completed':JSON.stringify(checks),raw};
  }
  async place(o:ExecutableOrder):ReturnType<TradingBroker['place']>{
    const proposal=this.connection.db.raw.prepare('SELECT proposal_id FROM executions_v2 WHERE idempotency_key=?').get(o.clientOrderId) as {proposal_id:string}|undefined;
    if(!proposal)throw new Error('Persisted execution authorization missing');
    const response=envelope.parse(await this.connection.execute(o.option?'place_option_order':'place_equity_order',officialOrderArguments(o,process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID!,true),proposal.proposal_id));
    const normalized=normalizeOfficialOrder(response.structuredContent.data.order,!!o.option);
    return {id:normalized.order.id,status:normalized.order.status==='REJECTED'?'REJECTED':normalized.order.status==='UNKNOWN'?'UNKNOWN':'ACCEPTED',fills:normalized.fills};
  }
  async lookup(o:ExecutableOrder,id:string){
    const rows=await this.collection(o.option?'get_option_orders':'get_equity_orders','orders',{account_number:process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID,order_id:id});
    if(rows.length!==1)throw new Error('Broker order not found in scoped account');
    const result=normalizeOfficialOrder(rows[0],!!o.option),r=result.raw,args=officialOrderArguments(o,process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID!);
    if(result.order.id!==id||r.type!==args.type||Number(r.quantity)!==o.quantity||r.time_in_force!==args.time_in_force||r.market_hours!==args.market_hours||r.trigger!=='immediate')throw new Error('Broker order terms do not match unknown execution');
    if(typeof r.ref_id==='string'&&r.ref_id!==brokerReference(o.clientOrderId))throw new Error('Broker client reference does not match unknown execution');
    const execution=this.connection.db.raw.prepare('SELECT created_at FROM executions_v2 WHERE idempotency_key=?').get(o.clientOrderId) as {created_at:string}|undefined;
    if(!execution||typeof r.created_at!=='string'||!Number.isFinite(Date.parse(r.created_at))||Date.parse(r.created_at)<Date.parse(execution.created_at)-5000||Date.parse(r.created_at)>Date.parse(execution.created_at)+60000)throw new Error('Broker order creation time does not match unknown submission');
    if(o.option){const legs=z.array(z.object({option_id:z.string(),side:z.string(),position_effect:z.string(),ratio_quantity:z.number()})).length(1).parse(r.legs);if(legs[0]!.option_id!==o.option.optionId||legs[0]!.side!==o.side.toLowerCase()||legs[0]!.position_effect!==o.positionEffect.toLowerCase()||legs[0]!.ratio_quantity!==1||Number(r.price)!==o.limitPrice)throw new Error('Option order identity mismatch');}
    else if(r.symbol!==o.symbol||r.side!==o.side.toLowerCase()||o.limitPrice!==null&&Number(r.price)!==o.limitPrice)throw new Error('Equity order identity mismatch');
    return {order:result.order,fills:result.fills};
  }
  async cancel(id:string):ReturnType<TradingBroker['cancel']>{
    const row=this.connection.db.raw.prepare('SELECT proposal_id,order_json FROM executions_v2 WHERE broker_order_id=?').get(id) as {proposal_id:string;order_json:string}|undefined;
    if(!row)throw new Error('Unattributed broker order cannot be cancelled');
    const option=!!JSON.parse(row.order_json).option,tool=option?'cancel_option_order':'cancel_equity_order';
    const response=envelope.parse(await this.connection.execute(tool,{account_number:process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID,order_id:id},row.proposal_id));
    if(response.structuredContent.data.accepted!==true)return {cancelled:false};
    const rows=await this.collection(option?'get_option_orders':'get_equity_orders','orders',{account_number:process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID,order_id:id});
    // Acceptance is only a cancel request, never a confirmed cancellation.
    return {cancelled:rows.length===1&&normalizeOfficialOrder(rows[0],option).order.status==='CANCELLED',pending:true};
  }
}
