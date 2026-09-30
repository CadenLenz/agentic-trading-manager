import {afterEach,describe,expect,it,vi} from 'vitest';
import {AgenticManager} from '../packages/core/src/agentic-manager.js';
import {ProposalService} from '../packages/trading-v2/src/proposals.js';
import {AccountReconciliationService} from '../packages/trading-v2/src/account-reconciliation.js';
import {SLEEVES,type TradingAccount,type TradingBroker} from '../packages/trading-v2/src/model.js';
import {nowIso} from '../packages/core/src/utils.js';
import {BrokerBasisUnavailable} from '../packages/trading-v2/src/worker-broker.js';

let manager:AgenticManager;
afterEach(async()=>{await manager?.shutdown();vi.unstubAllEnvs();});
async function fixture(){
  vi.stubEnv('ROBINHOOD_AGENTIC_ACCOUNT_ID','fixture-account');
  manager=new AgenticManager({databasePath:':memory:',workingDirectory:process.cwd(),sessionSecret:'isolated-opening-account-test-secret',startBackgroundServices:false});await manager.start();
  manager.database.setSetting('operating_mode','READ_ONLY');manager.database.setSetting('global_pause',true);
  const account:TradingAccount={accountId:'fixture-account',agentic:true,complete:true,healthy:true,cash:500.53,buyingPower:500.53,netAccountValue:940.53,optionsLevel:2,asOf:nowIso(),positions:[{symbol:'TSLA',quantity:1,averageCost:367.23,price:353,assetClass:'EQUITY'},{symbol:'KO',quantity:1,averageCost:88.44,price:87,assetClass:'EQUITY'}],options:[],orders:[],fills:[]};
  const forbidden=vi.fn(async()=>{throw new Error('No broker execution permitted');});
  const broker:TradingBroker={deterministic:true,account:async()=>structuredClone(account),quote:forbidden,preview:forbidden,place:forbidden,cancel:forbidden};
  const proposals=new ProposalService(manager.database,manager.ledger,manager.allocation,()=>broker),service=new AccountReconciliationService(proposals);
  await proposals.reconcile();
  const request=()=>({token:service.report().initialImport.token,confirmation:'IMPORT VERIFIED ACCOUNT',review:'Reviewed existing holdings and verified cash, no trading requested.',assignments:[{symbol:'TSLA',strategy:'SAFE_LONG_TERM'},{symbol:'KO',strategy:'AGGRESSIVE_STOCKS'}],cash:{SAFE_LONG_TERM:200,AGGRESSIVE_STOCKS:200,OPTIONS:100.53}});
  return {account,broker,forbidden,proposals,service,request};
}
describe('Reviewed initial broker account import',()=>{
  it('imports unavailable basis only with explicit acknowledgement, preserving null P&L and exact exposure',async()=>{
    const {account,service,request,proposals}=await fixture();account.positions[0]!.averageCost=null;
    await proposals.reconcile();expect(service.report().initialImport.available).toBe(true);
    await expect(service.importOpeningBalance(request(),'operator')).rejects.toThrow('acknowledgement');
    const acknowledgement='These holdings were imported from Robinhood and cost basis is currently unavailable.';
    expect((await service.importOpeningBalance({...request(),basisAcknowledgement:acknowledgement},'operator')).clear).toBe(true);
    expect(manager.ledger.getPosition('SAFE_LONG_TERM','TSLA')).toMatchObject({averageCost:null,basisStatus:'UNAVAILABLE_EXTERNAL',unrealizedPnl:null,marketValue:353});
    expect(manager.allocation.state('SAFE_LONG_TERM')).toMatchObject({currentEquity:553,unrealizedPnL:null,drawdown:0});
    manager.analytics.snapshot('UNKNOWN_BASIS_OPENING');expect(service.report().warnings).toContain('Historical cost basis unavailable: TSLA');
    expect(()=>manager.risk.defaultContext()).toThrow('basis-dependent');
    manager.allocation.transferPosition('SAFE_LONG_TERM','OPTIONS','TSLA',1,'Reviewed collateral ownership transfer','operator');
    expect(manager.ledger.getPosition('OPTIONS','TSLA')?.averageCost).toBeNull();
    expect((await proposals.reconcile()).clear).toBe(true);
  });
  it('shows incomplete broker holdings and cash with a specific basis blocker and cannot clear or import them',async()=>{
    const {service,proposals,broker,request}=await fixture();const input=request();
    Object.assign(broker,{account:async()=>{throw new BrokerBasisUnavailable({accountId:'fixture-account',cash:500.53,buyingPower:500.53,netAccountValue:940.53,asOf:nowIso(),positions:[{symbol:'TSLA',quantity:1,averageCost:null}]},['TSLA']);}});
    await expect(proposals.reconcile()).rejects.toThrow('cost basis');
    expect(service.report()).toMatchObject({clear:false,snapshotComplete:false,cash:{broker:500.53},positions:[{symbol:'TSLA',broker:1,averageCost:null}],initialImport:{available:false}});
    expect(manager.database.getSetting('broker_account_v2')).toBeNull();
    await expect(service.importOpeningBalance(input,'operator')).rejects.toThrow('cost basis');expect(manager.ledger.aggregatePositions()).toHaveLength(0);
  });
  it('reports actual mismatches and imports holdings and cash atomically without orders or risk-policy changes',async()=>{
    const {service,request,forbidden}=await fixture(),before=SLEEVES.map(s=>manager.allocation.policy(s));
    expect(service.report()).toMatchObject({clear:false,cash:{internal:50000,broker:500.53},initialImport:{available:true}});
    expect(service.report().mismatches).toHaveLength(3);
    expect((await service.importOpeningBalance(request(),'operator')).clear).toBe(true);
    expect(manager.ledger.getPosition('SAFE_LONG_TERM','TSLA')).toMatchObject({quantity:1,averageCost:367.23});
    expect(manager.ledger.getPosition('AGGRESSIVE_STOCKS','KO')).toMatchObject({quantity:1,averageCost:88.44});
    expect(service.report().cash.internal).toBe(500.53);
    for(const s of SLEEVES)expect(manager.allocation.state(s)).toMatchObject({drawdown:0,killed:false});
    expect(SLEEVES.map(s=>manager.allocation.policy(s))).toEqual(before);
    expect(manager.database.getMode()).toBe('READ_ONLY');expect(manager.database.getSetting('global_pause')).toBe(true);
    expect(manager.database.raw.prepare('SELECT * FROM orders').all()).toHaveLength(0);expect(forbidden).not.toHaveBeenCalled();
    expect(manager.database.raw.prepare("SELECT * FROM audit_events WHERE action='INITIAL_ACCOUNT_IMPORT'").all()).toHaveLength(1);
    await expect(service.importOpeningBalance(request(),'operator')).rejects.toThrow('already imported');
  });
  it('rejects changed broker evidence and incomplete strategy assignment without changing cash',async()=>{
    const {service,request,account}=await fixture(),input=request();account.cash=501;account.netAccountValue=941;
    await expect(service.importOpeningBalance(input,'operator')).rejects.toThrow('changed');
    const next=request();next.assignments=[];await expect(service.importOpeningBalance(next,'operator')).rejects.toThrow('every broker holding');
    expect(service.report().cash.internal).toBe(50000);
  });
  it('rejects incorrect cash totals and requires exact confirmation',async()=>{
    const {service,request}=await fixture();const b=request();b.cash.OPTIONS=100;
    await expect(service.importOpeningBalance(b,'operator')).rejects.toThrow('exactly');
    await expect(service.importOpeningBalance({...request(),confirmation:'yes'},'operator')).rejects.toThrow();
    expect(manager.ledger.aggregatePositions()).toHaveLength(0);
  });
  it('blocks live mode, stale or wrong-scope snapshots and nondeterministic evidence',async()=>{
    const {service,request,account,broker}=await fixture();const b=request();
    manager.database.setSetting('operating_mode','LIVE');await expect(service.importOpeningBalance(b,'operator')).rejects.toThrow('Read only');
    manager.database.setSetting('operating_mode','READ_ONLY');account.asOf='2000-01-01T00:00:00.000Z';await expect(service.importOpeningBalance(b,'operator')).rejects.toThrow('fresh');
    account.asOf=nowIso();account.accountId='wrong';await expect(service.importOpeningBalance(b,'operator')).rejects.toThrow('configured account');
    account.accountId='fixture-account';Object.assign(broker,{deterministic:false});await expect(service.importOpeningBalance(b,'operator')).rejects.toThrow('verification');
    expect(service.report().cash.internal).toBe(50000);
  });
  it('cannot reset an established ledger or a latched risk stop',async()=>{
    const {service,request}=await fixture(),b=request();manager.database.raw.prepare("UPDATE strategy_capital SET killed=1 WHERE strategy_id='OPTIONS'").run();
    await expect(service.importOpeningBalance(b,'operator')).rejects.toThrow('risk latch');
    manager.database.raw.prepare("UPDATE strategy_capital SET killed=0 WHERE strategy_id='OPTIONS'").run();
    manager.ledger.createOrder({idempotencyKey:'pending',strategyId:'SAFE_LONG_TERM',symbol:'TSLA',side:'BUY',quantity:1,orderType:'MARKET',mode:'READ_ONLY',source:'TEST'});
    await expect(service.importOpeningBalance(b,'operator')).rejects.toThrow('established ledger');
  });
  it('excludes unreconciled setup history from verified account charts and returns without deleting audit history',async()=>{
    const {service,request}=await fixture();manager.analytics.snapshot('UNVERIFIED_SETUP',0,'2026-01-01T00:00:00.000Z');
    await service.importOpeningBalance(request(),'operator');manager.analytics.snapshot('VERIFIED_OPENING');
    const series=manager.analytics.series('ALL');expect(series.points).toHaveLength(1);expect(series.points[0]?.value).toBe(940.53);
    expect(manager.analytics.performance('2000-01-01').pnl).toBeNull();
    expect(manager.database.raw.prepare("SELECT * FROM portfolio_snapshots WHERE reason='UNVERIFIED_SETUP'").all()).toHaveLength(1);
  });
});
