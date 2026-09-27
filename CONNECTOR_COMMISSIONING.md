# Connector investigation — 2026-09-27 UTC

Status: connector recovery checkpoint, **not a final production release**.

## Observed evidence

- The actual Pi was reachable over Tailscale; its authenticated dashboard displayed READ_ONLY and GLOBAL PAUSE. Its setup page showed both OpenAI and Robinhood unconnected and account binding incomplete.
- SSH authentication was denied. The Pi service environment, credential vault, logs, running SHA, systemd configuration, and deployment could not be inspected or modified.
- Live official MCP discovery advertised authorization at `https://robinhood.com/oauth`, registration at `https://agent.robinhood.com/oauth/trading/register`, public-client token authentication, scope `internal`, and PKCE S256.
- Fresh registration with the configured Pi HTTPS callback returned HTTP 200. Using installed MCP SDK 1.30.0, the resulting authorization request reached Robinhood's consent/Allow screen in the user's desktop browser. The probe stopped before consent. It had no callback handler and made no trading tool calls.
- The separately authenticated Codex Robinhood connector could read account eligibility. This does **not** establish authorization, account scope, or acceptance for the Pi application.

The pre-callback rejection was not reproduced with fresh registration. Stale saved registration is a plausible cause, but the exact failing Pi request/registration has not been examined; it is not a confirmed root cause. The callback hostname and current fresh SDK flow were accepted in this browser test.

## Implemented recovery

- New sign-in without tokens discards saved client registration and performs fresh official dynamic registration.
- Pending state, actor, expiry, and PKCE verifier survive application restart in the existing encrypted vault. Callback state is consumed durably before exchange; replay fails.
- Credential writes use same-directory atomic replacement.
- A connection check reconnects from saved tokens after restart; SDK refresh is covered by mocked integration testing.
- Callback completion no longer reports success if another sign-in is required.
- Protected, recent-password-confirmed reset forgets local Robinhood credentials, clears catalog/preview evidence, revokes application LIVE approval, and pauses trading. It also recovers a corrupted vault without attempting to decrypt it. Provider-side access revocation remains in Robinhood settings.
- Advanced connection details retain the latest 40 structured diagnostic events: stage, safe code, time, provider, callback origin, state, and optional HTTP status. Request bodies, response bodies, tokens, verifiers, passwords, and URL queries are excluded.

## Verification

- 211 automated tests; mocked SDK discovery, stale-registration replacement, PKCE, callback after restart, replay rejection, token refresh, reconnect, encrypted persistence, reset, and API authorization checks included.
- 6 safety self-checks and 65 full-system simulation checks; zero live broker calls and zero external requests in full-system simulation.
- Typecheck, lint, production build, dependency audit; zero production dependency vulnerabilities. Existing bundle-size warning remains.
- Browser exercised the reset form against an isolated in-memory Simulation instance. No production credentials or database were used for that test.

## Unfinished production requirements

No real orders, cancellations, transfers, or other financial transactions were performed. No real broker previews were performed.

Pi OAuth callback/token acceptance, real account mapping/reconciliation, preview commissioning, OpenAI setup, Pi acceptance, deployment, running-SHA verification, restart/reboot/network acceptance, and production agent/research commissioning remain unverified. The production placement/cancellation adapter remains unimplemented, and `PREPRODUCTION_LIVE_LOCK` remains enabled. This checkpoint is not LIVE-capable and must not be marketed as the requested final release.

To resume commissioning, obtain working SSH access to the Pi, complete the app-password and official Robinhood consent steps, and configure OpenAI through the Pi UI. Do not export Codex OAuth tokens into the application. Deploy only a reviewed commit through `scripts/update-pi.sh`, preserving READ_ONLY, GLOBAL PAUSE, and MANUAL_APPROVAL. The remaining implementation and acceptance work must then be completed before replacing the hard lock with evidence-based production gates.

Official reference: [Robinhood Agentic Trading overview](https://robinhood.com/us/en/support/articles/agentic-trading-overview/).
