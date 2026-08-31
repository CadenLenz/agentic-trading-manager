import type { BrokerAccountSnapshot, ReconciliationMismatch } from '../../core/src/types.js';
import { makeId, nowIso, roundMoney, roundQuantity } from '../../core/src/utils.js';
import type { AppDatabase } from '../../database/src/database.js';
import type { VirtualPortfolioLedger } from '../../ledger/src/virtual-ledger.js';

export class ReconciliationEngine {
  constructor(private readonly database: AppDatabase, private readonly ledger: VirtualPortfolioLedger) {}

  reconcile(snapshot: BrokerAccountSnapshot, source: 'ROBINHOOD' | 'SIMULATION'): ReconciliationMismatch[] {
    const internal = new Map(this.ledger.aggregatePositions().map((position) => [position.symbol, position.quantity]));
    const broker = new Map(snapshot.positions.map((position) => [position.symbol, position.quantity]));
    const symbols = new Set([...internal.keys(), ...broker.keys()]);
    const tolerance = this.database.getGlobalRisk().maxReconciliationDiscrepancy;
    const mismatches: ReconciliationMismatch[] = [];
    for (const symbol of symbols) {
      const internalQuantity = internal.get(symbol) ?? 0;
      const brokerQuantity = broker.get(symbol) ?? 0;
      const difference = roundQuantity(brokerQuantity - internalQuantity);
      if (Math.abs(difference) > tolerance) mismatches.push({ kind: 'POSITION', symbol, internalValue: internalQuantity, brokerValue: brokerQuantity, difference, severity: 'CRITICAL', details: { source, brokerAverageCost: snapshot.positions.find((position) => position.symbol === symbol)?.averageCost ?? 0 } });
    }
    if (source === 'ROBINHOOD') {
      const internalCash = this.database.listStrategies().reduce((sum, strategy) => sum + strategy.cash, 0);
      const difference = roundMoney(snapshot.cash - internalCash);
      if (Math.abs(difference) > tolerance) mismatches.push({ kind: 'CASH', internalValue: roundMoney(internalCash), brokerValue: roundMoney(snapshot.cash), difference, severity: 'CRITICAL', details: { source } });
    }
    this.database.raw.transaction(() => {
      this.database.raw.prepare('DELETE FROM broker_positions').run();
      const insertPosition = this.database.raw.prepare('INSERT INTO broker_positions(symbol,quantity,average_cost,asset_type,sector,updated_at) VALUES(?,?,?,?,?,?)');
      for (const position of snapshot.positions) insertPosition.run(position.symbol, position.quantity, position.averageCost, position.assetType, position.sector, snapshot.asOf);
      for (const mismatch of mismatches) this.database.raw.prepare('INSERT INTO reconciliation_events(id,severity,status,kind,symbol,internal_value,broker_value,difference,details_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(makeId('recon'), mismatch.severity, 'OPEN', mismatch.kind, mismatch.symbol ?? null, String(mismatch.internalValue), String(mismatch.brokerValue), mismatch.difference, JSON.stringify(mismatch.details), nowIso());
      this.database.setSetting('reconciliation_clear', mismatches.every((mismatch) => mismatch.severity !== 'CRITICAL'));
      this.database.setSetting('last_reconciliation_at', nowIso());
      if (mismatches.some((mismatch) => mismatch.severity === 'CRITICAL')) this.database.setSetting('global_pause', true);
      this.database.audit('RECONCILIATION_ENGINE', 'RECONCILIATION_COMPLETED', 'account', null, { source, mismatchCount: mismatches.length, mismatches });
    })();
    return mismatches;
  }

  simulationSnapshot(): BrokerAccountSnapshot {
    const positions = this.ledger.aggregatePositions().map((position) => ({ symbol: position.symbol, quantity: position.quantity, averageCost: 0, assetType: 'EQUITY' as const, sector: 'Unknown' }));
    const cash = this.database.listStrategies().reduce((sum, strategy) => sum + strategy.cash, 0);
    const exposure = this.ledger.listPositions().reduce((sum, position) => sum + position.marketValue, 0);
    return { buyingPower: cash, cash, equity: cash + exposure, positions, openOrders: [], asOf: nowIso() };
  }

  resolve(eventId: string, resolution: 'ACKNOWLEDGE_EXTERNAL' | 'REVERSE_AT_BROKER' | 'ATTRIBUTE_TO_STRATEGY', actor: string, strategyId?: string): void {
    const event = this.database.raw.prepare('SELECT * FROM reconciliation_events WHERE id=? AND status=\'OPEN\'').get(eventId) as { id: string; kind: string; symbol: string | null; difference: number; details_json: string } | undefined;
    if (!event) throw new Error('Open reconciliation event not found');
    if (resolution === 'ATTRIBUTE_TO_STRATEGY') {
      if (!strategyId || !this.database.getStrategy(strategyId)) throw new Error('A valid strategy attribution is required');
      if (event.kind !== 'POSITION' || !event.symbol || event.difference <= 0) throw new Error('Only positive manual position additions can be attributed automatically');
      const details = JSON.parse(event.details_json) as { brokerAverageCost?: number };
      const price = details.brokerAverageCost && details.brokerAverageCost > 0 ? details.brokerAverageCost : 0;
      if (!price) throw new Error('Broker average cost is required for manual attribution');
      const orderId = this.ledger.createOrder({ idempotencyKey: `manual-attribution:${event.id}`, strategyId, symbol: event.symbol, side: 'BUY', quantity: event.difference, orderType: 'MARKET', mode: this.database.getMode(), source: 'MANUAL_ATTRIBUTION' });
      this.ledger.applyFill({ brokerFillId: `manual:${event.id}`, orderId, quantity: event.difference, price, fees: 0, executedAt: nowIso() });
    }
    this.database.raw.prepare('UPDATE reconciliation_events SET status=?,resolution_json=?,resolved_at=? WHERE id=?').run('RESOLVED', JSON.stringify({ resolution, strategyId: strategyId ?? null, actor }), nowIso(), eventId);
    const remaining = this.database.raw.prepare("SELECT COUNT(*) AS count FROM reconciliation_events WHERE status='OPEN' AND severity='CRITICAL'").get() as { count: number };
    this.database.setSetting('reconciliation_clear', remaining.count === 0);
    this.database.audit(actor, 'RECONCILIATION_RESOLVED', 'reconciliation_event', eventId, { resolution, strategyId });
  }
}
