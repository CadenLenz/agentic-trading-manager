import { z } from 'zod';

export const operatingModeSchema = z.enum(['SIMULATION', 'READ_ONLY', 'LIVE', 'MANUAL_LIVE', 'AUTONOMOUS_LIVE']);
export const assetTypeSchema = z.enum(['EQUITY', 'ETF', 'OPTION', 'CRYPTO']);
export const orderIntentSchema = z.object({
  side: z.enum(['BUY', 'SELL']),
  quantity: z.number().positive().finite().max(1_000_000),
  orderType: z.enum(['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT']),
  limitPrice: z.number().positive().finite().optional(),
  stopPrice: z.number().positive().finite().optional(),
  timeInForce: z.enum(['DAY', 'GTC']),
  assetType: assetTypeSchema,
}).superRefine((intent, context) => {
  if ((intent.orderType === 'LIMIT' || intent.orderType === 'STOP_LIMIT') && intent.limitPrice === undefined) {
    context.addIssue({ code: 'custom', path: ['limitPrice'], message: 'Limit price is required for limit orders' });
  }
  if ((intent.orderType === 'STOP' || intent.orderType === 'STOP_LIMIT') && intent.stopPrice === undefined) {
    context.addIssue({ code: 'custom', path: ['stopPrice'], message: 'Stop price is required for stop orders' });
  }
});

export const tradeProposalSchema = z.object({
  strategyId: z.string().min(1).max(80),
  symbol: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9.-]{0,9}$/),
  action: z.enum(['BUY', 'SELL', 'HOLD', 'RESEARCH']),
  orderIntent: orderIntentSchema.optional(),
  confidence: z.number().min(0).max(1),
  thesis: z.string().min(1).max(5_000),
  timeHorizon: z.string().min(1).max(200),
  riskFactors: z.array(z.string().min(1).max(500)).max(20),
  invalidationConditions: z.array(z.string().min(1).max(500)).max(20),
  requestedCapital: z.number().min(0).finite(),
  requiresImmediateAction: z.boolean(),
  marketPrice: z.number().positive().finite(),
  marketDataAsOf: z.string().datetime(),
  sector: z.string().max(100).optional(),
  source: z.enum(['AGENT', 'USER', 'PROTECTIVE', 'SIMULATION']),
}).superRefine((proposal, context) => {
  const isTrade = proposal.action === 'BUY' || proposal.action === 'SELL';
  if (isTrade && proposal.orderIntent === undefined) context.addIssue({ code: 'custom', path: ['orderIntent'], message: 'Trade actions require an order intent' });
  if (!isTrade && proposal.orderIntent !== undefined) context.addIssue({ code: 'custom', path: ['orderIntent'], message: 'Non-trade actions cannot include an order intent' });
  if (isTrade && proposal.orderIntent?.side !== proposal.action) context.addIssue({ code: 'custom', path: ['orderIntent', 'side'], message: 'Order side must match proposal action' });
});

export const strategyConfigSchema = z.object({
  allocationAmount: z.number().min(0).max(1_000_000_000),
  maxPositionPercent: z.number().min(0).max(100),
  maxSectorExposurePercent: z.number().min(0).max(100),
  maxDailyLossPercent: z.number().min(0).max(100),
  maxDrawdownPercent: z.number().min(0).max(100),
  maxSimultaneousPositions: z.number().int().min(0).max(10_000),
  maxTradesPerDay: z.number().int().min(0).max(10_000),
  overnightHoldingsAllowed: z.boolean(),
  closePositionCutoff: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  targetCashReservePercent: z.number().min(0).max(100),
  minimumHoldingDays: z.number().int().min(0).max(100_000),
  rebalanceThresholdPercent: z.number().min(0).max(100),
  turnoverLimitPercent: z.number().min(0).max(10_000),
  allowedAssetTypes: z.array(assetTypeSchema).min(1),
  scanner: z.object({ minPrice: z.number().min(0), maxPrice: z.number().positive(), minRelativeVolume: z.number().min(0), minMovePercent: z.number().min(0), maxSpreadPercent: z.number().min(0), limit: z.number().int().min(1).max(1_000) }),
  schedule: z.object({ timezone: z.string().min(1), reviewCron: z.string().min(1), marketOpenReview: z.boolean(), preCloseReview: z.boolean() }),
  agentGuidance: z.string().max(10_000),
}).refine((config) => config.scanner.maxPrice >= config.scanner.minPrice, { path: ['scanner', 'maxPrice'], message: 'Maximum price must be at least minimum price' });

export const globalRiskConfigSchema = z.object({
  maxTotalExposurePercent: z.number().min(0).max(100),
  minimumReservedCash: z.number().min(0).max(1_000_000_000),
  maxTickerExposurePercent: z.number().min(0).max(100),
  maxSectorExposurePercent: z.number().min(0).max(100),
  maxDailyDrawdownPercent: z.number().min(0).max(100),
  maxWeeklyDrawdownPercent: z.number().min(0).max(100),
  maxOpenPositions: z.number().int().min(0).max(100_000),
  maxNewTradesPerDay: z.number().int().min(0).max(100_000),
  maxOrderNotional: z.number().min(0).max(1_000_000_000),
  restrictToMarketHours: z.boolean(),
  optionsEnabled: z.boolean(),
  cryptoEnabled: z.boolean(),
  marginEnabled: z.boolean(),
  maxConsecutiveLosses: z.number().int().min(0).max(100_000),
  maxStaleDataAgeSeconds: z.number().int().min(1).max(86_400),
  maxReconciliationDiscrepancy: z.number().min(0).max(1_000_000_000),
}).strict();

export const directiveSchema = z.object({
  strategyId: z.string().min(1).nullable(),
  type: z.enum(['RESEARCH_ONLY', 'ALLOWED_SYMBOL', 'FORBIDDEN_SYMBOL', 'MAX_ALLOCATION', 'SECTOR_INTEREST', 'STRATEGY_PAUSE', 'FOCUS_AREA']),
  symbol: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9.-]{0,9}$/).nullable(),
  value: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().min(1).max(1_000),
  expiresAt: z.string().datetime().nullable(),
});

export const managerMessageSchema = z.object({ message: z.string().trim().min(1).max(4_000) });
export const setupSchema = z.object({
  username: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_.-]+$/),
  password: z.string().min(12).max(200),
  designatedCapital: z.number().min(100).max(1_000_000_000),
  allocations: z.record(z.string(), z.number().min(0)),
  demoData: z.boolean().default(true),
});
