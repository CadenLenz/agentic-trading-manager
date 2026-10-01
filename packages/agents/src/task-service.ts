import {z} from 'zod';
import type {AppDatabase} from '../../database/src/database.js';
import type {ProposalService} from '../../trading-v2/src/proposals.js';
import {RiskConfigurationService,configurationEvidenceHash,resolveRisk} from '../../trading-v2/src/configuration.js';
import {sleeveSchema,SLEEVES} from '../../trading-v2/src/model.js';
import {makeId,nowIso,stableHash} from '../../core/src/utils.js';
import {classify,taskInput,taskResponse,taskSettings,defaultSettings,taskType,authority,templateVersion,validateAuthority,type TaskInput} from './task-contract.js';
import {WorkerClient,type WorkerTransport} from './worker-client.js';
import type {WorkerJob} from './worker.js';
import {autonomousAuthorized,revokeAutonomy} from '../../trading-v2/src/autonomy.js';

export interface AppTask extends WorkerJob{actor:string;source:'MANUAL'|'SCHEDULED'|'AUTONOMOUS';type:TaskInput['type'];authority:TaskInput['authority'];strategy:TaskInput['strategy'];message:string;templateVersion:string;appStateVersion:string;settings:TaskInput['settings'];result:unknown;applied:boolean;dispatched:boolean;executionAttempted?:boolean}
export const scheduleInput=z.object({name:z.string().min(1).max(100),message:z.string().min(1).max(12000),type:taskType,authority:authority.exclude(['CONFIGURE_PROPOSAL']),strategy:sleeveSchema.nullable(),intervalMinutes:z.number().int().min(15).max(10080),enabled:z.boolean(),timeoutMs:z.number().int().min(10000).max(600000)}).strict();
export type TaskSchedule=z.infer<typeof scheduleInput>&{id:string;nextRun:string;lastRun:string|null;templateVersion:string;actor:string};
export class CodexTaskService{
  private busy=false;private stopped=false;private timer:ReturnType<typeof setInterval>|null=null;
  runSimulation:(actor:string)=>unknown=()=>{throw new Error('Simulation service unavailable');};
  constructor(readonly db:AppDatabase,readonly proposals:ProposalService,readonly worker:WorkerTransport=new WorkerClient()){
    db.raw.exec('CREATE TABLE IF NOT EXISTS codex_tasks(id TEXT PRIMARY KEY,body_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS codex_schedules(id TEXT PRIMARY KEY,body_json TEXT NOT NULL)');
  }
  settings(){return taskSettings.parse(this.db.getSetting('codex_task_settings',defaultSettings));}
  configure(input:unknown,actor:string){const settings=taskSettings.parse(input);this.db.setSetting('codex_task_settings',settings);this.db.audit(actor,'CODEX_SETTINGS','system',null,settings);return settings;}
  list():AppTask[]{return (this.db.raw.prepare('SELECT body_json FROM codex_tasks ORDER BY rowid DESC LIMIT 500').all() as Array<{body_json:string}>).map(r=>JSON.parse(r.body_json));}
  get(id:string):AppTask{const r=this.db.raw.prepare('SELECT body_json FROM codex_tasks WHERE id=?').get(id) as {body_json:string}|undefined;if(!r)throw new Error('Task not found');return JSON.parse(r.body_json);}
  private save(task:AppTask){this.db.raw.prepare('INSERT INTO codex_tasks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body_json=excluded.body_json').run(task.id,JSON.stringify(task));}
  create(message:string,actor:string,options?:{id?:string;schedule?:TaskSchedule;autonomous?:import('../../trading-v2/src/model.js').Sleeve}){
    const text=z.string().trim().min(1).max(12000).parse(message),id=options?.id??makeId('task'),old=this.db.raw.prepare('SELECT id FROM codex_tasks WHERE id=?').get(id);
    if(old){const task=this.get(id);if(task.message!==text||task.actor!==actor)throw new Error('Duplicate task ID conflict');return task;}
    if(this.list().filter(j=>['QUEUED','RUNNING'].includes(j.status)).length>=100)throw new Error('Task queue full');
    const c=options?.autonomous?{type:'GENERATE_TRADE_PROPOSAL' as const,authority:'TRADE_PROPOSAL' as const,strategy:options.autonomous}:options?.schedule??classify(text),settings=this.settings();if(options?.schedule)settings.timeoutMs=options.schedule.timeoutMs;
    const task:AppTask={id,actor,source:options?.autonomous?'AUTONOMOUS':options?.schedule?'SCHEDULED':'MANUAL',type:c.type,authority:c.authority,strategy:c.strategy,message:text,templateVersion,appStateVersion:configurationEvidenceHash(this.db),settings,result:null,applied:false,dispatched:false,status:'QUEUED',createdAt:nowIso(),startedAt:null,endedAt:null,response:null,error:null,stdout:'',stderr:'',version:null,hash:null,durationMs:null};
    this.db.raw.transaction(()=>{this.save(task);this.db.audit(actor,'CODEX_TASK_CREATED','codex_task',id,{type:task.type,authority:task.authority,source:task.source,templateVersion});})();return task;
  }
  context(task:AppTask){const strategies=task.strategy?[task.strategy]:SLEEVES;const account=this.db.getSetting<Record<string,unknown>|null>('broker_account_v2',null);
    return JSON.stringify({asOf:nowIso(),mode:this.db.getMode(),paused:this.db.getSetting('global_pause',true),stopped:this.db.getSetting('stopped',false),reconciled:this.db.getSetting('reconciliation_clear',false),account:account?{accountId:account.accountId,asOf:account.asOf,netAccountValue:account.netAccountValue,buyingPower:account.buyingPower,healthy:account.healthy}:null,
      strategies:strategies.map(s=>({id:s,enabled:this.db.getStrategy(s)?.enabled,allocation:this.proposals.allocation.state(s),risk:new RiskConfigurationService(this.db).current().config})),
      legacyPositions:this.proposals.ledger.legacyPositions(),positions:this.proposals.ledger.listPositions(task.strategy??undefined).slice(0,50),options:task.strategy==='OPTIONS'?this.db.raw.prepare('SELECT * FROM option_positions WHERE contracts<>0 LIMIT 50').all():[],
      proposals:this.proposals.list().filter(p=>!task.strategy||p.strategy===task.strategy).slice(0,10),
      recentReports:/REPORT/.test(task.type)?this.db.raw.prepare('SELECT * FROM trading_reports ORDER BY created_at DESC LIMIT 3').all():[],
      strategyBehavior:Object.fromEntries(strategies.map(s=>[s,this.db.getSetting('strategy_behavior:'+s,{manageExistingFirst:true})])),
      limitations:'Codex can only create local drafts and structured rules. The deterministic application alone authorizes and executes trades under persisted operator autonomy and fresh risk checks. A trade draft should include research with all required categories and actual observed sources, simulated=false. Never invent evidence.'});
  }
  async status(){try{return {...await this.worker.health(),lastSuccess:this.list().find(j=>j.status==='COMPLETED')?.endedAt??null,lastError:this.list().find(j=>j.error)?.error??null,settings:this.settings()};}catch{return {installed:false,loggedIn:false,usable:false,version:null,compatible:false,robinhood:{configured:false,status:'Unavailable'},active:0,queued:this.list().filter(j=>j.status==='QUEUED').length,lastSuccess:this.list().find(j=>j.status==='COMPLETED')?.endedAt??null,lastError:'Local Codex worker unavailable. Dashboard and safety controls remain available.',settings:this.settings()};}}
  async cancel(id:string,actor:string){const task=this.get(id);if(!['QUEUED','RUNNING'].includes(task.status))return task;task.status='CANCELLED';task.endedAt=nowIso();this.save(task);this.db.audit(actor,'CODEX_TASK_CANCELLED','codex_task',id,{});if(task.dispatched)try{await this.worker.cancel(id);}catch{/* app will never apply cancelled output */}return task;}
  private accept(task:AppTask,job:WorkerJob){if(job.id!==task.id)throw new Error('Worker task identity mismatch');if(this.get(task.id).status==='CANCELLED')return;
    Object.assign(task,job);if(task.status==='COMPLETED'&&!task.applied){
      try{const response=taskResponse.parse(task.response);const input=taskInput.parse({id:task.id,message:task.message,type:task.type,authority:task.authority,strategy:task.strategy,context:'',settings:task.settings});validateAuthority(input,response);
        this.db.raw.transaction(()=>{const a=response.action;
          if(a?.intent==='pause_strategy'){this.db.setStrategyEnabled(a.strategy,false,task.actor,a.reason);task.result={paused:a.strategy};}
          else if(a?.intent==='pause_all'){revokeAutonomy(this.db,'Operator requested global pause');task.result={paused:true};}
          else if(a?.intent==='configure_strategies'){
            if(task.source!=='MANUAL')throw new Error('Scheduled reasoning cannot edit policy');
            if(new Set(a.rules.map(r=>r.strategy)).size!==a.rules.length)throw new Error('Duplicate strategy rules');
            for(const rule of a.rules){const objective=rule.strategy==='SAFE_LONG_TERM'?'LONG_TERM_QUALITY':rule.strategy==='OPTIONS'?'ACTIVE_LEVEL2_OPTIONS':'SWING_MOMENTUM';if(rule.objective!==objective)throw new Error('Strategy objective mismatch');this.db.setSetting('strategy_behavior:'+rule.strategy,rule);const service=new RiskConfigurationService(this.db),current=service.current();current.config.strategies[rule.strategy]={...current.config.strategies[rule.strategy],allowedSymbols:rule.allowedSymbols,perTradeRiskPercent:rule.maxPortfolioRiskPercent,maxPositionPercent:rule.maxPortfolioRiskPercent,...(rule.objective==='LONG_TERM_QUALITY'?{minMarketCap:10000000000,earningsTradingAllowed:true}:{})};service.apply(current.config,current.version,task.actor,'Validated operator strategy instruction: '+rule.reason,'APPLY RISK CONFIGURATION',{instruction:task.message,interpretation:response.message,sessionId:task.id});}
            task.result={rules:a.rules,persisted:true};
          }
          else if(a?.intent==='risk_change_proposal'){
            const service=new RiskConfigurationService(this.db),context={reason:a.reason,instruction:task.message,interpretation:response.message,sessionId:task.id};
            if(this.db.getMode()==='AUTONOMOUS_LIVE'&&task.source==='MANUAL'){const preview=service.previewEdits(a.changes);for(const s of SLEEVES){const risk=resolveRisk(preview.config,s,s==='OPTIONS'?'OPTION':'EQUITY','DEFAULT');if(risk.maxPositionPercent>25||risk.perTradeRiskPercent>25||risk.maxPremiumRiskPercent>25)throw new Error('Autonomous platform risk bound is 25%');}task.result=service.apply(preview.config,preview.expectedVersion,task.actor,a.reason,'APPLY RISK CONFIGURATION',context);}
            else task.result=service.propose(a.changes,task.actor,context);
          }
          else if(a?.intent==='create_trade_proposal'){const p=this.proposals.create(a.proposal,task.actor);if(a.research)this.proposals.research(p.id,a.research,task.actor);task.result=this.proposals.get(p.id);}
          else if(a?.intent==='run_full_simulation')task.result=this.runSimulation(task.actor);
          task.applied=true;task.hash=stableHash(response);this.save(task);this.db.audit(task.actor,'CODEX_TASK_COMPLETED','codex_task',task.id,{hash:task.hash,action:a,result:task.result,authority:task.authority});
        })();
      }catch(error){task.status='FAILED';task.error='Validated action not applied: '+String(error);this.save(task);}
    }else this.save(task);
    if(task.status!=='RUNNING'&&task.status!=='QUEUED'&&task.status!=='COMPLETED')this.db.audit(task.actor,'CODEX_TASK_'+task.status,'codex_task',task.id,{error:task.error});
  }
  async tick(){if(this.busy||this.stopped)return;this.busy=true;try{this.tickSchedules();for(const task of this.list().reverse().filter(j=>['QUEUED','RUNNING'].includes(j.status))){
    try{if(!task.dispatched){const input=taskInput.parse({id:task.id,message:task.message,type:task.type,authority:task.authority,strategy:task.strategy,context:this.context(task),settings:task.settings});task.dispatched=true;task.startedAt=nowIso();this.save(task);this.accept(task,await this.worker.enqueue(input));}else this.accept(task,await this.worker.get(task.id));}
    catch(error){task.status='UNKNOWN';task.error='Worker unavailable or dispatch outcome uncertain; task will not be replayed. '+String(error).slice(0,300);task.endedAt=nowIso();this.save(task);this.db.audit(task.actor,'CODEX_TASK_UNKNOWN','codex_task',task.id,{error:task.error});}
  }
    for(const task of this.list().filter(t=>(t.source==='AUTONOMOUS'||t.authority==='TRADE_PROPOSAL'&&this.db.getMode()==='AUTONOMOUS_LIVE')&&t.status==='COMPLETED'&&t.applied&&!t.executionAttempted)){
      task.executionAttempted=true;this.save(task);
      const id=(task.result as {id?:string}|null)?.id;if(!id||!task.strategy||!autonomousAuthorized(this.db,task.strategy))continue;
      try{const p=this.proposals.get(id);if(p.state!=='RESEARCHED')throw new Error('Current complete sourced research required before autonomous execution');
        await this.proposals.review(id,'AUTONOMOUS_POLICY_ENGINE');
        if(this.proposals.get(id).state==='READY_TO_EXECUTE')await this.proposals.execute(id,'AUTONOMOUS_POLICY_ENGINE','AUTONOMOUS');
        task.result=this.proposals.detail(id);this.save(task);
      }catch(error){task.error='Autonomous pipeline blocked: '+String(error).slice(0,500);this.save(task);this.db.audit('AUTONOMOUS_POLICY_ENGINE','AUTONOMOUS_PIPELINE_BLOCKED','proposal',id,{error:task.error,retry:false});}
    }
  }finally{this.busy=false;}}
  schedules():TaskSchedule[]{return (this.db.raw.prepare('SELECT body_json FROM codex_schedules ORDER BY id').all() as Array<{body_json:string}>).map(r=>JSON.parse(r.body_json));}
  schedule(input:unknown,actor:string,id=makeId('schedule')){const fields=scheduleInput.parse(input);const old=this.schedules().find(s=>s.id===id);const value:TaskSchedule={...fields,id,actor,nextRun:old?.nextRun??new Date(Date.now()+fields.intervalMinutes*60000).toISOString(),lastRun:old?.lastRun??null,templateVersion};this.db.raw.prepare('INSERT INTO codex_schedules VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body_json=excluded.body_json').run(id,JSON.stringify(value));this.db.audit(actor,'CODEX_SCHEDULE_UPDATED','codex_schedule',id,value);return value;}
  tickSchedules(date=new Date()){for(const s of this.schedules()){if(!s.enabled||Date.parse(s.nextRun)>date.getTime())continue;this.db.raw.transaction(()=>{const id='scheduled_'+stableHash({id:s.id,slot:s.nextRun}).slice(0,40);this.create(s.message,s.actor,{id,schedule:s});s.lastRun=date.toISOString();s.nextRun=new Date(date.getTime()+s.intervalMinutes*60000).toISOString();this.db.raw.prepare('UPDATE codex_schedules SET body_json=? WHERE id=?').run(JSON.stringify(s),s.id);})();}}
  start(){this.timer=setInterval(()=>{void this.tick().catch(()=>{/* next tick; no process crash */});},1000);this.timer.unref();}
  async stop(){this.stopped=true;if(this.timer)clearInterval(this.timer);while(this.busy)await new Promise(r=>setTimeout(r,20));}
}
