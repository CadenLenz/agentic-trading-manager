import {mkdtempSync,readFileSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {ServerOAuth,OfficialRobinhoodConnection} from '../packages/trading-v2/src/connectors.js';
import {diagnostic,oauthRequestStage} from '../packages/trading-v2/src/oauth-diagnostics.js';
import {openDatabase} from '../packages/database/src/database.js';

const dirs:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function vault(){const dir=mkdtempSync(join(tmpdir(),'oauth-recovery-'));dirs.push(dir);return {dir,path:join(dir,'robinhood-oauth.enc'),secret:'synthetic-test-secret',callback:'https://pi.example.ts.net/api/v2/connections/robinhood/callback'};}
describe('OAuth restart and replay protection',()=>{
  it('forgets a corrupted local credential file without reading it and revokes application LIVE approval',async()=>{
    const v=vault(),db=openDatabase(':memory:');writeFileSync(v.path,'corrupted envelope');db.setSetting('v2_live_activation',true);db.setSetting('live_db_confirmation',true);db.setSetting('reconciliation_clear',true);
    try{const connection=new OfficialRobinhoodConnection(db,v.dir,v.secret);await connection.disconnect('operator');expect(existsSync(v.path)).toBe(false);expect(db.getSetting('global_pause',false)).toBe(true);expect(db.getSetting('v2_live_activation',true)).toBe(false);expect(db.getSetting('live_db_confirmation',true)).toBe(false);expect(db.getSetting('reconciliation_clear',true)).toBe(false);}finally{db.close();}
  });
  it('completes SDK discovery, registration, PKCE callback after restart and catalog discovery without real provider calls',async()=>{
    const v=vault();vi.stubEnv('PRIVATE_UI_URL','https://pi.example.ts.net');vi.stubEnv('WEB_ORIGIN','https://pi.example.ts.net');
    const db=openDatabase(':memory:');const tokenRequests:URLSearchParams[]=[];let acceptedToken='synthetic-access';
    new ServerOAuth(v.path,v.secret,v.callback).saveClientInformation({client_id:'obsolete-registration'});
    const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
    const network=vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
      const url=new URL(input instanceof Request?input.url:String(input));
      if(url.pathname.includes('oauth-protected-resource'))return json({resource:'https://agent.robinhood.com/mcp/trading',authorization_servers:['https://agent.robinhood.com/mcp/trading'],scopes_supported:['internal']});
      if(url.pathname.includes('oauth-authorization-server'))return json({issuer:'https://agent.robinhood.com/mcp/trading',authorization_endpoint:'https://robinhood.com/oauth',token_endpoint:'https://api.robinhood.com/oauth2/token/',registration_endpoint:'https://agent.robinhood.com/oauth/trading/register',response_types_supported:['code'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']});
      if(url.pathname==='/oauth/trading/register'){const body=JSON.parse(String(init?.body));expect(body.redirect_uris).toEqual([v.callback]);expect(body.scope).toBe('internal');return json({...body,client_id:'synthetic-client'});}
      if(url.pathname==='/oauth2/token/'){const body=new URLSearchParams(String(init?.body));tokenRequests.push(body);if(body.get('grant_type')==='refresh_token'){expect(body.get('refresh_token')).toBe('synthetic-refresh');return json({access_token:acceptedToken,token_type:'Bearer',expires_in:3600});}expect(body.get('redirect_uri')).toBe(v.callback);expect(body.get('code_verifier')).toBeTruthy();return json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',token_type:'Bearer',expires_in:3600});}
      if(url.href!=='https://agent.robinhood.com/mcp/trading')throw new Error('Unexpected test destination');
      if(new Headers(init?.headers).get('authorization')!=='Bearer '+acceptedToken)return new Response('',{status:401,headers:{'WWW-Authenticate':'Bearer resource_metadata="https://agent.robinhood.com/.well-known/oauth-protected-resource/mcp/trading"'}});
      if(init?.method==='DELETE')return new Response(null,{status:200});
      const message=JSON.parse(String(init?.body));if(message.method==='notifications/initialized')return new Response(null,{status:202});
      if(message.method==='initialize')return json({jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'mock-official-mcp',version:'1'}}});
      if(message.method==='tools/list')return json({jsonrpc:'2.0',id:message.id,result:{tools:[{name:'get_accounts',inputSchema:{type:'object'}}]}});
      throw new Error('Unexpected test RPC; mutations are forbidden');
    });vi.stubGlobal('fetch',network);
    const first=new OfficialRobinhoodConnection(db,v.dir,v.secret);let recovered:OfficialRobinhoodConnection|undefined;
    try{
      const result=await first.connect('operator');expect('authorizationUrl' in result).toBe(true);if(!('authorizationUrl' in result))throw new Error('Missing redirect');
      const url=new URL(result.authorizationUrl);expect(url.searchParams.get('client_id')).toBe('synthetic-client');expect(url.searchParams.get('scope')).toBe('internal');expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      recovered=new OfficialRobinhoodConnection(db,v.dir,v.secret);expect(await recovered.finishCallback(url.searchParams.get('state')!,'synthetic-code')).toMatchObject({state:'CONNECTED'});
      expect(tokenRequests).toHaveLength(1);await expect(recovered.finishCallback(url.searchParams.get('state')!,'synthetic-code')).rejects.toThrow('expired');expect(tokenRequests).toHaveLength(1);
      await recovered.close();acceptedToken='synthetic-refreshed-access';recovered=new OfficialRobinhoodConnection(db,v.dir,v.secret);expect(await recovered.check('operator')).toMatchObject({state:'CONNECTED'});expect(tokenRequests).toHaveLength(2);expect(new ServerOAuth(v.path,v.secret,v.callback).tokens()?.refresh_token).toBe('synthetic-refresh');
      const diagnostics=JSON.stringify(db.getSetting('robinhood_diagnostics',[]));for(const secret of ['synthetic-code','synthetic-access','synthetic-refresh',url.searchParams.get('state')!])expect(diagnostics).not.toContain(secret);
    }finally{await recovered?.close();await first.close();db.close();}
  });
  it('restores encrypted pending PKCE state and consumes it durably before token exchange',()=>{
    const v=vault(),p=new ServerOAuth(v.path,v.secret,v.callback);p.begin('operator');p.saveCodeVerifier('synthetic-verifier');const state=p.state();
    const saved=readFileSync(v.path,'utf8');expect(saved).not.toContain(state);expect(saved).not.toContain('synthetic-verifier');expect(saved).not.toContain('operator');
    const recovered=new ServerOAuth(v.path,v.secret,v.callback);expect(recovered.state()).toBe(state);expect(recovered.actor).toBe('operator');expect(recovered.codeVerifier()).toBe('synthetic-verifier');expect(recovered.expires).toBeGreaterThan(Date.now());
    recovered.consume();expect(new ServerOAuth(v.path,v.secret,v.callback).state()).toBe('');recovered.disable();expect(()=>recovered.saveTokens({access_token:'late-token-after-reset',token_type:'Bearer'})).toThrow('reset');expect(new ServerOAuth(v.path,v.secret,v.callback).tokens()).toBeUndefined();
  });
  it('rejects mismatched and expired callbacks without making a network request',async()=>{
    const v=vault();vi.stubEnv('PRIVATE_UI_URL','https://pi.example.ts.net');vi.stubEnv('WEB_ORIGIN','https://pi.example.ts.net');
    const db=openDatabase(':memory:');const p=new ServerOAuth(v.path,v.secret,v.callback);p.begin('operator');const connection=new OfficialRobinhoodConnection(db,v.dir,v.secret);
    try{await expect(connection.callback('operator','wrong','synthetic-code')).rejects.toThrow('expired');await expect(connection.callback('different-operator',p.state(),'synthetic-code')).rejects.toThrow('expired');p.consume();const restarted=new OfficialRobinhoodConnection(db,v.dir,v.secret);await expect(restarted.callback('operator',p.state(),'synthetic-code')).rejects.toThrow('expired');}finally{db.close();}
  });
  it('invalidates pending state when the registered callback changes',()=>{
    const v=vault(),p=new ServerOAuth(v.path,v.secret,v.callback);p.begin('operator');p.saveCodeVerifier('synthetic-verifier');
    const changed=new ServerOAuth(v.path,v.secret,'https://other.example.ts.net/callback');expect(changed.state()).toBe('');expect(()=>changed.codeVerifier()).toThrow();
  });
});
describe('Secret-free diagnostics',()=>{
  it.each([['https://agent.robinhood.com/.well-known/oauth-protected-resource/mcp/trading','DISCOVERY'],['https://agent.robinhood.com/oauth/trading/register','REGISTRATION'],['https://api.robinhood.com/oauth2/token/','TOKEN_EXCHANGE'],['https://agent.robinhood.com/mcp/trading','TRANSPORT']])('classifies %s without retaining URL payloads',(url,stage)=>expect(oauthRequestStage(url+'?code=do-not-retain')).toBe(stage));
  it('only retains enumerated diagnostic fields',()=>{
    const d=diagnostic('TOKEN_EXCHANGE','BROKER_HTTP_400','https://pi.example.ts.net/callback?code=secret','ERROR',400);
    expect(d).toMatchObject({stage:'TOKEN_EXCHANGE',code:'BROKER_HTTP_400',callbackOrigin:'https://pi.example.ts.net',provider:'ROBINHOOD',state:'ERROR',httpStatus:400});expect(JSON.stringify(d)).not.toContain('secret');expect(Object.keys(d)).toHaveLength(7);
  });
});
