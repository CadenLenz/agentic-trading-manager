# Agentic Trading Manager V2

An in-place update to the Raspberry Pi trading control plane: React/Vite, Fastify, SQLite/WAL, attributed FIFO ledger, persisted proposals, deterministic risk, local reports/scheduling and bounded Codex CLI tasks using ChatGPT login.

**Current status: approved pre-production commissioning candidate, simulation-validated; not production LIVE-ready or fully feature-complete. DO NOT ENABLE LIVE YET.** Placement and LIVE activation are locked in code, even with environment flags. Publication does not constitute Pi, connector, account, preview, or LIVE acceptance.

The Control Room now includes one-click isolated **RUN FULL SYSTEM TEST**, versioned inherited risk settings/history, account/sleeve/position charts, options lifecycle telemetry, notifications, official MCP OAuth/discovery, connections, Pi acceptance and explicit readiness stages. See the [current implementation report](docs/PREPRODUCTION_REPORT.md) for executed verification, exact limitations and the final-pass checklist.

Run `npm ci`, `npm test`, `npm run self-test`, `npm run test:system`, `npm run lint`, `npm run typecheck`, `npm run build`. The full-system CLI writes a retained temporary database and `simulation-report.json`; it does not open your application ledger or call a real broker/model. In the UI, the main button immediately starts a dedicated fixture session. See [Simulation](docs/SIMULATION.md), [Options](docs/OPTIONS.md), [Notifications](docs/NOTIFICATIONS.md), [Tailscale](docs/TAILSCALE.md) and [Production readiness](docs/PRODUCTION_READINESS.md).

Exactly three active sleeves:

| Sleeve | Default target | Execution assets |
| --- | --- | --- |
| SAFE_LONG_TERM | One third of account NAV | Long US stocks/ETFs; low turnover |
| AGGRESSIVE_STOCKS | One third of account NAV | Long US stocks/ETFs; intraday to short-term |
| OPTIONS | One third of account NAV | Single-leg Level 2 longs, covered calls, cash-secured puts |

Targets use total net account value, never buying power. Weekly allocation transfers free cash outside tolerance bands and never forces sales. Options collateral/share ownership is sleeve-specific. 60% drawdown is a latched emergency backstop; much tighter normal and inherited risk controls apply first. All policies default to manual approval.

The application owns risk and execution. Codex Tasks sends typed jobs to a separate authenticated worker, records results, and validates every proposed action. See [Codex worker architecture and operations](docs/CODEX_WORKER.md).

## Development

Node >=22.13, npm and Git are required. On Pi use 64-bit ARM64 Raspberry Pi OS with a USB SSD.

```bash
npm ci
cp .env.example .env
# Set a random SESSION_SECRET. No OpenAI API key is required.
npm run lint
npm run typecheck
npm test
npm run self-test
npm run build
npm audit --omit=dev
npm run dev
```

Windows PowerShell: Copy-Item .env.example .env instead of cp. Vite binds 127.0.0.1:3000; API 127.0.0.1:4010. First-run funds are labeled Simulation examples, not Robinhood balances. The dashboard works without Codex. For reasoning, deploy the private Unix-socket worker under the externally authenticated Codex user. Unavailable jobs fail safely and never fall back to API billing. Read-only Robinhood MCP tools are allowlisted; deterministic reconciliation retains its independent optional connector.

## Upgrade safety

Existing file databases receive an automatic pre-migration backup. Migration 3 archives original strategy records/history, moves Long-Term ownership to SAFE and Day/Growth ownership to AGGRESSIVE, starts OPTIONS empty, expires old pending changes, revokes LIVE and leaves trading paused. Internal ownership transfers require explicit review and cannot move shares reserved for covered calls.

```bash
npm run backup
npm run upgrade:safe
```

Stop service/backup writers before operating on a production DB. backup never triggers migrations first. upgrade:safe applies migrations and saves Read Only/paused/manual posture. Do not run an old binary against a migrated DB; restore a matched revision and backup together.

## Deployment, API and acceptance

- [Implementation report and remaining requested work](docs/IMPLEMENTATION_V2.md)
- [Architecture and schema](docs/ARCHITECTURE_V2.md)
- [Deterministic risk](docs/RISK_ENGINE.md)
- [Agent tools, modes and separate sleeve autonomy](docs/AGENT.md)
- [Official MCP boundary and LIVE prerequisites](docs/ROBINHOOD_MCP.md)
- [Exact GitHub → Pi installation/update commands](docs/PI_DEPLOYMENT.md)
- [Operations](docs/OPERATIONS.md), [security](docs/SECURITY.md), [backups](docs/BACKUPS.md), [recovery](docs/RECOVERY.md)

Pi scripts stage a reviewed published commit/tag and run validation before swapping releases; updates back up before migrations and never auto-enable LIVE/autonomy. Install only the exact commissioning SHA reported for a reviewed release. Physical Pi/systemd/HTTPS/rollback testing must be recorded separately and is never inferred from publication.

V1 architecture/agent/setup documents remain as historical context, but their old brokerage execution guidance is superseded by V2.

This is not investment advice, a profitability claim or an invitation to bypass safety gates.
