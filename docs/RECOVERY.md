# Failure recovery

The safe default is to prevent **new autonomous risk** while preserving observation and evidence. Do not edit ledger tables manually to make an alert disappear.

## Pi reboot or process crash

systemd restarts on failure. Startup restores SQLite state, checks unresolved orders, reconnects/read-checks the broker when required, reconciles, starts provider/watcher/queue, then marks ready.

```bash
sudo systemctl status agentic-trading-manager --no-pager
sudo journalctl -u agentic-trading-manager -b -n 200 --no-pager
curl --fail http://127.0.0.1:4010/health
```

If `ready=false` or reconciliation is blocked, leave trading paused and investigate.

## Network, Robinhood or MCP outage

1. Keep or set global pause.
2. Do not infer that a timed-out order failed.
3. Check the order record for `UNKNOWN`, `SUBMITTED`, or `PARTIALLY_FILLED`.
4. Restore network/authentication through the official flow.
5. In Read Only, fetch current orders/fills/positions.
6. Run reconciliation.
7. Attribute or reverse manual changes explicitly.
8. Resume only after every critical event is resolved.

## Unknown/partial order outcome

Never resubmit the same economic order merely because the client timed out. Use the stored client/order IDs and broker history. Post discovered fills with their unique broker fill IDs; duplicates are idempotent. Cancel only through the official capability after confirming the broker order ID. Reconcile remaining quantity and cash.

## Codex failure

Codex timeout, invalid JSON, auth failure or unavailable model records an agent error. No order is created. Deterministic watchers, hard stops already placed at the broker, health and manual controls remain independent. The next scheduled run may proceed after health is restored; there is no infinite retry.

## Market-data outage

Stale data blocks order evaluation. The simulation provider is not LIVE-eligible. Restore a legitimate provider and verify source timestamps/market status. Do not extend stale-data tolerance as an incident shortcut.

## Restore SQLite backup

Resolve and verify the exact paths before modifying files:

```bash
sudo systemctl stop agentic-trading-manager
sudo install -d -o agentic-trader -g agentic-trader -m 0700 /var/lib/agentic-trading-manager/recovery
sudo cp -a /var/lib/agentic-trading-manager/agentic-trading-manager.db* /var/lib/agentic-trading-manager/recovery/
sqlite3 /var/backups/agentic-trading-manager/<selected-backup>.db 'PRAGMA integrity_check;'
sudo cp /var/backups/agentic-trading-manager/<selected-backup>.db /var/lib/agentic-trading-manager/agentic-trading-manager.db
sudo chown agentic-trader:agentic-trader /var/lib/agentic-trading-manager/agentic-trading-manager.db
sudo chmod 0600 /var/lib/agentic-trading-manager/agentic-trading-manager.db
sudo rm -f /var/lib/agentic-trading-manager/agentic-trading-manager.db-wal /var/lib/agentic-trading-manager/agentic-trading-manager.db-shm
sudo -u agentic-trader env DATA_DIR=/var/lib/agentic-trading-manager npm --prefix /opt/agentic-trading-manager/current run migrate
```

Confirm the paths above match the configured `DATA_DIR` before running `rm -f`. Then set environment gates to Simulation, start, inspect health, and reconcile:

```bash
sudo systemctl start agentic-trading-manager
curl --fail http://127.0.0.1:4010/health
sudo journalctl -u agentic-trading-manager -n 100 --no-pager
```

## Manual Robinhood trade

A broker-side trade changes aggregate quantity/cash without internal ownership. Reconciliation creates a critical event and pauses autonomy. The admin screen supports intended resolution categories:

- attribute a verified positive position addition to Day Trader, Aggressive Growth, or Long-Term;
- acknowledge external/manual ownership;
- reverse at Robinhood;
- leave open while investigating.

Automatic attribution requires the exact broker average cost and enough virtual cash. Negative/manual sell attribution is not auto-repaired in V1; review lots and reverse/resolve deliberately.

## Database corruption or disk failure

Stop the service, image/preserve the device if forensic recovery matters, replace failing storage, install the reviewed application release, restore the latest verified off-device backup, and reconcile in Read Only. Treat post-backup broker activity as an unresolved external change.

## Incident record

Preserve journal excerpts, health response, affected order/reconciliation IDs, application version, timestamps/timezone, mode and operator actions. Redact credentials/tokens before sharing. Do not delete failed orders, agent errors or risk events.
