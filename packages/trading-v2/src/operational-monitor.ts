import type {AppDatabase} from '../../database/src/database.js';
import type {NotificationService} from './notifications.js';
import {nowIso} from '../../core/src/utils.js';
import {revokeAutonomy} from './autonomy.js';
export class OperationalNotificationMonitor{
  constructor(readonly db:AppDatabase,readonly notifications:NotificationService,readonly health:()=>{status:string},readonly broker:()=>{state:string;configured:boolean}){}
  tick(){
    const kills=this.db.raw.prepare("SELECT id,message,strategy_id FROM risk_events WHERE code='SLEEVE_EMERGENCY_KILL' ORDER BY created_at DESC LIMIT 1000").all() as Array<{id:string;message:string;strategy_id:string}>;
    for(const e of kills)this.notifications.emit('kill:'+e.id,'KILL_SWITCH','CRITICAL',{summary:e.message,strategy:e.strategy_id});
    const b=this.broker(),a=this.db.getSetting<{healthy:boolean;complete:boolean;asOf:string}|null>('broker_account_v2',null),actual=this.db.getMode()!=='SIMULATION',stale=actual&&(!a?.healthy||!a.complete||!Number.isFinite(Date.parse(a.asOf))||Date.now()-Date.parse(a.asOf)>120000||Date.parse(a.asOf)>Date.now()+5000);
    if(actual&&(stale||['DISCONNECTED','ERROR','AUTH_EXPIRED'].includes(b.state))){this.db.setSetting('reconciliation_clear',false);revokeAutonomy(this.db,'Broker state stale or disconnected');}
    const state={health:this.health().status,broker:b.state,stale},previous=this.db.getSetting<typeof state|null>('operational_notification_state',null);
    if(state.health!=='healthy'&&state.health!==previous?.health)this.notifications.emit('health:'+nowIso(),'SYSTEM_UNHEALTHY','CRITICAL',{summary:'System health is '+state.health});
    if(actual&&['DISCONNECTED','ERROR','AUTH_EXPIRED'].includes(b.state)&&b.state!==previous?.broker&&(b.configured||previous?.broker==='READ_ONLY'||previous?.broker==='CONNECTED'))this.notifications.emit('broker:'+nowIso(),'BROKER_DISCONNECT','CRITICAL',{summary:'Broker connection is '+b.state+'; new risk is paused'});
    if(stale&&!previous?.stale)this.notifications.emit('stale:'+nowIso(),'RECONCILIATION_FAILURE','CRITICAL',{summary:'Verified broker account facts are missing, stale or unhealthy; new risk paused'});
    this.db.setSetting('operational_notification_state',state);return state;
  }
}
