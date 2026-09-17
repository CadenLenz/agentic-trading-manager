# V2 architecture and integration boundary

## Pre-production services (schema 4)

React/Vite → authenticated Fastify/CSRF → persistent application agent → typed service tools → proposals → inherited deterministic risk → broker preview → approval/policy → second risk → execution → reconciliation → SQLite/WAL → analytics, reports, notifications and audit. The agent has no raw DB, shell or unrestricted broker tool.

`configuration.ts` owns validated revisions and global→sleeve→asset→symbol resolution. `analytics.ts` stores account/mode-separated attributed snapshots and option telemetry. `broker-events.ts` applies explicitly reviewed ownership/cash/split/option economic events. `notifications.ts` persists deduplicated events and a claimed SMS outbox. `connectors.ts` uses the installed official MCP SDK OAuth/PKCE and runtime schemas. `mcp-binding.ts` accepts only a protected, catalog-hash-bound operator-reviewed deterministic mapping; no account fields/arguments are guessed. It never places or cancels real orders.

`system-simulation.ts` constructs its own fixture-only service graph and DB. Application DB writes are limited to test metadata/events/readiness evidence, never portfolio fills/cash. `pi-acceptance.ts` inspects the actual host and separates operator observations from automatic checks. `readiness.ts` enforces explicit sequential stages and a hard pre-production LIVE lock. Graceful shutdown cancels/waits for an active simulation before closing the DB. Physical restart is an acceptance task, not inferred from a successful local fixture restart.

The current factual limitations and superseding verification are in [PREPRODUCTION_REPORT.md](PREPRODUCTION_REPORT.md). The remaining foundation discussion below describes the earlier V2 design; it is not proof of commissioned production connectors.

V2 updates the existing React/Vite, Fastify, SQLite WAL, ledger, auth, SSE, watcher, job queue and systemd application in place. It is a verified **Simulation foundation, not a production LIVE release**. See IMPLEMENTATION_V2.md for unimplemented acceptance items.

Active ownership is exactly SAFE_LONG_TERM, AGGRESSIVE_STOCKS and OPTIONS. Stock sleeves accept long equities/ETFs only. OPTIONS accepts single-leg long calls/puts, covered calls and cash-secured puts, never spreads or naked calls. Covered-call shares must be explicitly owned by OPTIONS.

React AgentChat → authenticated/CSRF-protected Fastify → PersistentTradingAgent → typed application tools → ProposalService → deterministic risk → broker preview → version-bound manual approval or sleeve-specific autonomous policy → second risk → durable execution reservation → TradingBroker → fill ledger → reconciliation.

The model never receives a database, shell, raw MCP, placement or approval tool. The old ambient Codex brokerage placement/cancellation path is disabled. Legacy equity simulation and historical views remain for regression coverage; they cannot place real orders. CodexRunner remains in the repository but V2 analysis refuses ambient tool access.

## Migration 3

Automatic VACUUM INTO backup precedes an existing database upgrade. Migration runs transactionally and aborts on inconsistent legacy ownership. Old strategies become archived and disabled. Original rows are copied to migration_archive, and strategy_aliases retains old-to-new ownership. Long-Term maps to SAFE; Day Trader/Growth map to AGGRESSIVE. Cash, lots, orders, fill attribution, P&L and related history move to their canonical owner. OPTIONS starts empty. Pending old changes expire. LIVE is revoked; an old non-Simulation database becomes Read Only; trading is globally paused and requires ownership review.

New tables: migration_archive, strategy_aliases, sleeve_policies, strategy_capital, strategy_allocations, proposals, proposal_transitions, risk_decisions_v2, executions_v2, capital_reservations, option_positions, option_lots, position_assignments, trading_reports, scheduler_jobs_v2, market_sessions, agent_sessions, agent_messages, agent_actions, simulation_option_instruments. strategies adds archived and sleeve_kind. Legacy constrained kind is retained internally; API kind uses canonical sleeve_kind.

No hard-coded account balance or migration ticker determines live ownership. A small-account allocation test uses $950 to verify thirds; production allocation reads verified NAV, not buying power.

## Persistent lifecycle

DRAFT → RESEARCHED → SUBMITTED_TO_RISK → RISK_APPROVED/RISK_REJECTED → BROKER_PREVIEWED → READY_TO_EXECUTE → EXECUTION_SENT → BROKER_ACCEPTED → PARTIALLY_FILLED/FILLED, with explicit CANCELLED, REJECTED, FAILED, RECONCILIATION_REQUIRED and CLOSED transitions. Illegal transitions throw. Every transition records actor, proposal version, reason/details and time.

Edits increment version and invalidate research, risk, preview and approval. The approval binds current version, order hash and expiry. One durable execution/idempotency key per proposal prevents resend, including after uncertain outcomes. Interrupted sends are marked for reconciliation at startup. Unknown outcomes retain reservations and pause globally; never retry placement.

## Capital and options

Weekly targets default to NAV/3. Explicit target weight changes normalize the other sleeves to sum to one. Allocation transfers free cash only outside tolerance bands; it never forces sales, releases option collateral or uses buying power as NAV. Cash/position transfers adjust capital baselines so transfers do not masquerade as returns/drawdown.

FIFO equities and signed option lots retain ownership. Long option value is positive; short option liability is negative. CSP reserves full strike × 100 × contracts, without relying on premium credit. Covered calls reserve 100 same-sleeve shares per contract. Partial fills transfer pending reservations into filled collateral proportionally. Fill IDs deduplicate accounting. Option exposure changes produce immediate reports.

60% drawdown is an emergency latched kill, not the operating loss allowance. Smaller configured normal/global/legacy limits reject new risk much earlier. A reviewed RESET sleeve action clears the latch but neither resumes the sleeve nor enables LIVE.

## Scheduling/calendar

Schedules persist in SQLite with America/Los_Angeles timezone and claimed minute slots. Defaults: Monday 06:35 allocation and SAFE review; market-day AGGRESSIVE and OPTIONS checks; 13:10 daily and Friday 13:20 weekly reports. Holiday/early-close-aware reviews skip absent/closed sessions. A NYSE 2026 calendar snapshot is included; other years fail closed until verified sessions are added. LIVE calendar evidence expires after seven days. No schedule automatically invents research or generates/executes trades.

The existing interval scheduler continues directive expiry, watchers, reconciliation and performance recording. Reports and records are local dashboard artifacts; no email/notification integration is included.
