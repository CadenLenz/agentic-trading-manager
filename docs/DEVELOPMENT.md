# Development

## Install and run

```bash
cp .env.example .env
npm install
npm run migrate
npm run dev
```

Vite runs on `http://localhost:3000` and proxies API/SSE traffic to Fastify at `http://127.0.0.1:4010`. Development defaults use a non-production session secret only when `NODE_ENV` is not `production`. Set your own `.env` value for any persistent use.

## Commands

```bash
npm run dev           # web + API watchers
npm run typecheck     # strict client and server TypeScript
npm run lint          # ESLint, including no-explicit-any
npm test              # deterministic unit/integration tests
npm run build         # Vite SPA + bundled ESM API
npm start             # production build
npm run migrate       # apply schema migrations
npm run backup        # online SQLite backup
npm audit --omit=dev  # production dependency audit
```

## Database

`DATA_DIR` defaults to `./data`; the database file is `agentic-trading-manager.db`. Migrations are ordered, transactional, idempotent, and recorded in `schema_migrations`. Runtime-editable strategy/risk settings belong in SQLite, not environment variables.

Add a migration by appending a versioned entry in `packages/database/src/database.ts`. Never rewrite a migration already deployed. Add rollback/recovery instructions when a schema change cannot be forward-compatible.

## Adding a market-data provider

Implement `MarketDataProvider` in `packages/market-data`. A provider must supply quotes, batches, bars, market status and scanner results. Keep `tradingEligible=false` until the source, timestamp semantics, licensing, outage behavior and market-hours truth have been reviewed. The built-in simulation provider is always false.

## Adding Robinhood capabilities

Do not import an unofficial Robinhood client. Extend only `RobinhoodMcpAdapter`; discover exact current tool names instead of assuming them. Keep read, preview, placement and cancellation schemas separate. An uncertain placement must remain `UNKNOWN` and require reconciliation.

## Tests

- `ledger.test.ts`: buys, partial fills, duplicate events, shared tickers, strategy-only sells, FIFO P/L, rejection/cancel, restart.
- `risk.test.ts`: allocation/exposure/directive/pause/mode/staleness/reconciliation/asset gates.
- `strategy-directive.test.ts`: versions, diffs, revert, allocation journal, directive lifecycle.
- `reconciliation-execution.test.ts`: aggregate match, halt on mismatch, simulation execution, rejected order persistence.
- `api.test.ts`: setup, auth, CSRF, confirmation, invalid login and LIVE protection.
- `scheduler.test.ts`: timezone-aware cron matching and same-minute deduplication.

Use temporary or in-memory databases. No test should contact Robinhood or place a real order.

## Definition of done

Run lint, typecheck, tests, production build and production dependency audit. Search for accidental `TODO`, `FIXME`, `TEMP`, `HACK`, unlabelled mock/placeholder data, secrets and shell interpolation. Update the relevant operations/recovery documentation when behavior changes.
