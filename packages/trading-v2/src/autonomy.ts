import type {AppDatabase} from '../../database/src/database.js';
import type {Sleeve,TradingAccount} from './model.js';
import {manualLiveChecks} from './manual-live.js';
import {nowIso,makeId} from '../../core/src/utils.js';

export interface AutonomousAuthorization {id:string;accountId:string;actor:string;at:string;review:string}
export const liveMode=(mode:string)=>['LIVE','MANUAL_LIVE','AUTONOMOUS_LIVE'].includes(mode);
export function revokeAutonomy(db:AppDatabase,reason:string){
  if(db.getSetting('autonomous_authorization_v1',null))db.audit('SAFETY','AUTONOMY_REVOKED','system',null,{reason});
  db.setSetting('autonomous_authorization_v1',null);
  db.setSetting('v2_live_activation',false);db.setSetting('live_db_confirmation',false);
  db.setSetting('global_pause',true);
  if(liveMode(db.getMode()))db.setSetting('operating_mode','READ_ONLY');
}
export function autonomyChecks(db:AppDatabase){
  const {manualApprovalOnly:_,pauseReleased:__,...checks}=manualLiveChecks(db);
  void _;void __;
  // Configuration is validated on every order; the isolated smoke is release evidence.
  const smoke=db.getSetting<{sha:string}|null>('manual_live_safety_evidence',null);
  return {...checks,noLatchedSleeveStops:!db.raw.prepare('SELECT strategy_id FROM strategy_capital WHERE killed=1 LIMIT 1').get(),deterministicRiskHealthy:!!smoke&&smoke.sha===(process.env.APP_GIT_SHA??'local')};
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
    !db.raw.prepare("SELECT proposal_id FROM executions_v2 WHERE status='UNKNOWN_OUTCOME' LIMIT 1").get()&&!db.raw.prepare('SELECT strategy_id FROM strategy_capital WHERE killed=1 LIMIT 1').get();
}
export function autonomousExecutionAuthorized(db:AppDatabase,id:string,version:number,hash:string,strategy:Sleeve){
  const proof=db.getSetting<{version:number;hash:string;authorizationId:string}|null>('autonomous_execution:'+id,null);
  const a=db.getSetting<AutonomousAuthorization|null>('autonomous_authorization_v1',null);
  return autonomousAuthorized(db,strategy)&&!!proof&&proof.version===version&&proof.hash===hash&&proof.authorizationId===a?.id;
}
