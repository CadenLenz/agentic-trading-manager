# Backups

SQLite runs in WAL mode. Do not back up a live database by copying only the `.db` file; that can omit committed WAL pages. Use the application's online backup command:

```bash
DATA_DIR=/var/lib/agentic-trading-manager \
BACKUP_DIR=/var/backups/agentic-trading-manager \
npm run backup
```

The command asks SQLite for an online snapshot, writes a `.partial` file, applies mode `0600`, then atomically renames it. The supplied systemd timer runs daily at approximately 03:15 and catches missed runs after reboot.

## Verify

```bash
sudo systemctl start agentic-trading-manager-backup.service
sudo systemctl status agentic-trading-manager-backup.service --no-pager
ls -lh /var/backups/agentic-trading-manager
sqlite3 /var/backups/agentic-trading-manager/<backup>.db 'PRAGMA integrity_check;'
```

Expected output is `ok`. Periodically restore a copy on a separate machine and run migrations/tests against it. A backup that has never been restored is unverified.

## Retention and off-device copies

Keep multiple daily/weekly generations based on available storage and risk tolerance. The timer intentionally does not delete old backups; add a reviewed retention script or backup tool with explicit paths. Copy encrypted backups to another device/location. Tailscale, `rsync` over SSH, restic, borg, or another legitimate tool can be used, but credentials must not enter application logs.

Protect backup directories with mode `0700`. Backups contain password hashes, account/portfolio history, decisions and financial records; treat them as sensitive.

## Restore

Follow [Recovery](RECOVERY.md). Stop the service, preserve the damaged/current files, verify the candidate backup, restore it with correct ownership/mode, remove stale WAL/SHM only after confirming the exact data directory, run migrations, and start in Simulation/Read Only. Reconcile before enabling any autonomy.
