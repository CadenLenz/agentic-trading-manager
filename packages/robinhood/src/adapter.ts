import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { BrokerAccountSnapshot, BrokerOrderRequest, BrokerOrderResult, McpCapability } from '../../core/src/types.js';
import type { CodexRunner } from '../../agents/src/codex-runner.js';
const execFileAsync=promisify(execFile);
export interface RobinhoodStatus {configured:boolean;connected:boolean;authenticated:boolean;capabilities:McpCapability[];limitation:string}
/** Compatibility/configuration inspector. Ambient LLM tools are not an authoritative broker adapter. */
export class RobinhoodMcpAdapter {
  constructor(_runner:CodexRunner,_workingDirectory:string,private readonly binary=process.env.CODEX_BIN??'codex'){}
  async discoverCapabilities(_force=false):Promise<RobinhoodStatus>{
    let configured=false;
    try{const {stdout}=await execFileAsync(this.binary,['mcp','list','--json'],{timeout:15000,windowsHide:true,maxBuffer:1000000});const servers=z.array(z.object({name:z.string(),enabled:z.boolean().optional()}).passthrough()).parse(JSON.parse(stdout));configured=servers.some(s=>s.name==='robinhood-trading'&&s.enabled!==false);}catch{ /* Configuration unknown, not authenticated. */ }
    return {configured,connected:false,authenticated:false,capabilities:[],limitation:'V2 requires a deterministic verified official TradingBroker binding. Configured Codex MCP is not proof of authentication, account scope, preview or execution readiness.'};
  }
  async getAccountSnapshot():Promise<BrokerAccountSnapshot>{throw new Error('LLM-normalized broker state is not authoritative in V2. Use ProposalService.reconcile with a verified typed broker binding.');}
  async previewOrder(_order:BrokerOrderRequest):Promise<Record<string,unknown>>{throw new Error('Legacy LLM broker preview disabled; use V2 proposals');}
  async placeOrder(_order:BrokerOrderRequest):Promise<BrokerOrderResult>{throw new Error('Legacy LLM broker placement disabled; use V2 proposals');}
  async cancelOrder(_id:string):Promise<Record<string,unknown>>{throw new Error('Legacy LLM broker cancellation disabled; use V2 proposals');}
}
