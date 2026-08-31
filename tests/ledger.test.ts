import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../packages/database/src/database.js';
import { VirtualPortfolioLedger } from '../packages/ledger/src/virtual-ledger.js';
import { buy, fixture } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

describe('VirtualPortfolioLedger', () => {
  it('posts a buy transaction and reduces only that strategy cash', () => {
    const { ledger, close } = fixture(); cleanups.push(close);
    const beforeDay = ledger.getCash('day-trader'); const beforeGrowth = ledger.getCash('aggressive-growth');
    const result = buy(ledger, 'day-trader', 'NVDA', 2, 100, 'buy-basic');
    expect(result.orderStatus).toBe('FILLED'); expect(ledger.getPosition('day-trader', 'NVDA')).toMatchObject({ quantity: 2, averageCost: 100 });
    expect(ledger.getCash('day-trader')).toBe(beforeDay - 200); expect(ledger.getCash('aggressive-growth')).toBe(beforeGrowth);
  });

  it('handles partial fills transactionally', () => {
    const { ledger, close } = fixture(); cleanups.push(close);
    const orderId = ledger.createOrder({ idempotencyKey: 'partial', strategyId: 'day-trader', symbol: 'NVDA', side: 'BUY', quantity: 5, orderType: 'LIMIT', limitPrice: 101, mode: 'SIMULATION', source: 'TEST' });
    expect(ledger.applyFill({ brokerFillId: 'partial-1', orderId, quantity: 2, price: 100, fees: 0, executedAt: new Date().toISOString() }).orderStatus).toBe('PARTIALLY_FILLED');
    expect(ledger.applyFill({ brokerFillId: 'partial-2', orderId, quantity: 3, price: 102, fees: 0, executedAt: new Date().toISOString() }).orderStatus).toBe('FILLED');
    expect(ledger.getPosition('day-trader', 'NVDA')).toMatchObject({ quantity: 5, averageCost: 101.2 });
  });

  it('deduplicates repeated broker fill events', () => {
    const { ledger, close } = fixture(); cleanups.push(close);
    const orderId = ledger.createOrder({ idempotencyKey: 'duplicate', strategyId: 'day-trader', symbol: 'NVDA', side: 'BUY', quantity: 1, orderType: 'MARKET', mode: 'SIMULATION', source: 'TEST' });
    const fill = { brokerFillId: 'same-fill', orderId, quantity: 1, price: 100, fees: 0, executedAt: new Date().toISOString() };
    expect(ledger.applyFill(fill).duplicate).toBe(false); expect(ledger.applyFill(fill).duplicate).toBe(true); expect(ledger.getPosition('day-trader', 'NVDA')?.quantity).toBe(1);
  });

  it('preserves ownership when two strategies hold the same ticker', () => {
    const { ledger, close } = fixture(); cleanups.push(close);
    buy(ledger, 'day-trader', 'NVDA', 3, 100, 'shared-day'); buy(ledger, 'aggressive-growth', 'NVDA', 7, 110, 'shared-growth');
    expect(ledger.aggregatePositions()).toContainEqual({ symbol: 'NVDA', quantity: 10, marketValue: 1070 });
    expect(ledger.getPosition('day-trader', 'NVDA')?.averageCost).toBe(100); expect(ledger.getPosition('aggressive-growth', 'NVDA')?.averageCost).toBe(110);
  });

  it('sells only the attributed strategy quantity and calculates FIFO realized P/L', () => {
    const { ledger, close } = fixture(); cleanups.push(close);
    buy(ledger, 'day-trader', 'NVDA', 3, 100, 'sell-day'); buy(ledger, 'aggressive-growth', 'NVDA', 7, 110, 'sell-growth');
    const orderId = ledger.createOrder({ idempotencyKey: 'sell-own', strategyId: 'day-trader', symbol: 'NVDA', side: 'SELL', quantity: 2, orderType: 'MARKET', mode: 'SIMULATION', source: 'TEST' });
    const result = ledger.applyFill({ brokerFillId: 'sell-own-fill', orderId, quantity: 2, price: 125, fees: 0, executedAt: new Date().toISOString() });
    expect(result.realizedPnl).toBe(50); expect(ledger.getPosition('day-trader', 'NVDA')?.quantity).toBe(1); expect(ledger.getPosition('aggressive-growth', 'NVDA')?.quantity).toBe(7);
  });

  it('creates a post-trade review when an attributed position closes', () => {
    const { database, ledger, close } = fixture(); cleanups.push(close); buy(ledger, 'day-trader', 'NVDA', 1, 100, 'review-buy');
    const orderId = ledger.createOrder({ idempotencyKey: 'review-sell', strategyId: 'day-trader', symbol: 'NVDA', side: 'SELL', quantity: 1, orderType: 'MARKET', mode: 'SIMULATION', source: 'TEST' });
    ledger.applyFill({ brokerFillId: 'review-sell-fill', orderId, quantity: 1, price: 110, fees: 0, executedAt: new Date().toISOString() });
    const review = database.raw.prepare('SELECT symbol,realized_result FROM trade_reviews WHERE strategy_id=?').get('day-trader') as { symbol: string; realized_result: number };
    expect(review).toEqual({ symbol: 'NVDA', realized_result: 10 });
  });

  it('rejects a fill that would sell another strategy shares', () => {
    const { ledger, close } = fixture(); cleanups.push(close); buy(ledger, 'aggressive-growth', 'NVDA', 4, 100, 'only-growth');
    const orderId = ledger.createOrder({ idempotencyKey: 'steal', strategyId: 'day-trader', symbol: 'NVDA', side: 'SELL', quantity: 1, orderType: 'MARKET', mode: 'SIMULATION', source: 'TEST' });
    expect(() => ledger.applyFill({ brokerFillId: 'steal-fill', orderId, quantity: 1, price: 105, fees: 0, executedAt: new Date().toISOString() })).toThrow(/another strategy/i);
  });

  it('does not mutate the ledger for rejected or canceled orders', () => {
    const { ledger, close } = fixture(); cleanups.push(close);
    const rejected = ledger.createOrder({ idempotencyKey: 'rejected', strategyId: 'day-trader', symbol: 'NVDA', side: 'BUY', quantity: 1, orderType: 'MARKET', mode: 'SIMULATION', source: 'TEST' }); ledger.rejectOrder(rejected, 'risk', 'RISK');
    const canceled = ledger.createOrder({ idempotencyKey: 'canceled', strategyId: 'day-trader', symbol: 'RKLB', side: 'BUY', quantity: 1, orderType: 'MARKET', mode: 'SIMULATION', source: 'TEST' }); ledger.cancelOrder(canceled, 'user');
    expect(ledger.listPositions()).toHaveLength(0); expect(() => ledger.applyFill({ brokerFillId: 'late', orderId: canceled, quantity: 1, price: 10, fees: 0, executedAt: new Date().toISOString() })).toThrow(/canceled/i);
  });

  it('recovers persisted ownership after a restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ledger-restart-')); const path = join(directory, 'state.db'); cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    let database = openDatabase(path); let ledger = new VirtualPortfolioLedger(database); buy(ledger, 'long-term-investor', 'VTI', 2, 300, 'persist'); database.close();
    database = openDatabase(path); ledger = new VirtualPortfolioLedger(database); cleanups.push(() => database.close());
    expect(ledger.getPosition('long-term-investor', 'VTI')).toMatchObject({ quantity: 2, averageCost: 300 });
  });
});
