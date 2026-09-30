import type { AppDatabase } from '../../database/src/database.js';
import { cronMatches } from '../../core/src/scheduler.js';
import { nowIso } from '../../core/src/utils.js';
import type { ProposalService } from './proposals.js';
import type { Sleeve } from './model.js';

export function zonedDate(date:Date,timezone='America/New_York'):string {return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);}
export async function verifyCalendar2026(db:AppDatabase){
  if(new Date().getUTCFullYear()!==2026)throw new Error('The new year requires a reviewed exchange calendar update');
  const source='https://www.nyse.com/trade/hours-calendars';
  const response=await fetch(source,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('Official exchange calendar unavailable');
  const html=await response.text(),rows=[...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(r=>[...r[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c=>c[1]!.replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim()));
  const expected=['Thursday, January 1','Monday, January 19','Monday, February 16','Friday, April 3','Monday, May 25','Friday, June 19','Friday, July 3','Monday, September 7','Thursday, November 26','Friday, December 25'];
  const header=rows.find(r=>r[0]==='Holiday');if(!header||header[1]!=='2026'||!expected.every(d=>rows.some(r=>r[1]?.startsWith(d))))throw new Error('Official calendar changed or could not be parsed; do not assume market hours');
  const text=html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
  if(!text.includes('Friday, November 27, 2026')||!text.includes('Thursday, December 24, 2026'))throw new Error('Early-close calendar unverified');
  const at=nowIso();db.raw.prepare("UPDATE market_sessions SET verified_at=?,source=? WHERE date LIKE '2026-%'").run(at,source);db.audit('CALENDAR','OFFICIAL_CALENDAR_VERIFIED','system',null,{source,at,year:2026});return {source,verifiedAt:at};
}
export function seedCalendar2026(db:AppDatabase):void {
  // Official NYSE snapshot checked 2026-09-16; expires for LIVE and must be reverified by the operator.
  const closed=new Set(['2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25']);
  const early=new Set(['2026-11-27','2026-12-24']);
  const source='https://www.nyse.com/trade/hours-calendars';
  for(let d=new Date('2026-01-01T12:00:00Z');d.getUTCFullYear()===2026;d=new Date(d.getTime()+86400000)){
    const key=d.toISOString().slice(0,10);if(d.getUTCDay()===0||d.getUTCDay()===6||closed.has(key))continue;
    const offset=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',timeZoneName:'shortOffset'}).formatToParts(d).find(p=>p.type==='timeZoneName')!.value;
    const hours=Math.abs(Number(offset.replace('GMT','')));
    const open=new Date(key+'T'+String(9+hours).padStart(2,'0')+':30:00Z').toISOString();
    const close=new Date(key+'T'+String((early.has(key)?13:16)+hours).padStart(2,'0')+':00:00Z').toISOString();
    db.raw.prepare('INSERT OR IGNORE INTO market_sessions VALUES(?,?,?,?,?)').run(key,open,close,source,'2026-09-16T12:00:00.000Z');
  }
}
const DEFAULT_JOBS=[
  ['weekly-allocation','35 6 * * 1','ALLOCATION',null],
  ['safe-weekly-review','35 6 * * 1','REVIEW','SAFE_LONG_TERM'],
  ['aggressive-market-review','35,55 6-12 * * 1-5','REVIEW','AGGRESSIVE_STOCKS'],
  ['options-periodic-review','*/30 7-12 * * 1-5','REVIEW','OPTIONS'],
  ['daily-report','10 13 * * 1-5','DAILY_REPORT',null],
  ['weekly-report','20 13 * * 5','WEEKLY_REPORT',null],
] as const;
export class PersistedTradingScheduler {
  private running=false;
  constructor(private readonly db:AppDatabase,private readonly proposals:ProposalService,private readonly review:(s:Sleeve)=>Promise<void>){
    seedCalendar2026(db);
    for(const [id,cron,kind,strategy] of DEFAULT_JOBS)db.raw.prepare('INSERT OR IGNORE INTO scheduler_jobs_v2(id,cron,timezone,kind,strategy_id,market_day_only,enabled) VALUES(?,?,?,?,?,1,1)').run(id,cron,'America/Los_Angeles',kind,strategy);
  }
  list(){return this.db.raw.prepare('SELECT * FROM scheduler_jobs_v2 ORDER BY id').all();}
  update(id:string,cron:string,enabled:boolean,actor:string){
    if(!/^[-0-9*,/ ]+$/.test(cron)||cron.trim().split(/\s+/).length!==5)throw new Error('Invalid supported cron syntax');
    const changed=this.db.raw.prepare('UPDATE scheduler_jobs_v2 SET cron=?,enabled=? WHERE id=?').run(cron,enabled?1:0,id);
    if(!changed.changes)throw new Error('Schedule not found');this.db.audit(actor,'SCHEDULE_UPDATED','schedule',id,{cron,enabled});
  }
  async tick(date=new Date()){
    if(this.running)return;this.running=true;
    try{
      const dateKey=zonedDate(date),session=this.db.raw.prepare('SELECT opens_at,closes_at FROM market_sessions WHERE date=?').get(dateKey) as {opens_at:string;closes_at:string}|undefined;
      for(const row of this.list() as Array<{id:string;cron:string;timezone:string;kind:string;strategy_id:Sleeve|null;enabled:number;last_slot:string|null}>){
        const slot=date.toISOString().slice(0,16);
        if(!row.enabled||row.last_slot===slot||!session||!cronMatches(row.cron,date,row.timezone))continue;
        if(row.kind==='REVIEW'&&(date.getTime()<Date.parse(session.opens_at)||date.getTime()>=Date.parse(session.closes_at)))continue;
        this.db.raw.prepare('UPDATE scheduler_jobs_v2 SET last_slot=?,last_run_at=?,last_error=NULL WHERE id=?').run(slot,nowIso(),row.id);
        try{
          if(row.kind==='ALLOCATION'){
            await this.proposals.reconcile();const a=this.db.getSetting<{netAccountValue:number}>('broker_account_v2');
            if(!this.db.getSetting('reconciliation_clear',false))throw new Error('Allocation blocked on reconciliation');
            this.proposals.allocation.weekly(a.netAccountValue);
          }else if(row.kind==='REVIEW'&&row.strategy_id)await this.review(row.strategy_id);
          else this.proposals.report(row.kind);
          this.db.audit('SCHEDULER','V2_JOB_COMPLETE','schedule',row.id,{slot});
        }catch(error){const message=error instanceof Error?error.message:'Schedule failed';this.db.raw.prepare('UPDATE scheduler_jobs_v2 SET last_error=? WHERE id=?').run(message,row.id);this.db.audit('SCHEDULER','V2_JOB_FAILED','schedule',row.id,{slot,message});}
      }
    }finally{this.running=false;}
  }
}
