import {execFile} from 'node:child_process';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import {chmod,unlink} from 'node:fs/promises';
import {z} from 'zod';
import {CodexRunner,safeCodexEnvironment,scrubLog} from './codex-runner.js';
import {taskInput,taskResponse,taskPrompt,validateAuthority,type TaskInput,type TaskResponse} from './task-contract.js';
import {stableHash} from '../../core/src/utils.js';

const exec=(file:string,args:string[],options:{timeout:number;maxBuffer:number;env:NodeJS.ProcessEnv})=>new Promise<{stdout:string;stderr:string}>((resolve,reject)=>{execFile(file,args,options,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr}));});
export type WorkerStatus='QUEUED'|'RUNNING'|'COMPLETED'|'FAILED'|'CANCELLED'|'TIMED_OUT'|'BLOCKED_USAGE_LIMIT'|'UNKNOWN';
export interface WorkerJob{id:string;status:WorkerStatus;createdAt:string;startedAt:string|null;endedAt:string|null;response:TaskResponse|null;error:string|null;stdout:string;stderr:string;version:string|null;hash:string|null;durationMs:number|null}
export function failureCode(error:unknown):WorkerStatus{const text=String(error);return /usage.limit|quota|rate.limit|insufficient_quota|usage cap|credits|exceeded.*limit/i.test(text)?'BLOCKED_USAGE_LIMIT':/timed out/i.test(text)?'TIMED_OUT':/^(?:Error: )?Codex run cancel(?:ed|led)/i.test(text)?'CANCELLED':'FAILED';}
export async function probeCodex(binary=process.env.CODEX_BIN??'codex'){
  // Stay below the IPC deadline even when a locked desktop keyring blocks auth lookup.
  const run=async(args:string[])=>{try{const p=await exec(binary,args,{timeout:5000,maxBuffer:200000,env:safeCodexEnvironment()});return p.stdout+p.stderr;}catch{return '';}};
  const [version,login,mcp,help,mcpConfig]=await Promise.all([run(['--version']),run(['login','status']),run(['mcp','list','--json']),run(['exec','--help']),run(['mcp','get','robinhood-trading','--json'])]);
  let configured=false,auth='Unavailable';try{const rows=JSON.parse(mcp) as Array<{name:string;enabled:boolean;auth_status:string}>;const rh=rows.find(r=>r.name==='robinhood-trading'&&r.enabled);configured=!!rh;auth=rh?.auth_status==='o_auth'?'OAuth configured; session checked on use':rh?'Needs login':'Unavailable';}catch{/* CLI absent */}
  if(!mcp){try{const c=JSON.parse(mcpConfig) as {name:string;enabled:boolean};if(c.name==='robinhood-trading'&&c.enabled){configured=true;auth='Needs credential-store unlock or login; OAuth status unavailable';}}catch{/* Configuration unavailable */}}
  const installed=/codex-cli\s+[\d.]+/.test(version),loggedIn=/Logged in using ChatGPT/i.test(login),compatible=['--strict-config','--ignore-user-config','--ignore-rules','--output-schema','--ephemeral','--model'].every(flag=>help.includes(flag));
  return {installed,version:version.match(/codex-cli\s+[\w.+-]+/)?.[0]??null,loggedIn,compatible,usable:installed&&loggedIn&&compatible,robinhood:{configured,status:auth},checkedAt:new Date().toISOString()};
}
export class CodexWorker {
  private active=new Map<string,AbortController>();
  private timer:ReturnType<typeof setInterval>|null=null;
  private pumping=false;
  private closed=false;
  private capabilities:Awaited<ReturnType<typeof probeCodex>>|null=null;
  constructor(readonly db:Database.Database,readonly directory:string,private runner=new CodexRunner({maxConcurrency:4}),private probe:typeof probeCodex=probeCodex){
    db.pragma('journal_mode=WAL');db.exec('CREATE TABLE IF NOT EXISTS codex_worker_jobs(id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, request_json TEXT NOT NULL, body_json TEXT NOT NULL)');
    for(const j of this.list())if(j.status==='RUNNING'){j.status='UNKNOWN';j.error='Worker restarted during a task. No automatic replay.';j.endedAt=new Date().toISOString();this.save(j);}
  }
  list():WorkerJob[]{return (this.db.prepare('SELECT body_json FROM codex_worker_jobs ORDER BY rowid DESC LIMIT 500').all() as Array<{body_json:string}>).map(r=>JSON.parse(r.body_json));}
  get(id:string):WorkerJob{const row=this.db.prepare('SELECT body_json FROM codex_worker_jobs WHERE id=?').get(id) as {body_json:string}|undefined;if(!row)throw new Error('Task not found');return JSON.parse(row.body_json);}
  private save(job:WorkerJob){this.db.prepare('UPDATE codex_worker_jobs SET body_json=? WHERE id=?').run(JSON.stringify(job),job.id);}
  enqueue(input:unknown){const task=taskInput.parse(input),hash=stableHash(task);const row=this.db.prepare('SELECT request_hash FROM codex_worker_jobs WHERE id=?').get(task.id) as {request_hash:string}|undefined;
    if(row){if(row.request_hash!==hash)throw new Error('Duplicate task ID has different input');return this.get(task.id);}
    if(this.list().filter(j=>['QUEUED','RUNNING'].includes(j.status)).length>=100)throw new Error('Queue is full');
    const job:WorkerJob={id:task.id,status:'QUEUED',createdAt:new Date().toISOString(),startedAt:null,endedAt:null,response:null,error:null,stdout:'',stderr:'',version:null,hash:null,durationMs:null};
    this.db.prepare('INSERT INTO codex_worker_jobs VALUES(?,?,?,?)').run(task.id,hash,JSON.stringify(task),JSON.stringify(job));return job;
  }
  cancel(id:string){const job=this.get(id);if(['QUEUED','RUNNING'].includes(job.status)){job.status='CANCELLED';job.endedAt=new Date().toISOString();job.error='Cancelled by operator';this.save(job);this.active.get(id)?.abort();}return job;}
  async health(){if(!this.capabilities||Date.now()-Date.parse(this.capabilities.checkedAt)>60000)this.capabilities=await this.probe(this.runner.binary);return {...this.capabilities,active:this.active.size,queued:this.list().filter(j=>j.status==='QUEUED').length};}
  start(){this.timer=setInterval(()=>{void this.tick();},500);this.timer.unref();}
  async tick(){if(this.pumping||this.closed)return;this.pumping=true;try{for(const job of this.list().reverse().filter(j=>j.status==='QUEUED')){const row=this.db.prepare('SELECT request_json FROM codex_worker_jobs WHERE id=?').get(job.id) as {request_json:string};const task=taskInput.parse(JSON.parse(row.request_json));if(this.active.size>=task.settings.concurrency)break;const controller=new AbortController();this.active.set(job.id,controller);job.status='RUNNING';job.startedAt=new Date().toISOString();this.save(job);void this.execute(task,job,controller);}}finally{this.pumping=false;}}
  private async execute(task:TaskInput,job:WorkerJob,controller:AbortController){try{
    const health=await this.health();if(!health.usable)throw new Error('CODEX_UNAVAILABLE: ChatGPT login and compatible CLI required');job.version=health.version;
    const result=await this.runner.run({requestId:task.id,agent:'bounded reasoning worker',prompt:taskPrompt(task)+(health.robinhood.status.startsWith('OAuth configured')?'':'\nRobinhood MCP is unavailable for this task. Use supplied stored context only; state this limitation and do not claim fresh broker research.'),schema:z.toJSONSchema(taskResponse,{target:'draft-7'}),validate:value=>taskResponse.parse(value),workingDirectory:this.directory,timeoutMs:task.settings.timeoutMs,signal:controller.signal,model:task.settings.model,effort:task.settings.effort,robinhoodReads:health.robinhood.configured&&health.robinhood.status.startsWith('OAuth configured')});
    validateAuthority(task,result.value);job.response=result.value;job.hash=stableHash(result.value);job.stdout=scrubLog(String(result.metadata.stdout??''));job.stderr=scrubLog(result.stderr);job.durationMs=result.durationMs;job.status='COMPLETED';
  }catch(error){if(error&&typeof error==='object'){if('stdout' in error)job.stdout=scrubLog(String(error.stdout));if('stderr' in error)job.stderr=scrubLog(String(error.stderr));}job.status=failureCode(error);job.error=job.status==='BLOCKED_USAGE_LIMIT'?'Codex usage is currently unavailable. This task was not run.':scrubLog(String(error)).slice(-2000);}
    finally{if(this.get(job.id).status==='CANCELLED'){job.status='CANCELLED';job.response=null;}job.endedAt=new Date().toISOString();this.save(job);this.active.delete(job.id);}
  }
  async stop(){this.closed=true;if(this.timer)clearInterval(this.timer);for(const controller of this.active.values())controller.abort();while(this.active.size)await new Promise(r=>setTimeout(r,20));}
}
export function workerServer(worker:CodexWorker){const server=Fastify({logger:false,bodyLimit:160000});
  server.get('/health',()=>worker.health());server.post('/jobs',async r=>worker.enqueue(r.body));server.get('/jobs/:id',async r=>worker.get(z.object({id:z.string().max(100)}).parse(r.params).id));server.post('/jobs/:id/cancel',async r=>worker.cancel(z.object({id:z.string().max(100)}).parse(r.params).id));return server;
}
export async function listenWorker(server:ReturnType<typeof workerServer>,socket:string){try{await unlink(socket);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await server.listen({path:socket});await chmod(socket,0o660);}
