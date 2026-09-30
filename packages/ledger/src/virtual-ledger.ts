import type { Database } from 'better-sqlite3';
import type { AssetType, LedgerFill, OrderSide, OperatingMode, OrderStatus, VirtualPosition } from '../../core/src/types.js';
import { makeId, nowIso, roundMoney, roundQuantity } from '../../core/src/utils.js';
import type { AppDatabase } from '../../database/src/database.js';

interface PositionRow {
  strategy_id: string; symbol: string; quantity: number; average_cost: number|null; market_price: number;
  sector: string; asset_type: AssetType; updated_at: string;
}

interface OrderRow {
  id: string; strategy_id: string | null; symbol: string; side: OrderSide; quantity: number; status: OrderStatus;
  cumulative_filled_quantity: number; sector: string; asset_type: AssetType;
}

export interface CreateOrderInput {
  idempotencyKey: string;
  strategyId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  orderType: string;
  limitPrice?: number;
  stopPrice?: number;
  mode: OperatingMode;
  source: string;
  sector?: string;
  assetType?: AssetType;
}

export interface FillApplicationResult {
  duplicate: boolean;
  orderStatus: OrderStatus;
  realizedPnl: number;
  position: VirtualPosition | null;
  cash: number;
}

export class VirtualPortfolioLedger {
  constructor(private readonly database: AppDatabase) {}

  createOrder(input: CreateOrderInput): string {
    const existing = this.database.raw.prepare('SELECT id FROM orders WHERE idempotency_key=?').get(input.idempotencyKey) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = makeId('ord');
    const timestamp = nowIso();
    this.database.raw.prepare(`INSERT INTO orders(id,idempotency_key,strategy_id,symbol,sector,asset_type,side,quantity,order_type,limit_price,stop_price,status,mode,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.idempotencyKey, input.strategyId, input.symbol, input.sector ?? 'Unknown', input.assetType ?? 'EQUITY', input.side, input.quantity, input.orderType, input.limitPrice ?? null, input.stopPrice ?? null, 'PENDING', input.mode, input.source, timestamp, timestamp);
    return id;
  }

  updateOrder(id: string, status: OrderStatus, brokerOrderId?: string, error?: Record<string, unknown>): void {
    const result = this.database.raw.prepare('UPDATE orders SET status=?,broker_order_id=COALESCE(?,broker_order_id),error_json=?,updated_at=? WHERE id=?')
      .run(status, brokerOrderId ?? null, error ? JSON.stringify(error) : null, nowIso(), id);
    if (result.changes !== 1) throw new Error('Order not found');
  }

  applyFill(fill: LedgerFill): FillApplicationResult {
    const transaction = this.database.raw.transaction((value: LedgerFill): FillApplicationResult => this.applyFillInTransaction(value));
    return transaction(fill);
  }

  cancelOrder(orderId: string, reason: string): void {
    const order = this.getOrder(orderId);
    if (!order) throw new Error('Order not found');
    if (order.status === 'FILLED') throw new Error('Filled order cannot be canceled');
    this.updateOrder(orderId, 'CANCELED', undefined, { reason });
  }

  rejectOrder(orderId: string, reason: string, code: string): void {
    const order = this.getOrder(orderId);
    if (!order) throw new Error('Order not found');
    if (order.cumulative_filled_quantity > 0) throw new Error('Partially filled order cannot be rejected; cancel the remainder');
    this.updateOrder(orderId, 'REJECTED', undefined, { reason, code });
  }

  getPosition(strategyId: string, symbol: string): VirtualPosition | null {
    const row = this.database.raw.prepare('SELECT * FROM strategy_positions WHERE strategy_id=? AND symbol=?').get(strategyId, symbol) as PositionRow | undefined;
    return row ? this.mapPosition(row) : null;
  }

  listPositions(strategyId?: string): VirtualPosition[] {
    const rows = (strategyId
      ? this.database.raw.prepare('SELECT * FROM strategy_positions WHERE strategy_id=? AND quantity>0.000001 ORDER BY symbol').all(strategyId)
      : this.database.raw.prepare('SELECT * FROM strategy_positions WHERE quantity>0.000001 ORDER BY strategy_id,symbol').all()) as PositionRow[];
    return rows.map((row) => this.mapPosition(row));
  }

  aggregatePositions(): Array<{ symbol: string; quantity: number; marketValue: number }> {
    return this.database.raw.prepare(`SELECT symbol,ROUND(SUM(quantity),6) AS quantity,SUM(quantity*market_price) AS marketValue FROM strategy_positions GROUP BY symbol HAVING SUM(quantity)>0.000001 ORDER BY symbol`).all() as Array<{ symbol: string; quantity: number; marketValue: number }>;
  }

  markPrices(quotes: Array<{ symbol: string; price: number }>): void {
    const update = this.database.raw.prepare('UPDATE strategy_positions SET market_price=?,updated_at=? WHERE symbol=?');
    this.database.raw.transaction(() => { for (const quote of quotes) update.run(quote.price, nowIso(), quote.symbol); })();
  }

  getCash(strategyId: string): number {
    const row = this.database.raw.prepare('SELECT balance FROM strategy_cash WHERE strategy_id=?').get(strategyId) as { balance: number } | undefined;
    if (!row) throw new Error('Strategy cash account not found');
    return roundMoney(row.balance);
  }

  getRealizedPnl(strategyId?: string, since?: string): number {
    const clauses: string[] = [];
    const parameters: Array<string> = [];
    if (strategyId) { clauses.push('strategy_id=?'); parameters.push(strategyId); }
    if (since) { clauses.push('created_at>=?'); parameters.push(since); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const row = this.database.raw.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM (SELECT strategy_id,amount,created_at FROM realized_pnl UNION ALL SELECT strategy_id,amount,created_at FROM economic_event_pnl) ${where}`).get(...parameters) as { total: number };
    return roundMoney(row.total);
  }

  private applyFillInTransaction(fill: LedgerFill): FillApplicationResult {
    const duplicate = this.database.raw.prepare('SELECT order_id FROM fills WHERE broker_fill_id=?').get(fill.brokerFillId) as { order_id: string } | undefined;
    if (duplicate) {
      const order = this.getOrder(duplicate.order_id) as OrderRow;
      const position = order.strategy_id ? this.getPosition(order.strategy_id, order.symbol) : null;
      return { duplicate: true, orderStatus: order.status, realizedPnl: 0, position, cash: order.strategy_id ? this.getCash(order.strategy_id) : 0 };
    }

    const order = this.getOrder(fill.orderId);
    if (!order?.strategy_id) throw new Error('Fill order or strategy attribution not found');
    if (order.status === 'REJECTED' || order.status === 'CANCELED') throw new Error(`Cannot apply fill to ${order.status.toLowerCase()} order`);
    if (order.cumulative_filled_quantity + fill.quantity > order.quantity + 0.000001) throw new Error('Fill quantity exceeds order quantity');

    const strategy = this.database.getStrategy(order.strategy_id);
    if (!strategy) throw new Error('Strategy not found');
    const fillId = makeId('fill');
    this.database.raw.prepare('INSERT INTO fills(id,broker_fill_id,order_id,quantity,price,fees,executed_at) VALUES(?,?,?,?,?,?,?)')
      .run(fillId, fill.brokerFillId, order.id, fill.quantity, fill.price, fill.fees, fill.executedAt);
    this.database.raw.prepare('INSERT INTO strategy_fills(id,fill_id,strategy_id,symbol,side,quantity,price,fees,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(makeId('sf'), fillId, order.strategy_id, order.symbol, order.side, fill.quantity, fill.price, fill.fees, fill.executedAt);

    let realizedPnl = 0;
    if (order.side === 'BUY') this.applyBuy(this.database.raw, order, fill, fillId);
    else realizedPnl = this.applySell(this.database.raw, order, fill, fillId);

    const cumulative = roundQuantity(order.cumulative_filled_quantity + fill.quantity);
    const status: OrderStatus = cumulative >= order.quantity - 0.000001 ? 'FILLED' : 'PARTIALLY_FILLED';
    this.database.raw.prepare('UPDATE orders SET cumulative_filled_quantity=?,status=?,updated_at=? WHERE id=?').run(cumulative, status, nowIso(), order.id);
    this.database.raw.prepare(`INSERT INTO virtual_transactions(id,idempotency_key,strategy_id,type,amount,symbol,quantity,reference_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(makeId('vtx'), `fill:${fill.brokerFillId}`, order.strategy_id, order.side, roundMoney(fill.quantity * fill.price + fill.fees), order.symbol, fill.quantity, fillId, JSON.stringify({ price: fill.price, fees: fill.fees }), fill.executedAt);
    this.database.audit('EXECUTION_ENGINE', 'FILL_APPLIED', 'order', order.id, { fillId, brokerFillId: fill.brokerFillId, quantity: fill.quantity, price: fill.price, status });
    return { duplicate: false, orderStatus: status, realizedPnl, position: this.getPosition(order.strategy_id, order.symbol), cash: this.getCash(order.strategy_id) };
  }

  private applyBuy(sqlite: Database, order: OrderRow, fill: LedgerFill, fillId: string): void {
    const cost = roundMoney(fill.quantity * fill.price + fill.fees);
    const cash = this.getCash(order.strategy_id as string);
    if (cost > cash + 0.000001) throw new Error('Insufficient virtual cash for fill');
    const current = this.getPosition(order.strategy_id as string, order.symbol);
    const oldQuantity = current?.quantity ?? 0;
    const newQuantity = roundQuantity(oldQuantity + fill.quantity);
    const averageCost = current && current.averageCost===null ? null : roundMoney(((oldQuantity * (current?.averageCost ?? 0)) + (fill.quantity * fill.price) + fill.fees) / newQuantity);
    sqlite.prepare(`INSERT INTO strategy_positions(strategy_id,symbol,quantity,average_cost,market_price,sector,asset_type,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(strategy_id,symbol) DO UPDATE SET quantity=excluded.quantity,average_cost=excluded.average_cost,market_price=excluded.market_price,updated_at=excluded.updated_at`)
      .run(order.strategy_id, order.symbol, newQuantity, averageCost, fill.price, current?.sector ?? order.sector, current?.assetType ?? order.asset_type, fill.executedAt);
    sqlite.prepare('UPDATE strategy_cash SET balance=balance-?,updated_at=? WHERE strategy_id=?').run(cost, fill.executedAt, order.strategy_id);
    sqlite.prepare('INSERT INTO strategy_lots(id,strategy_id,symbol,remaining_quantity,entry_price,fees,opened_at,source_fill_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(makeId('lot'), order.strategy_id, order.symbol, fill.quantity, fill.price, fill.fees, fill.executedAt, fillId);
  }

  private applySell(sqlite: Database, order: OrderRow, fill: LedgerFill, fillId: string): number {
    const current = this.getPosition(order.strategy_id as string, order.symbol);
    if (!current || current.quantity + 0.000001 < fill.quantity) throw new Error('Strategy cannot sell shares owned by another strategy');
    if(current.averageCost===null)throw new Error('Cost basis unavailable: realized P&L cannot be calculated for this sale.');
    let remaining = fill.quantity;
    let costBasis = 0;
    const lots = sqlite.prepare('SELECT id,remaining_quantity,entry_price,fees,opened_at FROM strategy_lots WHERE strategy_id=? AND symbol=? AND remaining_quantity>0.000001 ORDER BY opened_at,id').all(order.strategy_id, order.symbol) as Array<{ id: string; remaining_quantity: number; entry_price: number; fees: number; opened_at: string }>;
    for (const lot of lots) {
      if (remaining <= 0.000001) break;
      const consumed = Math.min(remaining, lot.remaining_quantity);
      const feeShare = lot.remaining_quantity > 0 ? lot.fees * (consumed / lot.remaining_quantity) : 0;
      costBasis += consumed * lot.entry_price + feeShare;
      sqlite.prepare('UPDATE strategy_lots SET remaining_quantity=?,fees=fees-? WHERE id=?').run(roundQuantity(lot.remaining_quantity - consumed), feeShare, lot.id);
      remaining = roundQuantity(remaining - consumed);
    }
    if (remaining > 0.000001) throw new Error('Lot accounting is inconsistent with strategy position');
    const proceeds = fill.quantity * fill.price - fill.fees;
    const realized = roundMoney(proceeds - costBasis);
    const newQuantity = roundQuantity(current.quantity - fill.quantity);
    if (newQuantity <= 0.000001) sqlite.prepare('DELETE FROM strategy_positions WHERE strategy_id=? AND symbol=?').run(order.strategy_id, order.symbol);
    else {
      const basis = sqlite.prepare('SELECT COALESCE(SUM(remaining_quantity*entry_price+fees),0) AS basis,COALESCE(SUM(remaining_quantity),0) AS quantity FROM strategy_lots WHERE strategy_id=? AND symbol=? AND remaining_quantity>0.000001').get(order.strategy_id, order.symbol) as { basis: number; quantity: number };
      sqlite.prepare('UPDATE strategy_positions SET quantity=?,average_cost=?,market_price=?,updated_at=? WHERE strategy_id=? AND symbol=?')
        .run(newQuantity, basis.quantity > 0 ? roundMoney(basis.basis / basis.quantity) : 0, fill.price, fill.executedAt, order.strategy_id, order.symbol);
    }
    sqlite.prepare('UPDATE strategy_cash SET balance=balance+?,updated_at=? WHERE strategy_id=?').run(roundMoney(proceeds), fill.executedAt, order.strategy_id);
    sqlite.prepare('INSERT INTO realized_pnl(id,strategy_id,symbol,order_id,fill_id,amount,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(makeId('pnl'), order.strategy_id, order.symbol, order.id, fillId, realized, fill.executedAt);
    if (newQuantity <= 0.000001) {
      const thesis = sqlite.prepare("SELECT id,thesis,opened_at FROM theses WHERE strategy_id=? AND symbol=? AND status='OPEN' ORDER BY opened_at DESC LIMIT 1").get(order.strategy_id, order.symbol) as { id: string; thesis: string; opened_at: string } | undefined;
      sqlite.prepare('INSERT INTO trade_reviews(id,strategy_id,symbol,thesis_id,entry_summary_json,exit_summary_json,realized_result,followed_rules,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(makeId('review'), order.strategy_id, order.symbol, thesis?.id ?? null, JSON.stringify({ lots: lots.map((lot) => ({ entryPrice: lot.entry_price, quantity: lot.remaining_quantity, openedAt: lot.opened_at })), thesis: thesis?.thesis ?? null, intendedHorizon: null }), JSON.stringify({ price: fill.price, quantity: fill.quantity, fees: fill.fees, actualHorizonStart: thesis?.opened_at ?? lots[0]?.opened_at ?? null, maximumFavorableExcursion: null, maximumAdverseExcursion: null }), realized, 1, 'Generated deterministically when the attributed position closed; excursion data was unavailable.', fill.executedAt);
      if (thesis) sqlite.prepare("UPDATE theses SET status='CLOSED',closed_at=?,updated_at=? WHERE id=?").run(fill.executedAt, fill.executedAt, thesis.id);
    }
    return realized;
  }

  private getOrder(id: string): OrderRow | null {
    return (this.database.raw.prepare('SELECT id,strategy_id,symbol,sector,asset_type,side,quantity,status,cumulative_filled_quantity FROM orders WHERE id=?').get(id) as OrderRow | undefined) ?? null;
  }

  private mapPosition(row: PositionRow): VirtualPosition {
    const marketValue = roundMoney(row.quantity * row.market_price);
    return {
      strategyId: row.strategy_id, symbol: row.symbol, quantity: roundQuantity(row.quantity), averageCost: row.average_cost===null?null:roundMoney(row.average_cost), basisStatus:row.average_cost===null?"UNAVAILABLE_EXTERNAL":"KNOWN",
      marketPrice: roundMoney(row.market_price), sector: row.sector, assetType: row.asset_type, marketValue,
      unrealizedPnl: row.average_cost===null?null:roundMoney((row.market_price - row.average_cost) * row.quantity), updatedAt: row.updated_at,
    };
  }
}
