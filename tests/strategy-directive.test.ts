import { afterEach, describe, expect, it } from 'vitest';
import { fixture } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

describe('strategy versioning and directives', () => {
  it('creates a new immutable strategy version with a diff', () => {
    const { database, close } = fixture(); cleanups.push(close); const original = database.getStrategy('day-trader')!;
    const updated = database.updateStrategy(original.id, { ...original.config, maxTradesPerDay: 5 }, 'TEST', 'tester', 'Reduce turnover');
    expect(updated.version).toBe(2); expect(updated.config.maxTradesPerDay).toBe(5);
    const row = database.raw.prepare('SELECT diff_json FROM strategy_versions WHERE strategy_id=? AND version=2').get(original.id) as { diff_json: string };
    expect(JSON.parse(row.diff_json).maxTradesPerDay).toEqual({ from: 8, to: 5 });
  });

  it('reverts by creating another version instead of deleting history', () => {
    const { database, close } = fixture(); cleanups.push(close); const original = database.getStrategy('day-trader')!;
    database.updateStrategy(original.id, { ...original.config, maxTradesPerDay: 3 }, 'TEST', 'tester', 'test');
    const reverted = database.revertStrategy(original.id, 1, 'tester');
    expect(reverted.version).toBe(3); expect(reverted.config.maxTradesPerDay).toBe(8);
    const count = database.raw.prepare('SELECT COUNT(*) AS count FROM strategy_versions WHERE strategy_id=?').get(original.id) as { count: number }; expect(count.count).toBe(3);
  });

  it('versions allocation and adjusts only the corresponding cash account', () => {
    const { database, close } = fixture(); cleanups.push(close); const strategy = database.getStrategy('aggressive-growth')!; const other = database.getStrategy('day-trader')!;
    const updated = database.updateStrategy(strategy.id, { ...strategy.config, allocationAmount: 16_000 }, 'TEST', 'tester', 'increase');
    expect(updated.cash).toBe(strategy.cash + 1_000); expect(database.getStrategy('day-trader')?.cash).toBe(other.cash);
  });

  it('creates and deactivates directives with audit records', () => {
    const { database, directives, close } = fixture(); cleanups.push(close);
    const directive = directives.create({ strategyId: 'aggressive-growth', type: 'MAX_ALLOCATION', symbol: 'RKLB', value: { maxAmount: 500 }, reason: 'Test cap', expiresAt: null }, 'tester');
    expect(directives.matching('aggressive-growth', 'RKLB')).toHaveLength(1); directives.deactivate(directive.id, 'tester'); expect(directives.matching('aggressive-growth', 'RKLB')).toHaveLength(0);
    const audit = database.raw.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE entity_id=?").get(directive.id) as { count: number }; expect(audit.count).toBe(2);
  });
});
