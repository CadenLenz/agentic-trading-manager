# GitHub → Raspberry Pi deployment and updates

Use the exact reviewed commissioning commit SHA recorded in the commissioning report. Do not install a moving branch name or assume the newest main revision is the reviewed build.

Prerequisites: Raspberry Pi OS 64-bit ARM64, Node >=22.13, npm, git, curl, tar, a USB SSD for persistent data and private HTTPS/Tailscale dashboard access. Install Node from its official distribution for ARM64. Scripts require sudo but execute npm installation/build/tests as the unprivileged agentic-trader user. Review downloaded scripts before running them as root.

## New installation

Replace REVIEWED_V2_REF with the reviewed published revision, not a guessed release tag:

```bash
git clone https://github.com/CadenLenz/agentic-trading-manager.git
cd agentic-trading-manager
git checkout --detach REVIEWED_V2_REF
sudo bash scripts/pi-install.sh REVIEWED_V2_REF
sudo systemctl status agentic-trading-manager --no-pager
curl --fail http://127.0.0.1:4010/health
```

The installer stages /opt/agentic-trading-manager/releases/GIT_SHA, runs npm ci, lint, typecheck, tests, self-test, build and production audit; generates a protected session secret; sets /etc/agentic-trading-manager/agentic-trading-manager.env; saves Read Only/paused/manual posture and installs existing systemd/backup units. It does not activate LIVE. A failed post-start health request stops the service. Staging/source directories are retained, not silently deleted.

Runtime data: /var/lib/agentic-trading-manager. Backups: /var/backups/agentic-trading-manager plus automatic pre-migration database backups in the data/backups directory. Credential environment file is mode 0600. Never make it public, commit it, or paste it into chat.

Secure HTTPS is necessary for production Secure session cookies. Bind remains 127.0.0.1; use private Tailscale HTTPS/Serve or an authenticated TLS proxy. Consult SECURITY.md. Do not expose port 4010 directly to the Internet.

Open the dashboard, create the operator account, and inspect the upgrade checklist. New first-run allocations are Simulation-only example funds. To test V2 now, explicitly select Simulation; no data on that screen represents actual Robinhood funds.

## Update an existing scripted installation

```bash
cd /path/to/reviewed/source
git fetch --tags origin
git checkout --detach REVIEWED_V2_REF
sudo bash scripts/pi-update.sh REVIEWED_V2_REF
sudo systemctl status agentic-trading-manager --no-pager
sudo journalctl -u agentic-trading-manager --since today --no-pager
```

The updater stops the running service and backup writers **before fetching/staging**, then validates the staged revision including the full-system fixture test. It revokes environment LIVE gates, backs up the existing SQLite DB **without opening migrations first**, applies transactional migration and upgrade-safe posture, and atomically swaps current to the new release. Prior release/database backups remain available. Policies become manual, sleeves paused, ownership review required. There is no auto updater and no automatic LIVE restoration.

An installation not already using /opt/.../releases with current as a symlink requires an operator-reviewed conversion; the script refuses unexpected paths. Do not copy these commands over a different layout blindly.

## Failure/rollback

If any staging/database/switch/health step fails, the service remains stopped. Inspect the retained backup and original revision. Restore the matched pre-upgrade database and original release together; never run an old binary against an upgraded database automatically. Stop the service and backup timer before restoring; preserve the failed DB plus WAL/SHM for investigation. Read BACKUPS.md and RECOVERY.md.

## Upgrade checklist

Migrate → authenticate official connectors and install a reviewed mapping → reconcile actual account in Read Only → review explicit transferred ownership/basis events → review capital targets → verify Level 2 and collateral → run self-tests/full test → run actual Pi acceptance → inspect reports/telemetry → advance readiness deliberately. LIVE remains locked; the final pass must commission missing execution contracts and controlled-trade evidence.

Aliases: `scripts/install-pi.sh REVIEWED_REF`, `scripts/update-pi.sh REVIEWED_REF`, `scripts/health-check.sh`, `scripts/backup-db.sh`. Install/update retain the reviewed-reference requirement. See [TAILSCALE.md](TAILSCALE.md) for private Serve networking and [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) for acceptance/evidence. `npm run pi:acceptance` checks the actual DATA_DIR database/host without placing trades; run it on the Pi, not on developer fixture data expecting a certification.

Pi installation/update scripts have not been executed on physical Raspberry Pi hardware in this Windows development session. Hardware/systemd, native ARM64 SQLite build, HTTPS and rollback execution remain deployment acceptance work.

Protect and back up the encrypted connector credential files alongside the private server environment and the unchanged SESSION_SECRET needed to decrypt them. SQLite backups alone do not contain those credentials. Review any secret rotation with a deliberate connector reauthentication/reconfiguration plan; never expose vault files or environment values to React, logs or Git.
