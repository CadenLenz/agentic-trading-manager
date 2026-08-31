# Deterministic risk engine

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
