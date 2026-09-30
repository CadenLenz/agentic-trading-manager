import {z} from 'zod';
import type {AppDatabase} from '../../database/src/database.js';
import {makeId,nowIso} from '../../core/src/utils.js';
import {configurationEvidenceHash} from './configuration.js';
import {manualLiveChecks} from './manual-live.js';
import {hasVerifiedPreview} from './commissioning.js';
export const PREPRODUCTION_LIVE_LOCK=false;
export const readinessStageSchema=z.enum(['DEVELOPMENT','SIMULATION_READY','PI_ACCEPTANCE_READY','READ_ONLY_PRODUCTION','MANUAL_LIVE_READY','AUTONOMOUS_READY']);
export type ReadinessStage=z.infer<typeof readinessStageSchema>;
const stages=readinessStageSchema.options;
export class ProductionReadiness{
  constructor(readonly db:AppDatabase){}
  current(){return readinessStageSchema.parse(this.db.getSetting('readiness_stage','DEVELOPMENT'));}
  checks(){const sim=this.db.getSetting<{configHash:string;at:string}|null>('full_simulation_evidence',null),pi=this.db.getSetting<{ok:boolean;at:string}|null>('pi_acceptance_evidence',null),broker=this.db.getSetting<{accountId:string;complete:boolean;healthy:boolean;asOf:string}|null>('broker_account_v2',null);
    const statuses=(this.db.raw.prepare('SELECT id,body_json FROM connector_status').all() as Array<{id:string;body_json:string}>).map(s=>({id:s.id,...JSON.parse(s.body_json)}));
    return {simulation:!!sim&&sim.configHash===configurationEvidenceHash(this.db)&&Date.now()-Date.parse(sim.at)<86400000,
      piAcceptance:!!pi?.ok&&Date.now()-Date.parse(pi.at)<86400000,robinhood:statuses.some(s=>s.id==='ROBINHOOD'&&s.state==='READ_ONLY'),
      scopedAccount:!!broker?.complete&&broker.healthy&&broker.accountId===process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID,
      readOnlyReconciliation:this.db.getMode()==='READ_ONLY'&&this.db.getSetting('reconciliation_clear',false)&&!!broker&&Date.now()-Date.parse(broker.asOf)<120000&&this.db.getSetting<string>('broker_verification_mode_v2','SIMULATION')==='READ_ONLY',
      manualPreview:hasVerifiedPreview(this.db),controlledTrade:this.db.getSetting('commissioning_trade_verified',false),preproductionLock:PREPRODUCTION_LIVE_LOCK};
  }
  transition(to:ReadinessStage,actor:string,confirmation:string){const from=this.current();if(confirmation!=='ADVANCE '+to||stages.indexOf(to)!==stages.indexOf(from)+1)throw new Error('Explicit sequential stage confirmation required');const c=this.checks();
    const requirements:Record<ReadinessStage,boolean>={DEVELOPMENT:true,SIMULATION_READY:c.simulation,PI_ACCEPTANCE_READY:c.simulation&&c.piAcceptance,READ_ONLY_PRODUCTION:c.piAcceptance&&c.robinhood&&c.scopedAccount&&c.readOnlyReconciliation,MANUAL_LIVE_READY:Object.values(manualLiveChecks(this.db)).every(Boolean),AUTONOMOUS_READY:false};
    if(!requirements[to])throw new Error('Required acceptance evidence is missing or pre-production lock is active');this.db.raw.transaction(()=>{this.db.setSetting('readiness_stage',to);this.db.raw.prepare('INSERT INTO readiness_transitions VALUES(?,?,?,?,?,?)').run(makeId('stage'),from,to,actor,JSON.stringify(c),nowIso());this.db.audit(actor,'READINESS_STAGE','system',null,{before:from,after:to,evidence:c});})();return this.state();
  }
  state(){return {stage:this.current(),checks:this.checks(),liveLocked:!Object.values(manualLiveChecks(this.db)).every(Boolean),next:stages[stages.indexOf(this.current())+1]??null};}
}
