import {afterEach,describe,expect,it,vi} from 'vitest';
import {WorkerRobinhoodBroker} from '../packages/trading-v2/src/worker-broker.js';
import {CodexMcpTransport,DETERMINISTIC_BROKER_TOOLS} from '../packages/agents/src/codex-mcp.js';
import type {OfficialRobinhoodConnection} from '../packages/trading-v2/src/connectors.js';

afterEach(()=>vi.unstubAllEnvs());
function fixture(overrides:Record<string,unknown>={}){
  vi.stubEnv('ROBINHOOD_AGENTIC_ACCOUNT_ID','test-scoped-account');
  const values:Record<string,unknown>={get_accounts:{accounts:[{account_number:'test-scoped-account',agentic_allowed:true,state:'active',deactivated:false,permanently_deactivated:false,option_level:'option_level_2'}]},get_portfolio:{currency:'USD',cash:'500',total_value:'900',buying_power:{buying_power:'500'},options_value:'0',futures_value:'0',event_contracts_value:'0',crypto_value:'0',mutual_funds_value:'0',fixed_income_value:'0',pending_deposits:'0'},get_equity_positions:{positions:[{symbol:'TEST',quantity:'1',average_buy_price:'300',type:'long'}]},get_option_positions:{positions:[]},get_equity_orders:{orders:[]},get_option_orders:{orders:[]},get_equity_quotes:{results:[{quote:{symbol:'TEST',last_trade_price:'400',venue_last_trade_time:new Date().toISOString(),last_non_reg_trade_price:null,venue_last_non_reg_trade_time:null}}]},...overrides};
  const connection={db:{raw:{prepare:()=>({all:()=>[]})},getSetting:(_key:string,fallback:unknown)=>fallback},check:vi.fn(),validateAccount:vi.fn(),call:vi.fn(async(name:string)=>({structuredContent:{data:values[name]}}))};
  return {broker:new WorkerRobinhoodBroker(connection as unknown as OfficialRobinhoodConnection),connection,values};
}
describe('deterministic worker broker',()=>{
  it('uses complete scoped tax lots for omitted basis and refuses incomplete or wrong-identity lots',async()=>{
    const {broker,values}=fixture({get_equity_positions:{positions:[{symbol:'TEST',quantity:'1',type:'long'}]},get_equity_tax_lots:{symbol:'TEST',tax_lots:[{open_lot_id:'lot-a',quantity:'0.4',tax_cost_basis:'120'},{open_lot_id:'lot-b',quantity:'0.6',cost_per_share:'300'}]}});
    expect((await broker.account()).positions[0]?.averageCost).toBe(300);
    values.get_equity_tax_lots={symbol:'TEST',tax_lots:[]};expect((await broker.account()).positions[0]).toMatchObject({averageCost:null,basisStatus:'UNAVAILABLE_EXTERNAL'});
    values.get_equity_tax_lots={symbol:'OTHER',tax_lots:[]};await expect(broker.account()).rejects.toThrow('identity');
    values.get_equity_tax_lots={symbol:'TEST',tax_lots:[{open_lot_id:'a',quantity:'0.5',cost_per_share:'300'}]};expect((await broker.account()).positions[0]).toMatchObject({averageCost:null,basisStatus:'UNAVAILABLE_EXTERNAL'});
    values.get_equity_tax_lots={symbol:'TEST',tax_lots:[{open_lot_id:'a',quantity:'1'}]};expect((await broker.account()).positions[0]).toMatchObject({averageCost:null,basisStatus:'UNAVAILABLE_EXTERNAL'});
  });
  it('normalizes actual decimals and scoped holdings without a model or ownership assignment',async()=>{const {broker,connection}=fixture();const a=await broker.account();expect(a).toMatchObject({cash:500,netAccountValue:900,complete:true,positions:[{symbol:'TEST',quantity:1,price:400,averageCost:300}]});expect(connection.validateAccount).toHaveBeenCalledWith('test-scoped-account');expect(connection.call.mock.calls.every(([name])=>name.startsWith('get_'))).toBe(true);});
  it('ignores verified zero-share rows with missing basis but rejects missing facts for held shares',async()=>{
    const {broker,values}=fixture({get_equity_positions:{positions:[{symbol:'TEST',quantity:'1',average_buy_price:'300',type:'long'},{symbol:'CLOSED',quantity:'0'},{symbol:'CLOSED2',quantity:0,average_buy_price:null}]}});
    expect((await broker.account()).positions).toHaveLength(1);
    values.get_equity_positions={positions:[{symbol:'TEST',quantity:'1',type:'long'}]};await expect(broker.account()).rejects.toThrow();
    values.get_equity_positions={positions:[{symbol:'UNKNOWN'}]};await expect(broker.account()).rejects.toThrow();
  });
  it('rejects unauthorized identity rather than choosing another account',async()=>{const {broker}=fixture({get_accounts:{accounts:[]}});await expect(broker.account()).rejects.toThrow('authorized Agentic');});
  it('fails closed for unsupported collateral or executions',async()=>{const {broker}=fixture({get_option_orders:{orders:[{id:'unknown'}]}});await expect(broker.account()).rejects.toThrow();});
  it('rejects missing facts and wrong quote identity',async()=>{const {broker}=fixture({get_equity_quotes:{results:[]}});await expect(broker.account()).rejects.toThrow();});
  it('follows pagination and rejects a repeating cursor',async()=>{const {broker,values}=fixture();values.get_equity_positions={positions:[],next:'repeat'};await expect(broker.account()).rejects.toThrow('repeated a cursor');});
  it('does not admit order placement or cancellation to the RPC catalog',async()=>{expect(DETERMINISTIC_BROKER_TOOLS.every(t=>!/(place|cancel|replace)_/.test(t))).toBe(true);const transport=new CodexMcpTransport('must-not-spawn');await expect(transport.call('place_equity_order',{})).rejects.toThrow('not a permitted');transport.close();});
});
