import {it,expect,vi} from 'vitest';
import {AgenticManager} from '../packages/core/src/agentic-manager.js';
import {buildServer} from '../apps/api/src/server.js';
it('activates after one password check and fresh sync, but keeps STOP and account scope enforced without placing orders',async()=>{
  vi.stubEnv('ROBINHOOD_AGENTIC_ACCOUNT_ID','activation-fixture');
  const m=new AgenticManager({databasePath:':memory:',workingDirectory:process.cwd(),sessionSecret:'activation-test-secret-long-enough',startBackgroundServices:false});
  await m.start();const app=await buildServer({manager:m,serveWeb:false});
  try{
    const setup=await app.inject({method:'POST',url:'/api/setup/complete',payload:{username:'operator',password:'very-secure-password',designatedCapital:5000,allocations:{SAFE_LONG_TERM:2000,AGGRESSIVE_STOCKS:2000,OPTIONS:1000},demoData:false}});
    const cookie=setup.headers['set-cookie'];const headers={cookie:(Array.isArray(cookie)?cookie[0]:cookie)!.split(';')[0]!,'x-csrf-token':setup.json().csrf};
    const payload={enabled:true,confirmation:'ENABLE AUTONOMOUS LIVE',review:'Operator acknowledged automatic real-money trading within existing allocations and risk limits.'};
    expect((await app.inject({method:'POST',url:'/api/v2/autonomy',headers,payload})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/api/v2/reauth',headers,payload:{password:'very-secure-password'}})).statusCode).toBe(200);
    const original=m.proposals.reconcile.bind(m.proposals);let accountId='activation-fixture';
    const sync=vi.spyOn(m.proposals,'reconcile').mockImplementation(async()=>{const result=await original();const account={...result.account,accountId,agentic:true,complete:true,healthy:true,asOf:new Date().toISOString()};m.database.setSetting('broker_account_v2',account);m.database.setSetting('reconciliation_clear',true);return {...result,account,clear:true};});
    m.database.setSetting('stopped',true);
    const stopped=await app.inject({method:'POST',url:'/api/v2/autonomy',headers,payload});expect(stopped.statusCode).toBe(409);expect(stopped.json().message).toContain('STOP is latched');
    m.database.setSetting('stopped',false);accountId='wrong-account';
    const wrong=await app.inject({method:'POST',url:'/api/v2/autonomy',headers,payload});expect(wrong.statusCode).toBe(409);expect(wrong.json().message).toContain('configured Agentic account');
    accountId='activation-fixture';m.database.setSetting('broker_account_v2',null);
    expect((await app.inject({method:'POST',url:'/api/v2/autonomy',headers,payload})).statusCode).toBe(200);
    expect(sync).toHaveBeenCalledTimes(3);expect(m.database.getMode()).toBe('AUTONOMOUS_LIVE');expect(m.database.getSetting('global_pause')).toBe(false);
    expect(m.database.raw.prepare('SELECT COUNT(*) AS n FROM executions_v2').get()).toEqual({n:0});
  }finally{await app.close();await m.shutdown();vi.unstubAllEnvs();}
});
