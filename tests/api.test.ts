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
    const response = await app.inject({ method: 'POST', url: '/api/setup/complete', payload: { username: 'operator', password: 'very-secure-password', designatedCapital: 1_000, allocations: { 'day-trader': 1_000, 'aggressive-growth': 1_000, 'long-term-investor': 1_000 }, demoData: false } });
    expect(response.statusCode).toBe(400); expect(response.json().error).toBe('ALLOCATION_TOTAL');
  });

  it('creates a secure session and enforces CSRF on mutations', async () => {
    const session = await setupSession(app); const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie: session.cookie } }); expect(dashboard.statusCode).toBe(200);
    const noCsrf = await app.inject({ method: 'POST', url: '/api/system/pause', headers: { cookie: session.cookie }, payload: { paused: true } }); expect(noCsrf.statusCode).toBe(403);
    const withCsrf = await app.inject({ method: 'POST', url: '/api/system/pause', headers: { cookie: session.cookie, 'x-csrf-token': session.csrf }, payload: { paused: true } }); expect(withCsrf.statusCode).toBe(200); expect(manager.database.getSetting('global_pause')).toBe(true);
  });

  it('requires explicit confirmation before a strategy change is committed', async () => {
    const session = await setupSession(app); const strategy = manager.database.getStrategy('day-trader')!;
    const proposed = await app.inject({ method: 'POST', url: '/api/strategies/day-trader/change', headers: { cookie: session.cookie, 'x-csrf-token': session.csrf }, payload: { config: { ...strategy.config, maxTradesPerDay: 4 }, reason: 'Test confirmation flow' } });
    expect(proposed.statusCode).toBe(200); expect(manager.database.getStrategy('day-trader')?.version).toBe(2);
    const changeId = proposed.json().change.id as string;
    const confirmed = await app.inject({ method: 'POST', url: `/api/changes/${changeId}/confirm`, headers: { cookie: session.cookie, 'x-csrf-token': session.csrf }, payload: {} });
    expect(confirmed.statusCode).toBe(200); expect(manager.database.getStrategy('day-trader')?.version).toBe(3); expect(manager.database.getStrategy('day-trader')?.config.maxTradesPerDay).toBe(4);
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
});

async function setupSession(app: FastifyInstance): Promise<{ cookie: string; csrf: string }> {
  const response = await app.inject({ method: 'POST', url: '/api/setup/complete', payload: { username: 'operator', password: 'very-secure-password', designatedCapital: 50_000, allocations: { 'day-trader': 10_000, 'aggressive-growth': 15_000, 'long-term-investor': 25_000 }, demoData: false } });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie']; const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie; if (!raw) throw new Error('Session cookie missing');
  return { cookie: raw.split(';')[0]!, csrf: response.json().csrf as string };
}
