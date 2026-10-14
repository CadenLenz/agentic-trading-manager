import type {AppDatabase} from '../../database/src/database.js';
import type {Sleeve,TradingAccount} from './model.js';
import {nowIso,makeId} from '../../core/src/utils.js';

export interface AutonomousAuthorization {id:string;accountId:string;actor:string;at:string;review:string}
export const liveMode=(mode:string)=>['LIVE','MANUAL_LIVE','AUTONOMOUS_LIVE'].includes(mode);
export function suspendAutonomy(db:AppDatabase,reason:string){db.setSetting('reconciliation_clear',false);db.setSetting('autonomous_runtime_block',reason);}
export function sleeveExecutionBlocked(db:AppDatabase,strategy:Sleeve){return !!db.raw.prepare("SELECT proposal_id FROM executions_v2 WHERE (status='UNKNOWN_OUTCOME' OR (status='PENDING' AND broker_order_id IS NULL)) AND (json_extract(order_json,'$.strategy')=? OR json_extract(order_json,'$.strategy') IS NULL) LIMIT 1").get(strategy);}
export function revokeAutonomy(db:AppDatabase,reason:string){
  if(db.getSetting('autonomous_authorization_v1',null))db.audit('SAFETY','AUTONOMY_REVOKED','system',null,{reason});
  db.setSetting('autonomous_authorization_v1',null);
  db.setSetting('v2_live_activation',false);db.setSetting('live_db_confirmation',false);
  db.setSetting('global_pause',true);
  if(liveMode(db.getMode()))db.setSetting('operating_mode','READ_ONLY');
}
export function autonomyChecks(db:AppDatabase){
  const a=db.getSetting<TradingAccount|null>('broker_account_v2',null);
  return {correctAccount:!!a&&a.agentic&&a.complete&&a.accountId===process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID,freshAccount:!!a&&a.healthy&&Date.now()-Date.parse(a.asOf)>=-5000&&Date.now()-Date.parse(a.asOf)<60000,cleanReconciliation:db.getSetting('reconciliation_clear',false),noBorrowing:!!a&&a.cash>=0&&a.buyingPower>=0,emergencyStopHealthy:db.getSetting('startup_ready',false),stopReleased:!db.getSetting('stopped',false),maintenanceOff:!db.getSetting('maintenance_mode',false)};
}
export function authorizeAutonomy(db:AppDatabase,actor:string,review:string){
  const checks=autonomyChecks(db);if(!Object.values(checks).every(Boolean))throw new Error('Autonomous readiness blocked: '+Object.entries(checks).filter(([,ok])=>!ok).map(([k])=>k).join(', '));
  const account=db.getSetting<TradingAccount>('broker_account_v2');
  const authorization:AutonomousAuthorization={id:makeId('autonomy'),accountId:account.accountId,actor,at:nowIso(),review};
  db.setSetting('operating_mode','MANUAL_LIVE');
  db.setSetting('autonomous_authorization_v1',authorization);
  db.setSetting('v2_live_activation',true);db.setSetting('live_db_confirmation',true);db.setSetting('global_pause',false);
  db.setSetting('operating_mode','AUTONOMOUS_LIVE');
  db.audit(actor,'AUTONOMOUS_LIVE_AUTHORIZED','system',null,authorization);return authorization;
}
export function autonomousAuthorized(db:AppDatabase,strategy:Sleeve){
  const a=db.getSetting<AutonomousAuthorization|null>('autonomous_authorization_v1',null);
  const account=db.getSetting<TradingAccount|null>('broker_account_v2',null);
  const row=db.raw.prepare('SELECT config_json FROM sleeve_policies WHERE strategy_id=?').get(strategy) as {config_json:string}|undefined;
  const policy=row?JSON.parse(row.config_json):null;
  return db.getMode()==='AUTONOMOUS_LIVE'&&!!a&&a.accountId===account?.accountId&&a.accountId===process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID&&!!account?.healthy&&
    db.getSetting('startup_ready',false)&&db.getSetting('reconciliation_clear',false)&&!db.getSetting('global_pause',true)&&!db.getSetting('stopped',false)&&!db.getSetting('maintenance_mode',false)&&
    db.getSetting('v2_live_activation',false)&&db.getSetting('live_db_confirmation',false)&&!!db.getStrategy(strategy)?.enabled&&policy?.executionPolicy==='AUTONOMOUS_RISK_APPROVED'&&
    !sleeveExecutionBlocked(db,strategy)&&!db.raw.prepare('SELECT strategy_id FROM strategy_capital WHERE killed=1 AND strategy_id=? LIMIT 1').get(strategy)&&Date.now()-Date.parse(account!.asOf)>=-5000&&Date.now()-Date.parse(account!.asOf)<90000;
}
export function autonomousExecutionAuthorized(db:AppDatabase,id:string,version:number,hash:string,strategy:Sleeve){
  const proof=db.getSetting<{version:number;hash:string;authorizationId:string}|null>('autonomous_execution:'+id,null);
  const a=db.getSetting<AutonomousAuthorization|null>('autonomous_authorization_v1',null);
  return autonomousAuthorized(db,strategy)&&!!proof&&proof.version===version&&proof.hash===hash&&proof.authorizationId===a?.id;
}
