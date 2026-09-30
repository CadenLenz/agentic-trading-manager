import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AgenticManager } from '../packages/core/src/agentic-manager.js';
import { buildServer } from '../apps/api/src/server.js';

describe('API authentication and confirmation boundaries', () => {
  let manager: AgenticManager; let app: FastifyInstance;
  beforeEach(async () => {
    manager = new AgenticManager({ databasePath: ':memory:', workingDirectory: process.cwd(), sessionSecret: 'a-secure-api-test-secret-that-is-long-enough', startBackgroundServices: false });
    await manager.start(); app = await buildServer({ manager, serveWeb: false });
  });
  afterEach(async () => { await app.close(); await manager.shutdown(); });

  it('exposes only a minimal unauthenticated health response', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' }); expect(health.statusCode).toBe(200); expect(health.json()).toMatchObject({ mode: 'SIMULATION', ready: true });
    expect((await app.inject({ method: 'GET', url: '/api/dashboard' })).statusCode).toBe(401);
  });

  it('validates first-run allocation totals', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/setup/complete', payload: { username: 'operator', password: 'very-secure-password', designatedCapital: 1_000, allocations: { 'AGGRESSIVE_STOCKS': 1_000, 'SAFE_LONG_TERM': 1_000, 'OPTIONS': 1_000 }, demoData: false } });
    expect(response.statusCode).toBe(400); expect(response.json().error).toBe('ALLOCATION_TOTAL');
  });
  it('commissioning smaller empty fixture funds does not trigger emergency drawdown',async()=>{
    const result=await app.inject({method:'POST',url:'/api/setup/complete',payload:{username:'operator',password:'very-secure-password',designatedCapital:5000,allocations:{SAFE_LONG_TERM:1666.67,AGGRESSIVE_STOCKS:1666.67,OPTIONS:1666.66},demoData:false}});
    expect(result.statusCode).toBe(200);expect(manager.database.getSetting<{netAccountValue:number}>('broker_account_v2',{netAccountValue:0}).netAccountValue).toBe(5000);
    for(const s of ['SAFE_LONG_TERM','AGGRESSIVE_STOCKS','OPTIONS'] as const)expect(manager.allocation.state(s)).toMatchObject({drawdown:0,killed:false});
  });

  it('creates a secure session and enforces CSRF on mutations', async () => {
    const session = await setupSession(app); const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie: session.cookie } }); expect(dashboard.statusCode).toBe(200);
    const noCsrf = await app.inject({ method: 'POST', url: '/api/system/pause', headers: { cookie: session.cookie }, payload: { paused: true } }); expect(noCsrf.statusCode).toBe(403);
    const withCsrf = await app.inject({ method: 'POST', url: '/api/system/pause', headers: { cookie: session.cookie, 'x-csrf-token': session.csrf }, payload: { paused: true } }); expect(withCsrf.statusCode).toBe(200); expect(manager.database.getSetting('global_pause')).toBe(true);
  });

  it('requires explicit confirmation before a strategy change is committed', async () => {
    const session = await setupSession(app); const strategy = manager.database.getStrategy('AGGRESSIVE_STOCKS')!;
    const proposed = await app.inject({ method: 'POST', url: '/api/strategies/AGGRESSIVE_STOCKS/change', headers: { cookie: session.cookie, 'x-csrf-token': session.csrf }, payload: { config: { ...strategy.config, maxTradesPerDay: 4 }, reason: 'Test confirmation flow' } });
    expect(proposed.statusCode).toBe(200); expect(manager.database.getStrategy('AGGRESSIVE_STOCKS')?.version).toBe(2);
    const changeId = proposed.json().change.id as string;
    const confirmed = await app.inject({ method: 'POST', url: `/api/changes/${changeId}/confirm`, headers: { cookie: session.cookie, 'x-csrf-token': session.csrf }, payload: {} });
    expect(confirmed.statusCode).toBe(200); expect(manager.database.getStrategy('AGGRESSIVE_STOCKS')?.version).toBe(3); expect(manager.database.getStrategy('AGGRESSIVE_STOCKS')?.config.maxTradesPerDay).toBe(4);
  });

  it('validates and confirms global hard-risk changes separately', async () => {
    const session = await setupSession(app); const original = manager.database.getGlobalRisk();
    const proposed = await app.inject({ method: 'POST', url: '/api/risk/change', headers: { cookie: session.cookie, 'x-csrf-token': session.csrf }, payload: { config: { ...original, maxOrderNotional: 2_500 }, reason: 'Reduce global order size' } });
    expect(proposed.statusCode).toBe(200); expect(manager.database.getGlobalRisk().maxOrderNotional).toBe(original.maxOrderNotional);
    const confirmed = await app.inject({ method: 'POST', url: `/api/changes/${proposed.json().change.id as string}/confirm`, headers: { cookie: session.cookie, 'x-csrf-token': session.csrf }, payload: {} });
    expect(confirmed.statusCode).toBe(200); expect(manager.database.getGlobalRisk().maxOrderNotional).toBe(2_500);
  });

  it('rejects invalid credentials without exposing which field was wrong', async () => {
    await setupSession(app);
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'operator', password: 'incorrect-password' } });
    expect(response.statusCode).toBe(401); expect(response.json()).toMatchObject({ error: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' });
  });

  it('keeps LIVE disabled when environment gates are absent', async () => {
    const session = await setupSession(app);
    const response = await app.inject({ method: 'POST', url: '/api/system/mode', headers: { cookie: session.cookie, 'x-csrf-token': session.csrf }, payload: { mode: 'LIVE', confirmation: 'ENABLE LIVE TRADING' } });
    expect(response.statusCode).toBe(409); expect(manager.database.getMode()).toBe('SIMULATION'); expect(manager.database.getSetting('live_db_confirmation')).toBe(false);
  });
  it('protects V2 resources and agent sessions with authentication and CSRF',async()=>{
    expect((await app.inject({method:'GET',url:'/api/v2/state'})).statusCode).toBe(401);
    const s=await setupSession(app),headers={cookie:s.cookie,'x-csrf-token':s.csrf};
    expect((await app.inject({method:'POST',url:'/api/v2/agent/sessions',headers:{cookie:s.cookie},payload:{mode:'ADVISOR'}})).statusCode).toBe(403);
    const session=await app.inject({method:'POST',url:'/api/v2/agent/sessions',headers,payload:{mode:'ADVISOR'}});expect(session.statusCode).toBe(200);
    const state=await app.inject({method:'GET',url:'/api/v2/state',headers});expect(state.json().sleeves).toHaveLength(3);expect(state.json().readiness.ready).toBe(false);
  });
  it('STOP remains latched after global pause release and mode changes clear cached funds',async()=>{
    const s=await setupSession(app),headers={cookie:s.cookie,'x-csrf-token':s.csrf};
    await app.inject({method:'POST',url:'/api/system/emergency-stop',headers,payload:{}});
    expect(manager.notifications.list()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'STOP',severity:'CRITICAL'})]));
    await app.inject({method:'POST',url:'/api/system/pause',headers,payload:{paused:false}});
    expect(manager.database.getSetting('stopped')).toBe(true);expect(manager.database.getSetting('v2_live_activation')).toBe(false);
    expect((await app.inject({method:'POST',url:'/api/system/mode',headers,payload:{mode:'READ_ONLY'}})).statusCode).toBe(200);
    expect(manager.database.getSetting('broker_account_v2')).toBeNull();expect(manager.database.getSetting('reconciliation_clear')).toBe(false);
  });
  it('requires session-specific reauthentication for major policy changes',async()=>{
    await setupSession(app);
    const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'operator',password:'very-secure-password'}});
    const cookies=login.headers['set-cookie'],raw=Array.isArray(cookies)?cookies[0]:cookies;
    const headers={cookie:raw!.split(';')[0]!,'x-csrf-token':login.json().csrf as string};
    const payload={policy:manager.allocation.policy('SAFE_LONG_TERM'),confirmation:'UPDATE SAFE_LONG_TERM POLICY',review:'Reviewed this exact independent sleeve policy'};
    expect((await app.inject({method:'POST',url:'/api/v2/sleeves/SAFE_LONG_TERM/policy',headers,payload})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/api/v2/reauth',headers,payload:{password:'very-secure-password'}})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:'/api/v2/sleeves/SAFE_LONG_TERM/policy',headers,payload})).statusCode).toBe(200);
  });
  it('protects opening-balance import with login, CSRF and a fresh password check',async()=>{
    expect((await app.inject({method:'GET',url:'/api/v2/reconciliation'})).statusCode).toBe(401);
    await setupSession(app);
    const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'operator',password:'very-secure-password'}});
    const cookies=login.headers['set-cookie'],raw=Array.isArray(cookies)?cookies[0]:cookies;
    const headers={cookie:raw!.split(';')[0]!,'x-csrf-token':login.json().csrf as string};
    expect((await app.inject({method:'POST',url:'/api/v2/reconciliation/import',headers:{cookie:headers.cookie},payload:{}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/api/v2/reconciliation/import',headers,payload:{}})).statusCode).toBe(403);
    expect((await app.inject({method:'GET',url:'/api/v2/reconciliation',headers})).json()).toHaveProperty('positions');
  });
});

async function setupSession(app: FastifyInstance): Promise<{ cookie: string; csrf: string }> {
  const response = await app.inject({ method: 'POST', url: '/api/setup/complete', payload: { username: 'operator', password: 'very-secure-password', designatedCapital: 50_000, allocations: { 'AGGRESSIVE_STOCKS': 10_000, 'SAFE_LONG_TERM': 15_000, 'OPTIONS': 25_000 }, demoData: false } });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie']; const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie; if (!raw) throw new Error('Session cookie missing');
  const session={ cookie: raw.split(';')[0]!, csrf: response.json().csrf as string };
  expect((await app.inject({method:'POST',url:'/api/v2/reauth',headers:{cookie:session.cookie,'x-csrf-token':session.csrf},payload:{password:'very-secure-password'}})).statusCode).toBe(200);
  return session;
}
