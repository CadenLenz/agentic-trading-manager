# Robinhood MCP: official OAuth/discovery and guarded READ_ONLY mapping

Robinhood documents the [official Agentic Trading MCP endpoint](https://robinhood.com/us/en/support/articles/agentic-trading-overview/) as https://agent.robinhood.com/mcp/trading. Its [trading guide](https://robinhood.com/us/en/support/articles/trading-with-your-agent/) describes a dedicated Agentic account and stock/option trading. Cash-account settlement restrictions mean cash balance alone cannot establish spendable funds; the application also requires verified broker buying power.

Do not use undocumented brokerage HTTP endpoints or extract Codex OAuth tokens. A configured Codex server is not proof of a working typed account/quote/preview/placement contract.

The old adapter used LLM-normalized snapshots and prompted placement/cancellation. Those methods now reject. Configuration inspection still runs harmless codex mcp list --json, without invoking broker tools.

`connectors.ts` now uses `@modelcontextprotocol/sdk` Client and StreamableHTTPClientTransport against the official endpoint. The SDK performs supported discovery, OAuth registration/PKCE/token refresh. The app validates HTTPS authorization redirects and one-use expiring state. Server-only OAuth storage is AES-256-GCM encrypted with a SESSION_SECRET-derived key; protect that secret, encrypted store and backups. SDK requests have bounded timeouts and no placement/replay path. OAuth callback is state-validated and excludes query strings from request logging. Cross-site callback does not depend on a SameSite=Strict session cookie.

Settings → Connections → reauthenticate → CONNECT ROBINHOOD uses the supported provider authorization URL. Test Connection enumerates actual schemas; catalog discovery is CONNECTED, **not READ_ONLY account proof**. A restart reports DISCONNECTED until reconnect. Read-only reconciliation requires a reviewed normalized account binding and fresh, complete, healthy Agentic account facts matching ROBINHOOD_AGENTIC_ACCOUNT_ID.

`VerifiedReadOnlyMcpBroker` is installed by default outside Simulation. It reads ROBINHOOD_BINDING_FILE, a protected JSON schemaVersion 1 manifest with accountId, exact catalogHash, verifiedBy, reviewReference and five operations (account/equityQuote/optionQuote/equityPreview/optionPreview). Each operation specifies actual discovered tool/arguments and explicit JSON-pointer result mappings. Supported mapping operators are `$ref`, optional `$number`, `$each`/`$map`, and `$concat`; absent fields/invalid decimals/prototype keys fail. Normalized results are strict typed schemas. No example invented brokerage field mapping is shipped; authenticated schemas and real read-only fixture evidence are required to write the manifest. Confirm full pagination/settlement/options/account type accessibility against the real account before commissioning.

Known read tools and confirmed preview tools are allowlisted, then validated against discovered input/output schemas. Raw read success alone is not account proof; normalized fresh scoped account validation marks READ_ONLY. The adapter's place/cancel methods always reject in this pass. No real OAuth, account, quote or preview has been executed during local verification. **DO NOT ENABLE LIVE YET.**

Before implementing the binding, obtain the authenticated official tool catalog/input/output schemas through the supported OAuth workflow. Use [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) and [tools discovery](https://modelcontextprotocol.io/specification/2025-06-18/server/tools), validate exact capability contracts, and restrict every operation to ROBINHOOD_AGENTIC_ACCOUNT_ID. Account snapshots must contain complete equities/options, cash/BP/NAV, options level, open orders and fills. Quotes need trusted US listing, asset classification, leverage flag, sector, timestamps and option instrument identity/multiplier.

Require a real supported preview. Do not treat unsupported preview as approval. Placement/cancel must not invoke an LLM and must never automatically retry a sent request. Unknown send outcomes must fail closed and reconcile by broker/client identifiers and fills before new risk. Include settlement, assignment, exercise, expiry and corporate actions in the binding/reconciliation acceptance work.

## LIVE activation gate

LIVE cannot be enabled on the current checkout. After the missing binding, verified market/research feeds and remaining acceptance items are completed:

1. Complete migration/ownership assignment, inspect balances/lots/options/reservations and accept migration review.
2. Reconcile the actual Agentic account in READ_ONLY with complete fresh facts; verify Level 2.
3. Update official market sessions and verify current quotes/instruments/settled buying power.
4. Pass isolated self-tests and full tests; review the simulated lifecycle and readiness panel.
5. Review account and sleeve policies against actual capital; default examples can block a small account and must not be silently scaled or bypassed.
6. Set TRADING_MODE=LIVE and ALLOW_LIVE_TRADING=true in the protected Pi environment, restart, and reconcile READ_ONLY again.
7. Settings → LIVE → exact ENABLE LIVE TRADING. Every readiness check must pass. The database activation and confirmation are separate from environment gates.
8. Explicitly resume chosen sleeves and release global pause only after reviewing pending proposals. Start with MANUAL_APPROVAL. Grant autonomy separately as described in AGENT.md.

Emergency STOP revokes LIVE and latches STOP. Releasing global pause alone is insufficient. Releasing STOP requires review; it leaves pause and LIVE revocation intact. No development test placed a real trade.
