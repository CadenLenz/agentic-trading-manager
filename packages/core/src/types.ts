export const STRATEGY_IDS = {
  dayTrader: 'OPTIONS',
  aggressiveGrowth: 'AGGRESSIVE_STOCKS',
  longTerm: 'SAFE_LONG_TERM',
  safe: 'SAFE_LONG_TERM',
  aggressive: 'AGGRESSIVE_STOCKS',
  options: 'OPTIONS',
} as const;

export type OperatingMode = 'SIMULATION' | 'READ_ONLY' | 'LIVE' | 'MANUAL_LIVE' | 'AUTONOMOUS_LIVE';
export type AgentStatus = 'IDLE' | 'WATCHING' | 'QUEUED' | 'ANALYZING' | 'AWAITING_DATA' | 'PROPOSING' | 'RISK_CHECK' | 'EXECUTING' | 'PAUSED' | 'ERROR';
export type StrategyKind = 'DAY_TRADER' | 'AGGRESSIVE_GROWTH' | 'LONG_TERM' | 'SAFE_LONG_TERM' | 'AGGRESSIVE_STOCKS' | 'OPTIONS';
export type OrderSide = 'BUY' | 'SELL';
export type ProposalAction = OrderSide | 'HOLD' | 'RESEARCH';
export type AssetType = 'EQUITY' | 'ETF' | 'OPTION' | 'CRYPTO';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
export type TimeInForce = 'DAY' | 'GTC';
export type OrderStatus = 'PENDING' | 'SUBMITTED' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'UNKNOWN';
export type DirectiveType = 'RESEARCH_ONLY' | 'ALLOWED_SYMBOL' | 'FORBIDDEN_SYMBOL' | 'MAX_ALLOCATION' | 'SECTOR_INTEREST' | 'STRATEGY_PAUSE' | 'FOCUS_AREA';
export type RiskSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface ScannerRules {
  minPrice: number;
  maxPrice: number;
  minRelativeVolume: number;
  minMovePercent: number;
  maxSpreadPercent: number;
  limit: number;
}

export interface StrategySchedule {
  timezone: string;
  reviewCron: string;
  marketOpenReview: boolean;
  preCloseReview: boolean;
}

export interface StrategyConfig {
  allocationAmount: number;
  maxPositionPercent: number;
  maxSectorExposurePercent: number;
  maxDailyLossPercent: number;
  maxDrawdownPercent: number;
  maxSimultaneousPositions: number;
  maxTradesPerDay: number;
  overnightHoldingsAllowed: boolean;
  closePositionCutoff: string | null;
  targetCashReservePercent: number;
  minimumHoldingDays: number;
  rebalanceThresholdPercent: number;
  turnoverLimitPercent: number;
  allowedAssetTypes: AssetType[];
  scanner: ScannerRules;
  schedule: StrategySchedule;
  agentGuidance: string;
}

export interface Strategy {
  id: string;
  name: string;
  kind: StrategyKind;
  enabled: boolean;
  status: AgentStatus;
  allocationAmount: number;
  cash: number;
  config: StrategyConfig;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface GlobalRiskConfig {
  maxTotalExposurePercent: number;
  minimumReservedCash: number;
  maxTickerExposurePercent: number;
  maxSectorExposurePercent: number;
  maxDailyDrawdownPercent: number;
  maxWeeklyDrawdownPercent: number;
  maxOpenPositions: number;
  maxNewTradesPerDay: number;
  maxOrderNotional: number;
  restrictToMarketHours: boolean;
  optionsEnabled: boolean;
  cryptoEnabled: boolean;
  marginEnabled: boolean;
  maxConsecutiveLosses: number;
  maxStaleDataAgeSeconds: number;
  maxReconciliationDiscrepancy: number;
}

export interface OrderIntent {
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce: TimeInForce;
  assetType: AssetType;
}

export interface TradeProposal {
  strategyId: string;
  symbol: string;
  action: ProposalAction;
  orderIntent?: OrderIntent;
  confidence: number;
  thesis: string;
  timeHorizon: string;
  riskFactors: string[];
  invalidationConditions: string[];
  requestedCapital: number;
  requiresImmediateAction: boolean;
  marketPrice: number;
  marketDataAsOf: string;
  sector?: string;
  source: 'AGENT' | 'USER' | 'PROTECTIVE' | 'SIMULATION';
}

export interface RiskViolation {
  code: string;
  message: string;
  severity: RiskSeverity;
  scope: 'GLOBAL' | 'STRATEGY' | 'DIRECTIVE' | 'SYSTEM';
  observed?: number | string;
  limit?: number | string;
}

export interface RiskDecision {
  approved: boolean;
  violations: RiskViolation[];
  evaluatedAt: string;
}

export interface VirtualPosition {
  strategyId: string;
  symbol: string;
  quantity: number;
  averageCost: number|null;
  basisStatus: "KNOWN"|"UNAVAILABLE_EXTERNAL";
  marketPrice: number;
  sector: string;
  assetType: AssetType;
  marketValue: number;
  unrealizedPnl: number|null;
  updatedAt: string;
}

export interface LedgerFill {
  brokerFillId: string;
  orderId: string;
  quantity: number;
  price: number;
  fees: number;
  executedAt: string;
}

export interface ReconciliationMismatch {
  kind: 'POSITION' | 'CASH' | 'OPEN_ORDER' | 'FILL';
  symbol?: string;
  internalValue: number | string;
  brokerValue: number | string;
  difference: number;
  severity: RiskSeverity;
  details: Record<string, unknown>;
}

export interface Directive {
  id: string;
  strategyId: string | null;
  type: DirectiveType;
  symbol: string | null;
  value: Record<string, unknown>;
  reason: string;
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
}

export interface AgentDecision {
  id: string;
  strategyId: string | null;
  agentType: string;
  action: ProposalAction | 'INFORMATION';
  symbol: string | null;
  confidence: number | null;
  rationale: string;
  status: string;
  proposal: TradeProposal | null;
  createdAt: string;
}

export interface BrokerPosition {
  symbol: string;
  quantity: number;
  averageCost: number;
  assetType: AssetType;
  sector: string;
}

export interface BrokerAccountSnapshot {
  buyingPower: number;
  cash: number;
  equity: number;
  positions: BrokerPosition[];
  openOrders: Array<{ brokerOrderId: string; symbol: string; side: OrderSide; quantity: number; filledQuantity: number; status: string }>;
  asOf: string;
}

export interface BrokerOrderRequest {
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  timeInForce: TimeInForce;
  limitPrice?: number;
  stopPrice?: number;
  assetType: AssetType;
}

export interface BrokerOrderResult {
  brokerOrderId: string;
  status: OrderStatus;
  submittedAt: string;
  raw: Record<string, unknown>;
}

export interface McpCapability {
  name: string;
  description: string;
  category: 'READ' | 'PREVIEW' | 'TRADE' | 'CANCEL' | 'MARKET_DATA' | 'UNKNOWN';
}

export interface HealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  mode: OperatingMode;
  uptimeSeconds: number;
  ready: boolean;
  checks: Record<string, { ok: boolean; message: string; latencyMs?: number }>;
  timestamp: string;
}

export const EXAMPLE_GLOBAL_RISK: GlobalRiskConfig = {
  maxTotalExposurePercent: 70,
  minimumReservedCash: 5_000,
  maxTickerExposurePercent: 20,
  maxSectorExposurePercent: 35,
  maxDailyDrawdownPercent: 3,
  maxWeeklyDrawdownPercent: 6,
  maxOpenPositions: 20,
  maxNewTradesPerDay: 20,
  maxOrderNotional: 5_000,
  restrictToMarketHours: false,
  optionsEnabled: false,
  cryptoEnabled: false,
  marginEnabled: false,
  maxConsecutiveLosses: 3,
  maxStaleDataAgeSeconds: 120,
  maxReconciliationDiscrepancy: 0.01,
};

const baseScanner: ScannerRules = { minPrice: 5, maxPrice: 500, minRelativeVolume: 1.5, minMovePercent: 2, maxSpreadPercent: 0.75, limit: 20 };
const baseSchedule: StrategySchedule = { timezone: 'America/New_York', reviewCron: '0 10 * * 1-5', marketOpenReview: true, preCloseReview: true };

export const EXAMPLE_STRATEGY_CONFIGS: Record<'DAY_TRADER' | 'AGGRESSIVE_GROWTH' | 'LONG_TERM', StrategyConfig> = {
  DAY_TRADER: {
    allocationAmount: 10_000, maxPositionPercent: 15, maxSectorExposurePercent: 35, maxDailyLossPercent: 1.5,
    maxDrawdownPercent: 5, maxSimultaneousPositions: 4, maxTradesPerDay: 8, overnightHoldingsAllowed: false,
    closePositionCutoff: '15:50', targetCashReservePercent: 10, minimumHoldingDays: 0, rebalanceThresholdPercent: 0,
    turnoverLimitPercent: 300, allowedAssetTypes: ['EQUITY', 'ETF'], scanner: baseScanner, schedule: baseSchedule,
    agentGuidance: 'EXAMPLE DEFAULT: prioritize liquid names, explicit invalidation, and modest turnover. This is not investment advice.',
  },
  AGGRESSIVE_GROWTH: {
    allocationAmount: 15_000, maxPositionPercent: 25, maxSectorExposurePercent: 45, maxDailyLossPercent: 3,
    maxDrawdownPercent: 12, maxSimultaneousPositions: 8, maxTradesPerDay: 4, overnightHoldingsAllowed: true,
    closePositionCutoff: null, targetCashReservePercent: 10, minimumHoldingDays: 5, rebalanceThresholdPercent: 8,
    turnoverLimitPercent: 120, allowedAssetTypes: ['EQUITY', 'ETF'], scanner: { ...baseScanner, minMovePercent: 1 }, schedule: { ...baseSchedule, reviewCron: '30 16 * * 1-5' },
    agentGuidance: 'EXAMPLE DEFAULT: seek durable growth while naming catalyst, valuation, and downside risks. This is not investment advice.',
  },
  LONG_TERM: {
    allocationAmount: 25_000, maxPositionPercent: 20, maxSectorExposurePercent: 30, maxDailyLossPercent: 5,
    maxDrawdownPercent: 15, maxSimultaneousPositions: 15, maxTradesPerDay: 2, overnightHoldingsAllowed: true,
    closePositionCutoff: null, targetCashReservePercent: 15, minimumHoldingDays: 90, rebalanceThresholdPercent: 5,
    turnoverLimitPercent: 35, allowedAssetTypes: ['EQUITY', 'ETF'], scanner: { ...baseScanner, minRelativeVolume: 1, minMovePercent: 0 }, schedule: { ...baseSchedule, reviewCron: '0 18 * * 5', preCloseReview: false },
    agentGuidance: 'EXAMPLE DEFAULT: favor portfolio quality, diversification, and low turnover. This is not investment advice.',
  },
};
