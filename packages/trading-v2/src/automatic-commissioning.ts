import type {AgenticManager} from '../../core/src/agentic-manager.js';
import {verifyCalendar2026} from './scheduling.js';
import {runSelfTests} from './self-tests.js';
import {configurationEvidenceHash} from './configuration.js';
export async function refreshCommissioning(m:AgenticManager){
  const db=m.database;if(db.getMode()==='SIMULATION')return;
  const a=db.getSetting<{accountId:string;healthy:boolean}|null>('broker_account_v2',null);
  if(!a?.healthy||!db.getSetting('initial_account_import_v2',null)||!db.getSetting('reconciliation_clear',false))return;
  const last=db.getSetting<number>('commissioning_refresh_at',0);if(Date.now()-last<23*3600000&&db.getSetting<{sha:string}|null>('manual_live_safety_evidence',null)?.sha===(process.env.APP_GIT_SHA??'local'))return;
  await verifyCalendar2026(db);await m.connectors.robinhood.check('AUTOMATIC_READ_ONLY_READINESS');
  const names=m.connectors.robinhood.catalog().map(t=>t.name);
  db.setSetting('manual_execution_capabilities_v2',['place_equity_order','place_option_order','cancel_equity_order','cancel_option_order','review_equity_order','review_option_order'].every(n=>names.includes(n)));
  const held=[...m.ledger.listPositions(),...m.ledger.legacyPositions()].find(p=>p.quantity>=1);
  if(held){const preview=await m.liveBroker.preview({clientOrderId:'READINESS_ONLY_NO_PLACEMENT',strategy:'SAFE_LONG_TERM',assetClass:held.assetType==='ETF'?'ETF':'EQUITY',symbol:held.symbol,underlying:null,side:'SELL',positionEffect:'CLOSE',quantity:1,orderType:'LIMIT',limitPrice:held.marketPrice,stopPrice:null,timeInForce:'DAY',marketHours:'REGULAR',option:null});db.audit('READINESS','OFFICIAL_READ_ONLY_PREVIEW','system',null,{symbol:held.symbol,preview,ordersPlaced:0});}
  const smoke=await runSelfTests();if(!smoke.ok)throw new Error('Isolated safety smoke failed');
  db.setSetting('manual_live_safety_evidence',{sha:process.env.APP_GIT_SHA??'local',configHash:configurationEvidenceHash(db)});db.setSetting('self_tests_v2',true);db.setSetting('simulated_lifecycle_v2',true);db.setSetting('commissioning_refresh_at',Date.now());
}
