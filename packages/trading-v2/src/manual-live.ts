import type {AppDatabase} from '../../database/src/database.js';
import {SLEEVES,type TradingAccount} from './model.js';
import {configurationEvidenceHash} from './configuration.js';

export function manualLiveChecks(db:AppDatabase){
  const a=db.getSetting<TradingAccount|null>('broker_account_v2',null),opening=db.getSetting<{accountId:string}|null>('initial_account_import_v2',null);
  const preview=db.getSetting<{accountId:string;catalogHash:string;at:string}|null>('manual_preview_capability_v2',null);
  const smoke=db.getSetting<{sha:string;configHash:string}|null>('manual_live_safety_evidence',null);
  const connector=db.raw.prepare("SELECT body_json FROM connector_status WHERE id='ROBINHOOD'").get() as {body_json:string}|undefined;
  const fresh=!!a&&Number.isFinite(Date.parse(a.asOf))&&Date.now()-Date.parse(a.asOf)>=-5000&&Date.now()-Date.parse(a.asOf)<=60000;
  const scope=!!a&&a.agentic===true&&a.complete===true&&a.healthy===true&&a.accountId===process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID;
  return {
    calendarVerified:!!db.raw.prepare('SELECT date FROM market_sessions WHERE date>=? AND verified_at>=? LIMIT 1').get(new Date().toISOString().slice(0,10),new Date(Date.now()-7*86400000).toISOString()),
    correctAccount:scope,freshAccount:fresh,cleanReconciliation:db.getSetting('reconciliation_clear',false),
    reviewedOpening:!!opening&&opening.accountId===a?.accountId,
    reviewedOwnership:!!opening&&!db.getSetting('v2_migration_review_required',false),
    robinhoodAvailable:!!connector&&JSON.parse(connector.body_json).state==='READ_ONLY'&&fresh,
    brokerReviewVerified:!!preview&&preview.accountId===a?.accountId&&preview.catalogHash===db.getSetting('official_mcp_catalog_hash','')&&Date.now()-Date.parse(preview.at)>=-5000&&Date.now()-Date.parse(preview.at)<86400000,
    executionCapabilities:db.getSetting('manual_execution_capabilities_v2',false)&&process.env.ROBINHOOD_TRANSPORT==='CODEX_WORKER',
    deterministicRiskHealthy:!!smoke&&smoke.sha===(process.env.APP_GIT_SHA??'local')&&smoke.configHash===configurationEvidenceHash(db),
    emergencyStopHealthy:db.getSetting('startup_ready',false)&&!!smoke,
    noUnknownOrders:!db.raw.prepare("SELECT id FROM executions_v2 WHERE status='UNKNOWN_OUTCOME' OR (status='PENDING' AND broker_order_id IS NULL) LIMIT 1").get(),
    manualApprovalOnly:SLEEVES.every(s=>{const row=db.raw.prepare('SELECT config_json FROM sleeve_policies WHERE strategy_id=?').get(s) as {config_json:string};return JSON.parse(row.config_json).executionPolicy==='MANUAL_APPROVAL';}),
    pauseReleased:!db.getSetting('global_pause',true),stopReleased:!db.getSetting('stopped',false),maintenanceOff:!db.getSetting('maintenance_mode',false),
  };
}
