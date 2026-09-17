# Deterministic risk engine

## Pre-production configuration contract

`packages/trading-v2/src/configuration.ts` defines strict schemaVersion 1, 76 settings, complete global defaults, three sleeve overrides, asset overrides and validated symbol overrides. Resolution order is global → sleeve → asset → symbol. Settings cover enabled trading, cash/exposure/loss/order caps, freshness, sessions/fractionals, instrument allow/block/liquidity/valuation/volatility/setup facts, holdings, Level 2 option sizing/DTE/OI/spread/delta/IV/Greeks/collateral and execution policy. Missing trusted facts fail enabled checks; no LLM can supply broker facts.

Every descriptor exposes type/range/default/scope/explanation/confirmation/recalculation and enforcement status. The 60% emergency backstop, 100 covered shares, full CSP collateral, HEALTHY broker requirement and STOP behavior are immutable literals. Exit method/stop/take-profit fields are stored planning policy, **not an implemented autonomous protective-order monitor**. Assignment always requires explicit review, regardless of a stored preference. Session/fractional/extended flags do not grant unsupported LIVE execution capabilities.

UI and agent use one preview/apply service. Preview shows key-level before/after and current-sleeve dollar impacts. Apply requires exact `APPLY RISK CONFIGURATION`, recent API reauthentication, a 20-character review and the expected version. Revisions record full previous/new state, instruction, interpretation, actor/session/time/reason. Rollback creates a new revision; baseline version 0 is supported. The UI distinguishes DEFAULT, OVERRIDDEN and INHERITED and has an advanced symbol editor.

Legacy global/strategy/account/sleeve limits remain **additional caps**, not overridden by raising a rich setting. Daily loss/report boundaries are Pacific calendar midnight with DST. Option economic-event P&L contributes to realized losses/cooldowns. STOP blocks new risk; owned manually reviewed CLOSE proposals still require fresh ownership/reconciliation/quotes/preview/approval. Maintenance blocks all execution. Rich mutations invalidate evidence; the evidence hash also covers legacy risk, account policy, sleeve policy and strategy configuration, so changes through older editors cannot reuse obsolete evidence.

## V2 authority

The versioned proposal path is packages/trading-v2/src/proposals.ts with model.ts and capital.ts. The legacy engine below is retained for Simulation equity regression only; its execution path cannot place LIVE orders or options.

V2 checks complete/fresh deterministic Agentic account facts, no borrowing/negative buying power, global pause/STOP/maintenance, sleeve enablement/kill, reconciliation/ownership review, quote/proposal/research age, calendar session, supported LIMIT order/asset class, US-listed/unleveraged metadata in LIVE, liquidity/spread/minimum equity price, directives, same-sleeve ownership, single-leg Level 2 contract identity/direction, full CSP strike collateral, covered-call share reservations, cash/reserves, per-position/gross exposure, position/order/rate limits, losses, drawdown and cooldown. Existing configured legacy global reserves/notional/exposure/ticker/sector/order/loss limits and sleeve limits remain additional checks, not silently weakened.

Proposal maxLoss/premium/collateral claims are not authoritative; facts are recomputed from trusted instrument, quote, limit and owned collateral. Every decision persists checks and facts. Preview must be supported, approved, fresh and bound to the canonical order hash. Manual approval binds version/hash/expiry; autonomous approval requires the specific sleeve policy and AUTONOMOUS session. A fresh second deterministic risk decision precedes the durable send reservation.

Unknown send outcomes retain reserved capital, set RECONCILIATION_REQUIRED and pause globally. No broker mutation retry is permitted. Duplicate execution/fill IDs cannot double-account. Normal limits reject new risk before the hard 60% latched sleeve kill. Explicit weekly reset never resumes or re-enables LIVE. Validated closing proposals may reduce risk while autonomy is paused/killed, but require separate manual approval and never bypass STOP, maintenance, mode, reconciliation, quotes or ownership.

LIVE currently fails closed because the verified deterministic official broker/market-data bindings are missing. See ROBINHOOD_MCP.md and IMPLEMENTATION_V2.md. Checklist structure does not validate research truth.

## V1 Simulation regression engine

`packages/risk/src/risk-engine.ts` is authoritative software. It does not ask Codex whether a hard limit should apply.

## Evaluation order

1. Validate the proposal and typed order intent.
2. Verify operating-mode gates.
3. Check maintenance, global pause and strategy enablement.
4. Require clear startup/broker reconciliation.
5. Reject stale data; LIVE additionally requires a provider explicitly marked trading-eligible.
6. Enforce global asset-class and market-hours policy.
7. Apply global/strategy directives (`FORBIDDEN_SYMBOL`, `RESEARCH_ONLY`, pause, temporary allocation cap).
8. Check strategy cash and ownership.
9. Check order notional, strategy position, total exposure, cash reserve, ticker/sector concentration, position count and trade count.
10. Check account/strategy daily and weekly losses plus consecutive losses.
11. Persist every violation and return an allow/reject decision.

SELL orders do not receive BUY-only concentration checks. A protective SELL may proceed while global/strategy autonomy is paused, but never bypasses mode, reconciliation, stale/trading-ineligible data, or ownership. Where available, broker-side protective orders should be used because Pi/network/LLM latency is not suitable for critical stops.

## Default configuration

Defaults exist only to demonstrate editable configuration. They are not recommendations. Global values are stored in SQLite and strategy values are versioned. Immutable code protects the hierarchy; natural-language manager input creates a pending change rather than directly editing hard limits.

## LIVE gates

All of these must be true:

- database mode is `LIVE`;
- process environment contains `TRADING_MODE=LIVE`;
- process environment contains `ALLOW_LIVE_TRADING=true`;
- an administrator used the exact UI confirmation;
- reconciliation is clear;
- official Robinhood MCP is authenticated and an order capability was discovered;
- market data is current and the provider is explicitly trading-eligible;
- global, strategy and directive checks approve.

Emergency stop sets global pause and revokes database LIVE confirmation.

## Tests

`tests/risk.test.ts` covers strategy cash/position limits, research-only and forbidden directives, expiration, global/strategy pause, protective exit behavior, stale data, reconciliation fault, Read Only, LIVE gates, ownership and disabled asset classes.
