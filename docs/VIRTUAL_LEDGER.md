# Virtual portfolio ledger

Robinhood sees one Agentic Account; the application tracks economic ownership by strategy.

## Accounting model

- An order is attributable to exactly one strategy unless a future explicit account-level operation says otherwise.
- `strategy_cash` is isolated by strategy.
- `strategy_positions` is keyed by `(strategy_id, symbol)`.
- `strategy_lots` holds FIFO cost-basis lots.
- `fills` deduplicates broker events by `broker_fill_id`.
- `strategy_fills` preserves attribution.
- `realized_pnl` records sell outcomes.
- `virtual_transactions` is an idempotent journal for fills and allocation changes.
- `broker_positions` stores the latest aggregate external snapshot; it never establishes ownership.

Every fill application is one SQLite transaction. A buy checks virtual cash, posts a lot, updates weighted average cost and reduces only the owning strategy's cash. A sell refuses quantity beyond that strategy's position, consumes its FIFO lots, posts realized P/L and adds net proceeds to that strategy's cash.

## Partial, duplicate and uncertain events

- Partial fills advance cumulative order quantity and remain `PARTIALLY_FILLED` until complete.
- Duplicate broker fill IDs return the prior state without reposting cash or shares.
- Rejected/canceled orders cannot accept a fill through the normal ledger path.
- A LIVE timeout becomes `UNKNOWN`; the application does not infer failure or retry. Reconciliation is required.
- Restart persistence comes from SQLite, not agent memory.

## Shared ticker example

```text
Broker NVDA: 35 shares
  Aggressive Growth: 15 shares / its lots
  Long-Term Investor: 20 shares / its lots
```

An Aggressive Growth sell of 15 is valid. A sell of 16 is rejected even though the aggregate broker account owns 35.

## Reconciliation

The engine aggregates virtual quantities by symbol, compares them to the broker snapshot within configured tolerance, and separately compares cash/open state when a real broker snapshot is used. Critical mismatch:

- persists an exact reconciliation event;
- sets reconciliation blocked;
- globally pauses new autonomous risk;
- remains visible for explicit manual classification or broker reversal.

The application never infers ownership from the broker aggregate. Manual attribution creates an explicit synthetic attributed order/fill at verified broker cost and is audited.
