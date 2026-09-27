import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {statfsSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {platform,arch,hostname} from 'node:os';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import Database from 'better-sqlite3';
import type {AppDatabase} from '../../database/src/database.js';
import {makeId,nowIso} from '../../core/src/utils.js';
import {hasVerifiedPreview} from './commissioning.js';
import {WorkerClient} from '../../agents/src/worker-client.js';
const exec=promisify(execFile);
export const manualAcceptanceCheck=z.enum(['Authenticated SSE reconnect','Private tailnet device reachability','Log rotation and reboot recovery']);
export const acceptanceEvidenceSchema=z.object({name:manualAcceptanceCheck,hostFingerprint:z.string().length(64),observedAt:z.string().datetime(),reference:z.string().min(20).max(2000),confirmation:z.literal('I VERIFIED THIS ON THE ACTUAL PI')}).strict();
export interface AcceptanceCheck{name:string;status:'PASS'|'FAIL'|'UNAVAILABLE';required:boolean;detail:string}
export class PiAcceptanceService{
  constructor(readonly db:AppDatabase,readonly directory:string,readonly healthUrl='http://127.0.0.1:4010/health'){}
  fingerprint(){return createHash('sha256').update(JSON.stringify({host:hostname(),platform:platform(),architecture:arch(),directory:this.directory,git:process.env.APP_GIT_SHA??'UNRECORDED',schema:4})).digest('hex');}
  attest(input:unknown,actor:string){const e=acceptanceEvidenceSchema.parse(input);if(platform()!=='linux'||arch()!=='arm64'||e.hostFingerprint!==this.fingerprint()||Date.now()-Date.parse(e.observedAt)>86400000||Date.parse(e.observedAt)>Date.now()+5000)throw new Error('Acceptance evidence must be recent and belong to this actual Pi host');this.db.setSetting('pi_manual_evidence:'+e.name,{...e,actor});this.db.setSetting('pi_acceptance_evidence',null);this.db.audit(actor,'PI_OPERATOR_EVIDENCE','acceptance',e.name,e);return {recorded:true,requiresRerun:true};}
  async run(){const checks:AcceptanceCheck[]=[],add=(name:string,ok:boolean,detail:string,required=true)=>checks.push({name,status:ok?'PASS':'FAIL',required,detail});
    add('Linux ARM64 Pi host',platform()==='linux'&&arch()==='arm64',platform()+'/'+arch());add('Node >=22.13',Number(process.versions.node.split('.')[0])>=22&&(Number(process.versions.node.split('.')[0])>22||Number(process.versions.node.split('.')[1])>=13),process.versions.node);
    mkdirSync(this.directory,{recursive:true,mode:0o700});const disk=statfsSync(this.directory);add('Disk space',disk.bavail*disk.bsize>2*1024**3,Math.floor(disk.bavail*disk.bsize/1024**2)+' MiB free');
    try{this.db.raw.transaction(()=>{this.db.raw.prepare("INSERT INTO settings VALUES('__acceptance_probe','true',?)").run(nowIso());throw new Error('ROLLBACK_PROBE');})();}catch(error){add('Writable DB and rollback',error instanceof Error&&error.message==='ROLLBACK_PROBE'&&!this.db.raw.prepare("SELECT key FROM settings WHERE key='__acceptance_probe'").get(),'Transaction rolled back');}
    const backup=join(this.directory,'acceptance-'+makeId('backup')+'.db');try{await this.db.raw.backup(backup);const restored=new Database(backup,{readonly:true});try{add('Backup restore validation',restored.pragma('integrity_check',{simple:true})==='ok'&&(restored.pragma('foreign_key_check') as unknown[]).length===0,'Retained '+backup);}finally{restored.close();}}catch{add('Backup restore validation',false,'Backup/restore failed');}
    const command=async(name:string,file:string,args:string[],validate:(output:string)=>boolean)=>{try{const r=await exec(file,args,{timeout:8000,maxBuffer:100000});add(name,validate(r.stdout),r.stdout.trim().slice(0,1000));}catch{checks.push({name,status:'UNAVAILABLE',required:true,detail:'Actual host command unavailable or check failed'});}};
    await command('systemd active','systemctl',['is-active','agentic-trading-manager'],o=>o.trim()==='active');await command('Reboot persistence','systemctl',['is-enabled','agentic-trading-manager'],o=>o.trim()==='enabled');
    await command('Tailscale running','tailscale',['status','--json'],o=>{const s=JSON.parse(o);return s.BackendState==='Running';});
    await command('Tailscale HTTPS Serve, no Funnel','tailscale',['serve','status','--json'],o=>{const s=JSON.parse(o);return Object.keys(s.Web??{}).some(k=>k.endsWith(':443'))&&!Object.values(s.AllowFunnel??{}).some(Boolean);});
    await command('Clock synchronized','timedatectl',['show','-p','NTPSynchronized','--value'],o=>o.trim()==='yes');await command('Host timezone','timedatectl',['show','-p','Timezone','--value'],o=>o.trim()==='America/Los_Angeles'||o.trim()==='UTC');
    try{const r=await fetch(this.healthUrl,{signal:AbortSignal.timeout(5000)});add('Local web / health',r.ok,'HTTP '+r.status);}catch{add('Local web / health',false,'Local service unavailable');}
    add('Schema migration 4',(this.db.raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {v:number}).v===4,'Expected schema version 4');
    add('Scheduler persisted',(this.db.raw.prepare('SELECT COUNT(*) AS n FROM scheduler_jobs_v2').get() as {n:number}).n>=5,'DB job definitions');
    const statuses=(this.db.raw.prepare('SELECT body_json FROM connector_status').all() as Array<{body_json:string}>).map(r=>JSON.parse(r.body_json));
    try{const worker=await new WorkerClient().health();add('Codex worker with ChatGPT',worker.usable,'Worker CLI '+worker.version,false);}catch{add('Codex worker with ChatGPT',false,'Worker unavailable; deterministic controls remain independent',false);}add('Robinhood READ access',statuses.some(s=>s.id==='ROBINHOOD'&&s.state==='READ_ONLY'),'Requires official OAuth/discovery/read validation');
    add('READ_ONLY reconciliation',this.db.getMode()==='READ_ONLY'&&this.db.getSetting('reconciliation_clear',false)&&this.db.getSetting<string>('broker_verification_mode_v2','SIMULATION')==='READ_ONLY','Actual account facts required');
    add('Manual preview verified',hasVerifiedPreview(this.db),'Requires fresh account/catalog/configuration/proposal version/hash-bound operator preview evidence');
    for(const name of manualAcceptanceCheck.options){const evidence=this.db.getSetting<z.infer<typeof acceptanceEvidenceSchema>&{actor:string}|null>('pi_manual_evidence:'+name,null),valid=!!evidence&&evidence.hostFingerprint===this.fingerprint()&&Date.now()-Date.parse(evidence.observedAt)<86400000&&Date.parse(evidence.observedAt)<=Date.now()+5000;checks.push({name,status:valid?'PASS':'UNAVAILABLE',required:true,detail:valid?'Operator observation by '+evidence.actor+': '+evidence.reference:'Requires actual authenticated reconnect, second-device or reboot/log observation; submit scoped operator evidence and rerun, never inferred from configuration'});}
    add('SMS configuration (optional)',!this.db.getSetting<{sms:boolean}>('notification_preferences',{sms:false}).sms||(!!process.env.TWILIO_ACCOUNT_SID&&!!process.env.TWILIO_AUTH_TOKEN&&!!process.env.TWILIO_FROM_NUMBER&&!!process.env.SMS_TO_NUMBER),'No SMS sent',false);
    const result={id:makeId('acceptance'),kind:'PI_ACCEPTANCE',hostFingerprint:this.fingerprint(),ok:checks.every(c=>!c.required||c.status==='PASS'),checks,at:nowIso(),tradesPlaced:0};
    this.db.raw.prepare('INSERT INTO acceptance_runs VALUES(?,?,?,?)').run(result.id,result.kind,JSON.stringify(result),result.at);this.db.setSetting('pi_acceptance_evidence',{ok:result.ok,at:result.at});return result;
  }
}
