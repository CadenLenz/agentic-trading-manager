import type { RiskDecision, RiskViolation, TradeProposal, VirtualPosition } from '../../core/src/types.js';
import { makeId, nowIso, roundMoney } from '../../core/src/utils.js';
import type { AppDatabase } from '../../database/src/database.js';
import type { VirtualPortfolioLedger } from '../../ledger/src/virtual-ledger.js';
import type { DirectiveService } from '../../strategies/src/directive-service.js';

export interface RiskContext {
  autonomous: boolean;
  reconciliationClear: boolean;
  marketOpen: boolean;
  accountEquity: number;
  accountCash: number;
  dailyPnl: number;
  weeklyPnl: number;
  openPositionCount: number;
  tradesToday: number;
  sectorExposure: Record<string, number>;
  consecutiveLosses: number;
  marketDataTradingEligible: boolean;
}

export class RiskEngine {
  constructor(private readonly database: AppDatabase, private readonly ledger: VirtualPortfolioLedger, private readonly directives: DirectiveService) {}

  evaluate(proposal: TradeProposal, context: RiskContext): RiskDecision {
    const violations: RiskViolation[] = [];
    const strategy = this.database.getStrategy(proposal.strategyId);
    const global = this.database.getGlobalRisk();
    const mode = this.database.getMode();
    const intent = proposal.orderIntent;
    const isBuy = proposal.action === 'BUY';
    const isSell = proposal.action === 'SELL';
    const isTrade = isBuy || isSell;
    const notional = intent ? roundMoney(intent.quantity * proposal.marketPrice) : 0;
    const positions = this.ledger.listPositions();

    if (!isTrade) return { approved: true, violations, evaluatedAt: nowIso() };
    if (!strategy) violations.push(this.violation('STRATEGY_NOT_FOUND', 'The attributed strategy does not exist.', 'CRITICAL', 'SYSTEM'));
    if (!intent) violations.push(this.violation('MISSING_ORDER_INTENT', 'A trade proposal must include a validated order intent.', 'CRITICAL', 'SYSTEM'));
    if (!strategy || !intent) return this.finish(proposal, violations);

    const protective = proposal.source === 'PROTECTIVE' && isSell;
    if (mode === 'READ_ONLY') violations.push(this.violation('READ_ONLY_MODE', 'Order placement is disabled in READ_ONLY mode.', 'CRITICAL', 'SYSTEM'));
    if (mode === 'LIVE') {
      if (process.env.TRADING_MODE !== 'LIVE' || process.env.ALLOW_LIVE_TRADING !== 'true' || !this.database.getSetting<boolean>('live_db_confirmation', false)) {
        violations.push(this.violation('LIVE_GATE_INCOMPLETE', 'LIVE requires both environment gates and a database administrator confirmation.', 'CRITICAL', 'SYSTEM'));
      }
      if (!context.marketDataTradingEligible) violations.push(this.violation('UNTRUSTED_MARKET_DATA', 'LIVE orders require a configured market-data provider explicitly eligible for trading.', 'CRITICAL', 'SYSTEM'));
    }
    if (this.database.getSetting<boolean>('maintenance_mode', false)) violations.push(this.violation('MAINTENANCE_MODE', 'New orders are disabled during maintenance.', 'CRITICAL', 'SYSTEM'));
    if (this.database.getSetting<boolean>('global_pause', false) && !protective) violations.push(this.violation('GLOBAL_PAUSE', 'Autonomous trading is globally paused.', 'CRITICAL', 'GLOBAL'));
    if (!strategy.enabled && !protective) violations.push(this.violation('STRATEGY_PAUSED', `${strategy.name} is paused.`, 'CRITICAL', 'STRATEGY'));
    if (!context.reconciliationClear) violations.push(this.violation('RECONCILIATION_FAULT', 'Ledger and broker state must reconcile before a new order.', 'CRITICAL', 'SYSTEM'));
    if (Date.now() - new Date(proposal.marketDataAsOf).getTime() > global.maxStaleDataAgeSeconds * 1_000) violations.push(this.violation('STALE_MARKET_DATA', 'Market data is too old for order evaluation.', 'CRITICAL', 'GLOBAL', Math.round((Date.now() - new Date(proposal.marketDataAsOf).getTime()) / 1_000), global.maxStaleDataAgeSeconds));
    if (global.restrictToMarketHours && !context.marketOpen) violations.push(this.violation('MARKET_CLOSED', 'Trading-hours restriction is active.', 'CRITICAL', 'GLOBAL'));
    if (intent.assetType === 'OPTION' && !global.optionsEnabled) violations.push(this.violation('OPTIONS_DISABLED', 'Options trading is disabled by global policy.', 'CRITICAL', 'GLOBAL'));
    if (intent.assetType === 'CRYPTO' && !global.cryptoEnabled) violations.push(this.violation('CRYPTO_DISABLED', 'Crypto trading is disabled by global policy.', 'CRITICAL', 'GLOBAL'));
    if (!strategy.config.allowedAssetTypes.includes(intent.assetType)) violations.push(this.violation('ASSET_NOT_ALLOWED', `${intent.assetType} is not allowed for ${strategy.name}.`, 'CRITICAL', 'STRATEGY'));

    const matchingDirectives = this.directives.matching(strategy.id, proposal.symbol);
    if (matchingDirectives.some((directive) => directive.type === 'FORBIDDEN_SYMBOL')) violations.push(this.violation('FORBIDDEN_SYMBOL', `${proposal.symbol} is forbidden by an active directive.`, 'CRITICAL', 'DIRECTIVE'));
    if (matchingDirectives.some((directive) => directive.type === 'RESEARCH_ONLY')) violations.push(this.violation('RESEARCH_ONLY', `${proposal.symbol} is research-only and cannot be traded.`, 'CRITICAL', 'DIRECTIVE'));
    if (matchingDirectives.some((directive) => directive.type === 'STRATEGY_PAUSE') && !protective) violations.push(this.violation('DIRECTIVE_PAUSE', `${strategy.name} is paused by an active directive.`, 'CRITICAL', 'DIRECTIVE'));

    if (notional > global.maxOrderNotional && isBuy) violations.push(this.violation('MAX_ORDER_NOTIONAL', 'Order exceeds the global maximum notional.', 'CRITICAL', 'GLOBAL', notional, global.maxOrderNotional));
    const temporaryCap = matchingDirectives.find((directive) => directive.type === 'MAX_ALLOCATION');
    const directiveCap = typeof temporaryCap?.value.maxAmount === 'number' ? temporaryCap.value.maxAmount : Number.POSITIVE_INFINITY;
    const currentlyOwned = this.ledger.getPosition(strategy.id, proposal.symbol)?.marketValue ?? 0;
    if (isBuy && currentlyOwned + notional > directiveCap) violations.push(this.violation('DIRECTIVE_ALLOCATION_CAP', 'Position would exceed a temporary allocation directive.', 'CRITICAL', 'DIRECTIVE', roundMoney(currentlyOwned + notional), directiveCap));
    if (isBuy && notional > strategy.cash + 0.000001) violations.push(this.violation('STRATEGY_CASH', 'Order would spend more than the strategy owns.', 'CRITICAL', 'STRATEGY', notional, strategy.cash));
    const requiredStrategyReserve = strategy.allocationAmount * strategy.config.targetCashReservePercent / 100;
    if (isBuy && strategy.cash - notional < requiredStrategyReserve - 0.01) violations.push(this.violation('STRATEGY_CASH_RESERVE', 'Order would breach the strategy cash reserve.', 'CRITICAL', 'STRATEGY', roundMoney(strategy.cash - notional), roundMoney(requiredStrategyReserve)));

    const owned = this.ledger.getPosition(strategy.id, proposal.symbol);
    if (isSell && (owned?.quantity ?? 0) + 0.000001 < intent.quantity) violations.push(this.violation('OWNERSHIP_LIMIT', 'A strategy may sell only its internally attributed quantity.', 'CRITICAL', 'STRATEGY', intent.quantity, owned?.quantity ?? 0));
    if (isBuy) this.evaluateExposure(proposal, context, positions, notional, violations);

    const strategyDayPnl = this.strategyPnl(strategy.id, true);
    const strategyDailyLimit = strategy.allocationAmount * (strategy.config.maxDailyLossPercent / 100);
    if (strategyDayPnl <= -strategyDailyLimit && !protective) violations.push(this.violation('STRATEGY_DAILY_LOSS', 'Strategy daily loss limit has been reached.', 'CRITICAL', 'STRATEGY', strategyDayPnl, -strategyDailyLimit));
    if (context.dailyPnl <= -(context.accountEquity * global.maxDailyDrawdownPercent / 100) && !protective) violations.push(this.violation('ACCOUNT_DAILY_DRAWDOWN', 'Account daily drawdown limit has been reached.', 'CRITICAL', 'GLOBAL', context.dailyPnl, -(context.accountEquity * global.maxDailyDrawdownPercent / 100)));
    if (context.weeklyPnl <= -(context.accountEquity * global.maxWeeklyDrawdownPercent / 100) && !protective) violations.push(this.violation('ACCOUNT_WEEKLY_DRAWDOWN', 'Account weekly drawdown limit has been reached.', 'CRITICAL', 'GLOBAL', context.weeklyPnl, -(context.accountEquity * global.maxWeeklyDrawdownPercent / 100)));
    if (isBuy && context.tradesToday >= global.maxNewTradesPerDay) violations.push(this.violation('GLOBAL_TRADE_COUNT_LIMIT', 'Account daily new-trade limit has been reached.', 'CRITICAL', 'GLOBAL', context.tradesToday, global.maxNewTradesPerDay));
    const strategyTradesToday = this.strategyTradesToday(strategy.id);
    if (isBuy && strategyTradesToday >= strategy.config.maxTradesPerDay) violations.push(this.violation('STRATEGY_TRADE_COUNT_LIMIT', 'Strategy daily trade limit has been reached.', 'CRITICAL', 'STRATEGY', strategyTradesToday, strategy.config.maxTradesPerDay));
    if (isBuy && !owned && context.openPositionCount >= global.maxOpenPositions) violations.push(this.violation('OPEN_POSITION_LIMIT', 'Maximum account open-position count has been reached.', 'CRITICAL', 'GLOBAL', context.openPositionCount, global.maxOpenPositions));
    const strategyPositions = positions.filter((position) => position.strategyId === strategy.id && position.quantity > 0);
    if (isBuy && !owned && strategyPositions.length >= strategy.config.maxSimultaneousPositions) violations.push(this.violation('STRATEGY_POSITION_COUNT', 'Strategy position-count limit has been reached.', 'CRITICAL', 'STRATEGY', strategyPositions.length, strategy.config.maxSimultaneousPositions));
    const lossStreak = this.consecutiveLosses(strategy.id);
    if (lossStreak >= global.maxConsecutiveLosses && !protective) {
      violations.push(this.violation('CONSECUTIVE_LOSSES', 'Strategy is suspended after consecutive losing trades.', 'CRITICAL', 'GLOBAL', lossStreak, global.maxConsecutiveLosses));
      if (strategy.enabled) this.database.setStrategyEnabled(strategy.id, false, 'RISK_ENGINE', `Automatic suspension after ${lossStreak} consecutive losing trades`);
    }
    const drawdown = this.strategyDrawdownPercent(strategy.id);
    if (drawdown >= strategy.config.maxDrawdownPercent && !protective) violations.push(this.violation('STRATEGY_MAX_DRAWDOWN', 'Strategy maximum drawdown has been reached.', 'CRITICAL', 'STRATEGY', roundMoney(drawdown), strategy.config.maxDrawdownPercent));
    return this.finish(proposal, violations);
  }

  defaultContext(): RiskContext {
    const positions = this.ledger.listPositions();
    const designatedCapital = this.database.getSetting<number>('designated_capital', 50_000);
    const cash = this.database.listStrategies().reduce((sum, strategy) => sum + strategy.cash, 0);
    const exposure = positions.reduce((sum, position) => sum + position.marketValue, 0);
    const realized = this.ledger.getRealizedPnl();
    if(realized===null)throw new Error('Historical realized P&L unavailable for basis-dependent risk');
    const unrealized = positions.reduce((sum, position) => sum + this.requirePnl(position), 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const week = new Date(today); week.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const weeklyRealized=this.ledger.getRealizedPnl(undefined,week.toISOString());
    if(weeklyRealized===null)throw new Error('Weekly realized P&L unavailable for basis-dependent risk');
    const sectors: Record<string, number> = {};
    for (const position of positions) sectors[position.sector] = (sectors[position.sector] ?? 0) + position.marketValue;
    const todayTrades = this.database.raw.prepare("SELECT COUNT(*) AS count FROM orders WHERE side='BUY' AND created_at>=? AND status NOT IN ('REJECTED','CANCELED')").get(today.toISOString()) as { count: number };
    return {
      autonomous: true, reconciliationClear: this.database.getSetting<boolean>('reconciliation_clear', true), marketOpen: true,
      accountEquity: roundMoney(cash + exposure || designatedCapital), accountCash: roundMoney(cash), dailyPnl: roundMoney(realized + unrealized),
      weeklyPnl: roundMoney(weeklyRealized + unrealized), openPositionCount: positions.length,
      tradesToday: todayTrades.count, sectorExposure: sectors, consecutiveLosses: 0,
      marketDataTradingEligible: this.database.getSetting<boolean>('market_data_trading_eligible', false),
    };
  }

  private evaluateExposure(proposal: TradeProposal, context: RiskContext, positions: VirtualPosition[], notional: number, violations: RiskViolation[]): void {
    const strategy = this.database.getStrategy(proposal.strategyId);
    if (!strategy) return;
    const global = this.database.getGlobalRisk();
    const existing = positions.find((position) => position.strategyId === strategy.id && position.symbol === proposal.symbol)?.marketValue ?? 0;
    const strategyPositionLimit = strategy.allocationAmount * (strategy.config.maxPositionPercent / 100);
    if (existing + notional > strategyPositionLimit + 0.01) violations.push(this.violation('STRATEGY_POSITION_LIMIT', 'Order would exceed the strategy position limit.', 'CRITICAL', 'STRATEGY', roundMoney(existing + notional), roundMoney(strategyPositionLimit)));
    const exposure = positions.reduce((sum, position) => sum + position.marketValue, 0);
    const maxExposure = context.accountEquity * global.maxTotalExposurePercent / 100;
    if (exposure + notional > maxExposure + 0.01) violations.push(this.violation('TOTAL_EXPOSURE_LIMIT', 'Order would exceed total account exposure.', 'CRITICAL', 'GLOBAL', roundMoney(exposure + notional), roundMoney(maxExposure)));
    if (context.accountCash - notional < global.minimumReservedCash - 0.01) violations.push(this.violation('CASH_RESERVE', 'Order would breach the global cash reserve.', 'CRITICAL', 'GLOBAL', roundMoney(context.accountCash - notional), global.minimumReservedCash));
    const tickerExposure = positions.filter((position) => position.symbol === proposal.symbol).reduce((sum, position) => sum + position.marketValue, 0);
    const tickerLimit = context.accountEquity * global.maxTickerExposurePercent / 100;
    if (tickerExposure + notional > tickerLimit + 0.01) violations.push(this.violation('TICKER_CONCENTRATION', 'Order would exceed global ticker concentration.', 'CRITICAL', 'GLOBAL', roundMoney(tickerExposure + notional), roundMoney(tickerLimit)));
    const sector = proposal.sector ?? 'Unknown';
    const globalSectorLimit = context.accountEquity * global.maxSectorExposurePercent / 100;
    if ((context.sectorExposure[sector] ?? 0) + notional > globalSectorLimit + 0.01) violations.push(this.violation('GLOBAL_SECTOR_CONCENTRATION', 'Order would exceed global sector concentration.', 'CRITICAL', 'GLOBAL', roundMoney((context.sectorExposure[sector] ?? 0) + notional), roundMoney(globalSectorLimit)));
    const strategySectorExposure = positions.filter((position) => position.strategyId === strategy.id && position.sector === sector).reduce((sum, position) => sum + position.marketValue, 0);
    const strategySectorLimit = strategy.allocationAmount * strategy.config.maxSectorExposurePercent / 100;
    if (strategySectorExposure + notional > strategySectorLimit + 0.01) violations.push(this.violation('STRATEGY_SECTOR_CONCENTRATION', 'Order would exceed strategy sector concentration.', 'CRITICAL', 'STRATEGY', roundMoney(strategySectorExposure + notional), roundMoney(strategySectorLimit)));
  }

  private requirePnl(position:VirtualPosition):number {if(position.unrealizedPnl===null)throw new Error('Cost basis unavailable for basis-dependent P&L risk calculation: '+position.symbol);return position.unrealizedPnl;}

  private strategyPnl(strategyId: string, includeUnrealized: boolean): number {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const realized = this.ledger.getRealizedPnl(strategyId, today.toISOString());
    if(realized===null)throw new Error('Sleeve realized P&L unavailable for basis-dependent risk');
    const unrealized = includeUnrealized ? this.ledger.listPositions(strategyId).reduce((sum, position) => sum + this.requirePnl(position), 0) : 0;
    return roundMoney(realized + unrealized);
  }

  private strategyTradesToday(strategyId: string): number {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const row = this.database.raw.prepare("SELECT COUNT(*) AS count FROM orders WHERE strategy_id=? AND side='BUY' AND created_at>=? AND status NOT IN ('REJECTED','CANCELED')").get(strategyId, today.toISOString()) as { count: number };
    return row.count;
  }

  private consecutiveLosses(strategyId: string): number {
    const rows = this.database.raw.prepare('SELECT amount FROM realized_pnl WHERE strategy_id=? ORDER BY created_at DESC,id DESC LIMIT 100').all(strategyId) as Array<{ amount: number }>;
    let losses = 0;
    for (const row of rows) { if (row.amount < 0) losses += 1; else break; }
    return losses;
  }

  private strategyDrawdownPercent(strategyId: string): number {
    const strategy = this.database.getStrategy(strategyId);
    if (!strategy) return 0;
    const currentEquity = strategy.cash + this.ledger.listPositions(strategyId).reduce((sum, position) => sum + position.marketValue, 0);
    const historical = this.database.raw.prepare('SELECT MAX(equity) AS peak FROM performance_snapshots WHERE strategy_id=?').get(strategyId) as { peak: number | null };
    const peak = Math.max(strategy.allocationAmount, historical.peak ?? 0, currentEquity);
    return peak > 0 ? Math.max(0, (peak - currentEquity) / peak * 100) : 0;
  }

  private finish(proposal: TradeProposal, violations: RiskViolation[]): RiskDecision {
    for (const item of violations) {
      this.database.raw.prepare('INSERT INTO risk_events(id,strategy_id,severity,code,message,scope,proposal_json,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(makeId('risk'), proposal.strategyId, item.severity, item.code, item.message, item.scope, JSON.stringify(proposal), JSON.stringify({ observed: item.observed, limit: item.limit }), nowIso());
    }
    return { approved: violations.every((item) => item.severity !== 'CRITICAL'), violations, evaluatedAt: nowIso() };
  }

  private violation(code: string, message: string, severity: 'INFO' | 'WARNING' | 'CRITICAL', scope: 'GLOBAL' | 'STRATEGY' | 'DIRECTIVE' | 'SYSTEM', observed?: number | string, limit?: number | string): RiskViolation {
    return { code, message, severity, scope, ...(observed !== undefined ? { observed } : {}), ...(limit !== undefined ? { limit } : {}) };
  }
}
