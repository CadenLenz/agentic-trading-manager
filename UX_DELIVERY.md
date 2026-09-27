# Product usability pass — 2026-09-26

Account-first navigation, guided setup, recorded-equity charts, expandable holdings, strategy summaries, simple/advanced risk controls, clearer options and simulation screens, and quieter assistant conversations. Advanced controls and original strategy configuration remain accessible.

## Connection diagnosis

The template defines PRIVATE_UI_URL as an empty string. The previous nullish fallback accepted it and called new URL(''), throwing before OAuth discovery; the generic server error concealed the cause. Empty values now fall back to WEB_ORIGIN. Production requires HTTPS; malformed origins and mismatched configured origins receive actionable errors. No request headers are used to choose redirects. Stored OAuth registration is invalidated when its callback changes (older registrations require reconnecting once). Provider and callback failures return curated diagnostic codes rather than credentials or raw provider payloads.

This reproduces a repository defect, not a confirmed diagnosis from Pi logs. Live Robinhood authorization and Pi/Tailscale operation were not verified here. A reviewed account ID/schema mapping remains required for read-only reconciliation. Real trading remains code-locked.

## Verification

- 201 automated tests passed, including Pi-related non-hardware tests and new callback configuration, encrypted credential callback binding, CSRF/reauthentication, OpenAI save contract, and chart observation tests.
- Safety self-test: 6/6; isolated full-system simulation: 65/65, no external requests or broker calls.
- Lint, TypeScript checks, and web/API production builds passed. Build reports a non-blocking JavaScript chunk-size warning.
- Production dependency audit: 0 vulnerabilities.
- Browser checks on an isolated in-memory account: login, account, range controls, strategies, holding expansion, options empty state, connections and wrong-password recovery, risk review, trade-review empty state, notifications, simulation run/result, assistant offline response, and readiness checks. Desktop/laptop and 390px phone layouts checked; no recorded console errors. Fresh-install welcome/password screens inspected; setup creation also tested at API level.
- No production database, real credentials, Pi hardware checks, or live trades were used. Real OpenAI model access and Robinhood sign-in remain operator acceptance tasks.

Update using the existing scripts/update-pi.sh with the exact reviewed commit SHA. The updater retains prior releases and starts in Read Only with trading paused.
