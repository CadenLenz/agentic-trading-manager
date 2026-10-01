import {officialOrderArguments} from './official-orders.js';
import {autonomousExecutionAuthorized,liveMode} from './autonomy.js';
import type {ExecutableOrder} from './model.js';
import {readFileSync,writeFileSync,existsSync,mkdirSync,chmodSync,renameSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {OAuthClientProvider} from '@modelcontextprotocol/sdk/client/auth.js';
import type {OAuthTokens,OAuthClientInformationMixed,OAuthClientMetadata} from '@modelcontextprotocol/sdk/shared/auth.js';
import {Ajv} from 'ajv';
import {z} from 'zod';
import type {AppDatabase} from '../../database/src/database.js';
import {nowIso} from '../../core/src/utils.js';
import {ConnectionSetupError,robinhoodCallback,robinhoodFailure} from './connection-setup.js';
import {diagnostic,oauthRequestStage,type OAuthStage} from './oauth-diagnostics.js';
import {OpenAICredentialVault} from './credential-vault.js';
import {hasOpenAIModelEvidence,openaiCredentialFingerprint} from './connector-evidence.js';
import {WorkerClient} from '../../agents/src/worker-client.js';

export type ConnectorState='CONNECTED'|'DISCONNECTED'|'ERROR'|'AUTH_EXPIRED'|'READ_ONLY'|'LIVE_CAPABLE';
export interface ConnectorStatus{id:string;state:ConnectorState;configured:boolean;lastSuccess:string|null;lastError:string|null;details:Record<string,unknown>}
const endpoint=new URL('https://agent.robinhood.com/mcp/trading');
// Names come from the currently available official Robinhood catalog. Discovery validates their actual schemas.
export const READ_TOOLS=new Set(['get_accounts','get_portfolio','get_equity_positions','get_option_positions','get_equity_orders','get_option_orders','get_equity_tax_lots','get_equity_quotes','get_option_quotes','get_option_instruments','get_option_chains','get_equity_fundamentals','get_equity_news','get_financials','get_earnings_results','get_earnings_calendar','get_equity_technical_indicators','get_equity_historicals','get_option_historicals','get_equity_tradability','get_realized_pnl','get_pnl_trade_history']);
const PREVIEWS=new Set(['review_equity_order','review_option_order']);
/** Encrypted, server-only OAuth state; not a Codex token export or a recreated brokerage login. */
export class ServerOAuth implements OAuthClientProvider{
  authorizationUrl:string|null=null;stateValue='';actor='';expires=0;private disabled=false;
  private data:{tokens?:OAuthTokens;client?:OAuthClientInformationMixed;verifier?:string;redirectUrl?:string;pending?:{actor:string;state:string;expires:number}}={};
  constructor(readonly path:string,readonly secret:string,readonly redirectUrl:string){
    if(existsSync(path)){const envelope=JSON.parse(readFileSync(path,'utf8')) as {iv:string;tag:string;body:string};const decipher=createDecipheriv('aes-256-gcm',this.key(),Buffer.from(envelope.iv,'hex'));decipher.setAuthTag(Buffer.from(envelope.tag,'hex'));this.data=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.body,'hex')),decipher.final()]).toString());if(this.data.redirectUrl!==redirectUrl)this.data={};if(this.data.pending){this.actor=this.data.pending.actor;this.stateValue=this.data.pending.state;this.expires=this.data.pending.expires;}}
  }
  private key(){return createHash('sha256').update(this.secret+'|robinhood-oauth').digest();}
  disable(){this.disabled=true;this.stateValue='';this.expires=0;}
  private save(){if(this.disabled)throw new ConnectionSetupError('BROKER_DISCONNECTED','This sign-in was reset. Start a new connection.');this.data.redirectUrl=this.redirectUrl;mkdirSync(dirname(this.path),{recursive:true,mode:0o700});const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key(),iv),body=Buffer.concat([cipher.update(JSON.stringify(this.data)),cipher.final()]);const temporary=this.path+'.'+randomBytes(8).toString('hex')+'.tmp';writeFileSync(temporary,JSON.stringify({iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),body:body.toString('hex')}),{mode:0o600});renameSync(temporary,this.path);chmodSync(this.path,0o600);}
  get clientMetadata():OAuthClientMetadata{return {client_name:'Agentic Trading Manager',redirect_uris:[this.redirectUrl],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'};}
  begin(actor:string){this.actor=actor;this.stateValue=randomBytes(24).toString('base64url');this.expires=Date.now()+600000;this.authorizationUrl=null;this.data.pending={actor,state:this.stateValue,expires:this.expires};this.save();}
  consume(){this.stateValue='';this.expires=0;delete this.data.pending;this.save();}
  state(){return this.stateValue;}
  clientInformation(){return this.data.client;}
  saveClientInformation(client:OAuthClientInformationMixed){this.data.client=client;this.save();}
  tokens(){return this.data.tokens;}
  saveTokens(tokens:OAuthTokens){this.data.tokens=tokens;this.save();}
  saveCodeVerifier(verifier:string){this.data.verifier=verifier;this.save();}
  codeVerifier(){if(!this.data.verifier)throw new ConnectionSetupError('BROKER_PKCE_MISSING','The saved Robinhood sign-in challenge is missing. Start a new sign-in.');return this.data.verifier;}
  redirectToAuthorization(url:URL){if(url.protocol!=='https:')throw new Error('Insecure authorization URL rejected');this.authorizationUrl=url.toString();}
  invalidateCredentials(scope:'all'|'client'|'tokens'|'verifier'|'discovery'){if(scope==='all')this.data=this.data.pending?{pending:this.data.pending}:{};if(scope==='client')delete this.data.client;if(scope==='tokens')delete this.data.tokens;if(scope==='verifier')delete this.data.verifier;this.save();}
}
export class OfficialRobinhoodConnection{
  readonly usesWorker=process.env.ROBINHOOD_TRANSPORT==='CODEX_WORKER';
  private readonly worker=new WorkerClient();
  private client:Client|null=null;private transport:StreamableHTTPClientTransport|null=null;private oauth:ServerOAuth|null=null;
  private tools=new Map<string,{inputSchema:Record<string,unknown>;outputSchema:Record<string,unknown>|undefined;description:string|undefined}>();
  private accountValidation:{accountId:string;at:number}|null=null;
  constructor(readonly db:AppDatabase,readonly directory:string,readonly secret:string){const old=this.db.raw.prepare('SELECT body_json FROM connector_status WHERE id=?').get('ROBINHOOD') as {body_json:string}|undefined;if(old){const s=JSON.parse(old.body_json);s.state='DISCONNECTED';s.details={...s.details,readValidated:false,reconnectRequired:true};this.db.raw.prepare('UPDATE connector_status SET body_json=?,updated_at=? WHERE id=?').run(JSON.stringify(s),nowIso(),'ROBINHOOD');}}
  private provider(){const callback=robinhoodCallback();if(!this.oauth){try{this.oauth=new ServerOAuth(join(this.directory,'robinhood-oauth.enc'),this.secret,callback);}catch{throw new ConnectionSetupError('BROKER_CREDENTIAL_STORAGE','Saved Robinhood authorization could not be opened. Check that the Pi session secret and protected credential directory have not changed. Restore the matching secret or have the operator reset only the saved Robinhood authorization, then reconnect.');}}return this.oauth;}
  async connect(actor:string){if(this.usesWorker){this.db.setSetting('worker_broker_disconnected',false);this.db.audit(actor,'WORKER_BROKER_CONNECTED','connector','ROBINHOOD',{credentialExport:false});return this.discover();}const p=this.provider();if(p.expires>Date.now()&&p.actor!==actor)throw new ConnectionSetupError('CONNECTION_IN_PROGRESS','Another operator is connecting Robinhood. Wait up to ten minutes, then retry.');if(!p.tokens())p.invalidateCredentials('client');p.begin(actor);await this.close();
    this.transport=this.createTransport(p);
    this.client=new Client({name:'agentic-trading-manager',version:'2.1.0'},{capabilities:{}});
    // SDK declarations have an exactOptionalPropertyTypes sessionId mismatch; runtime transport is the documented SDK class.
    try{await this.client.connect(this.transport as unknown as Transport,{timeout:15000});p.consume();return await this.discover();}catch(error){if(p.authorizationUrl){this.recordDiagnostic('AUTHORIZATION','BROKER_AWAITING_CALLBACK','DISCONNECTED');this.status('DISCONNECTED',null,{awaitingAuthorization:true});return {authorizationUrl:p.authorizationUrl,state:'DISCONNECTED',requiresUserLogin:true};}this.client=null;const failure=robinhoodFailure(error);this.status('ERROR',failure.message,{code:failure.code});throw failure;}
  }
  private createTransport(p:ServerOAuth){return new StreamableHTTPClientTransport(endpoint,{authProvider:p,fetch:async(input,init)=>{const stage=oauthRequestStage(input,init);try{const response=await fetch(input,init);this.recordDiagnostic(stage,response.ok?'BROKER_HTTP_OK':'BROKER_HTTP_'+response.status,response.ok?'CONNECTING':'ERROR',response.status);return response;}catch{this.recordDiagnostic(stage,'BROKER_NETWORK_FAILURE','ERROR');throw new ConnectionSetupError('BROKER_UNREACHABLE','Robinhood could not be reached. Check connectivity and reconnect.',502);}},reconnectionOptions:{maxRetries:0,maxReconnectionDelay:1000,initialReconnectionDelay:1000,reconnectionDelayGrowFactor:1}});
  }
  recordDiagnostic(stage:OAuthStage,code:string,state:string,httpStatus?:number){const entry=diagnostic(stage,code,robinhoodCallback(),state,httpStatus);this.db.setSetting('robinhood_diagnostic',entry);const history=this.db.getSetting<ReturnType<typeof diagnostic>[]>('robinhood_diagnostics',[]);this.db.setSetting('robinhood_diagnostics',[...history,entry].slice(-40));}
  async callback(actor:string,state:string,code:string){const p=this.provider();if(!state||state!==p.stateValue||p.actor!==actor||p.expires<Date.now()){this.recordDiagnostic('CALLBACK','BROKER_SESSION_EXPIRED','ERROR');throw new ConnectionSetupError('BROKER_SESSION_EXPIRED','This Robinhood sign-in link has expired or was already used. Return to Setup & connections and choose Connect Robinhood again.');}p.consume();this.recordDiagnostic('CALLBACK','BROKER_CALLBACK_VERIFIED','CONNECTING');this.transport??=this.createTransport(p);try{await this.transport.finishAuth(code);const result=await this.connect(actor);if('requiresUserLogin' in result)throw new ConnectionSetupError('BROKER_AUTH_REJECTED','Robinhood did not accept the completed authorization. Reconnect to try again.');return result;}catch(error){const failure=robinhoodFailure(error);this.status('ERROR',failure.message,{code:failure.code});throw failure;}}
  async finishCallback(state:string,code:string){return this.callback(this.provider().actor,state,code);}
  async disconnect(actor:string){if(this.usesWorker)this.db.setSetting('worker_broker_disconnected',true);this.oauth?.disable();this.db.setSetting('global_pause',true);this.db.setSetting('v2_live_activation',false);this.db.setSetting('live_db_confirmation',false);await this.close();rmSync(join(this.directory,'robinhood-oauth.enc'),{force:true});this.oauth=null;this.transport=null;this.tools.clear();this.accountValidation=null;this.db.setSetting('reconciliation_clear',false);this.db.setSetting('global_pause',true);this.db.setSetting('v2_live_activation',false);this.db.setSetting('live_db_confirmation',false);this.db.setSetting('official_mcp_catalog_hash','');this.db.setSetting('manual_preview_evidence',null);this.status('DISCONNECTED',null,{reconnectRequired:true});this.db.audit(actor,'BROKER_AUTHORIZATION_FORGOTTEN','connector','ROBINHOOD',{ordersPlaced:0});return {state:'DISCONNECTED',ordersPlaced:0};}
  async check(actor:string){if(this.usesWorker){if(this.db.getSetting('worker_broker_disconnected',false))throw new ConnectionSetupError('BROKER_DISCONNECTED','The deterministic worker connection was disconnected. Choose Connect Robinhood to reconnect.');if(this.tools.size)return {state:'CONNECTED',placementEnabled:false};return this.discover();}if(this.client)return this.discover();if(!this.provider().tokens())throw new ConnectionSetupError('BROKER_DISCONNECTED','Choose Connect Robinhood to sign in.');return this.connect(actor);}
  async discover(){if(!this.client&&!this.usesWorker)throw new ConnectionSetupError('BROKER_DISCONNECTED','Choose Connect Robinhood first, then check the connection.');this.accountValidation=null;this.recordDiagnostic('CATALOG','BROKER_CATALOG_STARTED','CONNECTING');this.tools.clear();if(this.usesWorker){for(const tool of await this.worker.brokerCatalog())this.tools.set(tool.name,{inputSchema:tool.inputSchema,outputSchema:tool.outputSchema,description:tool.description});}else{let cursor:string|undefined;let pages=0;do{const response=await this.client!.listTools(cursor?{cursor}:{});for(const tool of response.tools)this.tools.set(tool.name,{inputSchema:tool.inputSchema,outputSchema:tool.outputSchema,description:tool.description});cursor=response.nextCursor;if(++pages>20)throw new Error('MCP catalog pagination exceeded');}while(cursor);}
    this.db.setSetting('official_mcp_catalog_hash',createHash('sha256').update(JSON.stringify(this.catalog().map(t=>({name:t.name,inputSchema:t.inputSchema,outputSchema:t.outputSchema})).sort((a,b)=>a.name.localeCompare(b.name)))).digest('hex'));
    const names=[...this.tools.keys()],reads=names.filter(n=>READ_TOOLS.has(n)),previews=names.filter(n=>PREVIEWS.has(n));this.status('CONNECTED',null,{reads,previews,readValidated:false,placementEnabled:false,accountScope:process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID??null});return {state:'CONNECTED',reads,previews,placementEnabled:false};
  }
  catalog(){return [...this.tools].map(([name,schema])=>({name,...schema,allowed:READ_TOOLS.has(name)||PREVIEWS.has(name)}));}
  async call(name:string,args:Record<string,unknown>,previewConfirmed=false){if(!READ_TOOLS.has(name)&&!(PREVIEWS.has(name)&&previewConfirmed))throw new Error('MCP operation is not read-only/confirmed preview; placement disabled in pre-production');
    if(this.usesWorker)await this.check('BROKER_READ');if(!this.client&&!this.usesWorker)throw new Error('Connect Robinhood first');const tool=this.tools.get(name);if(!tool)throw new Error('Official capability not discovered');const validate=new Ajv({strict:false,allErrors:true}).compile(tool.inputSchema);if(!validate(args))throw new Error('Arguments do not match discovered official MCP schema');
    const account=process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID;if(name!=='get_accounts'&&name!=='get_equity_news'&&Object.keys(args).some(k=>/account/i.test(k)&&args[k]!==account))throw new Error('Broker account scope mismatch');
    try{const result=this.usesWorker?await this.worker.brokerCall(name,args):await this.client!.callTool({name,arguments:args},undefined,{timeout:20000});if(result.isError)throw new Error('Official MCP read/preview returned an error');const structured=result.structuredContent;if(tool.outputSchema&&structured&&!new Ajv({strict:false}).compile(tool.outputSchema)(structured))throw new Error('MCP output contract mismatch');const validated=!!this.accountValidation&&this.accountValidation.accountId===account&&Date.now()-this.accountValidation.at<120000;this.status(validated?'READ_ONLY':'CONNECTED',null,{lastTool:name,readValidated:validated,placementEnabled:false,transport:this.usesWorker?'CODEX_WORKER':'DIRECT_OAUTH'});return result;}catch(error){this.accountValidation=null;this.status('ERROR','MCP read/preview failed');this.db.setSetting('reconciliation_clear',false);this.db.setSetting('global_pause',true);throw error;}
  }
  /** Only the proposal executor invokes this; generic connector APIs remain read/preview only. */
  async execute(name:string,args:Record<string,unknown>,proposalId:string){
    if(!this.usesWorker||!['place_equity_order','place_option_order','cancel_equity_order','cancel_option_order'].includes(name))throw new Error('Unsupported broker execution transport');
    const cancelling=name.startsWith('cancel_');
    const row=this.db.raw.prepare('SELECT p.version,p.state,p.approval_json,p.preview_hash,e.order_json,e.broker_order_id FROM proposals p JOIN executions_v2 e ON e.proposal_id=p.id WHERE p.id=?').get(proposalId) as {version:number;state:string;approval_json:string|null;preview_hash:string;order_json:string;broker_order_id:string|null}|undefined;
    if(!row)throw new Error('Execution attribution required');
    if(args.account_number!==process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID)throw new Error('Broker account scope mismatch');
    if(cancelling){if(args.order_id!==row.broker_order_id||!['BROKER_ACCEPTED','PARTIALLY_FILLED'].includes(row.state))throw new Error('Cancel requires an attributed open broker order');}
    else{
      const approval=JSON.parse(row.approval_json??'null') as {version:number;hash:string;expiresAt:string}|null;
      if(!liveMode(this.db.getMode())||!this.db.getSetting('v2_live_activation',false)||!this.db.getSetting('live_db_confirmation',false)||this.db.getSetting('global_pause',true)||this.db.getSetting('stopped',false)||this.db.getSetting('maintenance_mode',false)||!this.db.getSetting('reconciliation_clear',false))throw new Error('LIVE execution gates are closed');
      if(JSON.stringify(args)!==JSON.stringify(officialOrderArguments(JSON.parse(row.order_json) as ExecutableOrder,process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID!,true)))throw new Error('Broker mutation differs from the approved executable order');
      const automatic=autonomousExecutionAuthorized(this.db,proposalId,row.version,row.preview_hash,(JSON.parse(row.order_json) as ExecutableOrder).strategy);
      if(row.state!=='EXECUTION_SENT'||(!automatic&&(!approval||approval.version!==row.version||approval.hash!==row.preview_hash||Date.parse(approval.expiresAt)<=Date.now())))throw new Error('Current execution authorization required');
    }
    await this.check('DETERMINISTIC_EXECUTOR');const tool=this.tools.get(name);
    if(!tool||!new Ajv({strict:false}).compile(tool.inputSchema)(args))throw new Error('Execution arguments do not match the discovered official schema');
    if(!cancelling){
      const current=this.db.raw.prepare('SELECT version,state,approval_json,preview_hash FROM proposals WHERE id=?').get(proposalId) as typeof row;
      const approval=JSON.parse(current?.approval_json??'null') as {version:number;hash:string;expiresAt:string}|null;
      const order=JSON.parse(row.order_json) as ExecutableOrder;
      if(!liveMode(this.db.getMode())||this.db.getSetting('stopped',false)||this.db.getSetting('global_pause',true)||this.db.getSetting('maintenance_mode',false)||!this.db.getSetting('reconciliation_clear',false)||!this.db.getSetting('live_db_confirmation',false)||!this.db.getSetting('v2_live_activation',false)||!this.db.getStrategy(order.strategy)?.enabled)throw new Error('STOP/pause revoked execution before broker submission');
      const automatic=current&&autonomousExecutionAuthorized(this.db,proposalId,current.version,current.preview_hash,order.strategy);
      if(!current||current.state!=='EXECUTION_SENT'||(!automatic&&(!approval||approval.version!==current.version||approval.hash!==current.preview_hash||Date.parse(approval.expiresAt)<=Date.now())))throw new Error('Execution authorization expired before broker submission');
    }
    this.db.audit('EXECUTION_ENGINE','BROKER_MUTATION_SENT','proposal',proposalId,{name,arguments:args,retry:false});
    const result=await this.worker.brokerExecute(name,args);
    if(result.isError||!result.structuredContent||tool.outputSchema&&!new Ajv({strict:false}).compile(tool.outputSchema)(result.structuredContent))throw new Error('Broker mutation outcome unverified; reconcile without retry');
    return result;
  }
  private status(state:ConnectorState,error:string|null,details:Record<string,unknown>={}){const body:ConnectorStatus={id:'ROBINHOOD',state,configured:this.usesWorker?!this.db.getSetting('worker_broker_disconnected',false):!!this.oauth?.tokens(),lastSuccess:['CONNECTED','READ_ONLY','LIVE_CAPABLE'].includes(state)&&!error?nowIso():null,lastError:error,details};this.db.raw.prepare('INSERT INTO connector_status VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body_json=excluded.body_json,updated_at=excluded.updated_at').run('ROBINHOOD',JSON.stringify(body),nowIso());this.db.audit('CONNECTORS','CONNECTOR_STATUS','connector','ROBINHOOD',{state,error});}
  validateAccount(accountId:string){if(accountId!==process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID){this.recordDiagnostic('ACCOUNT_SCOPE','BROKER_ACCOUNT_MISMATCH','ERROR');throw new Error('Wrong scoped account');}this.accountValidation={accountId,at:Date.now()};this.status('READ_ONLY',null,{accountScope:accountId,readValidated:true,placementEnabled:false});}
  async close(){await this.client?.close();this.client=null;}
}
export class ConnectorService{
  readonly robinhood:OfficialRobinhoodConnection;
  private readonly openaiVault:OpenAICredentialVault;
  constructor(readonly db:AppDatabase,directory:string,secret:string){this.robinhood=new OfficialRobinhoodConnection(db,directory,secret);this.openaiVault=new OpenAICredentialVault(join(directory,'openai-credential.enc'),secret);if(process.env.ENABLE_LEGACY_OPENAI_API==='true'&&!process.env.OPENAI_API_KEY){const saved=this.openaiVault.read();if(saved){process.env.OPENAI_API_KEY=saved.openaiKey;process.env.OPENAI_MODEL=process.env.OPENAI_MODEL??saved.openaiModel;}}}
  configureOpenAI(key:string,model:string,actor:string){if(process.env.NODE_ENV==='production'&&!process.env.PRIVATE_UI_URL?.startsWith('https://'))throw new ConnectionSetupError('PRIVATE_HTTPS_REQUIRED','Before saving an API key, set PRIVATE_UI_URL to your Tailscale HTTPS address and restart the app.');this.openaiVault.save({openaiKey:key,openaiModel:model});process.env.OPENAI_API_KEY=key;process.env.OPENAI_MODEL=model;this.db.raw.prepare('DELETE FROM connector_status WHERE id=?').run('OPENAI');this.db.setSetting('pi_acceptance_evidence',null);this.db.audit(actor,'OPENAI_CREDENTIAL_CONFIGURED','connector','OPENAI',{model,credential:'ENCRYPTED_SERVER_ONLY',tested:false});return {configured:true,tested:false,paidCalls:0};}
  list(){const statuses=(this.db.raw.prepare('SELECT body_json FROM connector_status').all() as Array<{body_json:string}>).map(r=>JSON.parse(r.body_json) as ConnectorStatus);return ['OPENAI','ROBINHOOD','SMS','NETWORK'].map(id=>{
    const configured=id==='OPENAI'?!!process.env.OPENAI_API_KEY:id==='SMS'?!!process.env.TWILIO_ACCOUNT_SID&&!!process.env.TWILIO_AUTH_TOKEN&&!!process.env.TWILIO_FROM_NUMBER&&!!process.env.SMS_TO_NUMBER:id==='NETWORK'?(process.env.BIND_HOST??'127.0.0.1')==='127.0.0.1':statuses.find(s=>s.id===id)?.configured??false;
    const previous=statuses.find(s=>s.id===id);if(id==='OPENAI'&&previous?.state==='CONNECTED'&&!hasOpenAIModelEvidence(this.db))return {...previous,state:'DISCONNECTED' as const,configured,details:{...previous.details,retestRequired:true}};
      return previous??{id,state:'DISCONNECTED',configured,lastSuccess:null,lastError:null,details:id==='OPENAI'?{setup:'Server-side OPENAI_API_KEY; no invented ChatGPT login',model:process.env.OPENAI_MODEL??'gpt-5.5'}:id==='NETWORK'?{bind:process.env.BIND_HOST??'127.0.0.1',privateUrl:process.env.PRIVATE_UI_URL??null,expectedProxy:'TAILSCALE_SERVE',funnelAllowed:false}:{setup:'Server-side credentials; untested'}};
  });}
  async testOpenAI(){if(!process.env.OPENAI_API_KEY)throw new ConnectionSetupError('OPENAI_KEY_MISSING','Choose Connect OpenAI and save an API key before checking access.');const model=process.env.OPENAI_MODEL??'gpt-5.5';let state:ConnectorState='ERROR',error:string|null='Model access request failed or timed out';try{const response=await fetch('https://api.openai.com/v1/models/'+encodeURIComponent(model),{headers:{Authorization:'Bearer '+process.env.OPENAI_API_KEY},signal:AbortSignal.timeout(15000)});if(response.ok){const metadata=await response.json() as {id?:string};if(metadata.id===model){state='CONNECTED';error=null;}else error='Model metadata identity mismatch';}else{state=response.status===401?'AUTH_EXPIRED':'ERROR';error='Model access HTTP '+response.status;}}catch{/* Persist generic error without credentials or provider payloads. */}
    const status:ConnectorStatus={id:'OPENAI',state,configured:true,lastSuccess:state==='CONNECTED'?nowIso():null,lastError:error,details:{model,modelAvailable:state==='CONNECTED',agentConnectivity:'No paid Responses call performed',lastSuccessfulAgentCall:this.db.getSetting('openai_last_success',null)}};
    this.db.raw.prepare('INSERT INTO connector_status VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body_json=excluded.body_json,updated_at=excluded.updated_at').run(status.id,JSON.stringify(status),nowIso());this.db.setSetting('openai_verified_fingerprint',state==='CONNECTED'?openaiCredentialFingerprint():null);return status;
  }
}
export const connectorReadSchema=z.object({tool:z.string().min(1),arguments:z.record(z.string(),z.unknown())}).strict();
