import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {Ajv} from 'ajv';
import {BROKER_READ_TOOLS,isolatedConfig,safeCodexEnvironment} from './codex-runner.js';

export const DETERMINISTIC_BROKER_TOOLS=[...BROKER_READ_TOOLS,'get_equity_tradability','get_equity_tax_lots','get_realized_pnl','get_pnl_trade_history','review_equity_order','review_option_order'];
export interface BrokerTool {name:string;inputSchema:Record<string,unknown>;outputSchema?:Record<string,unknown>;description?:string}
export interface BrokerResult {content:Array<{type:string;text?:string}>;structuredContent?:unknown;isError?:boolean|null}
export interface BrokerTransport {catalog():Promise<BrokerTool[]>;call(name:string,args:Record<string,unknown>):Promise<BrokerResult>}

/** Fixed MCP RPCs only. No turn/start, model inference, credential export, or write tools. */
export class CodexMcpTransport implements BrokerTransport {
  private child:ChildProcessWithoutNullStreams|null=null;
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private sequence=0;
  private starting:Promise<void>|null=null;
  private threadId:string|null=null;
  private tools:BrokerTool[]=[];
  constructor(readonly binary=process.env.CODEX_BIN??'codex'){}
  private request(method:string,params:unknown):Promise<unknown>{
    const child=this.child;if(!child)throw new Error('Codex MCP transport unavailable');
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Codex MCP request timed out'));this.close();},30000);this.pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
  }
  private async start(){
    if(this.threadId)return;
    if(this.starting)return this.starting;
    this.starting=this.initialize();
    try{await this.starting;}catch{this.close();throw new Error('Robinhood worker connection unavailable; check Codex worker authentication');}finally{this.starting=null;}
  }
  private async initialize(){
    const args=['--strict-config','app-server',...isolatedConfig({robinhoodReads:false}),'-c','mcp_servers='+JSON.stringify({})];
    // CLI config overrides are TOML, not JSON objects. This replaces the whole server table.
    args[args.length-1]='mcp_servers={robinhood-trading={url="https://agent.robinhood.com/mcp/trading",enabled_tools='+JSON.stringify(DETERMINISTIC_BROKER_TOOLS)+',startup_timeout_sec=20}}';
    const child=spawn(this.binary,args,{env:safeCodexEnvironment(),shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;
    child.stderr.resume();child.stdin.on('error',()=>this.close());
    child.on('error',()=>this.close());child.on('close',()=>{if(this.child===child)this.close();});
    createInterface({input:child.stdout}).on('line',line=>{
      if(line.length>3000000){this.close();return;}
      try{const message=JSON.parse(line) as {id?:number;method?:string;result?:unknown;error?:unknown};
        if(message.method&&message.id!==undefined){child.stdin.write(JSON.stringify({id:message.id,error:{code:-32601,message:'Interactive requests are not supported by the deterministic broker transport'}})+'\n');return;}
        if(message.id===undefined)return;const waiting=this.pending.get(message.id);if(!waiting)return;clearTimeout(waiting.timer);this.pending.delete(message.id);
        if(message.error)waiting.reject(new Error('Codex MCP rejected the fixed RPC request'));else waiting.resolve(message.result);
      }catch{/* Ignore non-protocol diagnostics, never log broker payloads. */}
    });
    await this.request('initialize',{clientInfo:{name:'agentic-deterministic-broker',version:'1.0.0'},capabilities:{experimentalApi:true}});
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    const started=await this.request('thread/start',{ephemeral:true,cwd:process.cwd(),approvalPolicy:'never',sandbox:'read-only',baseInstructions:'Deterministic MCP transport only. No model turns.'}) as {thread:{id:string}};
    const threadId=started.thread.id;
    const all:BrokerTool[]=[];let cursor:string|null=null;
    for(let page=0;page<20;page++){
      const status=await this.request('mcpServerStatus/list',{threadId,limit:100,...(cursor?{cursor}:{})}) as {data:Array<{name:string;runtimeStatus?:string;tools:Record<string,BrokerTool>}>;nextCursor?:string|null};
      const broker=status.data.find(s=>s.name==='robinhood-trading');if(broker){if(broker.runtimeStatus!=='connected')throw new Error('Robinhood MCP is not connected');all.push(...Object.values(broker.tools).filter(t=>DETERMINISTIC_BROKER_TOOLS.includes(t.name)));}
      cursor=status.nextCursor??null;if(!cursor)break;if(page===19)throw new Error('MCP catalog pagination limit');
    }
    if(!all.some(t=>t.name==='get_accounts'))throw new Error('Robinhood account capability unavailable');
    this.tools=all;this.threadId=threadId;
  }
  async catalog(){await this.start();return this.tools;}
  async call(name:string,args:Record<string,unknown>){
    if(!DETERMINISTIC_BROKER_TOOLS.includes(name))throw new Error('Broker tool is not a permitted read or preview');
    await this.start();const tool=this.tools.find(t=>t.name===name);if(!tool||!new Ajv({strict:false}).compile(tool.inputSchema)(args))throw new Error('Broker arguments do not match the discovered schema');
    const result=await this.request('mcpServer/tool/call',{threadId:this.threadId,server:'robinhood-trading',tool:name,arguments:args}) as BrokerResult;
    if(result.isError)throw new Error('Robinhood read or preview failed');
    if(tool.outputSchema&&(!result.structuredContent||!new Ajv({strict:false}).compile(tool.outputSchema)(result.structuredContent)))throw new Error('Broker output does not match the discovered schema');
    return result;
  }
  close(){const child=this.child;this.child=null;this.threadId=null;this.tools=[];for(const waiting of this.pending.values()){clearTimeout(waiting.timer);waiting.reject(new Error('Codex MCP transport closed'));}this.pending.clear();child?.kill('SIGTERM');}
}
