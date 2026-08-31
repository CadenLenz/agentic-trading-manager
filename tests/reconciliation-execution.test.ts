import { afterEach, describe, expect, it } from 'vitest';
import { AgenticManager } from '../packages/core/src/agentic-manager.js';
import type { BrokerAccountSnapshot } from '../packages/core/src/types.js';
import { ReconciliationEngine } from '../packages/reconciliation/src/reconciliation-engine.js';
import { buy, fixture, proposal } from './helpers.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

describe('reconciliation and execution pipeline', () => {
  it('reconciles aggregated quantities from multiple strategy owners', () => {
    const { database, ledger, close } = fixture(); cleanups.push(close); buy(ledger, 'day-trader', 'NVDA', 3, 100, 'recon-day'); buy(ledger, 'aggressive-growth', 'NVDA', 7, 110, 'recon-growth');
    const engine = new ReconciliationEngine(database, ledger);
    const snapshot: BrokerAccountSnapshot = { buyingPower: 0, cash: 0, equity: 1_000, positions: [{ symbol: 'NVDA', quantity: 10, averageCost: 107, assetType: 'EQUITY', sector: 'Technology' }], openOrders: [], asOf: new Date().toISOString() };
    expect(engine.reconcile(snapshot, 'SIMULATION')).toHaveLength(0); expect(database.getSetting('reconciliation_clear')).toBe(true);
  });

  it('halts new autonomous risk on a position discrepancy', () => {
    const { database, ledger, close } = fixture(); cleanups.push(close); buy(ledger, 'day-trader', 'NVDA', 3, 100, 'recon-fault');
    const engine = new ReconciliationEngine(database, ledger);
    const snapshot: BrokerAccountSnapshot = { buyingPower: 0, cash: 0, equity: 1_000, positions: [{ symbol: 'NVDA', quantity: 4, averageCost: 100, assetType: 'EQUITY', sector: 'Technology' }], openOrders: [], asOf: new Date().toISOString() };
    const mismatches = engine.reconcile(snapshot, 'SIMULATION'); expect(mismatches[0]).toMatchObject({ kind: 'POSITION', symbol: 'NVDA', difference: 1, severity: 'CRITICAL' }); expect(database.getSetting('reconciliation_clear')).toBe(false); expect(database.getSetting('global_pause')).toBe(true);
  });

  it('executes an approved simulation proposal and deduplicates a repeated request', async () => {
    const manager = new AgenticManager({ databasePath: ':memory:', workingDirectory: process.cwd(), sessionSecret: 'a-secure-test-secret-that-is-long-enough', startBackgroundServices: false }); cleanups.push(() => manager.shutdown()); await manager.start();
    const first = await manager.execution.execute(proposal({ symbol: 'RKLB', marketPrice: 50 }), 'execution-idempotent', 'test'); const second = await manager.execution.execute(proposal({ symbol: 'RKLB', marketPrice: 50 }), 'execution-idempotent', 'test');
    expect(first.status).toBe('FILLED'); expect(second.orderId).toBe(first.orderId); expect(manager.ledger.getPosition('day-trader', 'RKLB')?.quantity).toBe(1);
  });

  it('persists a rejected order and exact risk reason', async () => {
    const manager = new AgenticManager({ databasePath: ':memory:', workingDirectory: process.cwd(), sessionSecret: 'a-secure-test-secret-that-is-long-enough', startBackgroundServices: false }); cleanups.push(() => manager.shutdown()); await manager.start();
    const result = await manager.execution.execute(proposal({ marketPrice: 1_000, orderIntent: { side: 'BUY', quantity: 20, orderType: 'MARKET', timeInForce: 'DAY', assetType: 'EQUITY' } }), 'execution-rejected', 'test');
    expect(result.status).toBe('REJECTED'); expect(result.risk.violations.length).toBeGreaterThan(0);
    const order = manager.database.raw.prepare('SELECT status,error_json FROM orders WHERE id=?').get(result.orderId) as { status: string; error_json: string }; expect(order.status).toBe('REJECTED'); expect(order.error_json).toContain('RISK_REJECTED');
  });
});
