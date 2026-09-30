import { z } from 'zod';

export const sleeveSchema = z.enum(['SAFE_LONG_TERM', 'AGGRESSIVE_STOCKS', 'OPTIONS']);
export type Sleeve = z.infer<typeof sleeveSchema>;
export const SLEEVES: Sleeve[] = ['SAFE_LONG_TERM', 'AGGRESSIVE_STOCKS', 'OPTIONS'];
export const executionPolicySchema = z.enum(['MANUAL_APPROVAL', 'AUTONOMOUS_RISK_APPROVED']);
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;
export const agentModeSchema = z.enum(['ADVISOR', 'OPERATOR', 'AUTONOMOUS']);
export type AgentMode = z.infer<typeof agentModeSchema>;
export const states = ['DRAFT', 'RESEARCHED', 'SUBMITTED_TO_RISK', 'RISK_REJECTED', 'RISK_APPROVED', 'BROKER_PREVIEWED', 'READY_TO_EXECUTE', 'EXECUTION_SENT', 'BROKER_ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'FAILED', 'RECONCILIATION_REQUIRED', 'UNKNOWN_OUTCOME', 'CLOSED'] as const;
export type ProposalState = typeof states[number];
const symbol = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9.-]{0,9}$/);
export const proposalSchema = z.object({
  schemaVersion: z.literal(2), strategy: sleeveSchema, assetClass: z.enum(['EQUITY', 'ETF', 'OPTION']),
  symbol, underlying: symbol.nullable(), side: z.enum(['BUY', 'SELL']), positionEffect: z.enum(['OPEN', 'CLOSE']),
  orderType: z.enum(['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT']), quantity: z.number().positive().finite().max(1_000_000),
  dollarAmount: z.number().positive().finite().nullable(), limitPrice: z.number().positive().finite().nullable(),
  stopPrice: z.number().positive().finite().nullable(), timeInForce: z.enum(['DAY', 'GTC']), marketHours: z.enum(['REGULAR', 'EXTENDED']),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  option: z.object({
    optionId: z.string().min(1).max(200), type: z.enum(['CALL', 'PUT']), strike: z.number().positive(),
    expiration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), contracts: z.number().int().positive(),
    strategy: z.enum(['LONG_CALL', 'LONG_PUT', 'COVERED_CALL', 'CASH_SECURED_PUT']),
    maxLoss: z.number().nonnegative(), collateralRequired: z.number().nonnegative(), estimatedPremium: z.number().nonnegative(),
  }).strict().nullable(),
  researchSummary: z.string().min(1).max(5000), thesis: z.string().min(1).max(5000), catalyst: z.string().max(2000),
  technicalSetup: z.string().max(2000), fundamentalContext: z.string().max(2000),
  riskFactors: z.array(z.string().min(1).max(1000)).min(1).max(20), invalidation: z.string().min(1).max(2000),
  expectedHoldingPeriod: z.string().min(1).max(500),holdingTradingDays:z.number().int().nonnegative().nullable(), exitPlan: z.string().min(1).max(2000),
}).strict().superRefine((p, ctx) => {
  if (Date.parse(p.expiresAt) <= Date.parse(p.createdAt)) ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Expiration must follow creation' });
  if (p.orderType.includes('LIMIT') && p.limitPrice === null) ctx.addIssue({ code: 'custom', path: ['limitPrice'], message: 'Limit price required' });
  if (p.orderType.includes('STOP') && p.stopPrice === null) ctx.addIssue({ code: 'custom', path: ['stopPrice'], message: 'Stop price required' });
  if ((p.assetClass === 'OPTION') !== (p.option !== null)) ctx.addIssue({ code: 'custom', path: ['option'], message: 'Options metadata is required only for options' });
  if (p.option && (p.option.contracts !== p.quantity || !p.underlying || p.marketHours !== 'REGULAR' || p.orderType !== 'LIMIT')) ctx.addIssue({ code: 'custom', path: ['option'], message: 'Single-leg options require integral matching contracts, underlying, regular hours and LIMIT orders' });
});
export type ProposalInput = z.infer<typeof proposalSchema>;
export interface Proposal extends ProposalInput { id: string; version: number; state: ProposalState }
export const researchSchema = z.object({
  items: z.array(z.object({ category: z.string().min(1).max(100), summary: z.string().min(20).max(3000), sources: z.array(z.string().url()).min(1).max(10), observedAt: z.string().datetime() }).strict()).min(1).max(30),
  simulated: z.boolean(),
}).strict();
export type Research = z.infer<typeof researchSchema>;
export const RESEARCH_REQUIRED: Record<Sleeve, string[]> = {
  SAFE_LONG_TERM: ['fundamentals', 'balance_sheet_fcf', 'valuation', 'sector_macro', 'news', 'long_term_thesis', 'price_context', 'major_risks'],
  AGGRESSIVE_STOCKS: ['catalyst_news', 'earnings_timing', 'liquidity', 'volume', 'trend', 'support_resistance', 'volatility', 'momentum', 'risk_reward', 'invalidation'],
  OPTIONS: ['underlying_thesis', 'catalyst_news', 'event_timing', 'technical_setup', 'iv_event_risk', 'strike', 'expiration', 'moneyness', 'contract_liquidity', 'bid_ask_spread', 'open_interest_volume', 'theta', 'max_loss', 'collateral', 'exit_plan'],
};
export const sleevePolicySchema = z.object({
  targetWeight: z.number().min(0).max(1), tolerancePercent: z.number().min(0).max(100),
  maxPositionRiskPercent: z.number().min(0).max(100), normalDrawdownPercent: z.number().min(0).max(60),
  emergencyDrawdownPercent: z.literal(60), executionPolicy: executionPolicySchema,
  minEquityPrice: z.number().min(1), maxSpreadPercent: z.number().min(0).max(100),
  minVolume: z.number().nonnegative(), maxHoldingTradingDays: z.number().int().nonnegative(),
}).strict();
export type SleevePolicy = z.infer<typeof sleevePolicySchema>;
export const DEFAULT_POLICIES: Record<Sleeve, SleevePolicy> = {
  SAFE_LONG_TERM: { targetWeight: 1/3, tolerancePercent: 5, maxPositionRiskPercent: 20, normalDrawdownPercent: 15, emergencyDrawdownPercent: 60, executionPolicy: 'MANUAL_APPROVAL', minEquityPrice: 5, maxSpreadPercent: 1, minVolume: 100000, maxHoldingTradingDays: 0 },
  AGGRESSIVE_STOCKS: { targetWeight: 1/3, tolerancePercent: 5, maxPositionRiskPercent: 25, normalDrawdownPercent: 10, emergencyDrawdownPercent: 60, executionPolicy: 'MANUAL_APPROVAL', minEquityPrice: 5, maxSpreadPercent: 0.75, minVolume: 500000, maxHoldingTradingDays: 10 },
  OPTIONS: { targetWeight: 1/3, tolerancePercent: 5, maxPositionRiskPercent: 25, normalDrawdownPercent: 10, emergencyDrawdownPercent: 60, executionPolicy: 'MANUAL_APPROVAL', minEquityPrice: 5, maxSpreadPercent: 15, minVolume: 100, maxHoldingTradingDays: 10 },
};
export const accountPolicySchema = z.object({
  maxDailyRealizedLoss: z.number().nonnegative(), maxTotalDailyLoss: z.number().nonnegative(),
  maxGrossExposurePercent: z.number().min(0).max(100), minimumCashReserve: z.number().nonnegative(),
  maxPositions: z.number().int().nonnegative(), maxOrdersPerDay: z.number().int().nonnegative(),
  maxOrdersPerMinute: z.number().int().nonnegative(), maxOrderNotional: z.number().nonnegative(),
  lossCooldownMinutes: z.number().int().nonnegative(), maxQuoteAgeSeconds: z.number().int().positive(),
  maxProposalAgeSeconds: z.number().int().positive(), maxResearchAgeHours: z.number().positive(),
  optionsLevel: z.literal(2), allowLevel3: z.literal(false), allowBorrowing: z.literal(false),
}).strict();
export type AccountPolicy = z.infer<typeof accountPolicySchema>;
export const DEFAULT_ACCOUNT_POLICY: AccountPolicy = { maxDailyRealizedLoss: 25, maxTotalDailyLoss: 40, maxGrossExposurePercent: 90, minimumCashReserve: 25, maxPositions: 12, maxOrdersPerDay: 12, maxOrdersPerMinute: 3, maxOrderNotional: 250, lossCooldownMinutes: 60, maxQuoteAgeSeconds: 60, maxProposalAgeSeconds: 900, maxResearchAgeHours: 24, optionsLevel: 2, allowLevel3: false, allowBorrowing: false };
export interface OptionInstrument { optionId: string; underlying: string; type: 'CALL' | 'PUT'; strike: number; expiration: string; multiplier: 100 }
export interface TrustedQuote { symbol: string; price: number; bid: number; ask: number; volume: number; asOf: string; tradingEligible: boolean; option?: OptionInstrument; usListed?:boolean; leveraged?:boolean; assetClass?:'EQUITY'|'ETF'|'OPTION'|undefined; sector?:string; marketCap?:number; relativeVolume?:number; atrPercent?:number; valuationPE?:number; setupScore?:number; earningsWithinHolding?:boolean; openInterest?:number; delta?:number; gamma?:number; theta?:number; vega?:number; iv?:number; underlyingPrice?:number; underlyingVolume?:number; provenance?:string }
export interface ExecutableOrder {
  clientOrderId: string; strategy: Sleeve; assetClass: ProposalInput['assetClass']; symbol: string; underlying: string | null;
  side: 'BUY' | 'SELL'; positionEffect: 'OPEN' | 'CLOSE'; quantity: number; orderType: ProposalInput['orderType'];
  limitPrice: number | null; stopPrice: number | null; timeInForce: 'DAY' | 'GTC'; marketHours: 'REGULAR' | 'EXTENDED'; option: OptionInstrument | null;
}
export interface BrokerPreview { approved: boolean; asOf: string; estimatedCost: number; collateralRequired: number; reason: string; raw?: unknown }
export interface BrokerFill { id: string; brokerOrderId: string; quantity: number; price: number; fees: number|null; executedAt: string }
export interface TradingAccount {
  accountId: string; agentic: boolean; cash: number; buyingPower: number; netAccountValue: number; optionsLevel: number;
  asOf: string; healthy: boolean; complete: boolean;
  positions: Array<{ symbol: string; quantity: number; averageCost: number|null; basisStatus?: "KNOWN"|"UNAVAILABLE_EXTERNAL"|undefined; price: number; assetClass: 'EQUITY' | 'ETF' }>;
  options: Array<{ optionId: string; contracts: number; averagePremium: number; price: number; collateral: number }>;
  orders: Array<{ id: string; clientOrderId: string | null; status: string; filledQuantity: number }>; fills: BrokerFill[];
}
export interface TradingBroker {
  readonly deterministic: boolean;
  account(): Promise<TradingAccount>;
  quote(p: ProposalInput): Promise<TrustedQuote>;
  preview(order: ExecutableOrder): Promise<BrokerPreview>;
  place(order: ExecutableOrder): Promise<{ id: string; status: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN'; fills: BrokerFill[] }>;
  cancel(id: string): Promise<{ cancelled: boolean; pending?:boolean }>;
  lookup?(order:ExecutableOrder,id:string):Promise<{order:TradingAccount["orders"][number];fills:BrokerFill[]}>;
}
