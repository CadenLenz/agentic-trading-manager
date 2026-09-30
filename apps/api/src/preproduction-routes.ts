import {OPENAI_CONNECTION_CONFIRMATION} from '../../../packages/trading-v2/src/connection-contract.js';
import {connectionSetup,ConnectionSetupError,robinhoodFailure} from '../../../packages/trading-v2/src/connection-setup.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import type {AgenticManager} from '../../../packages/core/src/agentic-manager.js';
import {riskConfigurationSchema} from '../../../packages/trading-v2/src/configuration.js';
import {notificationPreferencesSchema} from '../../../packages/trading-v2/src/notifications.js';
import {readinessStageSchema} from '../../../packages/trading-v2/src/readiness.js';
import {connectorReadSchema} from '../../../packages/trading-v2/src/connectors.js';
import {prepareEmergencyCloses} from '../../../packages/trading-v2/src/emergency.js';
import {pacificPeriodStart} from '../../../packages/trading-v2/src/periods.js';
import {verifyManualPreview} from '../../../packages/trading-v2/src/commissioning.js';
const actor=(r:FastifyRequest)=>r.authUser!.username;
const id=(r:FastifyRequest)=>z.object({id:z.string().min(1).max(200)}).parse(r.params).id;
export function reauthKey(who:string,csrf:string){return 'reauth:'+who+':'+createHash('sha256').update(csrf).digest('hex');}
export function requireRecentAuth(m:AgenticManager,who:string,csrf:string){if(Date.now()-m.database.getSetting<number>(reauthKey(who,csrf),0)>300000)throw Object.assign(new Error('Confirm your app password in the password check before making this change. The check lasts five minutes.'),{statusCode:403});}
export function registerPreproduction(app:FastifyInstance,m:AgenticManager){
  app.post('/api/v2/reauth',{config:{rateLimit:{max:5,timeWindow:'15 minutes'}}},async r=>{const b=z.object({password:z.string().min(1).max(200)}).strict().parse(r.body);if(!await m.auth.authenticate(actor(r),b.password))throw Object.assign(new Error('That app password did not match. Try the password you use to sign in here; your account connection was not changed.'),{statusCode:403});m.database.setSetting(reauthKey(actor(r),r.authUser!.csrf),Date.now());return {validForSeconds:300};});
  app.get('/api/v2/risk-configuration',async()=>({...m.riskConfiguration.current(),descriptors:m.riskConfiguration.descriptors(),history:m.riskConfiguration.history()}));
  app.post('/api/v2/risk-configuration/preview',async r=>m.riskConfiguration.preview(r.body));
  app.post('/api/v2/risk-configuration/apply',async r=>{const b=z.object({config:riskConfigurationSchema,expectedVersion:z.number().int().nonnegative(),reason:z.string().min(20),confirmation:z.literal('APPLY RISK CONFIGURATION')}).strict().parse(r.body);requireRecentAuth(m,actor(r),r.authUser!.csrf);return m.riskConfiguration.apply(b.config,b.expectedVersion,actor(r),b.reason,b.confirmation);});
  app.post('/api/v2/risk-configuration/rollback',async r=>{const b=z.object({version:z.number().int().nonnegative(),reason:z.string().min(20),confirmation:z.literal('APPLY RISK CONFIGURATION')}).strict().parse(r.body);requireRecentAuth(m,actor(r),r.authUser!.csrf);return m.riskConfiguration.rollback(b.version,actor(r),b.reason,b.confirmation);});
  app.get('/api/v2/simulations',async()=>m.fullSimulation.list());
  app.post('/api/v2/simulations',async r=>{const b=z.object({speed:z.union([z.literal(0),z.literal(1),z.literal(5),z.literal(20)])}).strict().parse(r.body);return m.fullSimulation.start(actor(r),b.speed);});
  app.get('/api/v2/simulations/:id',async r=>m.fullSimulation.get(id(r)));
  app.get('/api/v2/simulations/:id/export',async(r,reply)=>reply.header('Content-Disposition','attachment; filename="simulation-report.json"').send(m.fullSimulation.get(id(r))));
  app.post('/api/v2/simulations/:id/speed',async r=>{const b=z.object({speed:z.number()}).strict().parse(r.body);return m.fullSimulation.speed(id(r),b.speed);});
  app.post('/api/v2/simulations/:id/cancel',async r=>{m.fullSimulation.cancel(id(r));return {cancelRequested:true};});
  app.get('/api/v2/charts',async r=>{const q=z.object({period:z.string().default('1D'),strategy:z.string().optional(),instrument:z.string().optional()}).parse(r.query);return m.analytics.series(q.period,q.strategy,q.instrument);});
  app.get('/api/v2/performance-summary',async()=>({timeZone:'America/Los_Angeles',today:m.analytics.performance(pacificPeriodStart('DAY')),week:m.analytics.performance(pacificPeriodStart('WEEK'))}));
  app.get('/api/v2/options/:id/telemetry',async r=>m.analytics.optionDetail(id(r)));
  app.get('/api/v2/options-history',async()=>m.database.raw.prepare('SELECT * FROM option_positions ORDER BY updated_at DESC LIMIT 200').all());
  app.get('/api/v2/notifications',async()=>({notifications:m.notifications.list(),preferences:m.notifications.preferences(),deliveries:m.database.raw.prepare('SELECT * FROM notification_deliveries ORDER BY updated_at DESC LIMIT 100').all()}));
  app.post('/api/v2/notifications/preferences',async r=>{const b=notificationPreferencesSchema.parse(r.body);return m.notifications.update(b,actor(r));});
  app.post('/api/v2/notifications/:id/read',async r=>{m.notifications.markRead(id(r));return {ok:true};});
  app.get('/api/v2/connections',async r=>({connectors:m.connectors.list(),diagnostics:m.database.getSetting('robinhood_diagnostics',[]),setup:{...connectionSetup(),accountMapped:!!process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID?.trim(),brokerTransport:m.connectors.robinhood.usesWorker?"CODEX_WORKER":"DIRECT_OAUTH",bindingConfigured:m.connectors.robinhood.usesWorker||!!process.env.ROBINHOOD_BINDING_FILE?.trim(),mode:m.database.getMode()},network:{remoteAddress:r.raw.socket.remoteAddress,forwardedProto:typeof r.headers['x-forwarded-proto']==='string'?r.headers['x-forwarded-proto']:null,expectedLoopback:r.raw.socket.remoteAddress==='127.0.0.1'||r.raw.socket.remoteAddress==='::1',trustProxy:false,warning:'Headers are observational only. Tailnet ACLs and application auth enforce access.'}}));
  app.post('/api/v2/connections/openai/test',async()=>m.connectors.testOpenAI());
  app.post('/api/v2/connections/openai/connect',async r=>{requireRecentAuth(m,actor(r),r.authUser!.csrf);const b=z.object({key:z.string().min(20).max(500),model:z.string().min(1).max(200),confirmation:z.literal(OPENAI_CONNECTION_CONFIRMATION)}).strict().parse(r.body);return m.connectors.configureOpenAI(b.key,b.model,actor(r));});
  app.post('/api/v2/connections/robinhood/connect',async r=>{requireRecentAuth(m,actor(r),r.authUser!.csrf);return m.connectors.robinhood.connect(actor(r));});
  app.post('/api/v2/connections/robinhood/disconnect',async r=>{requireRecentAuth(m,actor(r),r.authUser!.csrf);z.object({confirmation:z.literal('FORGET ROBINHOOD AUTHORIZATION')}).strict().parse(r.body);return m.connectors.robinhood.disconnect(actor(r));});
  app.post('/api/v2/connections/robinhood/test',async r=>m.connectors.robinhood.check(actor(r)));
  app.get('/api/v2/connections/robinhood/catalog',async()=>m.connectors.robinhood.catalog());
  app.post('/api/v2/connections/robinhood/read',async r=>{const b=connectorReadSchema.parse(r.body);const result=await m.connectors.robinhood.call(b.tool,b.arguments);m.database.audit(actor(r),'OFFICIAL_MCP_READ','connector','ROBINHOOD',{tool:b.tool});return result;});
  app.get('/api/v2/connections/robinhood/callback',async(r,reply)=>{const q=z.object({state:z.string().optional(),code:z.string().optional(),error:z.string().optional()}).parse(r.query);try{if(q.error||!q.state||!q.code)throw new ConnectionSetupError('BROKER_LOGIN_CANCELLED','Robinhood sign-in was not completed. Choose Connect Robinhood to try again.');await m.connectors.robinhood.finishCallback(q.state,q.code);return reply.redirect('/?connection=robinhood');}catch(error){const failure=robinhoodFailure(error);if(connectionSetup().ready)m.connectors.robinhood.recordDiagnostic('CALLBACK',failure.code,'ERROR');return reply.redirect('/?connectionError='+encodeURIComponent(failure.code));}});
  app.get('/api/v2/production-readiness',async()=>m.productionReadiness.state());
  app.post('/api/v2/commissioning/preview',async r=>{requireRecentAuth(m,actor(r),r.authUser!.csrf);return verifyManualPreview(m.proposals,r.body,actor(r));});
  app.post('/api/v2/production-readiness',async r=>{const b=z.object({stage:readinessStageSchema,confirmation:z.string()}).strict().parse(r.body);return m.productionReadiness.transition(b.stage,actor(r),b.confirmation);});
  app.post('/api/v2/pi-acceptance',async()=>m.piAcceptance.run());
  app.get('/api/v2/pi-acceptance/context',async()=>({hostFingerprint:m.piAcceptance.fingerprint()}));
  app.post('/api/v2/pi-acceptance/evidence',async r=>{requireRecentAuth(m,actor(r),r.authUser!.csrf);return m.piAcceptance.attest(r.body,actor(r));});
  app.get('/api/v2/pi-acceptance',async()=>m.database.raw.prepare("SELECT * FROM acceptance_runs WHERE kind='PI_ACCEPTANCE' ORDER BY created_at DESC LIMIT 20").all());
  app.get('/api/v2/broker-events',async()=>m.database.raw.prepare('SELECT * FROM broker_events ORDER BY created_at DESC LIMIT 200').all());
  app.post('/api/v2/broker-events',async r=>m.brokerEvents.ingest(r.body,actor(r)));
  app.post('/api/v2/broker-events/:id/apply',async r=>{const b=z.object({confirmation:z.literal('APPLY VERIFIED BROKER EVENT'),review:z.string().min(20)}).strict().parse(r.body);requireRecentAuth(m,actor(r),r.authUser!.csrf);return m.brokerEvents.apply(id(r),actor(r),b.confirmation,b.review);});
  app.post('/api/v2/emergency',async r=>{const b=z.object({action:z.enum(['STOP_NEW_TRADES','CANCEL_OPEN_ENTRIES','PAUSE_SAFE','PAUSE_AGGRESSIVE','PAUSE_OPTIONS','CLOSE_AGGRESSIVE','CLOSE_OPTIONS','LIQUIDATE_ALL']),confirmation:z.string(),reason:z.string().min(20)}).strict().parse(r.body);
    if(b.confirmation!==b.action)throw new Error('Exact emergency action confirmation required');if(b.action==='STOP_NEW_TRADES'){m.database.setSetting('global_pause',true);m.database.setSetting('stopped',true);m.database.setSetting('v2_live_activation',false);m.database.setSetting('live_db_confirmation',false);m.notifications.emit('stop:'+Date.now(),'STOP','CRITICAL',{summary:b.reason});}
    else if(b.action.startsWith('PAUSE_'))m.database.setStrategyEnabled(b.action==='PAUSE_SAFE'?'SAFE_LONG_TERM':b.action==='PAUSE_AGGRESSIVE'?'AGGRESSIVE_STOCKS':'OPTIONS',false,actor(r),b.reason);
    else{requireRecentAuth(m,actor(r),r.authUser!.csrf);if(b.action==='CANCEL_OPEN_ENTRIES'){for(const p of m.proposals.list().filter(p=>p.positionEffect==='OPEN'&&['BROKER_ACCEPTED','PARTIALLY_FILLED'].includes(p.state)))await m.proposals.cancel(p.id,actor(r));}else{m.database.setSetting('global_pause',true);return prepareEmergencyCloses(m.proposals,b.action==='CLOSE_AGGRESSIVE'?'AGGRESSIVE_STOCKS':b.action==='CLOSE_OPTIONS'?'OPTIONS':null,actor(r),b.reason);}}
    m.database.audit(actor(r),'EMERGENCY_CONTROL','system',null,b);return {ok:true,action:b.action};
  });
}
