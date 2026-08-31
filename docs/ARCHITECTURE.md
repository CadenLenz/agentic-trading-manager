# Architecture

## Authority boundary

The central invariant is **Codex gets intelligence; AgenticManager gets authority**. Agent output is parsed against a JSON schema and becomes a proposal. It cannot mutate configuration, allocate capital, run shell commands, or become an order without deterministic application checks.

The enforcement hierarchy is:

```text
global hard limits
  └─ strategy hard limits
       └─ active directives
            └─ agent/user proposal
```

Nothing lower in the hierarchy can override a higher restriction.

## Runtime composition

`AgenticManager` constructs one in-process service graph appropriate for a Raspberry Pi:

- `AppDatabase`: SQLite, WAL, foreign keys, migrations, critical transactions.
- `VirtualPortfolioLedger`: virtual cash, positions, FIFO lots, fills, ownership and P/L.
- `DirectiveService`: permanent or expiring constraints separate from strategy configuration.
- `RiskEngine`: pure deterministic evaluation plus persisted violation records.
- `MarketDataProvider`: swappable quotes/bars/status/scanner interface. V1 includes only a clearly labeled deterministic simulation provider; it is never LIVE-eligible.
- `WatcherEngine`: polling fallback that marks positions and emits mechanical events without calling Codex continuously.
- `Scheduler`: configurable interval and timezone-aware cron evaluations with per-minute deduplication; market-open decisions still consult the provider's market status.
- `JobQueue`: persisted priorities, deduplication and cancellation.
- `CodexRunner`: noninteractive process, read-only sandbox, explicit schema/workdir/timeout, bounded retry and concurrency.
- `AgentOrchestrator`: concise database-derived context and audit-ready structured decisions.
- `ExecutionEngine`: typed proposal → risk → mode → broker → ledger/audit.
- `RobinhoodMcpAdapter`: the sole Robinhood boundary. It discovers actual capabilities at runtime through the configured official MCP and normalizes responses.
- `ReconciliationEngine`: compares aggregate virtual positions/cash/open state with broker truth and halts on critical mismatch.
- `EventBus`: watcher, execution, risk, and health events feeding SSE and future notifications.

## Startup sequence

1. Open SQLite, enable foreign keys/WAL, apply migrations.
2. Restore settings, strategies, directives, jobs and ledger state.
3. Mark startup not ready.
4. Detect unresolved orders.
5. In Simulation, reconcile against the simulation aggregate; otherwise require an authenticated Robinhood read and reconcile.
6. Select the market-data provider. The built-in provider is simulation-only.
7. Start the persisted queue, scheduler and watcher.
8. Mark ready and publish `SYSTEM_READY`.

A failed broker read in non-simulation mode marks reconciliation blocked. Startup never assumes persisted state is current.

## Process topology

Development runs Vite on port 3000 and Fastify on 4010. Production builds the SPA into `dist/web`; the single Fastify process serves both the dashboard and API on 4010. systemd supervises that process and a separate oneshot backup timer.

## Failure posture

- Unknown LIVE order outcome becomes `UNKNOWN`; the adapter never retries placement automatically, and reconciliation blocks.
- Stale/untrusted data blocks orders.
- Codex timeout or malformed output creates an agent failure, not an order.
- Duplicate fills and duplicate execution requests are idempotent.
- Meaningful broker mismatch globally pauses new autonomous risk.
- Protective actions are deterministic; broker-side protective orders should be preferred when the discovered official MCP supports them.

## Intentional V1 boundaries

- No authenticated Robinhood session is bundled. The user must complete official desktop OAuth/onboarding.
- Exact Robinhood MCP tools are not hard-coded. Capability discovery is runtime-only, so unrecognized or unavailable operations fail closed.
- The included market-data provider is deterministic simulation data. A legitimate trading-grade provider must implement `MarketDataProvider` and explicitly set `tradingEligible=true`; the application otherwise rejects LIVE orders.
- Notification records and SSE are implemented; external email/SMS/push delivery is an adapter boundary, not silently simulated.
- Exchange-calendar truth is delegated to an official market-status capability/provider in non-simulation modes. The simulation provider reports an always-open synthetic session and is visibly labeled.
- Global hard-risk edits, strategy edits, and manual discrepancy attribution are operator-confirmed and audited. A `REVERSE_AT_BROKER` resolution records that the operator already completed the broker action; it does not synthesize a Robinhood order.
