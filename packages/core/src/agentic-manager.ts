import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HealthReport, TradeProposal } from './types.js';
import { nowIso } from './utils.js';
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

export interface ManagerOptions { databasePath: string; workingDirectory: string; sessionSecret: string; startBackgroundServices?: boolean; marketProvider?: MarketDataProvider }

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
      const targets = owners.length ? owners : [{ strategyId: 'day-trader' }];
      for (const target of targets) this.jobs.enqueue('AGENT_REVIEW', JOB_PRIORITY.MARKET_EVENT, { strategyId: target.strategyId, symbol: event.symbol, eventType: event.type }, `market-review:${target.strategyId}:${event.symbol}:${event.type}`);
    });
    this.configureSchedules();
  }

  async start(): Promise<void> {
    this.startedAt = Date.now(); this.ready = false; this.database.setSetting('startup_ready', false);
    this.directives.expireDue();
    const unknownOrders = this.database.raw.prepare("SELECT COUNT(*) AS count FROM orders WHERE status IN ('PENDING','SUBMITTED','PARTIALLY_FILLED','UNKNOWN')").get() as { count: number };
    if (unknownOrders.count > 0 && this.database.getMode() !== 'SIMULATION') this.database.setSetting('reconciliation_clear', false);
    if (this.database.getMode() === 'SIMULATION') this.reconciliation.reconcile(this.reconciliation.simulationSnapshot(), 'SIMULATION');
    else {
      try { this.reconciliation.reconcile(await this.robinhood.getAccountSnapshot(), 'ROBINHOOD'); }
      catch (error) {
        this.database.setSetting('reconciliation_clear', false);
        this.database.audit('STARTUP', 'BROKER_STARTUP_CHECK_FAILED', 'system', null, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (this.options.startBackgroundServices !== false) { this.jobs.start(); this.watcher.start(); this.scheduler.start(); }
    this.ready = true; this.database.setSetting('startup_ready', true);
    this.events.publish({ type: 'SYSTEM_READY', severity: 'INFO', source: 'AGENTIC_MANAGER', payload: { mode: this.database.getMode() } });
  }

  async shutdown(): Promise<void> { this.scheduler.stop(); this.watcher.stop(); this.jobs.stop(); this.ready = false; this.database.setSetting('startup_ready', false); this.database.close(); }

  health(): HealthReport {
    const mode = this.database.getMode();
    const diskPath = this.options.databasePath === ':memory:' ? this.options.workingDirectory : this.options.databasePath;
    const codexHealth = this.codex.health();
    return {
      status: this.ready ? (this.database.getSetting<boolean>('reconciliation_clear', true) ? 'healthy' : 'degraded') : 'unhealthy', version: '0.1.0', mode,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1_000), ready: this.ready,
      checks: {
        database: { ok: true, message: 'SQLite available with foreign keys and WAL where persistent.' },
        storage: { ok: diskPath === ':memory:' || existsSync(join(diskPath, '..')) || existsSync(this.options.workingDirectory), message: diskPath },
        codex: { ok: codexHealth.healthy, message: `${codexHealth.active} active, ${codexHealth.queued} queued` },
        reconciliation: { ok: this.database.getSetting<boolean>('reconciliation_clear', true), message: this.database.getSetting<boolean>('reconciliation_clear', true) ? 'Clear' : 'Blocked' },
        watcher: { ok: true, message: this.market.name },
      }, timestamp: nowIso(),
    };
  }

  async seedDemoData(): Promise<void> {
    if (this.database.getSetting<boolean>('demo_seeded', false)) return;
    const proposals: TradeProposal[] = [
      this.demoProposal('day-trader', 'NVDA', 5, 178.42),
      this.demoProposal('aggressive-growth', 'NVDA', 7, 178.42),
      this.demoProposal('long-term-investor', 'VTI', 12, 323.72),
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
      .run('demo_risk_position_cap', 'day-trader', 'WARNING', 'DEMO_POSITION_CAP', 'Demonstration risk event: sample order would have exceeded the position cap.', 'STRATEGY', '{}', nowIso());
    this.database.setSetting('demo_seeded', true);
  }

  private demoProposal(strategyId: string, symbol: string, quantity: number, marketPrice: number): TradeProposal {
    return { strategyId, symbol, action: 'BUY', orderIntent: { side: 'BUY', quantity, orderType: 'MARKET', timeInForce: 'DAY', assetType: symbol === 'VTI' ? 'ETF' : 'EQUITY' }, confidence: 0.5, thesis: 'Clearly labeled demonstration position for validating virtual ownership and accounting.', timeHorizon: 'Simulation only', riskFactors: ['Synthetic data'], invalidationConditions: ['Demo reset'], requestedCapital: quantity * marketPrice, requiresImmediateAction: false, marketPrice, marketDataAsOf: nowIso(), sector: symbol === 'NVDA' ? 'Technology' : 'Diversified', source: 'SIMULATION' };
  }

  private configureSchedules(): void {
    this.scheduler.every('directive-expiry', 60_000, async () => { this.directives.expireDue(); });
    this.scheduler.every('performance-snapshot', 15 * 60_000, async () => { this.recordPerformance(); });
    this.scheduler.every('reconciliation', 5 * 60_000, async () => {
      try {
        const mode = this.database.getMode(); const snapshot = mode === 'SIMULATION' ? this.reconciliation.simulationSnapshot() : await this.robinhood.getAccountSnapshot();
        this.reconciliation.reconcile(snapshot, mode === 'SIMULATION' ? 'SIMULATION' : 'ROBINHOOD');
      } catch (error) {
        this.database.setSetting('reconciliation_clear', false);
        this.database.audit('SCHEDULER', 'RECONCILIATION_FAILED', 'system', null, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    for (const strategy of this.database.listStrategies()) {
      this.scheduler.cron(`strategy-review:${strategy.id}`, () => this.database.getStrategy(strategy.id)?.config.schedule.reviewCron ?? strategy.config.schedule.reviewCron, strategy.config.schedule.timezone, async () => {
        const candidate = this.database.raw.prepare(`SELECT symbol FROM watchlists WHERE strategy_id=? ORDER BY created_at DESC LIMIT 1`).get(strategy.id) as { symbol: string } | undefined;
        const position = this.database.raw.prepare(`SELECT symbol FROM strategy_positions WHERE strategy_id=? ORDER BY market_price*quantity DESC LIMIT 1`).get(strategy.id) as { symbol: string } | undefined;
        this.jobs.enqueue('AGENT_REVIEW', JOB_PRIORITY.SCHEDULED_REVIEW, { strategyId: strategy.id, symbol: candidate?.symbol ?? position?.symbol ?? 'SPY', schedule: strategy.config.schedule.reviewCron }, `scheduled-review:${strategy.id}`);
      });
    }
  }

  private recordPerformance(): void {
    for (const strategy of this.database.listStrategies()) {
      const positions = this.ledger.listPositions(strategy.id); const exposure = positions.reduce((sum, position) => sum + position.marketValue, 0); const unrealized = positions.reduce((sum, position) => sum + position.unrealizedPnl, 0); const realized = this.ledger.getRealizedPnl(strategy.id); const equity = strategy.cash + exposure;
      const peakRow = this.database.raw.prepare('SELECT MAX(equity) AS peak FROM performance_snapshots WHERE strategy_id=?').get(strategy.id) as { peak: number | null }; const peak = Math.max(strategy.allocationAmount, peakRow.peak ?? 0, equity); const drawdown = peak ? Math.min(0, (equity - peak) / peak * 100) : 0;
      this.database.raw.prepare('INSERT INTO performance_snapshots(id,strategy_id,equity,cash,exposure,realized_pnl,unrealized_pnl,drawdown_percent,benchmark_value,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(`perf_${strategy.id}_${Date.now()}`, strategy.id, equity, strategy.cash, exposure, realized, unrealized, drawdown, null, nowIso());
    }
  }
}
