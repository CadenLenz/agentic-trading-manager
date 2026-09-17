import {z} from 'zod';
import type {AppDatabase} from '../../database/src/database.js';
import {makeId,nowIso} from '../../core/src/utils.js';
export const notificationPreferencesSchema=z.object({inApp:z.boolean(),sms:z.boolean(),events:z.array(z.string().max(100)).max(50),quietStart:z.number().int().min(0).max(23),quietEnd:z.number().int().min(0).max(23),timeZone:z.enum(['America/Los_Angeles','UTC']),criticalOverridesQuiet:z.boolean()}).strict();
export const DEFAULT_NOTIFICATIONS={inApp:true,sms:false,events:['OPTION_OPENED','OPTION_CLOSED','AGGRESSIVE_OPENED','AGGRESSIVE_CLOSED','PARTIAL_FILL','REJECTED','STOP','KILL_SWITCH','RECONCILIATION_FAILURE','BROKER_DISCONNECT','DAILY_REPORT','WEEKLY_REPORT'],quietStart:21,quietEnd:7,timeZone:'America/Los_Angeles' as const,criticalOverridesQuiet:false};
export interface NotificationProvider{send(body:string):Promise<{id:string}>}
export class TwilioSmsProvider implements NotificationProvider{
  async send(body:string){const sid=process.env.TWILIO_ACCOUNT_SID,token=process.env.TWILIO_AUTH_TOKEN,from=process.env.TWILIO_FROM_NUMBER,to=process.env.SMS_TO_NUMBER;
    if(!sid||!token||!from||!to)throw new Error('SMS credentials not configured');
    const response=await fetch('https://api.twilio.com/2010-04-01/Accounts/'+encodeURIComponent(sid)+'/Messages.json',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(sid+':'+token).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({From:from,To:to,Body:body}),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('SMS provider HTTP '+response.status);const r=await response.json() as {sid:string};if(!r.sid)throw new Error('SMS delivery receipt missing');return {id:r.sid};
  }
}
export class NotificationService{
  constructor(readonly db:AppDatabase,readonly provider:NotificationProvider=new TwilioSmsProvider()){}
  preferences(){return notificationPreferencesSchema.parse(this.db.getSetting('notification_preferences',DEFAULT_NOTIFICATIONS));}
  update(input:unknown,actor:string){const previous=this.preferences(),next=notificationPreferencesSchema.parse(input);this.db.setSetting('notification_preferences',next);this.db.audit(actor,'NOTIFICATION_PREFERENCES','notifications',null,{before:previous,after:next});return next;}
  emit(eventKey:string,kind:string,severity:'INFO'|'WARNING'|'CRITICAL',body:Record<string,unknown>){
    const p=this.preferences();if(!p.events.includes(kind)&&severity!=='CRITICAL')return null;
    const existing=this.db.raw.prepare('SELECT id FROM notification_events WHERE event_key=?').get(eventKey) as {id:string}|undefined;if(existing)return existing.id;
    const id=makeId('notification');this.db.raw.transaction(()=>{this.db.raw.prepare('INSERT INTO notification_events VALUES(?,?,?,?,?,?,?)').run(id,eventKey,kind,severity,JSON.stringify(body),null,nowIso());
      if(p.sms&&p.events.includes(kind))this.db.raw.prepare('INSERT INTO notification_deliveries VALUES(?,?,?,?,?,?)').run(makeId('delivery'),id,'SMS',this.db.getMode()==='SIMULATION'?'SUPPRESSED_SIMULATION':'PENDING','',nowIso());
    })();return id;
  }
  quiet(at=new Date()){const p=this.preferences(),hour=Number(new Intl.DateTimeFormat('en-US',{hour:'numeric',hourCycle:'h23',timeZone:p.timeZone}).format(at));return p.quietStart===p.quietEnd?false:p.quietStart<p.quietEnd?hour>=p.quietStart&&hour<p.quietEnd:hour>=p.quietStart||hour<p.quietEnd;}
  async deliver(at=new Date()){
    if(this.db.getMode()==='SIMULATION'||process.env.ENABLE_SMS_DELIVERY!=='true'||!this.preferences().sms)return {sent:0};
    const rows=this.db.raw.prepare("SELECT d.id,n.kind,n.severity,n.body_json FROM notification_deliveries d JOIN notification_events n ON n.id=d.notification_id WHERE d.status='PENDING' ORDER BY n.created_at LIMIT 10").all() as Array<{id:string;kind:string;severity:string;body_json:string}>;let sent=0;
    for(const r of rows){if(this.quiet(at)&&!(r.severity==='CRITICAL'&&this.preferences().criticalOverridesQuiet))continue;
      if(this.db.getMode()==='SIMULATION'||this.db.raw.prepare("UPDATE notification_deliveries SET status='UNKNOWN',updated_at=? WHERE id=? AND status='PENDING'").run(nowIso(),r.id).changes!==1)continue;
      try{const result=await this.provider.send(('ATM '+r.kind+': '+String(JSON.parse(r.body_json).summary??r.severity)+' '+(process.env.PRIVATE_UI_URL??'')).slice(0,500));this.db.raw.prepare("UPDATE notification_deliveries SET status='SENT',detail=?,updated_at=? WHERE id=?").run(result.id,nowIso(),r.id);sent++;}
      catch{this.db.audit('NOTIFICATIONS','SMS_OUTCOME_UNKNOWN','delivery',r.id,{reason:'No automatic resend; provider receipt must be reconciled'});}
    }return {sent};
  }
  list(includeHistory=false){if(!includeHistory&&!this.preferences().inApp)return [];return this.db.raw.prepare('SELECT * FROM notification_events ORDER BY created_at DESC LIMIT 200').all();}
  markRead(id:string){this.db.raw.prepare('UPDATE notification_events SET read_at=? WHERE id=?').run(nowIso(),id);}
}
