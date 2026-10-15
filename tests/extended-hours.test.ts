import {it,expect} from 'vitest';
import {openDatabase} from '../packages/database/src/database.js';
import {marketClock,sessionAllows} from '../packages/trading-v2/src/market-session.js';
import {officialOrderArguments} from '../packages/trading-v2/src/official-orders.js';
import type {ExecutableOrder} from '../packages/trading-v2/src/model.js';
import {enableExtendedEquities} from '../packages/trading-v2/src/extended-equity-config.js';
import {RiskConfigurationService} from '../packages/trading-v2/src/configuration.js';
import {StrategyAllocationManager} from '../packages/trading-v2/src/capital.js';
import {VirtualPortfolioLedger} from '../packages/ledger/src/virtual-ledger.js';
it('enables equity sessions once while retaining saved autonomy, sleeve ownership and exposure limits',()=>{
  const db=openDatabase(':memory:');try{
    const allocation=new StrategyAllocationManager(db,new VirtualPortfolioLedger(db));
    allocation.updatePolicy('SAFE_LONG_TERM',{...allocation.policy('SAFE_LONG_TERM'),executionPolicy:'AUTONOMOUS_RISK_APPROVED'},'fixture');
    db.setSetting('operating_mode','AUTONOMOUS_LIVE');db.setSetting('autonomous_authorization_v1',{id:'saved'});db.setSetting('global_pause',false);
    const service=new RiskConfigurationService(db),before=service.effective('SAFE_LONG_TERM','EQUITY','DEFAULT');
    enableExtendedEquities(db);const version=service.current().version;enableExtendedEquities(db);expect(service.current().version).toBe(version);
    expect(service.effective('SAFE_LONG_TERM','EQUITY','DEFAULT')).toMatchObject({extendedHoursAllowed:true,maxPositionPercent:before.maxPositionPercent,perTradeRiskPercent:before.perTradeRiskPercent});
    expect(service.effective('OPTIONS','OPTION','DEFAULT').extendedHoursAllowed).toBe(false);
    expect(db.getMode()).toBe('AUTONOMOUS_LIVE');expect(db.getSetting('global_pause')).toBe(false);expect(db.getSetting('autonomous_authorization_v1')).toEqual({id:'saved'});
    expect(allocation.policy('SAFE_LONG_TERM').executionPolicy).toBe('AUTONOMOUS_RISK_APPROVED');
  }finally{db.close();}
});
it('allows verified 7am–8pm ET equity sessions, preserves option hours, holidays, stale-calendar and early-close boundaries',()=>{
  const db=openDatabase(':memory:');try{
    db.raw.prepare('INSERT OR REPLACE INTO market_sessions VALUES(?,?,?,?,?)').run('2026-10-15','2026-10-15T13:30:00Z','2026-10-15T20:00:00Z','fixture','2026-10-15T00:00:00Z');
    for(const at of ['2026-10-15T11:00:00Z','2026-10-15T13:29:59Z','2026-10-15T23:59:59Z']){expect(sessionAllows(db,'EXTENDED',false,new Date(at))).toBe(true);expect(sessionAllows(db,'REGULAR',false,new Date(at))).toBe(false);expect(sessionAllows(db,'EXTENDED',true,new Date(at))).toBe(false);}
    expect(sessionAllows(db,'EXTENDED',false,new Date('2026-10-15T10:59:59Z'))).toBe(false);
    expect(sessionAllows(db,'EXTENDED',false,new Date('2026-10-16T00:00:00Z'))).toBe(false);
    expect(sessionAllows(db,'REGULAR',true,new Date('2026-10-15T14:00:00Z'))).toBe(true);
    db.raw.prepare("UPDATE market_sessions SET verified_at='2026-10-01T00:00:00Z'").run();expect(marketClock(db,new Date('2026-10-15T21:00:00Z')).equityOpen).toBe(false);
    db.raw.prepare("UPDATE market_sessions SET verified_at='2026-10-15T00:00:00Z',closes_at='2026-10-15T17:00:00Z'").run();expect(marketClock(db,new Date('2026-10-15T18:00:00Z')).equityOpen).toBe(false);
    expect(marketClock(db,new Date('2026-10-17T14:00:00Z')).equityOpen).toBe(false);
  }finally{db.close();}
});
it('maps extended whole-share limits to the official session and rejects market/fractional/option alternatives',()=>{
  const order:ExecutableOrder={clientOrderId:'extended-fixture',strategy:'AGGRESSIVE_STOCKS',assetClass:'EQUITY',symbol:'TEST',underlying:null,side:'BUY',positionEffect:'OPEN',quantity:1,orderType:'LIMIT',limitPrice:10,stopPrice:null,timeInForce:'DAY',marketHours:'EXTENDED',option:null};
  expect(officialOrderArguments(order,'fixture')).toMatchObject({market_hours:'extended_hours',type:'limit',limit_price:'10'});
  expect(officialOrderArguments(order,'fixture',true)).toHaveProperty('ref_id');
  expect(()=>officialOrderArguments({...order,orderType:'MARKET',limitPrice:null},'fixture')).toThrow('Extended');
  expect(()=>officialOrderArguments({...order,quantity:.5},'fixture')).toThrow('Extended');
  expect(()=>officialOrderArguments({...order,option:{optionId:'option',underlying:'TEST',type:'CALL',strike:10,expiration:'2026-11-20',multiplier:100}},'fixture')).toThrow('Extended');
});
