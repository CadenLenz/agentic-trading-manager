import { makeId, nowIso } from '../../core/src/utils.js';
import type { TradeProposal } from '../../core/src/types.js';
import type { VirtualPortfolioLedger, FillApplicationResult } from '../../ledger/src/virtual-ledger.js';

export class SimulationBroker {
  constructor(private readonly ledger: VirtualPortfolioLedger) {}
  execute(orderId: string, proposal: TradeProposal): FillApplicationResult {
    if (!proposal.orderIntent) throw new Error('Simulation execution requires an order intent');
    return this.ledger.applyFill({ brokerFillId: makeId('simfill'), orderId, quantity: proposal.orderIntent.quantity, price: proposal.marketPrice, fees: 0, executedAt: nowIso() });
  }
}
