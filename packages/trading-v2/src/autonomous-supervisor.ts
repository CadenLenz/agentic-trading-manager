import {z} from 'zod';
import type {AppDatabase} from '../../database/src/database.js';
import {stableHash} from '../../core/src/utils.js';
import {SLEEVES,type Sleeve} from './model.js';

// Monitoring is deterministic. Only createReasoning may enqueue a Codex task;
// this class deliberately has no broker execution capability.
export const supervisorConfigSchema=z.object({
  enabled:z.boolean(),reviewMinutes:z.number().int().min(5).max(10080),
  cooldownMinutes:z.number().int().min(2).max(1440),
  monitorSeconds:z.number().int().min(15).max(3600),
  activeOrderPollSeconds:z.number().int().min(15).max(300),
  materialMovePercent:z.number().positive().max(100),
  nearExpiryDays:z.number().int().min(0).max(30),
}).strict().refine(c=>c.cooldownMinutes<=c.reviewMinutes,{message:'Cooldown cannot exceed scheduled review frequency'});
export type SupervisorConfig=z.infer<typeof supervisorConfigSchema>;
export const DEFAULT_SUPERVISOR_CONFIG:Record<Sleeve,SupervisorConfig>={
  SAFE_LONG_TERM:{enabled:true,reviewMinutes:10080,cooldownMinutes:60,monitorSeconds:300,activeOrderPollSeconds:30,materialMovePercent:5,nearExpiryDays:0},
  AGGRESSIVE_STOCKS:{enabled:true,reviewMinutes:60,cooldownMinutes:10,monitorSeconds:120,activeOrderPollSeconds:30,materialMovePercent:3,nearExpiryDays:0},
  OPTIONS:{enabled:true,reviewMinutes:20,cooldownMinutes:3,monitorSeconds:60,activeOrderPollSeconds:15,materialMovePercent:10,nearExpiryDays:3},
};
export interface MonitoredPosition {
  id:string;quantity:number;price:number;underlyingPrice?:number;expiresAt?:string;
  spreadPercent?:number;delta?:number;iv?:number;
}
export interface MonitoredOrder {id:string;status:string;filledQuantity:number}
export interface MonitoredSleeve {
  enabled:boolean;autonomous:boolean;killed:boolean;positions:MonitoredPosition[];
  orders:MonitoredOrder[];materialEvents?:string[];
}
export interface SupervisorSnapshot {
  mode:string;paused:boolean;stopped:boolean;reconciled:boolean;brokerHealthy:boolean;
  accountAsOf:string|null;
  market:{open:boolean;verified:boolean;date:string;closesAt:string|null;nextOpen:string|null;lastSessionOfWeek?:boolean};
  sleeves:Record<Sleeve,MonitoredSleeve>;
}
export type SupervisorTaskStatus='QUEUED'|'RUNNING'|'COMPLETED'|'FAILED'|'CANCELLED'|'TIMED_OUT'|'UNKNOWN';
export interface SupervisorCallbacks {
  snapshot:()=>SupervisorSnapshot|Promise<SupervisorSnapshot>;
  reconcile:()=>Promise<void>;
  workerAvailable:()=>Promise<boolean>;
  createReasoning:(request:{id:string;sleeve:Sleeve;message:string;reason:string;contextHash:string})=>Promise<{id:string}>;
  taskStatus:(id:string)=>SupervisorTaskStatus|Promise<SupervisorTaskStatus>;
  report:(request:{kind:'EVENT'|'DAILY'|'WEEKLY';sleeve:Sleeve|null;reason:string;contextHash:string})=>void|Promise<void>;
  onFault?:(reason:string)=>void|Promise<void>;
}
export interface SupervisorSleeveState {
  status:'AUTONOMOUS'|'PAUSED'|'BLOCKED'|'REASONING'|'MARKET_CLOSED';reason:string;
  nextAnalysisAt:string|null;lastAnalysisAt:string|null;activeTaskId:string|null;
  lastTaskStatus:SupervisorTaskStatus|null;lastContextHash:string|null;
  lastPositions:MonitoredPosition[];lastOrders:MonitoredOrder[];lastEvents:string[];
  lastOpeningDate:string|null;lastClosingDate:string|null;lastEventReportHash:string|null;
}
interface SupervisorState {
  version:1;lastMonitorAt:string|null;lastError:string|null;lastDailyReport:string|null;
  lastWeeklyReport:string|null;sleeves:Record<Sleeve,SupervisorSleeveState>;
}
const emptySleeve=():SupervisorSleeveState=>({status:'PAUSED',reason:'Autonomy is off',nextAnalysisAt:null,lastAnalysisAt:null,activeTaskId:null,lastTaskStatus:null,lastContextHash:null,lastPositions:[],lastOrders:[],lastEvents:[],lastOpeningDate:null,lastClosingDate:null,lastEventReportHash:null});
const terminalOrder=(status:string)=>['FILLED','CANCELLED','CANCELED','REJECTED','EXPIRED','CLOSED'].includes(status.toUpperCase());
const future=(at:number,ms:number)=>new Date(at+ms).toISOString();
const changedPercent=(a:number,b:number)=>a>0&&Number.isFinite(a)&&Number.isFinite(b)?Math.abs(b-a)/a*100:0;
const sorted=<T extends {id:string}>(rows:T[])=>[...rows].sort((a,b)=>a.id.localeCompare(b.id));

export class AutonomousSupervisor {
  private busy=false;
  private timer:ReturnType<typeof setInterval>|null=null;
  constructor(private readonly db:AppDatabase,private readonly callbacks:SupervisorCallbacks){}
  config():Record<Sleeve,SupervisorConfig>{
    const saved=this.db.getSetting<Partial<Record<Sleeve,SupervisorConfig>>>('autonomous_supervisor_config_v1',{});
    return Object.fromEntries(SLEEVES.map(s=>[s,supervisorConfigSchema.parse(saved[s]??DEFAULT_SUPERVISOR_CONFIG[s])])) as Record<Sleeve,SupervisorConfig>;
  }
  configure(sleeve:Sleeve,input:unknown,actor:string){
    if(!SLEEVES.includes(sleeve))throw new Error('Unknown sleeve');
    const config=this.config();config[sleeve]=supervisorConfigSchema.parse(input);
    this.db.setSetting('autonomous_supervisor_config_v1',config);
    this.db.audit(actor,'AUTONOMOUS_SCHEDULE_UPDATED','strategy',sleeve,config[sleeve]);return config[sleeve];
  }
  state():SupervisorState{return this.db.getSetting<SupervisorState>('autonomous_supervisor_state_v1',{version:1,lastMonitorAt:null,lastError:null,lastDailyReport:null,lastWeeklyReport:null,sleeves:{SAFE_LONG_TERM:emptySleeve(),AGGRESSIVE_STOCKS:emptySleeve(),OPTIONS:emptySleeve()}});}
  status(){return {config:this.config(),...this.state()};}
  private save(state:SupervisorState){this.db.setSetting('autonomous_supervisor_state_v1',state);}
  private blockReason(snapshot:SupervisorSnapshot,sleeve:Sleeve,config:SupervisorConfig,at:number):string|null {
    const s=snapshot.sleeves[sleeve];
    if(snapshot.stopped||this.db.getSetting('stopped',false))return 'GLOBAL STOP';
    if(snapshot.paused||this.db.getSetting('global_pause',true))return 'Global pause';
    if(snapshot.mode!=='AUTONOMOUS_LIVE')return 'Autonomy is off';
    if(!config.enabled||!s.enabled||!s.autonomous)return 'Sleeve autonomy is paused';
    if(s.killed)return 'Sleeve kill switch';
    if(!snapshot.reconciled||!snapshot.brokerHealthy)return 'Fresh broker reconciliation required';
    const age=at-Date.parse(snapshot.accountAsOf??'');
    if(!Number.isFinite(age)||age< -5000||age>90000)return 'Broker snapshot is stale';
    if(!snapshot.market.verified)return 'Verified market calendar required';
    return null;
  }
  private reason(sleeve:Sleeve,current:MonitoredSleeve,old:SupervisorSleeveState,config:SupervisorConfig,snapshot:SupervisorSnapshot,at:number):string|null {
    if(!old.lastAnalysisAt)return 'Initial strategy review; manage existing positions first';
    const positions=sorted(current.positions),prior=sorted(old.lastPositions);
    if(stableHash(positions.map(p=>[p.id,p.quantity]))!==stableHash(prior.map(p=>[p.id,p.quantity])))return 'Position exposure changed';
    if(stableHash(sorted(current.orders))!==stableHash(sorted(old.lastOrders)))return 'Broker order or fill state changed';
    if((current.materialEvents??[]).some(event=>!old.lastEvents.includes(event)))return 'Material risk, thesis, news or catalyst event';
    for(const position of positions){
      const previous=prior.find(p=>p.id===position.id);if(!previous)continue;
      if(changedPercent(previous.price,position.price)>=config.materialMovePercent)return 'Material position price movement';
      if(previous.underlyingPrice!==undefined&&position.underlyingPrice!==undefined&&changedPercent(previous.underlyingPrice,position.underlyingPrice)>=Math.min(config.materialMovePercent,2))return 'Material underlying movement';
      if(position.spreadPercent!==undefined&&previous.spreadPercent!==undefined&&Math.abs(position.spreadPercent-previous.spreadPercent)>=3)return 'Option liquidity changed';
      if(position.iv!==undefined&&previous.iv!==undefined&&Math.abs(position.iv-previous.iv)>=0.1)return 'Option implied volatility changed';
      if(position.delta!==undefined&&previous.delta!==undefined&&Math.abs(position.delta-previous.delta)>=0.15)return 'Option delta changed';
    }
    if(sleeve!=='SAFE_LONG_TERM'&&old.lastOpeningDate!==snapshot.market.date)return 'Opening market review';
    const close=Date.parse(snapshot.market.closesAt??'');
    if(sleeve!=='SAFE_LONG_TERM'&&close-at<=30*60000&&close>at&&old.lastClosingDate!==snapshot.market.date)return 'End of session position review';
    const nearExpiry=positions.some(p=>p.expiresAt&&Date.parse(p.expiresAt)-at<=config.nearExpiryDays*86400000);
    const interval=nearExpiry||current.orders.some(o=>!terminalOrder(o.status))?Math.max(config.cooldownMinutes,Math.min(config.reviewMinutes,10)):config.reviewMinutes;
    if(at-Date.parse(old.lastAnalysisAt)>=interval*60000)return nearExpiry?'Approaching option expiry review':'Scheduled market review';
    return null;
  }
  private async reports(snapshot:SupervisorSnapshot,state:SupervisorState,at:number){
    const close=Date.parse(snapshot.market.closesAt??'');
    if(!snapshot.market.verified||!Number.isFinite(close)||at<close+5*60000)return;
    const date=snapshot.market.date;
    if(state.lastDailyReport!==date){
      // Claim before side effects: crashes never generate duplicate reports.
      state.lastDailyReport=date;this.save(state);
      for(const sleeve of ['AGGRESSIVE_STOCKS','OPTIONS',null] as const)await this.callbacks.report({kind:'DAILY',sleeve,reason:'Market session recap',contextHash:stableHash({date,sleeve})});
    }
    if(snapshot.market.lastSessionOfWeek&&state.lastWeeklyReport!==date){
      state.lastWeeklyReport=date;this.save(state);
      for(const sleeve of [...SLEEVES,null])await this.callbacks.report({kind:'WEEKLY',sleeve,reason:'Weekly strategy and account review',contextHash:stableHash({date,sleeve,weekly:true})});
    }
  }
  async tick(date=new Date()):Promise<void>{
    if(this.busy)return;this.busy=true;
    const at=date.getTime(),state=this.state();
    try{
      const config=this.config();let snapshot=await this.callbacks.snapshot();
      // Direct order polling also runs while paused/stopped: observing fills never
      // authorizes a new order and must not depend on Codex availability.
      const active=SLEEVES.filter(s=>snapshot.sleeves[s].orders.some(o=>!terminalOrder(o.status)));
      const monitor=active.length?Math.min(...active.map(s=>config[s].activeOrderPollSeconds)):
        snapshot.market.open?Math.min(...SLEEVES.filter(s=>snapshot.sleeves[s].enabled).map(s=>config[s].monitorSeconds),60):300;
      if(!state.lastMonitorAt||at-Date.parse(state.lastMonitorAt)>=monitor*1000){
        state.lastMonitorAt=date.toISOString();this.save(state);
        await this.callbacks.reconcile();snapshot=await this.callbacks.snapshot();
      }
      await this.reports(snapshot,state,at);
      for(const sleeve of SLEEVES){
        const old=state.sleeves[sleeve],current=snapshot.sleeves[sleeve];
        if(old.activeTaskId){
          const status=await this.callbacks.taskStatus(old.activeTaskId);old.lastTaskStatus=status;
          if(!['QUEUED','RUNNING'].includes(status))old.activeTaskId=null;
        }
        if(sleeve==='OPTIONS'){
          const eventHash=stableHash({positions:sorted(current.positions).map(p=>[p.id,p.quantity]),orders:sorted(current.orders)});
          if(old.lastEventReportHash!==eventHash){
            const wasKnown=old.lastEventReportHash!==null;old.lastEventReportHash=eventHash;this.save(state);
            if(wasKnown)await this.callbacks.report({kind:'EVENT',sleeve,reason:'Option exposure, order or fill changed',contextHash:eventHash});
          }
        }
        const blocked=this.blockReason(snapshot,sleeve,config[sleeve],at);
        old.reason=blocked??(snapshot.market.open?'Monitoring current exposure':'Outside market session');
        old.status=blocked?(blocked.includes('pause')||blocked==='Autonomy is off'?'PAUSED':'BLOCKED'):snapshot.market.open?'AUTONOMOUS':'MARKET_CLOSED';
        if(old.activeTaskId&&!blocked){old.status='REASONING';old.reason='Codex analysis in progress';}
        old.nextAnalysisAt=snapshot.market.open?(old.lastAnalysisAt?future(Date.parse(old.lastAnalysisAt),config[sleeve].reviewMinutes*60000):date.toISOString()):snapshot.market.nextOpen;
      }
      this.save(state);
      if(SLEEVES.some(s=>state.sleeves[s].activeTaskId))return;
      // Options have priority, but cooldowns and persisted due times ensure that
      // a busy options sleeve cannot occupy every reasoning dispatch slot.
      for(const sleeve of [...SLEEVES].reverse()){
        const old=state.sleeves[sleeve],c=config[sleeve];
        if(this.blockReason(snapshot,sleeve,c,at)||!snapshot.market.open)continue;
        if(old.lastAnalysisAt&&at-Date.parse(old.lastAnalysisAt)<c.cooldownMinutes*60000)continue;
        const reason=this.reason(sleeve,snapshot.sleeves[sleeve],old,c,snapshot,at);if(!reason)continue;
        if(!await this.callbacks.workerAvailable()){
          for(const s of SLEEVES)if(state.sleeves[s].status==='AUTONOMOUS'){state.sleeves[s].status='BLOCKED';state.sleeves[s].reason='Codex unavailable; deterministic monitoring continues';}
          return;
        }
        // Re-read STOP, pause, sleeve and market gates after the asynchronous
        // worker check. An operator can stop the app while health is in flight.
        snapshot=await this.callbacks.snapshot();
        if(this.blockReason(snapshot,sleeve,c,date.getTime())||!snapshot.market.open)continue;
        const current=snapshot.sleeves[sleeve],contextHash=stableHash({sleeve,positions:sorted(current.positions),orders:sorted(current.orders),events:[...(current.materialEvents??[])].sort()});
        const id='autonomous_'+stableHash({sleeve,contextHash,at:date.toISOString()}).slice(0,40);
        old.lastAnalysisAt=date.toISOString();old.lastContextHash=contextHash;old.lastPositions=current.positions;old.lastOrders=current.orders;old.lastEvents=current.materialEvents??[];
        old.activeTaskId=id;old.lastTaskStatus='UNKNOWN';old.lastOpeningDate=snapshot.market.date;
        if(reason==='End of session position review')old.lastClosingDate=snapshot.market.date;
        old.nextAnalysisAt=future(at,c.reviewMinutes*60000);old.status='REASONING';old.reason=reason;
        this.save(state); // Claim first. An ambiguous enqueue is never replayed.
        try{
          const task=await this.callbacks.createReasoning({id,sleeve,reason,contextHash,message:`Review ${sleeve}. Trigger: ${reason}. Manage and evaluate existing positions and active orders before considering any new exposure. Read current scoped broker facts and current source evidence. Honor the persisted strategy and all deterministic risk limits. Produce a supported structured proposal with required research only when justified; otherwise report HOLD with a reason. Never call broker placement or cancellation yourself. The deterministic application alone may execute qualifying proposals under the operator's active autonomy authorization.`});
          if(task.id!==id)throw new Error('Autonomous task identity mismatch');
          old.lastTaskStatus='QUEUED';this.db.audit('AUTONOMOUS_SUPERVISOR','AUTONOMOUS_ANALYSIS_QUEUED','strategy',sleeve,{id,reason,contextHash});
        }catch(error){old.lastTaskStatus='UNKNOWN';old.status='BLOCKED';old.reason='Task dispatch uncertain; not replayed';state.lastError=String(error).slice(0,500);return;}
        break;
      }
      state.lastError=null;
    }catch(error){
      const reason='Autonomous monitoring failed: '+String(error).slice(0,400);state.lastError=reason;
      this.db.setSetting('global_pause',true);
      for(const sleeve of SLEEVES){state.sleeves[sleeve].status='BLOCKED';state.sleeves[sleeve].reason=reason;}
      this.db.audit('AUTONOMOUS_SUPERVISOR','AUTONOMOUS_MONITOR_FAILED','system',null,{reason});
      await this.callbacks.onFault?.(reason);
    }finally{this.save(state);this.busy=false;}
  }
  start(){if(this.timer)return;this.timer=setInterval(()=>{void this.tick().catch(()=>{/* failure is persisted; STOP is independent */});},15000);this.timer.unref();}
  async stop(){if(this.timer)clearInterval(this.timer);this.timer=null;while(this.busy)await new Promise(resolve=>setTimeout(resolve,20));}
}
