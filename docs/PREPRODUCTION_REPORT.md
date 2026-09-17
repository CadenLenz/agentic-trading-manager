# Pre-production implementation report — 2026-09-17

DO NOT ENABLE LIVE YET. This report records the implementation and local validation pass; it does not claim Pi deployment, connector/account commissioning, real preview, real trade, paid model generation, or SMS. Simulation is validated. **The requested feature-complete end state has not fully been achieved:** connector commissioning and the specific remaining application gaps below are still required.

## 1. Architecture

Existing React/Vite/Fastify/SQLite-WAL architecture and exactly three sleeves are preserved. Persistent agent → controlled tools → services/proposals → risk → preview → approval/policy → second risk → execution → reconciliation → ledger/reporting/audit. Default one-third NAV targets, manual approval, no churn/borrowing/Level 3 remain. Legacy brokerage prompts reject. LIVE mode and typed adapter placement remain locked.

## 2. Files changed

Core additions under packages/trading-v2/src: configuration, analytics, notifications, connectors, mcp-binding, broker-events, system-simulation, pi-acceptance, readiness, emergency, periods, commissioning, operational-monitor, credential-vault and connector-evidence. Existing proposal/agent/broker/model/capital integration retained/extended. Database adds preproduction-migration.ts; API adds preproduction-routes.ts; core manager wires services/events/shutdown. UI adds PreproductionPanels, EmergencyControls, PiOperatorEvidence, PortfolioHierarchy and SymbolRiskOverrides SensitiveActionAuth, OpenAIConnectionSetup and ManualPreviewEvidence plus existing ControlRoom integration/styles. CLI/deployment adds full-system-test, pi-acceptance and four Pi aliases; updater now stops before staging. package.json/lock add official MCP SDK/AJV and updated test/bundler dependencies. All 13 requested documentation files are present and updated; this report supersedes historical foundation status in IMPLEMENTATION_V2.md. Git status is the authoritative exact changed-path list, including earlier local V2 work.

## 3. Database migrations

Transactional migration 4 adds 15 tables: risk_config_versions, simulation_runs/events, portfolio/strategy/position_snapshots, option_telemetry, notification_events/deliveries, connector_status, acceptance_runs, readiness_transitions, broker_events, economic_event_pnl, agent_summaries. Snapshot account/mode/time index added. Existing pre-migration backups/rollback behavior and positive-price fill constraints preserved; zero settlement uses separate economic P&L. Only disposable databases were migrated locally.

## 4. Risk schema

Strict version 1 with 76 described settings and global→sleeve→asset→symbol precedence. Validation, immutable safety literals, optional-fact fail-closed checks, explicit key diffs, dollar impacts, 20-character review, version guard, session-bound API reauthentication (including legacy confirmed changes, sleeve/account policies, ownership transfers, kill reset and STOP release), full audit and revision rollback (including baseline 0). Legacy limits remain additional caps. Stored exit-method/stop/take-profit planning fields do not activate an automatic exit monitor.

## 5. Agent tools

25 strict typed allowlisted tools, operator-owned sessions/turns/actions, deterministic recent-turn summaries, actual user-instruction audit, expiring timed pause and expanded app inspection/configuration/simulation/scheduler/notification requests. All handlers delegate to services. ADVISOR cannot mutate policies/execute; policy/risk activation remains separately confirmed. Research tools attach supplied source-bearing evidence, not fetched/factually verified current research.

## 6. UI additions

Prominent actual one-click full-system run, Simulation Control Room with speed/feed/progress/history/export, typed scoped risk controls/default/inherited indicators/history/diff/reauth, advanced symbol overrides, portfolio hierarchy, options detail, notifications/preferences, truthful connection cards, explicit readiness/Pi checklist/operator evidence and guarded emergency drafts. Existing graphite/copper colors and green gains/red losses preserved. Desktop/mobile smoke verification is recorded below, not an exhaustive accessibility certification.

## 7. Charts

Periodic two-minute and event snapshots; account/sleeve attributed cash + stocks + signed options. 1D/1W/1M/3M/1Y/ALL, recorded-only history, 500-point view downsampling, all-sleeve medium charts and equity position sparklines. Today/week P&L uses actual Pacific calendar boundaries with DST tests and excludes recorded external flows after first observation. Coverage is explicit; no synthetic pre-observation returns. Storage retention/long-run Pi sizing remains acceptance work; closed-position zero snapshots/option position sparklines need further refinement.

## 8. Options telemetry

Risk-call trusted quote telemetry, open/closed contract selection, Greeks/IV unavailable=null, instrument/premium/collateral/break-even/realized/unrealized detail, actual fills/executions/broker IDs/proposal thesis/risk/lifecycle, confirmed-fill timeline/duration, contract/underlying history and recorded per-contract P&L versus underlying. Synthetic movements are labeled. Missing IV rank, live source/feed/deliverable validation and complete tax-basis settlement are not invented.

## 9. Notifications

Deduplicated persistent in-app feed/read state, preferences/quiet hours/critical override, extensible provider and optional server-only Twilio SMS. Atomic UNKNOWN-before-send claim, no automatic retry on ambiguous outcomes, Simulation SMS suppression. Proposal/reconciliation/report/STOP paths plus deduplicated kill/system-health/broker-disconnect monitoring are wired. Missing/stale/invalid-time account facts pause new risk and block reconciliation; unchanged state does not create notification storms. No external message sent.

## 10. Connectors

Reauthenticated OpenAI API-key/model setup stores encrypted server-only credentials; protected environment fallback remains (no fake ChatGPT login). Explicit model-access GET is not paid generation; evidence is credential/model-bound and expires after 24h. Official MCP SDK OAuth/PKCE/discovery/encrypted server store/callback state and discovered schema validation. Catalog discovery is CONNECTED, not account proof. Protected reviewed catalog-hash/account-bound normalization manifest supports deterministic READ_ONLY account/quotes/previews. No manifest for actual authenticated contracts or real account acceptance is claimed. place/cancel reject; discovery/authentication does not enable LIVE.

## 11. Tailscale/Pi changes

Localhost binding, private HTTPS Serve guide/no Funnel/app auth retained, observational proxy context. Reviewed-ref install/update/health/backup aliases; staged tests/build/full-system test/backup/migration/atomic release swap and paused READ_ONLY posture. Updater blocks execution before fetch. No actual installation, Tailscale change or ARM64/systemd operation executed here.

## 12. Simulation architecture

Dedicated fixture DB/account/broker/event namespace, isolated graph without real connector transport or credentials, persisted application test metadata only. Current configuration metadata captured; main lifecycle uses rich-risk snapshot and synthetic $50k/fixture options permission, independent boundary branches use known defaults. Global-fetch-denial regression proves no network requests and unchanged application cash/positions. Restart reopens a file-backed fixture DB and does not resend pending placement. Presentation scenario time is accelerated, not a real exchange/backtesting clock.

## 13. Full simulation results

65 passed, 0 failed; zero live broker calls/external requests. All three sleeves, entries/exits/partial/cancel, collateral/naked rejection, OI/spread/DTE, price/explicit synthetic Greeks movement, expiry/assignment/exercise, stale/config/exposure/loss/pause/STOP/kill, outages/UNKNOWN/no-replay, transfers/basis/cash/split/restart and reports/notifications/charts exercised. CLI retains JSON/DB artifact location. UI displayed SYSTEM TEST PASSED with 65/0 and persistent run history.

## 14. Pi acceptance

Actual-host checklist plus protected operator evidence for authenticated SSE, second-device private reachability and reboot/log observations. Evidence cannot override automatic host checks, is fingerprint/revision/time bound, expires and requires rerun. Windows tests verify backup restore and honest failure/unavailable Pi checks. Actual Pi acceptance has not been executed. Manual-preview capture requires an existing fresh official-source READ_ONLY preview and healthy scoped account, official catalog/configuration/proposal-version/order-hash/operator evidence. It expires after 15 minutes; Simulation facts and obsolete DB booleans are rejected. Tiny controlled-trade capture remains a separately commissioned future workflow.

## 15. Verification

Latest unit/integration suite: 9 files, 187 tests passed (baseline 70). Full-system test: 65/65 with zero live-broker calls and zero external requests. Risk lifecycle self-tests: 6/6. Lint, typecheck and production build pass; full npm audit reports zero vulnerabilities. All six Pi shell scripts pass Bash syntax checks and `git diff --check` passes (Windows line-ending notices only). Browser verification exercised the one-button test through SYSTEM TEST PASSED 65/0, persistent history/export, mobile navigation and 375px no-overflow layout, plus desktop Connections and Production Readiness safeguards. The build retains one non-blocking 607.56 kB web-chunk warning; exhaustive accessibility/device certification remains acceptance work.

## 16. Remaining limitations

Unverified real OAuth/catalog/account contract mapping and current research/data collection; no commissioned autonomous research/decision/exit loop; stored exit policy only; real cancel/place/client-order recovery/deliverable/settlement/tax-basis contracts absent. External equity/basis/cash/split and plain option events are reviewed economic workflows, not automatic broker event ingestion or complete external option/dividend/complex-action accounting. Real authenticated preview proof has not been collected; tiny-trade capture awaits commissioned execution. Notification transport and actual broker/health failure observations remain production acceptance work. Options chart marker overlay/closed-position zero history and all-position sparklines need polish. UI remains partly structured JSON for advanced records; exhaustive responsive/accessibility, live ledger-report fixtures and long-run retention remain acceptance work. Calendar snapshot is 2026-only; real venue/current/future validation still required.

## 17. Exact production LIVE blockers

Hard code lock; no authenticated reviewed real schema mapping/account identity/type/access evidence; no proven fresh live prices/research provenance; no executed actual Pi/SSE/tailnet/reboot acceptance; no collected real manual-preview or controlled-trade commissioning evidence; no vetted placement/cancel/unknown-outcome resolution; incomplete production event/corporate/settlement/tax-basis coverage and unattended exit/decision controls. Environment flags, manual setting edits or model brokerage prompts must not substitute for these.

## 18. Exact final-pass checklist

1. Preserve/review this local diff; rerun all checks. Publish/deploy only upon separate explicit user instruction.
2. Close remaining application gaps: authenticated-manifest commissioning UX, verified current research collection, safe review/exit scheduling and required option/position/report refinements. Collect real preview proof and commission operational notifications. Keep placement locked.
3. Install the reviewed revision on actual ARM64 Pi/SSD with protected env/backups/systemd; set private Tailscale Serve HTTPS and ACLs, no Funnel; verify app auth/CSRF/SSE.
4. Authenticate OpenAI API model access (no fake account login) and official Robinhood OAuth; retrieve actual schemas, write/review protected catalog-bound mapping with complete pagination/settlement/account type/Agentic/options/BP/positions/orders/fills evidence. Test READ_ONLY only.
5. Review/import explicit external ownership/cost basis/economic events; reconcile cleanly and compare all account/sleeve/P&L/report values against verified broker evidence. Resolve unsupported events; never acknowledge them away.
6. Verify safe real previews and capture durable account/catalog/proposal-version/hash/time/operator proof. Run full-system current configuration and Pi acceptance including second-device/SSE/reboot/log observations; advance stages explicitly.
7. Implement narrowly typed commissioned place/cancel and broker/client-ID unknown recovery with no automatic send retry. Audit/review tiny-order dollar/contract allowlist, daily caps, manual per-order approval and emergency controls.
8. Only a separate explicit final LIVE authorization plus reviewed removal of the pre-production lock may permit MANUAL_LIVE. Observe tiny controlled real transactions with reconciliation/reports/notifications and restart recovery before enabling any autonomy.
9. Enable each sleeve AUTONOMOUS_RISK_APPROVED separately only after controlled-trade evidence, verifiable current research, continuous risk/exit/freshness controls and operator approval. Do not auto-resume LIVE after update/reboot.
