import {afterEach,describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {Ajv} from 'ajv';
import {openDatabase} from '../packages/database/src/database.js';
import {manualLiveChecks} from '../packages/trading-v2/src/manual-live.js';
import {configurationEvidenceHash} from '../packages/trading-v2/src/configuration.js';
import {officialOrderArguments,normalizeOfficialOrder,brokerReference} from '../packages/trading-v2/src/official-orders.js';
import {WorkerRobinhoodBroker} from '../packages/trading-v2/src/worker-broker.js';
import type {OfficialRobinhoodConnection} from '../packages/trading-v2/src/connectors.js';
import type {ExecutableOrder} from '../packages/trading-v2/src/model.js';
// Input contracts discovered from the connected official MCP on 2026-09-30.
const schemas=JSON.parse(readFileSync(new URL('./fixtures/official-order-inputs.json',import.meta.url),'utf8'));
const order:ExecutableOrder={clientOrderId:'proposal:v1',strategy:'AGGRESSIVE_STOCKS',assetClass:'EQUITY',symbol:'TEST',underlying:null,side:'BUY',positionEffect:'OPEN',quantity:1,orderType:'LIMIT',limitPrice:10,stopPrice:null,timeInForce:'DAY',marketHours:'REGULAR',option:null};
afterEach(()=>vi.unstubAllEnvs());
describe('official manual execution contracts',()=>{
  it('validates market/limit equities and all four single-leg Level 2 directions against discovered schemas',()=>{
    const ajv=new Ajv({strict:false});
    for(const side of ['BUY','SELL'] as const)for(const type of ['LIMIT','MARKET'] as const){const o={...order,side,orderType:type,limitPrice:type==='MARKET'?null:10};for(const placement of [false,true])expect(ajv.compile(schemas[placement?'place_equity_order':'review_equity_order'])(officialOrderArguments(o,'account',placement))).toBe(true);}
    for(const side of ['BUY','SELL'] as const)for(const type of ['CALL','PUT'] as const){const o:ExecutableOrder={...order,strategy:'OPTIONS',assetClass:'OPTION',underlying:'TEST',side,option:{optionId:'55555555-5555-4555-a555-555555555555',underlying:'TEST',type,strike:10,expiration:'2027-01-15',multiplier:100}};for(const placement of [false,true])expect(ajv.compile(schemas[placement?'place_option_order':'review_option_order'])(officialOrderArguments(o,'account',placement))).toBe(true);}
    expect(brokerReference('same')).toBe(brokerReference('same'));expect(brokerReference('same')).not.toBe(brokerReference('other'));
    expect(()=>officialOrderArguments({...order,quantity:.5},'account')).toThrow('fractional');
    expect(()=>officialOrderArguments({...order,orderType:'STOP_LIMIT',stopPrice:9},'account')).toThrow('market/limit');
  });
  it('preserves partial/rejected/cancelled facts and never fabricates missing option fees',()=>{
    const raw={id:'broker',state:'partially_filled',cumulative_quantity:'1',executions:[{id:'fill',quantity:'1',price:'10',fees:'0.02',timestamp:new Date().toISOString()}]};
    expect(normalizeOfficialOrder(raw)).toMatchObject({order:{status:'PARTIALLY_FILLED',filledQuantity:1},fills:[{fees:.02}]});
    for(const [state,status] of [['rejected','REJECTED'],['cancelled','CANCELLED']])expect(normalizeOfficialOrder({...raw,state,cumulative_quantity:'0',executions:[]} ).order.status).toBe(status);
    expect(normalizeOfficialOrder({id:'option',state:'filled',processed_quantity:'1',legs:[{ratio_quantity:1,option_id:'contract',executions:[{id:'fill',quantity:'1',price:'1.00',timestamp:new Date().toISOString()}]}]},true).fills[0]?.fees).toBeNull();
    expect(()=>normalizeOfficialOrder({...raw,cumulative_quantity:'2'})).toThrow('incomplete');
    expect(()=>normalizeOfficialOrder({...raw,executions:[{...raw.executions[0],fees:undefined}]})).toThrow('incomplete');
  });
  it('verifies option collateral debit and blocks infinite/uncovered exposure in mocked official review',async()=>{
    const db=openDatabase(':memory:');vi.stubEnv('ROBINHOOD_AGENTIC_ACCOUNT_ID','account');
    const o:ExecutableOrder={...order,strategy:'OPTIONS',assetClass:'OPTION',underlying:'TEST',side:'SELL',option:{optionId:'contract',underlying:'TEST',type:'PUT',strike:10,expiration:'2027-01-15',multiplier:100}};
    const args=officialOrderArguments(o,'account'),raw={...args,order_checks:{},collateral:{account_number:'account',cash:{amount:'1000',direction:'debit',infinite:false},equities:[]},fees:{total_fee:'0.03'}};
    const connection={db,call:vi.fn(async()=>({structuredContent:{data:raw}}))};
    const broker=new WorkerRobinhoodBroker(connection as unknown as OfficialRobinhoodConnection);
    try{expect(await broker.preview(o)).toMatchObject({approved:true,collateralRequired:1000,estimatedCost:1000.03});raw.collateral.cash.infinite=true;expect((await broker.preview(o)).approved).toBe(false);}finally{db.close();}
  });
  it('requires every readiness proof and ignores acknowledged historical basis as an activation blocker',()=>{
    const db=openDatabase(':memory:');vi.stubEnv('ROBINHOOD_AGENTIC_ACCOUNT_ID','account');vi.stubEnv('ROBINHOOD_TRANSPORT','CODEX_WORKER');
    try{
      db.setSetting('broker_account_v2',{accountId:'account',agentic:true,complete:true,healthy:true,asOf:new Date().toISOString(),positions:[{averageCost:null,basisStatus:'UNAVAILABLE_EXTERNAL'}]});
      db.setSetting('initial_account_import_v2',{accountId:'account'});db.setSetting('v2_migration_review_required',false);db.setSetting('reconciliation_clear',true);db.setSetting('startup_ready',true);db.setSetting('global_pause',false);db.setSetting('manual_execution_capabilities_v2',true);db.setSetting('official_mcp_catalog_hash','catalog');db.setSetting('manual_preview_capability_v2',{accountId:'account',catalogHash:'catalog',at:new Date().toISOString()});db.setSetting('manual_live_safety_evidence',{sha:'local',configHash:configurationEvidenceHash(db)});
      db.raw.prepare('INSERT INTO connector_status VALUES(?,?,?)').run('ROBINHOOD',JSON.stringify({state:'READ_ONLY'}),new Date().toISOString());
      db.raw.prepare('INSERT OR REPLACE INTO market_sessions VALUES(?,?,?,?,?)').run('2026-12-24','2026-12-24T14:30:00Z','2026-12-24T18:00:00Z','verified',new Date().toISOString());
      expect(Object.values(manualLiveChecks(db)).every(Boolean)).toBe(true);
      db.setSetting('global_pause',true);expect(manualLiveChecks(db).pauseReleased).toBe(false);
      db.setSetting('stopped',true);expect(manualLiveChecks(db).stopReleased).toBe(false);
      db.setSetting('reconciliation_clear',false);expect(manualLiveChecks(db).cleanReconciliation).toBe(false);
      db.setSetting('manual_live_safety_evidence',{sha:'other',configHash:configurationEvidenceHash(db)});expect(manualLiveChecks(db).deterministicRiskHealthy).toBe(false);
      db.setSetting('broker_account_v2',{accountId:'wrong',asOf:'2020-01-01T00:00:00Z'});expect(manualLiveChecks(db)).toMatchObject({correctAccount:false,freshAccount:false});
    }finally{db.close();}
  });
});
