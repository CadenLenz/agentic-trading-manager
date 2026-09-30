import {taskSettings} from '../../../packages/agents/src/task-contract.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {AgenticManager} from '../../../packages/core/src/agentic-manager.js';
import {SLEEVES,agentModeSchema,sleeveSchema,sleevePolicySchema,accountPolicySchema,DEFAULT_ACCOUNT_POLICY} from '../../../packages/trading-v2/src/model.js';
import {nowIso} from '../../../packages/core/src/utils.js';
import {runSelfTests} from '../../../packages/trading-v2/src/self-tests.js';
const actor=(r:FastifyRequest)=>r.authUser!.username;
const params=(r:FastifyRequest)=>z.object({id:z.string().min(1).max(200)}).parse(r.params).id;
export function readiness(m:AgenticManager){
  const db=m.database,a=db.getSetting<{accountId:string;optionsLevel:number;agentic:boolean;complete:boolean;asOf:string}|null>('broker_account_v2',null);
  const checks={ownershipReviewed:!db.getSetting('v2_migration_review_required',false),reconciled:db.getSetting('reconciliation_clear',false),
    accountFresh:!!a&&Date.now()-Date.parse(a.asOf)<=60000&&Date.now()-Date.parse(a.asOf)>=-5000,accountScope:!!a?.agentic&&!!a.complete&&a.accountId===process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID,readOnlyVerification:['READ_ONLY','LIVE'].includes(db.getSetting('broker_verification_mode_v2','SIMULATION')),
    optionsLevel:a?.optionsLevel===2,selfTests:db.getSetting('self_tests_v2',false),simulatedLifecycle:db.getSetting('simulated_lifecycle_v2',false),
    deterministicBroker:!!m.liveBroker.deterministic,verifiedMarketData:m.market.tradingEligible,
    calendarFresh:!!db.raw.prepare('SELECT date FROM market_sessions WHERE opens_at<=? AND closes_at>? AND verified_at>?').get(nowIso(),nowIso(),new Date(Date.now()-7*86400000).toISOString())};
  return {ready:Object.values(checks).every(Boolean),checks,liveActivation:db.getSetting('v2_live_activation',false),mode:db.getMode(),
    schemaVersion:(db.raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {v:number}).v,gitSha:process.env.APP_GIT_SHA??'unrecorded',version:'2.0.0',uptime:m.health().uptimeSeconds,
    limitation:'LIVE remains locked pending complete reconciliation, execution-grade market data, preview and placement commissioning'};
}
export function registerV2(app:FastifyInstance,m:AgenticManager){
  const db=m.database;
  app.get('/api/v2/codex/status',()=>m.codexTasks.status());
  app.get('/api/v2/codex/tasks',async()=>m.codexTasks.list());
  app.post('/api/v2/codex/tasks',async r=>{const b=z.object({message:z.string().min(1).max(12000),id:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional()}).strict().parse(r.body);return m.codexTasks.create(b.message,actor(r),b.id?{id:b.id}:undefined);});
  app.post('/api/v2/codex/tasks/:id/cancel',r=>m.codexTasks.cancel(params(r),actor(r)));
  app.get('/api/v2/codex/schedules',async()=>m.codexTasks.schedules());
  app.post('/api/v2/codex/schedules',async r=>m.codexTasks.schedule(r.body,actor(r)));
  app.post('/api/v2/codex/schedules/:id',async r=>m.codexTasks.schedule(r.body,actor(r),params(r)));
  app.post('/api/v2/codex/settings',async r=>m.codexTasks.configure(taskSettings.parse(r.body),actor(r)));

  app.get('/api/v2/state',async()=>({account:db.getSetting('broker_account_v2',null),sleeves:SLEEVES.map(s=>({...m.allocation.state(s),enabled:db.getStrategy(s)!.enabled,target:(db.getSetting<{netAccountValue:number}|null>('broker_account_v2',null)?.netAccountValue??0)*m.allocation.policy(s).targetWeight,openOrders:(db.raw.prepare("SELECT COUNT(*) AS n FROM orders WHERE strategy_id=? AND status IN ('PENDING','SUBMITTED','PARTIALLY_FILLED','UNKNOWN')").get(s) as {n:number}).n})),readiness:readiness(m),globalPause:db.getSetting('global_pause',false),stopped:db.getSetting('stopped',false),maintenance:db.getSetting('maintenance_mode',false),reconciliation:db.getSetting('reconciliation_v2',[]),policy:db.getSetting('account_policy_v2',DEFAULT_ACCOUNT_POLICY)}));
  app.get('/api/v2/proposals',async()=>m.proposals.list());
  app.get('/api/v2/proposals/:id',async r=>m.proposals.detail(params(r)));
  app.post('/api/v2/proposals',async r=>m.proposals.create(r.body,actor(r)));
  app.post('/api/v2/proposals/:id/modify',async r=>m.proposals.modify(params(r),r.body,actor(r)));
  app.post('/api/v2/proposals/:id/research',async r=>m.proposals.research(params(r),r.body,actor(r)));
  app.post('/api/v2/proposals/:id/review',async r=>m.proposals.review(params(r),actor(r)));
  app.post('/api/v2/proposals/:id/approve',async r=>{const b=z.object({version:z.number().int().positive(),confirmation:z.literal('APPROVE EXECUTION')}).strict().parse(r.body);return m.proposals.approve(params(r),b.version,actor(r));});
  app.post('/api/v2/proposals/:id/execute',async r=>m.proposals.execute(params(r),actor(r)));
  app.post('/api/v2/proposals/:id/cancel',async r=>m.proposals.cancel(params(r),actor(r)));
  app.post('/api/v2/reconciliation',async()=>m.proposals.reconcile());
  app.post('/api/v2/allocation',async r=>{z.object({confirmation:z.literal('RECOMPUTE WEEKLY ALLOCATION')}).strict().parse(r.body);await m.proposals.reconcile();if(!db.getSetting('reconciliation_clear',false))throw new Error('Reconciliation required');return m.allocation.weekly(db.getSetting<{netAccountValue:number}>('broker_account_v2').netAccountValue,actor(r));});
  app.post('/api/v2/position-transfer',async r=>{const b=z.object({from:sleeveSchema,to:sleeveSchema,symbol:z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/),quantity:z.number().positive(),reason:z.string().min(20),confirmation:z.literal('TRANSFER OWNERSHIP')}).strict().parse(r.body);m.allocation.transferPosition(b.from,b.to,b.symbol,b.quantity,b.reason,actor(r));return {ok:true};});
  app.post('/api/v2/sleeves/:id/reset',async r=>{const s=sleeveSchema.parse(params(r)),b=z.object({confirmation:z.string(),review:z.string().min(20)}).strict().parse(r.body);m.allocation.reset(s,b.confirmation,b.review,actor(r));return {ok:true};});
  app.post('/api/v2/sleeves/:id/policy',async r=>{const s=sleeveSchema.parse(params(r)),b=z.object({policy:sleevePolicySchema,confirmation:z.string(),review:z.string().min(20)}).strict().parse(r.body);if(b.confirmation!=='UPDATE '+s+' POLICY')throw new Error('Exact per-sleeve policy confirmation phrase required');return m.allocation.updatePolicy(s,b.policy,actor(r));});
  app.post('/api/v2/sleeves/:id/weight',async r=>{const s=sleeveSchema.parse(params(r)),b=z.object({weight:z.number().min(0).max(1),confirmation:z.literal('UPDATE ALLOCATION WEIGHTS')}).strict().parse(r.body);m.allocation.setWeight(s,b.weight,actor(r));return {ok:true};});
  app.get('/api/v2/scheduler',async()=>m.tradingScheduler.list());
  app.post('/api/v2/scheduler/:id',async r=>{const b=z.object({cron:z.string().max(100),enabled:z.boolean()}).strict().parse(r.body);m.tradingScheduler.update(params(r),b.cron,b.enabled,actor(r));return {ok:true};});
  app.get('/api/v2/readiness',async()=>readiness(m));
  app.post('/api/v2/self-tests',async r=>{const result=await runSelfTests();db.setSetting('self_tests_v2',result.ok);db.setSetting('simulated_lifecycle_v2',result.ok);db.audit(actor(r),'ISOLATED_SELF_TESTS','system',null,result);return result;});
  app.post('/api/v2/stop-release',async r=>{z.object({confirmation:z.literal('RELEASE STOP'),review:z.string().min(20)}).strict().parse(r.body);db.setSetting('stopped',false);db.audit(actor(r),'STOP_RELEASED','system',null,r.body);return {stopped:false,globalPause:db.getSetting('global_pause',true)};});
  app.post('/api/v2/upgrade-review',async r=>{const b=z.object({confirmation:z.literal('ACCEPT MIGRATED OWNERSHIP'),review:z.string().min(20)}).strict().parse(r.body);await m.proposals.reconcile();if(!db.getSetting('reconciliation_clear',false))throw new Error('Reconcile and explicitly assign external holdings first');db.setSetting('v2_migration_review_required',false);db.audit(actor(r),'MIGRATION_OWNERSHIP_REVIEW','system',null,b);return {ok:true};});
  app.post('/api/v2/account-policy',async r=>{const b=z.object({policy:accountPolicySchema,confirmation:z.literal('UPDATE ACCOUNT RISK POLICY')}).strict().parse(r.body);db.setSetting('account_policy_v2',b.policy);db.audit(actor(r),'ACCOUNT_POLICY_V2_UPDATED','system',null,b);return b.policy;});
  app.post('/api/v2/reports',async r=>{const b=z.object({kind:z.enum(['DAILY_REPORT','WEEKLY_REPORT'])}).strict().parse(r.body);return m.proposals.report(b.kind);});
  app.get('/api/v2/resources/:id',async r=>{
    const queries:Record<string,string>={orders:'SELECT * FROM orders ORDER BY created_at DESC LIMIT 200',fills:'SELECT * FROM fills ORDER BY executed_at DESC LIMIT 200',positions:'SELECT * FROM strategy_positions WHERE quantity>0',options:'SELECT * FROM option_positions WHERE contracts<>0',ledger:'SELECT * FROM virtual_transactions ORDER BY created_at DESC LIMIT 200',audit:'SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 200',reports:'SELECT * FROM trading_reports ORDER BY created_at DESC LIMIT 100',risk:'SELECT * FROM risk_decisions_v2 ORDER BY created_at DESC LIMIT 200',pending:"SELECT * FROM proposals WHERE state='READY_TO_EXECUTE' ORDER BY created_at DESC",assignments:'SELECT * FROM position_assignments ORDER BY created_at DESC LIMIT 200'};
    const sql=queries[params(r)];if(!sql)throw Object.assign(new Error('Unknown resource'),{statusCode:404});return db.raw.prepare(sql).all();
  });
  app.get('/api/v2/agent/sessions',async r=>m.tradingAgent.sessions(actor(r)));
  app.post('/api/v2/agent/sessions',async r=>{const b=z.object({mode:agentModeSchema}).strict().parse(r.body);return m.tradingAgent.create(actor(r),b.mode);});
  app.get('/api/v2/agent/sessions/:id',async r=>({session:m.tradingAgent.session(params(r),actor(r)),messages:m.tradingAgent.history(params(r),actor(r)),actions:m.tradingAgent.actions(params(r),actor(r))}));
  app.post('/api/v2/agent/sessions/:id/chat',async r=>{const b=z.object({message:z.string().min(1).max(12000)}).strict().parse(r.body);m.tradingAgent.session(params(r),actor(r));return m.codexTasks.create(b.message,actor(r));});
}
