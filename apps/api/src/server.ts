import {actionError} from './action-errors.js';
import {ConnectionSetupError} from '../../../packages/trading-v2/src/connection-setup.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import { directiveSchema, globalRiskConfigSchema, managerMessageSchema, operatingModeSchema, setupSchema, strategyConfigSchema, tradeProposalSchema } from '../../../packages/core/src/schemas.js';
import type { AgenticManager } from '../../../packages/core/src/agentic-manager.js';
import { makeId, nowIso, parseJson, roundMoney } from '../../../packages/core/src/utils.js';
import {registerV2,readiness} from './v2-routes.js';
import {sleeveSchema} from '../../../packages/trading-v2/src/model.js';
import {registerPreproduction,requireRecentAuth} from './preproduction-routes.js';
import {notificationPreferencesSchema} from '../../../packages/trading-v2/src/notifications.js';

declare module 'fastify' {
  interface FastifyRequest { authUser: { id: string; username: string; csrf: string } | null }
}

const SESSION_COOKIE = 'atm_session';
const loginSchema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) });
const symbolSchema = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9.-]{0,9}$/);
const publicPaths = new Set(['/health', '/api/setup/status', '/api/setup/complete', '/api/auth/login','/api/v2/connections/robinhood/callback']);

export interface ServerOptions { manager: AgenticManager; webRoot?: string; serveWeb?: boolean }

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const { manager } = options;
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', serializers:{req:r=>({method:r.method,url:String(r.url).split('?')[0]??'/',remoteAddress:r.ip})},redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie', '*.password', '*.token', '*.secret'] }, trustProxy: false, bodyLimit: 512 * 1024, requestTimeout: 30_000 });
  app.decorateRequest('authUser', null);
  await app.register(cookie);
  await app.register(cors, { origin: (origin, callback) => { const allowed = !origin || origin === (process.env.WEB_ORIGIN ?? 'http://localhost:3000'); callback(null, allowed); }, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute', keyGenerator: (request) => request.ip });

  app.addHook('preHandler', async (request, reply) => {
    const routePath = request.url.split('?')[0] ?? request.url;
    if (!routePath.startsWith('/api/') || publicPaths.has(routePath)) return;
    const token = request.cookies[SESSION_COOKIE];
    const payload = token ? manager.auth.verify(token) : null;
    if (!payload) return reply.code(401).send({ error: 'AUTH_REQUIRED', message: 'Authentication is required.' });
    request.authUser = { id: payload.sub, username: payload.username, csrf: payload.csrf };
    if(routePath==='/api/system/codex-reasoning'&&(request.body as {enabled?:boolean}|undefined)?.enabled===true)return reply.code(409).send({error:'V2_AGENT_REQUIRED',message:'Use Codex Tasks to explicitly request or schedule a bounded worker job.'});
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || csrf !== payload.csrf) return reply.code(403).send({ error: 'CSRF_INVALID', message: 'Your session has changed. Refresh the page, sign in if asked, and retry.' });
      const sensitive = /^\/api\/changes\/[^/]+\/confirm$/.test(routePath)
        || /^\/api\/v2\/sleeves\/[^/]+\/(policy|weight|reset)$/.test(routePath)
        || ['/api/v2/account-policy','/api/v2/position-transfer','/api/v2/stop-release','/api/v2/upgrade-review'].includes(routePath);
      if(sensitive)requireRecentAuth(manager,payload.username,payload.csrf);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ConnectionSetupError) return reply.code(error.statusCode).send({error:error.code,message:error.message});
    if (error instanceof ZodError) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Some fields are missing or invalid. Check the form values and try again.', issues: error.issues });
    const normalized = error instanceof Error ? error : new Error(String(error));
    const explanation=actionError(normalized.message);
    if(explanation)return reply.code(409).send({error:'ACTION_BLOCKED',message:explanation});
    const candidate = error && typeof error === 'object' && 'statusCode' in error ? (error as { statusCode?: unknown }).statusCode : undefined;
    const status = typeof candidate === 'number' && candidate >= 400 ? candidate : 500;
    request.log.error({ err: error }, 'request failed');
    return reply.code(status).send({ error: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR', message: status >= 500 ? 'The action could not be completed. Refresh to check its status before retrying. If this continues, inspect the server log using this request ID: '+request.id : normalized.message });
  });

  app.get('/health', async () => manager.health());
  app.get('/api/setup/status', async () => ({ complete: manager.database.getSetting<boolean>('setup_complete', false), hasAdmin: manager.auth.hasUser(), mode: manager.database.getMode(), strategies: manager.database.listStrategies().map((strategy) => ({ id: strategy.id, name: strategy.name, allocationAmount: strategy.allocationAmount })), checks: manager.health().checks, exampleDefaults: true }));
  app.post('/api/setup/complete', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    if (manager.database.getSetting<boolean>('setup_complete', false) || manager.auth.hasUser()) return reply.code(409).send({ error: 'SETUP_COMPLETE', message: 'First-run setup has already been completed.' });
    const input = setupSchema.parse(request.body);
    const strategies = manager.database.listStrategies();
    const total = Object.values(input.allocations).reduce((sum, amount) => sum + amount, 0);
    if (total > input.designatedCapital + 0.001) return reply.code(400).send({ error: 'ALLOCATION_TOTAL', message: 'Strategy allocations cannot exceed designated capital.' });
    for (const strategy of strategies) if (input.allocations[strategy.id] === undefined) return reply.code(400).send({ error: 'ALLOCATION_MISSING', message: `Allocation is missing for ${strategy.name}.` });
    const user = await manager.auth.createAdmin(input.username, input.password);
    manager.database.setSetting('designated_capital', input.designatedCapital);
    for (const strategy of strategies) manager.database.updateStrategy(strategy.id, { ...strategy.config, allocationAmount: input.allocations[strategy.id] ?? 0 }, 'SETUP', input.username, 'Confirmed first-run allocation');
    manager.database.setSetting('operating_mode', 'SIMULATION'); manager.database.setSetting('live_db_confirmation', false); manager.database.setSetting('setup_complete', true);
    // Commissioning empty fixture cash is not a trading loss. Never reset an existing trading ledger.
    if((manager.database.raw.prepare('SELECT COUNT(*) AS n FROM fills').get() as {n:number}).n===0&&manager.ledger.listPositions().length===0){
      for(const strategy of strategies){const cash=manager.ledger.getCash(strategy.id);manager.database.raw.prepare('UPDATE strategy_capital SET starting_capital=?,weekly_starting_capital=?,high_water_mark=?,killed=0,kill_reason=NULL WHERE strategy_id=?').run(cash,cash,cash,strategy.id);}
    }
    if (input.demoData) await manager.seedDemoData();
    await manager.proposals.reconcile();manager.analytics.snapshot('FIRST_RUN_COMMISSIONING');
    const session = await manager.auth.authenticate(input.username, input.password);
    if (!session) throw new Error('New administrator session could not be created');
    setSessionCookie(reply, session.token);
    manager.database.audit(user.username, 'SETUP_COMPLETED', 'system', null, { designatedCapital: input.designatedCapital, allocations: input.allocations, demoData: input.demoData }, request.ip);
    return { complete: true, csrf: session.csrf, user };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const session = await manager.auth.authenticate(input.username, input.password);
    if (!session) { manager.database.audit(input.username, 'LOGIN_FAILED', 'session', null, {}, request.ip); return reply.code(401).send({ error: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' }); }
    setSessionCookie(reply, session.token); manager.database.audit(session.user.username, 'LOGIN_SUCCEEDED', 'session', session.user.id, {}, request.ip);
    return { user: session.user, csrf: session.csrf };
  });
  app.post('/api/auth/logout', async (request, reply) => { reply.clearCookie(SESSION_COOKIE, { path: '/' }); manager.database.audit(actor(request), 'LOGOUT', 'session', null, {}, request.ip); return { ok: true }; });
  app.get('/api/auth/session', async (request) => ({ user: { id: request.authUser?.id, username: request.authUser?.username }, csrf: request.authUser?.csrf }));

  app.get('/api/dashboard', async () => dashboard(manager));
  registerV2(app,manager);
  registerPreproduction(app,manager);
  app.get('/api/strategies', async () => ({ strategies: manager.database.listStrategies(), positions: manager.ledger.listPositions(), watchlists: manager.database.raw.prepare('SELECT * FROM watchlists ORDER BY strategy_id,symbol').all(), directives: manager.directives.list(undefined, true) }));
  app.get('/api/strategies/:id/versions', async (request) => {
    const { id } = request.params as { id: string };
    return { versions: manager.database.raw.prepare('SELECT id,version,source,diff_json AS diffJson,origin,reason,portfolio_json AS portfolioJson,created_at AS createdAt FROM strategy_versions WHERE strategy_id=? ORDER BY version DESC').all(id).map((row) => normalizeJsonColumns(row as Record<string, unknown>, ['diffJson', 'portfolioJson'])) };
  });
  app.post('/api/strategies/:id/change', async (request) => {
    const { id } = request.params as { id: string }; const strategy = manager.database.getStrategy(id); if (!strategy) throw Object.assign(new Error('Strategy not found'), { statusCode: 404 });
    const body = z.object({ config: strategyConfigSchema, reason: z.string().min(3).max(1_000) }).parse(request.body);
    return createPending(manager, 'UPDATE_STRATEGY', { strategyId: id, config: body.config }, actor(request), body.reason);
  });
  app.post('/api/strategies/:id/pause', async (request) => { const { id } = request.params as { id: string }; return createPending(manager, 'SET_STRATEGY_ENABLED', { strategyId: id, enabled: false }, actor(request), `Pause ${manager.database.getStrategy(id)?.name ?? id}`); });
  app.post('/api/strategies/:id/resume', async (request) => { const { id } = request.params as { id: string }; return createPending(manager, 'SET_STRATEGY_ENABLED', { strategyId: id, enabled: true }, actor(request), `Resume ${manager.database.getStrategy(id)?.name ?? id}`); });
  app.post('/api/strategies/:id/revert', async (request) => { const { id } = request.params as { id: string }; const { version } = z.object({ version: z.number().int().positive() }).parse(request.body); return createPending(manager, 'REVERT_STRATEGY', { strategyId: id, version }, actor(request), `Restore ${id} to version ${version}`); });

  app.post('/api/directives', async (request) => { const input = directiveSchema.parse(request.body); return { directive: manager.directives.create(input, actor(request)) }; });
  app.delete('/api/directives/:id', async (request) => { const { id } = request.params as { id: string }; manager.directives.deactivate(id, actor(request)); return { ok: true }; });
  app.post('/api/watchlists', async (request) => {
    const input = z.object({ strategyId: z.string().min(1), symbol: symbolSchema, researchOnly: z.boolean().default(false), notes: z.string().max(1_000).default('') }).parse(request.body);
    if (!manager.database.getStrategy(input.strategyId)) throw Object.assign(new Error('Strategy not found'), { statusCode: 404 });
    manager.database.raw.prepare(`INSERT INTO watchlists(strategy_id,symbol,research_only,notes,created_at) VALUES(?,?,?,?,?) ON CONFLICT(strategy_id,symbol) DO UPDATE SET research_only=excluded.research_only,notes=excluded.notes`).run(input.strategyId, input.symbol, input.researchOnly ? 1 : 0, input.notes, nowIso());
    if (input.researchOnly) manager.directives.create({ strategyId: input.strategyId, type: 'RESEARCH_ONLY', symbol: input.symbol, value: {}, reason: input.notes || 'Marked research-only from watchlist', expiresAt: null }, actor(request));
    manager.database.audit(actor(request), 'WATCHLIST_UPSERTED', 'watchlist', `${input.strategyId}:${input.symbol}`, input);
    return { ok: true };
  });

  app.post('/api/agents/:strategyId/analyze', async (request) => { const { strategyId } = request.params as { strategyId: string }; const input = z.object({ symbol: symbolSchema, useCodex: z.boolean().default(false) }).parse(request.body); if(input.useCodex)return manager.codexTasks.create('Research '+input.symbol+' for '+strategyId,request.authUser!.username); const result = await manager.agents.analyze(strategyId, input.symbol, input.useCodex); manager.events.publish({ type: 'AGENT_DECISION', severity: 'INFO', source: 'AGENT_ORCHESTRATOR', strategyId, symbol: input.symbol, payload: { decisionId: result.decisionId, action: result.proposal.action } }); return result; });
  app.get('/api/agents/status', async () => ({ agents: manager.database.listStrategies().map((strategy) => { const stats = manager.database.raw.prepare("SELECT MAX(completed_at) AS lastRun,AVG(duration_ms) AS averageDurationMs,SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failures FROM agent_runs WHERE strategy_id=?").get(strategy.id) as { lastRun: string | null; averageDurationMs: number | null; failures: number }; const last = manager.database.raw.prepare('SELECT action,symbol,rationale,created_at AS createdAt FROM decisions WHERE strategy_id=? ORDER BY created_at DESC LIMIT 1').get(strategy.id); return { id: strategy.id, name: strategy.name, status: strategy.status, enabled: strategy.enabled, currentTask: strategy.status === 'ANALYZING' ? 'Market analysis' : strategy.kind === 'DAY_TRADER' ? 'Monitoring configured universe' : 'Awaiting scheduled review', lastSuccessfulRun: stats.lastRun, averageRunDurationMs: stats.averageDurationMs, recentFailures: stats.failures, lastDecision: last ?? null }; }) }));
  app.get('/api/decisions', async () => ({ decisions: manager.database.raw.prepare('SELECT id,strategy_id AS strategyId,agent_type AS agentType,symbol,action,confidence,rationale,proposal_json AS proposal,status,created_at AS createdAt FROM decisions ORDER BY created_at DESC LIMIT 100').all().map((row) => normalizeJsonColumns(row as Record<string, unknown>, ['proposal'])) }));

  app.post('/api/trades/execute', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    if (manager.database.getMode() !== 'SIMULATION') throw Object.assign(new Error('This endpoint is limited to SIMULATION; LIVE orders require the separately gated execution path.'), { statusCode: 409 });
    const body = z.object({ proposal: tradeProposalSchema, idempotencyKey: z.string().min(8).max(200) }).parse(request.body);
    const result = await manager.execution.execute(body.proposal, body.idempotencyKey, actor(request));
    manager.events.publish({ type: result.status === 'REJECTED' ? 'ORDER_REJECTED' : 'ORDER_FILLED', severity: result.status === 'REJECTED' ? 'WARNING' : 'INFO', source: 'EXECUTION_ENGINE', strategyId: result.proposal.strategyId, symbol: result.proposal.symbol, payload: { orderId: result.orderId, status: result.status } });
    return result;
  });

  app.get('/api/risk', async () => riskView(manager));
  app.post('/api/risk/change', async (request) => {
    const input = z.object({ config: globalRiskConfigSchema, reason: z.string().min(3).max(1_000) }).parse(request.body);
    return createPending(manager, 'UPDATE_GLOBAL_RISK', { config: input.config }, actor(request), input.reason);
  });
  app.get('/api/performance', async (request) => { const query = request.query as { from?: string; to?: string }; return performanceView(manager, query.from, query.to); });
  app.get('/api/scanner', async (request) => {
    const { strategyId } = z.object({ strategyId: z.string().optional() }).parse(request.query);
    const criteria = strategyId ? manager.database.getStrategy(strategyId)?.config.scanner ?? {} : {};
    return { candidates: await manager.market.getScannerResults(criteria), source: manager.market.name, simulated: manager.database.getMode() === 'SIMULATION' };
  });
  app.get('/api/activity', async () => ({ audit: manager.database.raw.prepare('SELECT id,actor,action,entity_type AS entityType,entity_id AS entityId,details_json AS details,created_at AS createdAt FROM audit_events ORDER BY created_at DESC LIMIT 100').all().map((row) => normalizeJsonColumns(row as Record<string, unknown>, ['details'])), risks: manager.database.raw.prepare('SELECT * FROM risk_events ORDER BY created_at DESC LIMIT 100').all(), orders: manager.database.raw.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100').all() }));
  app.get('/api/briefs', async () => ({ briefs: manager.database.raw.prepare('SELECT id,report_date AS reportDate,content_json AS content,created_at AS createdAt FROM daily_briefs ORDER BY report_date DESC LIMIT 30').all().map((row) => normalizeJsonColumns(row as Record<string, unknown>, ['content'])) }));
  app.post('/api/briefs/generate', async (request) => { const report = generateDailyBrief(manager); const date = nowIso().slice(0, 10); manager.database.raw.prepare(`INSERT INTO daily_briefs(id,report_date,content_json,created_at) VALUES(?,?,?,?) ON CONFLICT(report_date) DO UPDATE SET content_json=excluded.content_json,created_at=excluded.created_at`).run(makeId('brief'), date, JSON.stringify(report), nowIso()); manager.database.audit(actor(request), 'DAILY_BRIEF_GENERATED', 'daily_brief', date, {}); return report; });

  app.post('/api/manager/chat', async (request) => { const { message } = managerMessageSchema.parse(request.body); const session=manager.tradingAgent.create(actor(request),'ADVISOR');return manager.tradingAgent.chat(session.id,actor(request),message); });
  app.get('/api/changes', async () => ({ changes: manager.database.raw.prepare("SELECT id,type,status,payload_json AS payload,requested_by AS requestedBy,reason,created_at AS createdAt,expires_at AS expiresAt,confirmed_at AS confirmedAt FROM pending_changes ORDER BY created_at DESC LIMIT 100").all().map((row) => normalizeJsonColumns(row as Record<string, unknown>, ['payload'])) }));
  app.post('/api/changes/:id/confirm', async (request) => { const { id } = request.params as { id: string }; return confirmPending(manager, id, actor(request)); });
  app.post('/api/changes/:id/reject', async (request) => { const { id } = request.params as { id: string }; const result = manager.database.raw.prepare("UPDATE pending_changes SET status='REJECTED',confirmed_at=? WHERE id=? AND status='PENDING'").run(nowIso(), id); if (result.changes !== 1) throw Object.assign(new Error('Pending change not found'), { statusCode: 404 }); manager.database.audit(actor(request), 'CHANGE_REJECTED', 'pending_change', id, {}); return { ok: true }; });

  app.get('/api/robinhood/status', async () => manager.robinhood.discoverCapabilities());
  app.post('/api/reconciliation/run', async () => manager.proposals.reconcile());
  app.get('/api/reconciliation', async () => ({ clear: manager.database.getSetting<boolean>('reconciliation_clear', true), lastRunAt: manager.database.getSetting<string | null>('last_reconciliation_at', null), events: manager.database.raw.prepare('SELECT * FROM reconciliation_events ORDER BY created_at DESC LIMIT 100').all(), brokerPositions: manager.database.raw.prepare('SELECT * FROM broker_positions ORDER BY symbol').all(), internalPositions: manager.ledger.aggregatePositions() }));
  app.post('/api/reconciliation/:id/resolve', async () => {throw Object.assign(new Error('V2 requires explicit ownership assignment and fresh broker reconciliation; acknowledgement cannot clear a financial discrepancy.'),{statusCode:409});});

  app.post('/api/system/pause', async (request) => { const { paused } = z.object({ paused: z.boolean() }).parse(request.body); manager.database.setSetting('global_pause', paused); manager.database.audit(actor(request), paused ? 'GLOBAL_PAUSE_ENABLED' : 'GLOBAL_PAUSE_DISABLED', 'system', null, {}, request.ip); manager.events.publish({ type: paused ? 'GLOBAL_PAUSE' : 'GLOBAL_RESUME', severity: paused ? 'WARNING' : 'INFO', source: 'ADMIN', payload: {} }); return { paused }; });
  app.post('/api/system/maintenance', async (request) => { const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body); manager.database.setSetting('maintenance_mode', enabled); manager.database.audit(actor(request), enabled ? 'MAINTENANCE_ENABLED' : 'MAINTENANCE_DISABLED', 'system', null, {}); return { enabled }; });
  app.get('/api/system/settings', async () => ({ codexReasoningEnabled: manager.database.getSetting<boolean>('codex_reasoning_enabled', false), marketDataTradingEligible: manager.database.getSetting<boolean>('market_data_trading_eligible', false) }));
  app.post('/api/system/codex-reasoning', async (request) => { const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body); manager.database.setSetting('codex_reasoning_enabled', enabled); manager.database.audit(actor(request), enabled ? 'CODEX_REASONING_ENABLED' : 'CODEX_REASONING_DISABLED', 'system', null, {}); return { enabled }; });
  app.post('/api/system/emergency-stop', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => { manager.database.setSetting('global_pause', true); manager.database.setSetting('stopped',true);manager.database.setSetting('v2_live_activation',false);manager.database.setSetting('live_db_confirmation', false); manager.notifications.emit('stop:'+Date.now(),'STOP','CRITICAL',{summary:'Emergency STOP engaged; LIVE confirmation revoked',actor:actor(request)}); manager.database.audit(actor(request), 'EMERGENCY_STOP', 'system', null, {}, request.ip); manager.events.publish({ type: 'EMERGENCY_STOP', severity: 'CRITICAL', source: 'ADMIN', payload: {} }); return { stopped: true, liveConfirmationRevoked: true }; });
  app.post('/api/system/mode', async (request) => {
    const input = z.object({ mode: operatingModeSchema, confirmation: z.string().optional() }).parse(request.body);
    if (input.mode === 'LIVE') {
      requireRecentAuth(manager,actor(request),request.authUser!.csrf);
      await manager.proposals.reconcile();
      if (input.confirmation !== 'ENABLE LIVE TRADING') throw Object.assign(new Error('Exact LIVE confirmation phrase is required.'), { statusCode: 400 });
      if (!manager.database.getSetting<boolean>('reconciliation_clear', false)) throw Object.assign(new Error('Reconciliation must be clear before LIVE can be enabled.'), { statusCode: 409 });
      if(!readiness(manager).ready)throw Object.assign(new Error('V2 LIVE readiness checks have not passed; inspect /api/v2/readiness.'),{statusCode:409});
      manager.database.setSetting('v2_live_activation',true);
      manager.database.setSetting('live_db_confirmation', true);
    } else {manager.database.setSetting('live_db_confirmation', false);manager.database.setSetting('v2_live_activation',false);}
    if(input.mode!==manager.database.getMode()){manager.database.setSetting('broker_account_v2',null);manager.database.setSetting('reconciliation_clear',false);manager.database.setSetting('reconciliation_v2',['Account refresh required after mode change']);manager.database.setSetting('broker_verification_mode_v2','UNVERIFIED');}
    manager.database.setSetting('operating_mode', input.mode); manager.database.audit(actor(request), 'OPERATING_MODE_CHANGED', 'system', null, { mode: input.mode }, request.ip);
    return { mode: input.mode, liveConfirmed: input.mode === 'LIVE' };
  });

  app.get('/api/events', async (request, reply) => {
    reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event: unknown): void => { reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); };
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 20_000); heartbeat.unref();
    manager.events.on('system-event', send); send({ type: 'CONNECTED', createdAt: nowIso() });
    request.raw.on('close', () => { clearInterval(heartbeat); manager.events.off('system-event', send); });
  });

  const webRoot = resolve(options.webRoot ?? 'dist/web');
  if (options.serveWeb !== false && existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
    app.setNotFoundHandler((request, reply) => { if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html'); return reply.code(404).send({ error: 'NOT_FOUND', message: 'Route not found.' }); });
  }
  return app;
}

function actor(request: FastifyRequest): string { return request.authUser?.username ?? 'UNKNOWN'; }
function setSessionCookie(reply: { setCookie: (name: string, value: string, options: Record<string, unknown>) => unknown }, token: string): void { reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 }); }
function normalizeJsonColumns(record: Record<string, unknown>, columns: string[]): Record<string, unknown> { const result = { ...record }; for (const column of columns) if (typeof result[column] === 'string') result[column] = parseJson(result[column] as string); return result; }

function createPending(manager: AgenticManager, type: string, payload: Record<string, unknown>, requestedBy: string, reason: string): { change: Record<string, unknown> } {
  const id = makeId('change'); const createdAt = nowIso(); const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  manager.database.raw.prepare('INSERT INTO pending_changes(id,type,status,payload_json,requested_by,reason,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(id, type, 'PENDING', JSON.stringify(payload), requestedBy, reason, createdAt, expiresAt);
  manager.database.audit(requestedBy, 'CHANGE_PROPOSED', 'pending_change', id, { type, payload, reason });
  return { change: { id, type, status: 'PENDING', payload, requestedBy, reason, createdAt, expiresAt } };
}

async function confirmPending(manager: AgenticManager, id: string, confirmedBy: string): Promise<{ ok: true; result: unknown }> {
  const row = manager.database.raw.prepare("SELECT type,payload_json,expires_at FROM pending_changes WHERE id=? AND status='PENDING'").get(id) as { type: string; payload_json: string; expires_at: string } | undefined;
  if (!row) throw Object.assign(new Error('Pending change not found'), { statusCode: 404 });
  if (new Date(row.expires_at).getTime() < Date.now()) { manager.database.raw.prepare("UPDATE pending_changes SET status='EXPIRED' WHERE id=?").run(id); throw Object.assign(new Error('Pending change expired'), { statusCode: 409 }); }
  const payload = parseJson<Record<string, unknown>>(row.payload_json); let result: unknown = null;
  switch (row.type) {
    case 'V2_SCHEDULER':result=manager.tradingScheduler.update(String(payload.jobId),String(payload.cron),Boolean(payload.enabled),confirmedBy);break;
    case 'V2_NOTIFICATIONS':{const preferences={...payload};delete preferences.reason;result=manager.notifications.update(notificationPreferencesSchema.parse(preferences),confirmedBy);break;}
    case 'RISK_CONFIGURATION': result=manager.riskConfiguration.apply(payload.config,Number(payload.expectedVersion),confirmedBy,String(payload.reason),'APPLY RISK CONFIGURATION',{instruction:String(payload.instruction),interpretation:String(payload.interpretation),sessionId:String(payload.sessionId)});break;
    case 'UPDATE_STRATEGY': result = manager.database.updateStrategy(String(payload.strategyId), strategyConfigSchema.parse(payload.config), 'ADMIN_UI', confirmedBy, `Confirmed pending change ${id}`); break;
    case 'UPDATE_GLOBAL_RISK': { const config = globalRiskConfigSchema.parse(payload.config); manager.database.setSetting('global_risk', config); manager.database.audit(confirmedBy, 'GLOBAL_RISK_UPDATED', 'risk_config', 'global', { pendingChangeId: id }); result = config; break; }
    case 'SET_STRATEGY_ENABLED': manager.database.setStrategyEnabled(String(payload.strategyId), Boolean(payload.enabled), confirmedBy, `Confirmed pending change ${id}`); result = manager.database.getStrategy(String(payload.strategyId)); break;
    case 'SET_GLOBAL_PAUSE': manager.database.setSetting('global_pause', Boolean(payload.paused)); manager.database.audit(confirmedBy, 'GLOBAL_PAUSE_CHANGED', 'system', null, payload); result = { paused: Boolean(payload.paused) }; break;
    case 'SET_STRATEGY_ALLOCATION': { const strategy = manager.database.getStrategy(String(payload.strategyId)); if (!strategy) throw new Error('Strategy not found'); result = manager.database.updateStrategy(strategy.id, { ...strategy.config, allocationAmount: Number(payload.amount) }, 'MANAGER_CHAT', confirmedBy, `Confirmed pending change ${id}`); break; }
    case 'REVERT_STRATEGY': result = manager.database.revertStrategy(String(payload.strategyId), Number(payload.version), confirmedBy); break;
    case 'CREATE_DIRECTIVE': result = manager.directives.create(directiveSchema.parse(payload), confirmedBy); break;
    case 'V2_POLICY':result=manager.allocation.updatePolicy(sleeveSchema.parse(payload.strategy),payload.config,confirmedBy);break;
    case 'V2_WEIGHT':manager.allocation.setWeight(sleeveSchema.parse(payload.strategy),z.number().min(0).max(1).parse(payload.targetWeight),confirmedBy);result={ok:true};break;
    case 'V2_RESUME':{const s=sleeveSchema.parse(payload.strategy);if(manager.allocation.state(s).killed)throw new Error('Weekly kill-switch review/reset required');manager.database.setStrategyEnabled(s,true,confirmedBy,'Confirmed V2 resume');result={ok:true};break;}
    case 'V2_ORDER_CANCEL':result=await manager.proposals.cancel(String(payload.proposalId),confirmedBy);break;
    default: throw new Error(`Unsupported pending change type: ${row.type}`);
  }
  manager.database.raw.prepare("UPDATE pending_changes SET status='CONFIRMED',confirmed_at=? WHERE id=?").run(nowIso(), id); manager.database.audit(confirmedBy, 'CHANGE_CONFIRMED', 'pending_change', id, { type: row.type, payload });
  return { ok: true, result };
}

function dashboard(manager: AgenticManager): Record<string, unknown> {
  const strategies = manager.database.listStrategies(); const positions = manager.ledger.listPositions(); const cash = strategies.reduce((sum, strategy) => sum + strategy.cash, 0); const exposure = positions.reduce((sum, position) => sum + position.marketValue, 0); const realized = manager.ledger.getRealizedPnl(); const unrealized = positions.some(p=>p.unrealizedPnl===null)?null:positions.reduce((sum, position) => sum + position.unrealizedPnl!, 0); const opening=manager.database.getSetting<{reference:string}|null>('initial_account_import_v2',null);const capital=opening?(manager.database.raw.prepare('SELECT SUM(starting_capital) AS total FROM strategy_capital').get() as {total:number}).total:manager.database.getSetting<number>('designated_capital',50_000);
  return { mode: manager.database.getMode(), simulated: manager.database.getMode() === 'SIMULATION', setupComplete: manager.database.getSetting<boolean>('setup_complete', false), globalPause: manager.database.getSetting<boolean>('global_pause', false), maintenance: manager.database.getSetting<boolean>('maintenance_mode', false), metrics: { equity: roundMoney(cash + exposure), cash: roundMoney(cash), exposure: roundMoney(exposure), realizedPnl: realized, unrealizedPnl: unrealized===null?null:roundMoney(unrealized), totalPnl: roundMoney(cash + exposure - capital), exposurePercent: capital ? roundMoney(exposure / capital * 100) : 0 }, strategies: strategies.map((strategy) => { const owned = positions.filter((position) => position.strategyId === strategy.id); return { ...strategy, marketValue: roundMoney(owned.reduce((sum, position) => sum + position.marketValue, 0)), realizedPnl: manager.ledger.getRealizedPnl(strategy.id), unrealizedPnl: owned.some(p=>p.unrealizedPnl===null)?null:roundMoney(owned.reduce((sum, position) => sum + position.unrealizedPnl!, 0)), positionCount: owned.length }; }), positions, recentDecisions: manager.database.raw.prepare('SELECT id,strategy_id AS strategyId,symbol,action,confidence,rationale,status,created_at AS createdAt FROM decisions ORDER BY created_at DESC LIMIT 8').all(), recentRisks: manager.database.raw.prepare('SELECT id,strategy_id AS strategyId,severity,code,message,created_at AS createdAt FROM risk_events ORDER BY created_at DESC LIMIT 8').all(), health: manager.health(), risk: riskView(manager) };
}

function riskView(manager: AgenticManager): Record<string, unknown> {
  const config = manager.database.getGlobalRisk(); const unknownBasis=manager.ledger.listPositions().some(p=>p.unrealizedPnl===null);const positionsForContext=manager.ledger.listPositions(),cashForContext=manager.database.listStrategies().reduce((n,s)=>n+s.cash,0);const context=unknownBasis?{accountEquity:cashForContext+positionsForContext.reduce((n,p)=>n+p.marketValue,0),accountCash:cashForContext,dailyPnl:null,weeklyPnl:null,sectorExposure:positionsForContext.reduce<Record<string,number>>((n,p)=>({...n,[p.sector]:(n[p.sector]??0)+p.marketValue}),{}),reconciliationClear:manager.database.getSetting('reconciliation_clear',false)}:manager.risk.defaultContext(); const positions = manager.ledger.listPositions(); const exposure = positions.reduce((sum, position) => sum + position.marketValue, 0); const ticker = Object.entries(positions.reduce<Record<string, number>>((accumulator, position) => ({ ...accumulator, [position.symbol]: (accumulator[position.symbol] ?? 0) + position.marketValue }), {})).sort((a, b) => b[1] - a[1]);
  return { config, utilization: { exposure: { current: exposure, limit: context.accountEquity * config.maxTotalExposurePercent / 100 }, cashReserve: { current: context.accountCash, minimum: config.minimumReservedCash }, dailyLoss: { current: context.dailyPnl===null?null:Math.max(0, -context.dailyPnl), limit: context.accountEquity * config.maxDailyDrawdownPercent / 100 }, weeklyLoss: { current: context.weeklyPnl===null?null:Math.max(0, -context.weeklyPnl), limit: context.accountEquity * config.maxWeeklyDrawdownPercent / 100 } }, tickerConcentrations: ticker.map(([symbol, value]) => ({ symbol, value, percent: context.accountEquity ? value / context.accountEquity * 100 : 0 })), sectorConcentrations: Object.entries(context.sectorExposure).map(([sector, value]) => ({ sector, value, percent: context.accountEquity ? value / context.accountEquity * 100 : 0 })), events: manager.database.raw.prepare('SELECT * FROM risk_events ORDER BY created_at DESC LIMIT 100').all(), reconciliationClear: context.reconciliationClear };
}

function performanceView(manager: AgenticManager, from?: string, to?: string): Record<string, unknown> {
  const clauses: string[] = []; const parameters: string[] = []; if (from) { clauses.push('created_at>=?'); parameters.push(new Date(from).toISOString()); } if (to) { clauses.push('created_at<=?'); parameters.push(new Date(to).toISOString()); } const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const snapshots = manager.database.raw.prepare(`SELECT strategy_id AS strategyId,equity,cash,exposure,realized_pnl AS realizedPnl,unrealized_pnl AS unrealizedPnl,drawdown_percent AS drawdownPercent,benchmark_value AS benchmarkValue,created_at AS createdAt FROM performance_snapshots ${where} ORDER BY created_at`).all(...parameters);
  const comparison = manager.database.listStrategies().map((strategy) => { const trades = manager.database.raw.prepare("SELECT COUNT(*) AS count,SUM(CASE WHEN amount>0 THEN 1 ELSE 0 END) AS wins,COALESCE(SUM(amount),0) AS pnl FROM realized_pnl WHERE strategy_id=?").get(strategy.id) as { count: number; wins: number; pnl: number }; const turnover = manager.database.raw.prepare('SELECT COALESCE(SUM(quantity*price),0) AS value FROM strategy_fills WHERE strategy_id=?').get(strategy.id) as { value: number }; return { strategyId: strategy.id, name: strategy.name, realizedPnl: roundMoney(trades.pnl), winRate: trades.count ? trades.wins / trades.count * 100 : 0, trades: trades.count, turnover: roundMoney(turnover.value), returnPercent: strategy.allocationAmount ? trades.pnl / strategy.allocationAmount * 100 : 0 }; });
  return { snapshots, comparison, disclaimer: 'Simulation results are not evidence of future returns.' };
}

function generateDailyBrief(manager: AgenticManager): Record<string, unknown> { const state = dashboard(manager); return { date: nowIso().slice(0, 10), mode: manager.database.getMode(), simulationLabel: manager.database.getMode() === 'SIMULATION' ? 'SIMULATED DATA' : null, account: state.metrics, strategies: state.strategies, trades: manager.database.raw.prepare("SELECT symbol,side,quantity,status,created_at AS createdAt FROM orders WHERE created_at>=date('now') ORDER BY created_at").all(), decisions: state.recentDecisions, openRisks: manager.database.raw.prepare("SELECT severity,code,message,created_at AS createdAt FROM risk_events WHERE acknowledged_at IS NULL ORDER BY created_at DESC LIMIT 20").all(), nextEvaluations: manager.database.listStrategies().map((strategy) => ({ strategy: strategy.name, schedule: strategy.config.schedule })) }; }
