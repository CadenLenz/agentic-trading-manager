# Agentic Trading Manager

Agentic Trading Manager is a simulation-first, always-on control plane for a Raspberry Pi 4. It divides one Robinhood Agentic Account into independently owned virtual strategy portfolios while keeping deterministic application code—not an LLM—in charge of authorization, hard risk, execution mode, and emergency controls.

> This software does not provide investment advice and makes no claim of profitability. Example defaults and seeded performance are clearly labeled simulation data.

## Implemented architecture

```text
React + Vite control room
          │ authenticated JSON API + SSE
          ▼
Fastify / AgenticManager
  ├─ Scheduler + persisted job queue + EventBus + WatcherEngine
  ├─ AgentOrchestrator ── controlled CodexRunner
  ├─ Strategy versions + expiring directives + watchlists
  ├─ VirtualPortfolioLedger ── SQLite WAL transactions
  ├─ deterministic RiskEngine ── hard gates
  ├─ ExecutionEngine ── SimulationBroker / RobinhoodMcpAdapter
  ├─ ReconciliationEngine ── halt on meaningful mismatch
  └─ audit, health, performance, daily briefs
                                │
                                ▼
                   official Robinhood Trading MCP
```

The initial logical agents are Day Trader, Aggressive Growth, and Long-Term Investor. Two strategies can own the same symbol without losing attribution; a sell can consume only the initiating strategy's FIFO lots. The dashboard also exposes confirmed global-risk editing, configurable scanner shortlists, daily briefs, strategy version restoration, and audited manual reconciliation attribution.

## Requirements

- Node.js 22.13 or newer (Node 22/24 LTS, ARM64 supported)
- npm 10 or newer
- Git
- Codex CLI for optional agent reasoning and Robinhood MCP access
- Raspberry Pi OS Lite 64-bit for the production target

For continuous Pi operation, use a quality PSU, Ethernet, 4 GB+ RAM, and a USB SSD rather than a low-end microSD card.

## Development quick start

```bash
git clone https://github.com/CadenLenz/agentic-trading-manager.git
cd agentic-trading-manager
cp .env.example .env
npm install
npm run migrate
npm run dev
```

Open `http://localhost:3000`, complete the wizard, and retain `TRADING_MODE=SIMULATION` plus `ALLOW_LIVE_TRADING=false`.

Windows PowerShell equivalent:

```powershell
Copy-Item .env.example .env
npm install
npm run migrate
npm run dev
```

## Validation

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

Production serves the built dashboard and API from one process:

```bash
npm run build
npm start
```

The API binds to `127.0.0.1:4010` by default. Use Tailscale for remote access rather than public port forwarding.

## Operating modes

- `SIMULATION`: internal fills only; Robinhood is optional.
- `READ_ONLY`: official Robinhood reads and reconciliation; all placement is blocked.
- `LIVE`: requires `TRADING_MODE=LIVE`, `ALLOW_LIVE_TRADING=true`, exact UI confirmation, clear reconciliation, trading-eligible market data, and authenticated MCP capability discovery.

Emergency stop revokes the database LIVE confirmation. No installation defaults to LIVE.

## Robinhood MCP

```bash
codex mcp add robinhood-trading --url https://agent.robinhood.com/mcp/trading
```

Then launch Codex, enter `/mcp`, select `robinhood-trading`, and complete the Robinhood desktop OAuth/onboarding flow. Do not automate credentials. See [Robinhood setup](docs/ROBINHOOD_SETUP.md).

## Repository map

```text
apps/api/                 Fastify API and production entry point
src/                      React control room and setup wizard
packages/core/            canonical types, manager, EventBus
packages/database/        SQLite migrations and strategy versions
packages/ledger/          virtual cash, lots, fills, realized P/L
packages/risk/            deterministic global/strategy/directive gates
packages/execution/       simulation and execution pipeline
packages/agents/          Codex harness, queue, orchestrator, manager chat
packages/robinhood/       official MCP adapter boundary
packages/reconciliation/  broker/internal comparison and resolution
packages/market-data/     provider abstraction and watcher
scripts/                  migration and online backup utilities
systemd/                  service, backup unit/timer, journal policy
tests/                    ledger, risk, API, versioning, recovery tests
docs/                     architecture, deployment, security, operations
```

## Read next

1. [Architecture](docs/ARCHITECTURE.md)
2. [Risk engine](docs/RISK_ENGINE.md)
3. [Virtual ledger](docs/VIRTUAL_LEDGER.md)
4. [Development](docs/DEVELOPMENT.md)
5. [Pi setup](docs/PI_SETUP.md)
6. [Operations](docs/OPERATIONS.md)

Robinhood integration and any order placement must use the official Trading MCP. Unofficial scraping, private endpoints, browser automation, and credential capture are out of scope and prohibited by design.
