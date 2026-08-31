import { afterEach, describe, expect, it } from 'vitest';
import { buy, fixture, proposal } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); delete process.env.TRADING_MODE; delete process.env.ALLOW_LIVE_TRADING; });
const codes = (decision: { violations: Array<{ code: string }> }) => decision.violations.map((item) => item.code);

describe('RiskEngine deterministic gates', () => {
  it('rejects a strategy position limit breach', () => {
    const { risk, close } = fixture(); cleanups.push(close);
    const decision = risk.evaluate(proposal({ orderIntent: { side: 'BUY', quantity: 20, orderType: 'MARKET', timeInForce: 'DAY', assetType: 'EQUITY' }, requestedCapital: 2_000 }), risk.defaultContext());
    expect(decision.approved).toBe(false); expect(codes(decision)).toContain('STRATEGY_POSITION_LIMIT');
  });

  it('rejects spending beyond virtual strategy cash', () => {
    const { risk, close } = fixture(); cleanups.push(close);
    const decision = risk.evaluate(proposal({ marketPrice: 1_000, orderIntent: { side: 'BUY', quantity: 20, orderType: 'MARKET', timeInForce: 'DAY', assetType: 'EQUITY' }, requestedCapital: 20_000 }), risk.defaultContext());
    expect(codes(decision)).toContain('STRATEGY_CASH');
  });

  it('enforces research-only and forbidden directives above an agent proposal', () => {
    const { risk, directives, close } = fixture(); cleanups.push(close);
    directives.create({ strategyId: 'day-trader', type: 'RESEARCH_ONLY', symbol: 'NVDA', value: {}, reason: 'Test', expiresAt: null }, 'test');
    directives.create({ strategyId: null, type: 'FORBIDDEN_SYMBOL', symbol: 'NVDA', value: {}, reason: 'Test', expiresAt: null }, 'test');
    const decision = risk.evaluate(proposal(), risk.defaultContext());
    expect(codes(decision)).toEqual(expect.arrayContaining(['RESEARCH_ONLY', 'FORBIDDEN_SYMBOL']));
  });

  it('ignores an expired directive', () => {
    const { database, risk, close } = fixture(); cleanups.push(close);
    database.raw.prepare('INSERT INTO directives(id,strategy_id,type,symbol,value_json,reason,expires_at,active,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('expired', 'day-trader', 'RESEARCH_ONLY', 'NVDA', '{}', 'expired', new Date(Date.now() - 1_000).toISOString(), 1, new Date(Date.now() - 5_000).toISOString());
    expect(codes(risk.evaluate(proposal(), risk.defaultContext()))).not.toContain('RESEARCH_ONLY');
  });

  it('enforces global and strategy pause gates', () => {
    const { database, risk, close } = fixture(); cleanups.push(close);
    database.setSetting('global_pause', true); database.setStrategyEnabled('day-trader', false, 'test', 'test');
    const decision = risk.evaluate(proposal(), risk.defaultContext());
    expect(codes(decision)).toEqual(expect.arrayContaining(['GLOBAL_PAUSE', 'STRATEGY_PAUSED']));
  });

  it('permits a protective sell while globally paused', () => {
    const { database, ledger, risk, close } = fixture(); cleanups.push(close); buy(ledger, 'day-trader', 'NVDA', 1, 100, 'protective'); database.setSetting('global_pause', true);
    const decision = risk.evaluate(proposal({ action: 'SELL', source: 'PROTECTIVE', orderIntent: { side: 'SELL', quantity: 1, orderType: 'MARKET', timeInForce: 'DAY', assetType: 'EQUITY' } }), risk.defaultContext());
    expect(codes(decision)).not.toContain('GLOBAL_PAUSE'); expect(decision.approved).toBe(true);
  });

  it('rejects stale market data', () => {
    const { risk, close } = fixture(); cleanups.push(close);
    const decision = risk.evaluate(proposal({ marketDataAsOf: new Date(Date.now() - 10 * 60_000).toISOString() }), risk.defaultContext());
    expect(codes(decision)).toContain('STALE_MARKET_DATA');
  });

  it('rejects when reconciliation is not clear', () => {
    const { database, risk, close } = fixture(); cleanups.push(close); database.setSetting('reconciliation_clear', false);
    expect(codes(risk.evaluate(proposal(), risk.defaultContext()))).toContain('RECONCILIATION_FAULT');
  });

  it('blocks all placement in READ_ONLY', () => {
    const { database, risk, close } = fixture(); cleanups.push(close); database.setSetting('operating_mode', 'READ_ONLY');
    expect(codes(risk.evaluate(proposal(), risk.defaultContext()))).toContain('READ_ONLY_MODE');
  });

  it('requires every independent LIVE gate', () => {
    const { database, risk, close } = fixture(); cleanups.push(close); database.setSetting('operating_mode', 'LIVE');
    expect(codes(risk.evaluate(proposal(), risk.defaultContext()))).toContain('LIVE_GATE_INCOMPLETE');
    process.env.TRADING_MODE = 'LIVE'; process.env.ALLOW_LIVE_TRADING = 'true'; database.setSetting('live_db_confirmation', true);
    expect(codes(risk.evaluate(proposal(), risk.defaultContext()))).not.toContain('LIVE_GATE_INCOMPLETE');
  });

  it('enforces strategy ownership on sells', () => {
    const { ledger, risk, close } = fixture(); cleanups.push(close); buy(ledger, 'aggressive-growth', 'NVDA', 4, 100, 'ownership-risk');
    const decision = risk.evaluate(proposal({ action: 'SELL', orderIntent: { side: 'SELL', quantity: 1, orderType: 'MARKET', timeInForce: 'DAY', assetType: 'EQUITY' } }), risk.defaultContext());
    expect(codes(decision)).toContain('OWNERSHIP_LIMIT');
  });

  it('rejects disabled asset classes', () => {
    const { risk, close } = fixture(); cleanups.push(close);
    const option = risk.evaluate(proposal({ orderIntent: { side: 'BUY', quantity: 1, orderType: 'MARKET', timeInForce: 'DAY', assetType: 'OPTION' } }), risk.defaultContext());
    const crypto = risk.evaluate(proposal({ orderIntent: { side: 'BUY', quantity: 1, orderType: 'MARKET', timeInForce: 'DAY', assetType: 'CRYPTO' } }), risk.defaultContext());
    expect(codes(option)).toContain('OPTIONS_DISABLED'); expect(codes(crypto)).toContain('CRYPTO_DISABLED');
  });

  it('enforces strategy cash reserve and strategy-scoped sector concentration', () => {
    const { database, risk, close } = fixture(); cleanups.push(close); const strategy = database.getStrategy('day-trader')!;
    database.updateStrategy(strategy.id, { ...strategy.config, maxPositionPercent: 100, maxSectorExposurePercent: 10 }, 'TEST', 'tester', 'tight sector');
    const decision = risk.evaluate(proposal({ marketPrice: 100, orderIntent: { side: 'BUY', quantity: 91, orderType: 'MARKET', timeInForce: 'DAY', assetType: 'EQUITY' }, requestedCapital: 9_100, sector: 'Technology' }), risk.defaultContext());
    expect(codes(decision)).toEqual(expect.arrayContaining(['STRATEGY_CASH_RESERVE', 'STRATEGY_SECTOR_CONCENTRATION']));
  });

  it('enforces strategy drawdown from persisted performance history', () => {
    const { database, risk, close } = fixture(); cleanups.push(close);
    database.raw.prepare('INSERT INTO performance_snapshots(id,strategy_id,equity,cash,exposure,realized_pnl,unrealized_pnl,drawdown_percent,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('peak', 'day-trader', 12_000, 12_000, 0, 0, 0, 0, new Date().toISOString());
    expect(codes(risk.evaluate(proposal(), risk.defaultContext()))).toContain('STRATEGY_MAX_DRAWDOWN');
  });

  it('suspends a strategy after the configured consecutive losing trades', () => {
    const { database, ledger, risk, close } = fixture(); cleanups.push(close);
    for (let index = 0; index < 3; index += 1) {
      const symbol = `T${index}`; buy(ledger, 'day-trader', symbol, 1, 100, `loss-buy-${index}`);
      const orderId = ledger.createOrder({ idempotencyKey: `loss-sell-${index}`, strategyId: 'day-trader', symbol, side: 'SELL', quantity: 1, orderType: 'MARKET', mode: 'SIMULATION', source: 'TEST' });
      ledger.applyFill({ brokerFillId: `loss-fill-${index}`, orderId, quantity: 1, price: 90, fees: 0, executedAt: new Date(Date.now() + index).toISOString() });
    }
    const decision = risk.evaluate(proposal({ symbol: 'MSFT' }), risk.defaultContext());
    expect(codes(decision)).toContain('CONSECUTIVE_LOSSES'); expect(database.getStrategy('day-trader')?.enabled).toBe(false);
  });
});
