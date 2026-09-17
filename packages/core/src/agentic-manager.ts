import { existsSync } from 'node:fs';
import { join,dirname } from 'node:path';
import {tmpdir} from 'node:os';
import type { HealthReport, TradeProposal } from './types.js';
import { nowIso,makeId } from './utils.js';
import { EventBus } from './event-bus.js';
import { openDatabase, type AppDatabase } from '../../database/src/database.js';
import { VirtualPortfolioLedger } from '../../ledger/src/virtual-ledger.js';
import { DirectiveService } from '../../strategies/src/directive-service.js';
import { RiskEngine } from '../../risk/src/risk-engine.js';
import { SimulationMarketDataProvider, WatcherEngine, type MarketDataProvider } from '../../market-data/src/provider.js';
import { SimulationBroker } from '../../execution/src/simulation-broker.js';
import { CodexRunner } from '../../agents/src/codex-runner.js';
import { RobinhoodMcpAdapter } from '../../robinhood/src/adapter.js';
import { ExecutionEngine } from '../../execution/src/execution-engine.js';
import { ReconciliationEngine } from '../../reconciliation/src/reconciliation-engine.js';
import { JobQueue } from '../../agents/src/job-queue.js';
import { AgentOrchestrator } from '../../agents/src/orchestrator.js';
import { ManagerChatService } from '../../agents/src/manager-chat.js';
import { AuthService } from '../../auth/src/auth-service.js';
import { Scheduler } from './scheduler.js';
import { JOB_PRIORITY } from '../../agents/src/job-queue.js';
import { StrategyAllocationManager } from '../../trading-v2/src/capital.js';
import { ProposalService } from '../../trading-v2/src/proposals.js';
import { SimulationTradingBroker } from '../../trading-v2/src/broker.js';
import {VerifiedReadOnlyMcpBroker} from '../../trading-v2/src/mcp-binding.js';
import { PersistentTradingAgent } from '../../trading-v2/src/agent.js';
import { PersistedTradingScheduler } from '../../trading-v2/src/scheduling.js';
import type { TradingBroker } from '../../trading-v2/src/model.js';
import {RiskConfigurationService} from '../../trading-v2/src/configuration.js';
import {PortfolioAnalytics} from '../../trading-v2/src/analytics.js';
import {NotificationService} from '../../trading-v2/src/notifications.js';
import {ConnectorService} from '../../trading-v2/src/connectors.js';
import {FullSystemSimulation} from '../../trading-v2/src/system-simulation.js';
import {ProductionReadiness,PREPRODUCTION_LIVE_LOCK} from '../../trading-v2/src/readiness.js';
import {PiAcceptanceService} from '../../trading-v2/src/pi-acceptance.js';
import {BrokerEventService} from '../../trading-v2/src/broker-events.js';
import {OperationalNotificationMonitor} from '../../trading-v2/src/operational-monitor.js';

export interface ManagerOptions { databasePath: string; workingDirectory: string; sessionSecret: string; startBackgroundServices?: boolean; marketProvider?: MarketDataProvider; liveBroker?: TradingBroker }

export class AgenticManager {
  readonly database: AppDatabase;
  readonly ledger: VirtualPortfolioLedger;
  readonly directives: DirectiveService;
  readonly risk: RiskEngine;
  readonly market: MarketDataProvider;
  readonly simulation: SimulationBroker;
  readonly codex: CodexRunner;
  readonly robinhood: RobinhoodMcpAdapter;
  readonly execution: ExecutionEngine;
  readonly reconciliation: ReconciliationEngine;
  readonly events = new EventBus();
  readonly watcher: WatcherEngine;
  readonly jobs: JobQueue;
  readonly agents: AgentOrchestrator;
  readonly chat: ManagerChatService;
  readonly auth: AuthService;
  readonly scheduler = new Scheduler();
  readonly allocation: StrategyAllocationManager;
  readonly proposals: ProposalService;
  readonly tradingAgent: PersistentTradingAgent;
  readonly tradingScheduler: PersistedTradingScheduler;
  readonly riskConfiguration:RiskConfigurationService;
  readonly analytics:PortfolioAnalytics;
  readonly notifications:NotificationService;
  readonly connectors:ConnectorService;
  readonly fullSimulation:FullSystemSimulation;
  readonly productionReadiness:ProductionReadiness;
  readonly piAcceptance:PiAcceptanceService;
  readonly brokerEvents:BrokerEventService;
  readonly operationalMonitor:OperationalNotificationMonitor;
  private startedAt = Date.now();
  private ready = false;

  constructor(readonly options: ManagerOptions) {
    this.database = openDatabase(options.databasePath);
    this.ledger = new VirtualPortfolioLedger(this.database);
    this.directives = new DirectiveService(this.database);
    this.risk = new RiskEngine(this.database, this.ledger, this.directives);
    this.market = options.marketProvider ?? new SimulationMarketDataProvider();
    this.database.setSetting('market_data_trading_eligible', this.market.tradingEligible);
    this.simulation = new SimulationBroker(this.ledger);
    this.codex = new CodexRunner();
    this.robinhood = new RobinhoodMcpAdapter(this.codex, options.workingDirectory);
    this.execution = new ExecutionEngine(this.database, this.ledger, this.risk, this.simulation, this.robinhood);
    this.reconciliation = new ReconciliationEngine(this.database, this.ledger);
    this.watcher = new WatcherEngine(this.market, this.database, this.ledger);
    this.jobs = new JobQueue(this.database);
    this.agents = new AgentOrchestrator(this.database, this.market, this.codex, options.workingDirectory);
    this.chat = new ManagerChatService(this.database);
    this.auth = new AuthService(this.database, options.sessionSecret);
    this.allocation = new StrategyAllocationManager(this.database,this.ledger);
    const dataDirectory=options.databasePath===':memory:'?join(tmpdir(),makeId('atm-test-manager')):dirname(options.databasePath);
    this.riskConfiguration=new RiskConfigurationService(this.database);this.analytics=new PortfolioAnalytics(this.database,this.ledger,this.allocation);
    this.notifications=new NotificationService(this.database);this.connectors=new ConnectorService(this.database,join(dataDirectory,'connectors'),options.sessionSecret);
    this.operationalMonitor=new OperationalNotificationMonitor(this.database,this.notifications,()=>this.health(),()=>this.connectors.list().find(c=>c.id==='ROBINHOOD')!);
    this.fullSimulation=new FullSystemSimulation(this.database,join(dataDirectory,'simulations'),event=>{this.events.publish({type:'SIMULATION_EVENT',severity:'INFO',source:'SIMULATION',payload:{...event}});});
    this.productionReadiness=new ProductionReadiness(this.database);this.piAcceptance=new PiAcceptanceService(this.database,join(dataDirectory,'acceptance-backups'));
    this.brokerEvents=new BrokerEventService(this.database,this.ledger,this.analytics);
    const simBroker=new SimulationTradingBroker(this.database,this.ledger,this.market),liveBroker=options.liveBroker??new VerifiedReadOnlyMcpBroker(this.connectors.robinhood);
    this.proposals=new ProposalService(this.database,this.ledger,this.allocation,()=>this.database.getMode()==='SIMULATION'?simBroker:liveBroker);
    this.proposals.reporter=kind=>this.analytics.report(kind);
    this.proposals.onQuote=(p,q)=>{if(p.option)this.analytics.recordOption(p.option.optionId,q);};
    this.proposals.onEvent=(kind,detail)=>{try{this.events.publish({type:kind,severity:kind==='RECONCILIATION_FAILURE'?'CRITICAL':'INFO',source:'V2',payload:detail});
      if(kind==='PROPOSAL_TRANSITION'){const p=this.proposals.get(String(detail.id)),state=String(detail.to);if(['FILLED','PARTIALLY_FILLED'].includes(state))this.analytics.snapshot('FILL');
        const event=state==='PARTIALLY_FILLED'?'PARTIAL_FILL':state==='REJECTED'?'REJECTED':state==='RECONCILIATION_REQUIRED'?'RECONCILIATION_FAILURE':state==='FILLED'?(p.option?'OPTION_'+(p.positionEffect==='OPEN'?'OPENED':'CLOSED'):p.strategy==='AGGRESSIVE_STOCKS'?'AGGRESSIVE_'+(p.positionEffect==='OPEN'?'OPENED':'CLOSED'):'SAFE_TRADE'):null;
        if(event)this.notifications.emit(p.id+':'+state+':'+String(this.database.raw.prepare('SELECT COUNT(*) AS n FROM fills').get()&&(this.database.raw.prepare('SELECT COUNT(*) AS n FROM fills').get() as {n:number}).n),event,state==='RECONCILIATION_REQUIRED'?'CRITICAL':'INFO',{summary:p.symbol+' '+state,proposalId:p.id});
      }else{if(kind==='RECONCILED')this.analytics.snapshot('RECONCILIATION');this.notifications.emit(kind+':'+nowIso(),kind,kind==='RECONCILIATION_FAILURE'?'CRITICAL':'INFO',{summary:kind,...detail});}
    }catch{this.database.audit('OBSERVABILITY','EVENT_SIDE_EFFECT_FAILED','system',null,{kind});}};
    this.tradingAgent=new PersistentTradingAgent(this.database,this.proposals);
    this.tradingAgent.runSimulation=speed=>this.fullSimulation.start('IN_APP_AGENT',speed);
    this.tradingAgent.inspect=area=>{switch(area){case 'RISK_SETTINGS':return {...this.riskConfiguration.current(),descriptors:this.riskConfiguration.descriptors()};case 'CONFIG_HISTORY':return this.riskConfiguration.history();case 'CONNECTORS':return this.connectors.list();case 'HEALTH':return this.health();case 'SCHEDULER':return this.tradingScheduler.list();case 'NOTIFICATIONS':return {preferences:this.notifications.preferences(),events:this.notifications.list()};case 'SIMULATIONS':return this.fullSimulation.list();case 'PROPOSALS':return this.proposals.list();case 'ALLOCATIONS':return ['SAFE_LONG_TERM','AGGRESSIVE_STOCKS','OPTIONS'].map(s=>this.allocation.state(s as import('../../trading-v2/src/model.js').Sleeve));case 'OPTIONS':return this.database.raw.prepare('SELECT * FROM option_positions').all();case 'FILLS':return this.database.raw.prepare('SELECT * FROM fills ORDER BY executed_at DESC LIMIT 100').all();case 'RISK_EVENTS':return this.database.raw.prepare('SELECT * FROM risk_events ORDER BY created_at DESC LIMIT 100').all();default:throw new Error('Unsupported application inspection');}};
    this.tradingScheduler=new PersistedTradingScheduler(this.database,this.proposals,async(sleeve)=>{
      const candidate=this.ledger.listPositions(sleeve)[0]?.symbol;
      if(candidate&&sleeve!=='OPTIONS')await this.agents.analyze(sleeve,candidate,false);
      // Scheduled research is not an autonomous order generator. It never fabricates evidence.
      this.proposals.report('STRATEGY_REVIEW:'+sleeve);
    });
    this.jobs.register('AGENT_REVIEW', async (job, signal) => {
      if (signal.aborted) return;
      const strategyId = String(job.payload.strategyId ?? ''); const symbol = String(job.payload.symbol ?? '');
      if (!this.database.getStrategy(strategyId) || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return;
      await this.agents.analyze(strategyId, symbol, this.database.getSetting<boolean>('codex_reasoning_enabled', false));
    });
    this.watcher.on('event', (event) => {
      this.events.publish({ type: event.type, severity: event.severity, source: 'WATCHER', ...(event.strategyId ? { strategyId: event.strategyId } : {}), ...(event.symbol ? { symbol: event.symbol } : {}), payload: event.payload });
      if (!event.symbol || event.severity === 'CRITICAL') return;
      const owners = this.database.raw.prepare(`SELECT DISTINCT strategy_id AS strategyId FROM strategy_positions WHERE symbol=? UNION SELECT DISTINCT strategy_id AS strategyId FROM watchlists WHERE symbol=?`).all(event.symbol, event.symbol) as Array<{ strategyId: string }>;
      const targets = owners.length ? owners : [{ strategyId: 'AGGRESSIVE_STOCKS' }];
      for (const target of targets) this.jobs.enqueue('AGENT_REVIEW', JOB_PRIORITY.MARKET_EVENT, { strategyId: target.strategyId, symbol: event.symbol, eventType: event.type }, `market-review:${target.strategyId}:${event.symbol}:${event.type}`);
    });
    this.configureSchedules();
  }

  async start(): Promise<void> {
    this.startedAt = Date.now(); this.ready = false; this.database.setSetting('startup_ready', false);
    if(this.database.getMode()==='LIVE'&&(PREPRODUCTION_LIVE_LOCK||process.env.TRADING_MODE!=='LIVE'||process.env.ALLOW_LIVE_TRADING!=='true')){this.database.setSetting('operating_mode','READ_ONLY');this.database.setSetting('v2_live_activation',false);this.database.setSetting('live_db_confirmation',false);this.database.setSetting('global_pause',true);}
    this.directives.expireDue();
    const interrupted=this.database.raw.prepare("SELECT proposal_id FROM executions_v2 WHERE status='PENDING' AND broker_order_id IS NULL").all() as Array<{proposal_id:string}>;
    for(const e of interrupted){if(this.proposals.get(e.proposal_id).state==='EXECUTION_SENT')this.proposals.transition(e.proposal_id,'RECONCILIATION_REQUIRED','STARTUP',{reason:'Interrupted send; never automatically replay placement'});this.database.setSetting('global_pause',true);this.database.setSetting('reconciliation_clear',false);}
    const unknownOrders = this.database.raw.prepare("SELECT COUNT(*) AS count FROM orders WHERE status IN ('PENDING','SUBMITTED','PARTIALLY_FILLED','UNKNOWN')").get() as { count: number };
    if (unknownOrders.count > 0 && this.database.getMode() !== 'SIMULATION') this.database.setSetting('reconciliation_clear', false);
    {
      try { await this.proposals.reconcile(); }
      catch (error) {
        this.database.setSetting('reconciliation_clear', false);
        this.database.setSetting('reconciliation_v2',['Broker account verification failed; LIVE unavailable or broker unhealthy']);
        this.database.setSetting('broker_account_v2',null);
        this.database.audit('STARTUP', 'BROKER_STARTUP_CHECK_FAILED', 'system', null, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (this.options.startBackgroundServices !== false) { this.jobs.start(); this.watcher.start(); this.scheduler.start(); }
    this.ready = true; this.database.setSetting('startup_ready', true);
    this.events.publish({ type: 'SYSTEM_READY', severity: 'INFO', source: 'AGENTIC_MANAGER', payload: { mode: this.database.getMode() } });
  }

  async shutdown(): Promise<void> { this.scheduler.stop(); this.watcher.stop(); this.jobs.stop(); await this.fullSimulation.shutdown(); await this.connectors.robinhood.close(); this.ready = false; this.database.setSetting('startup_ready', false); this.database.close(); }

  health(): HealthReport {
    const mode = this.database.getMode();
    const diskPath = this.options.databasePath === ':memory:' ? this.options.workingDirectory : this.options.databasePath;
    const codexHealth = this.codex.health();
    const connectorStates=this.connectors.list(),openaiState=connectorStates.find(c=>c.id==='OPENAI'),brokerState=connectorStates.find(c=>c.id==='ROBINHOOD');
    return {
      status: this.ready ? (this.database.getSetting<boolean>('reconciliation_clear', false) ? 'healthy' : 'degraded') : 'unhealthy', version: '2.0.0', mode,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1_000), ready: this.ready,
      checks: {
        database: { ok: true, message: 'SQLite available with foreign keys and WAL where persistent.' },
        storage: { ok: diskPath === ':memory:' || existsSync(join(diskPath, '..')) || existsSync(this.options.workingDirectory), message: diskPath },
        codex: { ok: codexHealth.healthy, message: `${codexHealth.active} active, ${codexHealth.queued} queued` },
        reconciliation: { ok: this.database.getSetting<boolean>('reconciliation_clear', true), message: this.database.getSetting<boolean>('reconciliation_clear', true) ? 'Clear' : 'Blocked' },
        watcher: { ok: true, message: this.market.name },
        openai: {ok:openaiState?.state==='CONNECTED',message:openaiState?.state??'DISCONNECTED'},
        revision: {ok:!!process.env.APP_GIT_SHA,message:process.env.APP_GIT_SHA??'Local uncommitted revision; deployed SHA unavailable'},
        schema: {ok:true,message:'Schema '+String((this.database.raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {v:number}).v)},
        broker: {ok:mode==='SIMULATION'||brokerState?.state==='READ_ONLY',message:mode==='SIMULATION'?'Synthetic broker only':brokerState?.state??'DISCONNECTED'},
      }, timestamp: nowIso(),
    };
  }

  async seedDemoData(): Promise<void> {
    if (this.database.getSetting<boolean>('demo_seeded', false)) return;
    const proposals: TradeProposal[] = [
      this.demoProposal('AGGRESSIVE_STOCKS', 'NVDA', 5, 178.42),
      this.demoProposal('SAFE_LONG_TERM', 'VTI', 12, 323.72),
    ];
    for (const proposal of proposals) await this.execution.execute(proposal, `demo:${proposal.strategyId}:${proposal.symbol}`,'SETUP');
    const strategies = this.database.listStrategies();
    const today = new Date();
    for (let offset = 29; offset >= 0; offset -= 1) {
      const date = new Date(today); date.setDate(today.getDate() - offset);
      for (let index = 0; index < strategies.length; index += 1) {
        const strategy = strategies[index]; if (!strategy) continue;
        const drift = (29 - offset) * (index + 1) * 6.2 + Math.sin(offset * 0.8 + index) * 55;
        this.database.raw.prepare('INSERT INTO performance_snapshots(id,strategy_id,equity,cash,exposure,realized_pnl,unrealized_pnl,drawdown_percent,benchmark_value,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(`demo_perf_${strategy.id}_${offset}`, strategy.id, strategy.allocationAmount + drift, strategy.cash, strategy.allocationAmount - strategy.cash, drift * 0.35, drift * 0.65, Math.min(0, Math.sin(offset / 3) * 1.4), 100 + (29 - offset) * 0.18, date.toISOString());
      }
    }
    this.database.raw.prepare('INSERT INTO risk_events(id,strategy_id,severity,code,message,scope,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('demo_risk_position_cap', 'AGGRESSIVE_STOCKS', 'WARNING', 'DEMO_POSITION_CAP', 'Demonstration risk event: sample order would have exceeded the position cap.', 'STRATEGY', '{}', nowIso());
    this.database.setSetting('demo_seeded', true);
  }

  private demoProposal(strategyId: string, symbol: string, quantity: number, marketPrice: number): TradeProposal {
    return { strategyId, symbol, action: 'BUY', orderIntent: { side: 'BUY', quantity, orderType: 'MARKET', timeInForce: 'DAY', assetType: symbol === 'VTI' ? 'ETF' : 'EQUITY' }, confidence: 0.5, thesis: 'Clearly labeled demonstration position for validating virtual ownership and accounting.', timeHorizon: 'Simulation only', riskFactors: ['Synthetic data'], invalidationConditions: ['Demo reset'], requestedCapital: quantity * marketPrice, requiresImmediateAction: false, marketPrice, marketDataAsOf: nowIso(), sector: symbol === 'NVDA' ? 'Technology' : 'Diversified', source: 'SIMULATION' };
  }

  private configureSchedules(): void {
    this.scheduler.every('v2-persisted-jobs',15000,async()=>{await this.tradingScheduler.tick();});
    this.scheduler.every('directive-expiry', 60_000, async () => { this.directives.expireDue(); });
    this.scheduler.every('performance-snapshot', 15 * 60_000, async () => { this.recordPerformance(); });
    this.scheduler.every('v2-equity-snapshot',2*60_000,async()=>{this.analytics.snapshot('PERIODIC');});
    this.scheduler.every('notification-delivery',30_000,async()=>{await this.notifications.deliver();});
    this.scheduler.every('operational-notifications',20_000,async()=>{this.operationalMonitor.tick();});
    this.scheduler.every('reconciliation',60_000, async () => {
      try {
        await this.proposals.reconcile();
      } catch (error) {
        this.database.setSetting('reconciliation_clear', false);
        this.database.audit('SCHEDULER', 'RECONCILIATION_FAILED', 'system', null, { error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  private recordPerformance(): void {
    for (const strategy of this.database.listStrategies()) {
      const sleeve=this.allocation.state(strategy.id as import('../../trading-v2/src/model.js').Sleeve);
      const exposure=sleeve.capitalAtRisk,unrealized=sleeve.unrealizedPnL,realized=sleeve.realizedPnL,equity=sleeve.currentEquity;
      const peakRow = this.database.raw.prepare('SELECT MAX(equity) AS peak FROM performance_snapshots WHERE strategy_id=?').get(strategy.id) as { peak: number | null }; const peak = Math.max(strategy.allocationAmount, peakRow.peak ?? 0, equity); const drawdown = peak ? Math.min(0, (equity - peak) / peak * 100) : 0;
      this.database.raw.prepare('INSERT INTO performance_snapshots(id,strategy_id,equity,cash,exposure,realized_pnl,unrealized_pnl,drawdown_percent,benchmark_value,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(`perf_${strategy.id}_${Date.now()}`, strategy.id, equity, strategy.cash, exposure, realized, unrealized, drawdown, null, nowIso());
    }
  }
}
