import {request} from 'node:http';
import type {TaskInput} from './task-contract.js';
import type {WorkerJob,probeCodex} from './worker.js';
import type {BrokerTool,BrokerResult} from './codex-mcp.js';
export interface WorkerTransport{health():Promise<Awaited<ReturnType<typeof probeCodex>>&{active:number;queued:number}>;enqueue(task:TaskInput):Promise<WorkerJob>;get(id:string):Promise<WorkerJob>;cancel(id:string):Promise<WorkerJob>}
export class WorkerClient implements WorkerTransport{
  constructor(readonly socket=process.env.CODEX_WORKER_SOCKET??'/run/agentic-codex-worker/worker.sock'){}
  private call<T>(path:string,body?:unknown):Promise<T>{return new Promise((resolve,reject)=>{
    const broker=path.startsWith('/broker/');const r=request({socketPath:this.socket,path,method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},timeout:broker?65000:10000},res=>{let data='';res.on('data',chunk=>{data+=chunk;if(data.length>(broker?3000000:250000)){r.destroy(new Error('Worker response too large'));}});res.on('end',()=>{try{if(res.statusCode!==200)throw new Error('Worker rejected request');resolve(JSON.parse(data) as T);}catch(e){reject(e);}});});r.on('timeout',()=>r.destroy(new Error('Worker IPC timeout')));r.on('error',reject);r.end(body===undefined?undefined:JSON.stringify(body));});}
  brokerCatalog(){return this.call<BrokerTool[]>('/broker/catalog');}
  brokerCall(name:string,args:Record<string,unknown>){return this.call<BrokerResult>('/broker/call',{name,arguments:args});}
  brokerExecute(name:string,args:Record<string,unknown>){return this.call<BrokerResult>('/broker/execute',{name,arguments:args});}
  health(){return this.call<Awaited<ReturnType<typeof probeCodex>>&{active:number;queued:number}>('/health');}
  enqueue(task:TaskInput){return this.call<WorkerJob>('/jobs',task);}
  get(id:string){return this.call<WorkerJob>('/jobs/'+encodeURIComponent(id));}
  cancel(id:string){return this.call<WorkerJob>('/jobs/'+encodeURIComponent(id)+'/cancel',{});}
}
