# Robinhood Agentic Account setup

Only Robinhood's official Trading MCP is supported. Do not use scraping, browser automation, reverse-engineered private endpoints, credential harvesting, or undocumented login flows.

Robinhood states that Agentic Account creation/authentication requires the desktop onboarding flow. The primary Robinhood investing account must already meet Robinhood eligibility and good-standing requirements.

## Supported connection flow

1. Install and authenticate Codex on a desktop.
2. Check the CLI:

   ```bash
   codex --version
   codex --help
   ```

3. Add the official server:

   ```bash
   codex mcp add robinhood-trading --url https://agent.robinhood.com/mcp/trading
   ```

4. Launch interactive Codex.
5. Enter `/mcp`.
6. Select `robinhood-trading`.
7. Complete Robinhood authentication in the official flow.
8. Follow Robinhood onboarding to create the Agentic Account.
9. Fund **only** the amount intended for agentic trading.
10. Confirm the MCP connection and harmless read tools.

Authentication may expose read information from other Robinhood accounts, but this application may trade only the Agentic Account. The adapter prompt and documentation make that scope explicit.

## Application progression

1. Keep application mode `SIMULATION` and `ALLOW_LIVE_TRADING=false`.
2. In Settings, inspect MCP status/capabilities. Capability discovery performs no preview, placement, cancellation, or mutation.
3. Change to `READ_ONLY`.
4. Pull account state and verify the displayed account is the Agentic Account.
5. Run reconciliation repeatedly. Resolve every position/cash/open-order discrepancy.
6. Verify manual broker-side changes are detected and globally halt autonomy.
7. Return to Simulation if authentication expires or data is uncertain.

## LIVE warning

**Do not perform a first LIVE test until the full security/risk checklist is complete. Real orders can lose the entire funded amount.**

Even after MCP authentication, LIVE remains blocked unless:

- `TRADING_MODE=LIVE`;
- `ALLOW_LIVE_TRADING=true`;
- the UI receives the exact operator confirmation;
- the database LIVE confirmation is present;
- reconciliation is clear;
- the discovered MCP includes the exact required official capability;
- a legitimate market-data provider is explicitly trading-eligible and fresh;
- every global/strategy/directive risk check approves.

Emergency stop revokes the database confirmation. A timeout is treated as unknown—not failure—and causes reconciliation before another action.

## Re-authentication

Open Codex as the service identity, enter `/mcp`, select `robinhood-trading`, and complete the official flow. Do not paste passwords, one-time codes, session cookies, bearer tokens, or account data into `.env`, SQLite, logs, issues, or manager chat.
