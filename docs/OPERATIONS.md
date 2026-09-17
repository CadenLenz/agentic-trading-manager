# Operations runbook

## Pre-production runbook (supersedes earlier integration status)

DO NOT ENABLE LIVE YET. Use [PREPRODUCTION_REPORT.md](PREPRODUCTION_REPORT.md) and [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md). The new main RUN FULL SYSTEM TEST immediately opens a fixture-only session; MAX accelerates it without bypassing assertions. Tests persist separately from application portfolio state. Export JSON before removing old test artifacts.

Connections distinguish configured, discovered and actually validated account/model access. A configured key or successful catalog enumeration is not permission to trade. OAuth and Twilio secrets remain on the server. STOP works without the agent. Production Readiness contains guarded emergency controls: close/liquidate actions create drafts only; uncertain placements remain reserved/paused rather than locally cancelled or resent.

External events enter REVIEW_REQUIRED, require account/source/strategy/basis and explicit reauthenticated application. Supported economic events: equity transfer, signed cash flow, external equity fill, equity split, plain 100-multiplier option expiration/assignment/exercise. Reconcile after application. Unsupported adjusted contracts, external option fills, dividends/complex corporate/tax-basis cases stay paused; never invent settlement or acknowledge unexplained ownership away. Reviewed fills are deduplicated and imported before ownership/cash comparison. Known broker terminal cancellation releases only verified remainder; UNKNOWN/missing/incomplete fill history stays unsafe.

Reports and chart summaries use recorded ledger evidence, Pacific day/week boundaries and explicit unavailable values. Snapshot history starts at first observation. Schema 4 adds auditable configuration, tests, snapshots, telemetry, notifications, connectors, acceptance/readiness and broker economic events. Production retention/archiving sizing still needs Pi acceptance.

## V2 operational boundary

Use PI_DEPLOYMENT.md for reviewed staged installation/update commands and ROBINHOOD_MCP.md for LIVE prerequisites. Current V2 is Simulation-verified; LIVE integration is unavailable. Old Codex MCP configuration does not authorize the new deterministic executor.

After upgrade, inspect Trading Workspace → Health / Settings, reconcile, review ownership, run isolated self-tests and inspect proposals/reports/ledger. Accept migrated ownership with a 20+ character review only after actual reconciliation. Select Simulation explicitly for test funds. Use Sleeve Policies for independent manual/autonomous policies; resume via the existing confirmed strategy controls. Release global pause only deliberately.

Emergency STOP persists a STOP latch, global pause and LIVE revocation. Trading Workspace → Sleeve Policies → Release STOP requires review and leaves pause/LIVE revocation unchanged. A killed sleeve requires exact RESET sleeve phrase plus weekly review; it remains paused afterward.

An unknown placement outcome is never resent. Preserve logs/DB/reservations and obtain complete broker order/fill facts. Acknowledging a discrepancy cannot clear it. External holding import/assignment and exercise/expiry processing remain blocked integration work.

No unattended updater, automatic LIVE restoration, scheduled order generator or external report notification is enabled. Existing service commands below remain applicable.

Examples assume the supplied systemd deployment.

## Service lifecycle

```bash
sudo systemctl start agentic-trading-manager
sudo systemctl stop agentic-trading-manager
sudo systemctl restart agentic-trading-manager
sudo systemctl status agentic-trading-manager --no-pager
sudo systemctl disable --now agentic-trading-manager
sudo systemctl enable --now agentic-trading-manager
```

## Logs and health

```bash
sudo journalctl -u agentic-trading-manager -f
sudo journalctl -u agentic-trading-manager --since today
curl --fail --silent http://127.0.0.1:4010/health | jq
```

Journald handles rotation; install the supplied `journald-agentic-trading-manager.conf`, restart journald, and verify host disk policy.

## Pause and emergency disable

Use the dashboard **Pause all** control for a reversible autonomy pause. Use red **STOP** for an emergency: it pauses all autonomous activity and revokes database LIVE confirmation. At the host level:

```bash
sudo systemctl stop agentic-trading-manager
sudo sed -i 's/^ALLOW_LIVE_TRADING=.*/ALLOW_LIVE_TRADING=false/' /etc/agentic-trading-manager/agentic-trading-manager.env
sudo sed -i 's/^TRADING_MODE=.*/TRADING_MODE=SIMULATION/' /etc/agentic-trading-manager/agentic-trading-manager.env
```

Review that file manually, then restart. The database mode/confirmation is an additional gate, so environment edits alone cannot enable LIVE.

## Reconcile account

In Simulation or authenticated Read Only, open **Reconciliation → Reconcile now**. A critical mismatch automatically pauses autonomy. Review internal vs broker quantities and the exact event. Classify a manual broker trade only after verifying symbol, quantity and cost; otherwise reverse it at Robinhood. Do not clear an unexplained event just to resume.

## Re-authenticate Robinhood MCP

```bash
sudo -u agentic-trader -H codex
```

Enter `/mcp`, select `robinhood-trading`, and complete the official desktop-authenticated flow. Return to Read Only, inspect capabilities, pull an account snapshot, and reconcile before considering any mode change.

## Update

```bash
sudo systemctl stop agentic-trading-manager
sudo -u agentic-trader env DATA_DIR=/var/lib/agentic-trading-manager BACKUP_DIR=/var/backups/agentic-trading-manager npm --prefix /opt/agentic-trading-manager/current run backup
cd /opt/agentic-trading-manager/current
sudo -u agentic-trader git fetch --tags --prune
sudo -u agentic-trader git checkout <reviewed-release-tag>
sudo -u agentic-trader npm ci
sudo -u agentic-trader npm run typecheck
sudo -u agentic-trader npm test
sudo -u agentic-trader npm run build
sudo -u agentic-trader env DATA_DIR=/var/lib/agentic-trading-manager npm run migrate
sudo systemctl start agentic-trading-manager
curl --fail http://127.0.0.1:4010/health
```

Keep `ALLOW_LIVE_TRADING=false` through maintenance unless a separate post-upgrade validation explicitly changes it.

## Rollback

Stop the service, check out the prior reviewed tag, install with `npm ci`, rebuild and start. Database migrations are forward-only; if the old release cannot read the new schema, follow [Recovery](RECOVERY.md) and restore the pre-upgrade backup rather than modifying SQLite by hand.
