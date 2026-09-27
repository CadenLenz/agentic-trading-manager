import {OPENAI_CONNECTION_CONFIRMATION} from '../packages/trading-v2/src/connection-contract.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ServerOAuth} from '../packages/trading-v2/src/connectors.js';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {robinhoodCallback,robinhoodFailure} from '../packages/trading-v2/src/connection-setup.js';
import {AgenticManager} from '../packages/core/src/agentic-manager.js';
import {buildServer} from '../apps/api/src/server.js';
import {chartPoints} from '../src/chart-data.js';

afterEach(()=>vi.unstubAllEnvs());
describe('Connection setup recovery',()=>{
  it('treats the empty PRIVATE_UI_URL template value as unset',()=>{
    expect(robinhoodCallback({PRIVATE_UI_URL:'',WEB_ORIGIN:'https://pi.example.ts.net',NODE_ENV:'production'})).toBe('https://pi.example.ts.net/api/v2/connections/robinhood/callback');
  });
  it('allows an explicit local development origin',()=>expect(robinhoodCallback({PRIVATE_UI_URL:' ',WEB_ORIGIN:'http://localhost:3000'})).toContain('http://localhost:3000/'));
  it.each([
    {PRIVATE_UI_URL:'http://100.80.1.2:4010'},
    {PRIVATE_UI_URL:'http://localhost:4010',NODE_ENV:'production'},
    {PRIVATE_UI_URL:'https://user:secret@pi.example.ts.net'},
    {PRIVATE_UI_URL:'https://pi.example.ts.net/subpath'},
    {PRIVATE_UI_URL:'https://pi.example.ts.net?token=secret'},
    {PRIVATE_UI_URL:'https://pi.example.ts.net',WEB_ORIGIN:'https://other.example.ts.net'},
    {PRIVATE_UI_URL:'',WEB_ORIGIN:'',NODE_ENV:'production'},
  ])('rejects unsafe or inconsistent callback configuration %j',env=>expect(()=>robinhoodCallback(env)).toThrow());
  it('never reflects raw provider errors or credentials in user-facing failures',()=>{
    const failure=robinhoodFailure(new Error('fetch failed: token=secret-provider-token'));
    expect(failure.code).toBe('BROKER_UNREACHABLE');expect(failure.message).not.toContain('secret-provider-token');
  });
  it('distinguishes provider registration from expired authorization',()=>{
    expect(robinhoodFailure(new Error('dynamic client registration failed')).code).toBe('BROKER_REGISTRATION');
    expect(robinhoodFailure(new Error('invalid_grant')).code).toBe('BROKER_AUTH_EXPIRED');
  });
  it('returns actionable configuration errors through authenticated API without bypassing CSRF or password checks',async()=>{
    vi.stubEnv('PRIVATE_UI_URL','');vi.stubEnv('WEB_ORIGIN','not-a-url');vi.stubEnv('OPENAI_API_KEY','');
    const manager=new AgenticManager({databasePath:':memory:',workingDirectory:process.cwd(),sessionSecret:'isolated-connection-test-secret-at-least-32',startBackgroundServices:false});
    await manager.start();const app=await buildServer({manager,serveWeb:false});
    try {
      const setup=await app.inject({method:'POST',url:'/api/setup/complete',payload:{username:'operator',password:'only-for-isolated-tests',designatedCapital:50000,allocations:{SAFE_LONG_TERM:20000,AGGRESSIVE_STOCKS:20000,OPTIONS:10000},demoData:false}});
      expect(setup.statusCode).toBe(200);
      const raw=setup.headers['set-cookie'];const cookie=(Array.isArray(raw)?raw[0]:raw)!.split(';')[0]!;const headers={cookie,'x-csrf-token':setup.json().csrf as string};
      expect((await app.inject({method:'POST',url:'/api/v2/connections/robinhood/connect',headers:{cookie},payload:{}})).statusCode).toBe(403);
      expect((await app.inject({method:'POST',url:'/api/v2/connections/robinhood/connect',headers,payload:{}})).statusCode).toBe(403);
      await app.inject({method:'POST',url:'/api/v2/reauth',headers,payload:{password:'only-for-isolated-tests'}});
      const credential=await app.inject({method:'POST',url:'/api/v2/connections/openai/connect',headers,payload:{key:'synthetic-local-test-key-only',model:'gpt-5.5',confirmation:OPENAI_CONNECTION_CONFIRMATION}});
      expect(credential.statusCode).toBe(200);expect(credential.json()).toMatchObject({configured:true,tested:false,paidCalls:0});expect(credential.body).not.toContain('synthetic-local-test-key-only');
      const failure=await app.inject({method:'POST',url:'/api/v2/connections/robinhood/connect',headers,payload:{}});
      expect(failure.statusCode).toBe(409);expect(failure.json()).toMatchObject({error:'PRIVATE_ADDRESS_MISSING'});expect(failure.json().message).toContain('PRIVATE_UI_URL');
      const status=await app.inject({method:'GET',url:'/api/v2/connections',headers});expect(status.json().setup).toMatchObject({ready:false,code:'PRIVATE_ADDRESS_MISSING'});
      const callback=await app.inject({method:'GET',url:'/api/v2/connections/robinhood/callback?error=access_denied&error_description=secret'});
      expect(callback.statusCode).toBe(302);expect(callback.headers.location).toBe('/?connectionError=BROKER_LOGIN_CANCELLED');
      expect(manager.database.getMode()).toBe('SIMULATION');expect(manager.database.getSetting('live_db_confirmation',false)).toBe(false);
    }finally{await app.close();await manager.shutdown();}
  });
});
describe('Recorded chart observations',()=>{
  it('orders observations by actual time and excludes invalid observations without inventing points',()=>{
    const points=[{at:'2026-09-02',value:110},{at:'invalid',value:30},{at:'2026-09-01',value:100},{at:'2026-09-03',value:NaN}];
    expect(chartPoints(points)).toEqual([{at:'2026-09-01',value:100},{at:'2026-09-02',value:110}]);expect(points).toHaveLength(4);
  });
});

it('reuses encrypted authorization only for the same callback origin',()=>{
  const dir=mkdtempSync(join(tmpdir(),'atm-oauth-test-')),path=join(dir,'oauth.enc'),secret='synthetic-test-only-credential-encryption';
  try{
    const original=new ServerOAuth(path,secret,'https://old.example.ts.net/callback');
    original.saveTokens({access_token:'synthetic-test-token',token_type:'Bearer'});
    expect(new ServerOAuth(path,secret,'https://old.example.ts.net/callback').tokens()?.access_token).toBe('synthetic-test-token');
    expect(new ServerOAuth(path,secret,'https://new.example.ts.net/callback').tokens()).toBeUndefined();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
