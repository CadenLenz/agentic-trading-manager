import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {ExecutableOrder,BrokerFill} from './model.js';
const decimal=z.union([z.number(),z.string().regex(/^-?\d+(\.\d+)?$/)]).transform(Number).pipe(z.number().finite());
export function brokerReference(clientOrderId:string){const h=createHash('sha256').update('agentic-order:'+clientOrderId).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);}
export function officialOrderArguments(o:ExecutableOrder,accountId:string,placement=false){
  if(!['LIMIT','MARKET'].includes(o.orderType)||o.marketHours!=='REGULAR'||o.stopPrice!==null)throw new Error('Only regular-session market/limit orders are commissioned');
  if(o.option&&(o.orderType!=='LIMIT'||!Number.isInteger(o.quantity)||o.option.multiplier!==100))throw new Error('Only standard single-leg limit options are commissioned');
  if(!o.option&&o.orderType==='LIMIT'&&!Number.isInteger(o.quantity))throw new Error('Official fractional equities require market orders');
  const common={account_number:accountId,type:o.orderType.toLowerCase(),quantity:String(o.quantity),time_in_force:o.timeInForce==='DAY'?'gfd':'gtc',market_hours:'regular_hours'};
  const args:Record<string,unknown>=o.option?{...common,direction:o.side==='BUY'?'debit':'credit',price:String(o.limitPrice),legs:[{option_id:o.option.optionId,side:o.side.toLowerCase(),position_effect:o.positionEffect.toLowerCase(),ratio_quantity:1}],...(!placement?{chain_symbol:o.option.underlying,underlying_type:'equity'}:{})}:{...common,symbol:o.symbol,side:o.side.toLowerCase(),...(o.limitPrice!==null?{limit_price:String(o.limitPrice)}:{})};
  if(placement)args.ref_id=brokerReference(o.clientOrderId);return args;
}
export function normalizeOfficialOrder(input:unknown,option=false){
  const raw=z.record(z.string(),z.unknown()).parse(input),id=z.string().min(1).parse(raw.id),state=z.string().parse(raw.state);
  const status:Record<string,string>={queued:'ACCEPTED',unconfirmed:'ACCEPTED',confirmed:'ACCEPTED',partially_filled:'PARTIALLY_FILLED',filled:'FILLED',cancelled:'CANCELLED',canceled:'CANCELLED',rejected:'REJECTED',failed:'REJECTED',voided:'CANCELLED',pending_cancelled:'ACCEPTED',pending_cancel:'ACCEPTED'};
  const filledQuantity=decimal.pipe(z.number().nonnegative()).parse(option?raw.processed_quantity:raw.cumulative_quantity);
  const sources=option?z.array(z.object({ratio_quantity:z.literal(1),option_id:z.string(),executions:z.array(z.unknown()).nullable().optional()})).length(1).parse(raw.legs)[0]!.executions:z.array(z.unknown()).nullable().parse(raw.executions);
  const rows=z.array(z.object({id:z.string().min(1),quantity:decimal.pipe(z.number().positive()),price:decimal.pipe(z.number().positive()),timestamp:z.string().datetime(),fees:decimal.pipe(z.number().nonnegative()).optional()})).parse(sources??[]);
  // Option per-fill fees are absent in the official contract. Require a verified fee total.
  const fees=option?(raw.fees===undefined?null:decimal.parse(raw.fees)):null;
  const fills:BrokerFill[]=rows.map(f=>({id:f.id,brokerOrderId:id,quantity:f.quantity,price:f.price,fees:option?(fees===null?null:fees*f.quantity/filledQuantity):f.fees!,executedAt:f.timestamp}));
  if(fills.some(f=>f.fees!==null&&(!Number.isFinite(f.fees)||f.fees<0))||new Set(fills.map(f=>f.id)).size!==fills.length||Math.abs(fills.reduce((n,f)=>n+f.quantity,0)-filledQuantity)>.000001)throw new Error('Broker fill history or fee facts incomplete');
  return {order:{id,clientOrderId:typeof raw.ref_id==='string'?raw.ref_id:null,status:status[state]??'UNKNOWN',filledQuantity},fills,raw};
}
