import { openDatabase } from '../packages/database/src/database.js';
import { VirtualPortfolioLedger } from '../packages/ledger/src/virtual-ledger.js';
import { DirectiveService } from '../packages/strategies/src/directive-service.js';
import { RiskEngine } from '../packages/risk/src/risk-engine.js';
import type { TradeProposal } from '../packages/core/src/types.js';

export function fixture() {
  const database = openDatabase(':memory:');
  const ledger = new VirtualPortfolioLedger(database);
  const directives = new DirectiveService(database);
  const risk = new RiskEngine(database, ledger, directives);
  return { database, ledger, directives, risk, close: () => database.close() };
}

export function proposal(overrides: Partial<TradeProposal> = {}): TradeProposal {
  return {
    strategyId: 'day-trader', symbol: 'NVDA', action: 'BUY', orderIntent: { side: 'BUY', quantity: 1, orderType: 'MARKET', timeInForce: 'DAY', assetType: 'EQUITY' },
    confidence: .7, thesis: 'Test proposal', timeHorizon: 'Test', riskFactors: ['Test risk'], invalidationConditions: ['Test invalidation'], requestedCapital: 100,
    requiresImmediateAction: false, marketPrice: 100, marketDataAsOf: new Date().toISOString(), sector: 'Technology', source: 'SIMULATION', ...overrides,
  };
}

export function buy(ledger: VirtualPortfolioLedger, strategyId: string, symbol: string, quantity: number, price: number, key: string) {
  const orderId = ledger.createOrder({ idempotencyKey: key, strategyId, symbol, side: 'BUY', quantity, orderType: 'MARKET', mode: 'SIMULATION', source: 'TEST' });
  return ledger.applyFill({ brokerFillId: `${key}:fill`, orderId, quantity, price, fees: 0, executedAt: new Date().toISOString() });
}
