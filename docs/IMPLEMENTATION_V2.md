# V2 implementation report

The **current pre-production pass and its 18-part handoff are in [PREPRODUCTION_REPORT.md](PREPRODUCTION_REPORT.md)**. The sections below are the preserved earlier foundation-pass record (70 tests); they are historical, not current connector/features/verification claims. The current pass adds schema 4, 76 rich risk settings, 25 agent tools, isolated 65-assertion full-system testing, charting/telemetry/notifications, official OAuth/discovery with reviewed READ_ONLY mapping, Pi acceptance, readiness and guarded emergency drafts. LIVE remains code-locked.

Status: approved pre-production commissioning candidate and Simulation foundation. Production LIVE acceptance remains blocked; publication alone is not Pi, connector, account, preview, or LIVE evidence and this is not a claim that every requested V2 feature is complete.

## Files and reuse

New packages/trading-v2/src/{model,capital,broker,proposals,agent,scheduling,self-tests}.ts contain strict schemas, allocation/capital tracking, synthetic/blocked-live brokers, persisted proposal/risk/execution lifecycle, persistent Responses agent/tools, DB-backed schedules/calendar and isolated acceptance tests. apps/api/src/v2-routes.ts adds the new API.

Existing packages/core/src/{types,agentic-manager}.ts, packages/database/src/database.ts, packages/execution/src/execution-engine.ts, packages/agents/src/orchestrator.ts, packages/robinhood/src/adapter.ts and packages/ledger/src/virtual-ledger.ts are updated in place. New packages/database/src/v2-migration.ts preserves/archives old ownership. Legacy capital-creating allocation updates are blocked outside first-run Simulation setup. FIFO stock fees now decrease proportionally after partial sales.

UI: new TradingWorkspace.tsx and AgentChat.tsx integrated into ControlRoom; src/types.ts and styles.css updated. Historical overview/strategy/watchlist/risk/performance/reconciliation/activity/settings views remain. TradingWorkspace contains proposal details, risk decisions, pending execution, orders, fills, stock/option positions, ledger, ownership, audit, reports, scheduler, policies and health/settings. Expanded details expose research, requested order, preview, approval, final execution and transition history.

Scripts: pi-install.sh, pi-update.sh, upgrade-safe.ts, self-test.ts; backup.ts now backs up before any migration. API startup loads .env without overriding deployment environment. Existing systemd assets retained. package.json/lock metadata version 2.0.0; no new runtime dependency.

Documentation: README, ARCHITECTURE_V2, RISK_ENGINE, ROBINHOOD_MCP, AGENT, OPERATIONS, PI_DEPLOYMENT and this report. V1 docs/history remain for context, but V2 safety boundaries supersede old LIVE guidance.

## Schema/API

Schema version 3 introduces the 20 tables and strategy columns listed in ARCHITECTURE_V2.md. All persisted migrations back up first on existing file databases; migration failure rolls back. Sessions, messages, actions, proposals, research, previews, approvals, transitions, risk facts, reservations, option lots, allocation targets, reports and scheduler slots survive restart.

All /api/v2 routes inherit auth, CSRF and rate limits. Routes:

- GET state, readiness, proposals, proposals/:id, scheduler, resources/:id.
- POST proposals, proposals/:id/{modify,research,review,approve,execute,cancel}.
- POST reconciliation, allocation, position-transfer, upgrade-review, account-policy, reports, self-tests, stop-release.
- POST sleeves/:id/{policy,weight,reset}; POST scheduler/:id.
- GET/POST agent/sessions; GET agent/sessions/:id; POST agent/sessions/:id/chat.
- Existing system/mode, system/pause, emergency-stop and confirmed changes retain their interfaces with V2 gates.

Resource keys: orders, fills, positions, options, ledger, assignments, audit, reports, risk, pending. Agent tool names/mode enforcement are listed in AGENT.md (18 typed functions). No approval, raw placement, DB or shell tool is offered to the agent.

New deployment variables: OPENAI_API_KEY, OPENAI_MODEL, ROBINHOOD_AGENTIC_ACCOUNT_ID, APP_GIT_SHA. Existing SESSION_SECRET, DATA_DIR, BIND_HOST, PORT, WEB_ORIGIN, TRADING_MODE and ALLOW_LIVE_TRADING remain. Credentials are never returned in health/state responses. OPENAI_API_KEY absence is explicitly labeled offline rather than fake reasoning.

## Verification

Executed in this Windows development session:

- npm run lint: passed.
- npm run typecheck: passed.
- npm test -- --reporter=dot: 8 files, 70 tests passed. Includes adapted V1 regressions and V2 lifecycle, capital conservation, options collateral/ownership, partial fills, stale data, STOP, autonomy, tool audit, persistent schedules, migration backup/rollback and API controls.
- npm run self-test: all 6 isolated synthetic lifecycle checks passed.
- npm run build: passed. Vite reports a non-blocking >500 kB main-chunk warning; bundle splitting remains optimization work.
- npm audit --omit=dev: zero vulnerabilities reported.
- Both Pi scripts: Bash syntax checks passed. git diff --check passed.
- Browser: disposable Simulation dashboard, three capital cards, offline chat persistence and rebuilt card spacing checked. Computer Use guidance routed verification through browser controls and exposed the spacing issue fixed in styles.css. This was desktop verification, not exhaustive responsive/accessibility acceptance.

Tests/build required approved execution outside the Windows sandbox where child-process/native bundler access was restricted. No package dependency was added.

Tests and self-tests never use a real broker. A real OpenAI request, broker authentication, Raspberry Pi installation, physical hardware, assignment/expiry handling and unattended autonomous performance have not been verified.

## Remaining requested acceptance work / limitations

1. No deterministic authenticated official Robinhood MCP binding or verified LIVE quote/option-chain feed. The production entry point intentionally installs UnavailableLiveBroker; all LIVE activation fails. TradingBroker injection is a test/integration seam, not an implemented OAuth workflow.
2. Research tools attach supplied evidence; no current news/fundamental/options research source collection or provenance verification. Checklist completion does not prove content truth. Automatic background trading decisions/agent research loops are not implemented.
3. External transferred holding import/initial assignment, corporate actions, stock/option settlement accounting, exercise/assignment, dividends and expiry/Greeks updates are not implemented. External mismatches stay paused and require integration/explicit ownership work. Internal existing-position reassignment is implemented.
4. V2 only executes regular-hours quantity LIMIT orders. MARKET/STOP/STOP_LIMIT schemas can be drafted, but risk rejects unsupported execution; no synthetic stop emulation. Synthetic accepted nonmarketable limits require cancellation or explicit fixture fill application; there is no exchange simulator.
5. Market sessions are a verified 2026 NYSE snapshot, with holidays/early closes and DST. Future years and fresh LIVE sessions need a verified calendar import/integration; no automatic calendar refresh is included.
6. Reports are local JSON/dashboard artifacts; SAFE daily materiality uses recorded trades, kill and 5% drawdown, not unimplemented fundamental/news event detection. No external immediate notification channel or configurable messaging template system.
7. Existing V1 configured global/sleeve limits remain authoritative in addition to V2 limits and can conservatively block small-account trading. The 60% emergency limit does not replace tighter limits. UI exposes example capital until actual broker integration; never treat it as account money.
8. Pi scripts stage safely but physical ARM64/systemd/HTTPS/rollback acceptance is not executed here. Existing non-scripted layouts require a reviewed conversion. No publication or deployment was performed.
9. The dashboard does not yet expose the requested trustworthy day/week account P&L or remote-branch update comparison. Planned holding-duration validation is implemented, but automatic overdue-position/thesis exit evaluation is not. Detailed reports still need acceptance against every requested weekly performance field and live options analytics.

These are explicit blockers to calling V2 production LIVE-ready. Do not work around them with environment flags, manual database edits, invented contracts or LLM brokerage prompts.

## Exact operational steps

GitHub installation and Pi update commands: PI_DEPLOYMENT.md. They require an explicitly reviewed published V2 revision; local changes are not on GitHub.

LIVE prerequisite/activation sequence: ROBINHOOD_MCP.md. LIVE cannot be enabled in this checkout until missing contracts/feeds and acceptance items are implemented.

SAFE/AGGRESSIVE/OPTIONS autonomy activation: AGENT.md. Each policy change requires its own explicit sleeve selection/review/phrase. Manual approvals remain default and independent of chat mode. No policy enables a scheduled autonomous trading loop.
