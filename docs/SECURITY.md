# Security model

## Network posture

The service binds to `127.0.0.1` by default. Do not forward it from a public router. Use Tailscale and host firewall rules for remote access. If a reverse proxy is introduced, terminate TLS there, preserve same-origin access and review proxy trust deliberately; Fastify `trustProxy` is disabled.

## Authentication and sessions

- First run creates exactly one local administrator.
- Passwords use Node `scrypt` with a random per-user salt; plaintext is never stored.
- Sessions are HMAC-SHA-256 signed, expire after eight hours, and are stored in HttpOnly, SameSite=Strict cookies (`Secure` in production).
- Every authenticated mutation requires the session-bound `x-csrf-token`.
- Login/setup and other sensitive routes are rate-limited.
- Error responses do not disclose stack traces or credential details.

## Secrets

`.env` and database files are ignored. `.env.example` contains placeholders only. `SESSION_SECRET` must be 32+ random characters in production. Generate one on the Pi:

```bash
openssl rand -base64 48
```

Store it in `/etc/agentic-trading-manager/agentic-trading-manager.env` with mode `0600`. Robinhood OAuth/MCP credentials remain managed by Codex/Robinhood. They are not copied into SQLite or documentation.

## Input and process safety

- Zod validates API, strategy, directive and proposal inputs.
- better-sqlite3 prepared statements parameterize all user values.
- React encodes rendered text.
- Codex is launched with a fixed executable plus argument array and `shell:false`.
- Manager chat has a small deterministic intent parser; it cannot issue arbitrary shell commands.
- Chat creates pending changes, not orders.
- Brokerage calls exist only in `RobinhoodMcpAdapter`.
- Order placement receives a typed request only after deterministic approval.
- Logs redact authorization, cookies, password, token and secret fields.

## Static content

The SPA files are public so an unauthenticated operator can load setup/login. Every `/api/*` route except health/setup/login is authenticated. `@fastify/static` is pinned above versions affected by known path traversal/guard bypass advisories, and directory listing is not enabled.

## systemd hardening

The supplied unit runs as `agentic-trader`, applies `UMask=0077`, `NoNewPrivileges`, private `/tmp`, protected home/system paths, and grants writes only to application data/backup directories. `MemoryDenyWriteExecute` cannot be enabled because the Node V8 JIT needs executable memory.

## Review checklist before LIVE

1. `npm audit --omit=dev` is clean.
2. File owner/modes match the service user.
3. Dashboard is reachable only locally/Tailscale.
4. Strong admin password and session secret are in place.
5. Official MCP read-only access is authenticated.
6. Reconciliation has run clean repeatedly.
7. A legitimate trading-grade market-data provider is installed and reviewed.
8. Simulation and Read Only have run without unexplained faults.
9. Backup and restore have been tested.
10. The operator understands that autonomous trading can lose the full funded amount.

Report vulnerabilities privately. Never include account identifiers, tokens, positions, or logs containing private financial data in a public issue.
