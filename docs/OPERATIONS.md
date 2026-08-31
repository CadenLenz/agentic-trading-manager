# Operations runbook

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
