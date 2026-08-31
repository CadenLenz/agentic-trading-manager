# Raspberry Pi 4 production setup

This guide targets Raspberry Pi OS Lite 64-bit on a Pi 4 with 4 GB+ RAM. Use a quality official-equivalent PSU and Ethernet. For a continuously writing WAL database, strongly prefer a reputable USB 3 SSD over a cheap microSD card. Keep the Pi and network equipment on a small UPS when possible.

## 1. Install and secure the OS

Use Raspberry Pi Imager to install the current Raspberry Pi OS Lite 64-bit release. Create a non-default administrator, enable SSH keys, set timezone, and boot. Then:

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y git curl ca-certificates build-essential python3 jq sqlite3 ufw
sudo reboot
```

Confirm ARM64:

```bash
uname -m
# expected: aarch64
```

## 2. Install Node LTS

Install a supported ARM64 Node 22 or 24 LTS using your organization's approved repository or the official Node distribution. Example using NodeSource for Node 22:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

The repository requires Node `>=22.13.0`. Do not run the application through an unreviewed global process manager; systemd is supplied.

## 3. Create the service identity and directories

```bash
sudo useradd --system --create-home --home-dir /var/lib/agentic-trader --shell /bin/bash agentic-trader
sudo install -d -o agentic-trader -g agentic-trader -m 0750 /opt/agentic-trading-manager
sudo install -d -o agentic-trader -g agentic-trader -m 0700 /var/lib/agentic-trading-manager
sudo install -d -o agentic-trader -g agentic-trader -m 0700 /var/backups/agentic-trading-manager
sudo install -d -o root -g agentic-trader -m 0750 /etc/agentic-trading-manager
```

Mount the SSD so `/var/lib/agentic-trading-manager` and preferably `/var/backups/agentic-trading-manager` reside on durable storage. Backups should also be copied off-device.

## 4. Clone, install, validate and build

```bash
sudo -u agentic-trader git clone <repository-url> /opt/agentic-trading-manager/current
cd /opt/agentic-trading-manager/current
sudo -u agentic-trader npm ci
sudo -u agentic-trader npm run typecheck
sudo -u agentic-trader npm test
sudo -u agentic-trader npm run build
```

If `better-sqlite3` has no prebuilt binary for the current Node/ARM64 combination, `build-essential` and Python allow its documented native build. Do not bypass failed install scripts silently.

## 5. Production environment

Generate a secret:

```bash
openssl rand -base64 48
```

Create `/etc/agentic-trading-manager/agentic-trading-manager.env`:

```dotenv
NODE_ENV=production
BIND_HOST=127.0.0.1
PORT=4010
DATA_DIR=/var/lib/agentic-trading-manager
SESSION_SECRET=<paste-generated-secret>
TRADING_MODE=SIMULATION
ALLOW_LIVE_TRADING=false
LOG_LEVEL=info
CODEX_BIN=/usr/local/bin/codex
CODEX_TIMEOUT_MS=120000
CODEX_MAX_CONCURRENCY=1
WEB_ORIGIN=http://127.0.0.1:4010
```

Protect it:

```bash
sudo chown root:agentic-trader /etc/agentic-trading-manager/agentic-trading-manager.env
sudo chmod 0600 /etc/agentic-trading-manager/agentic-trading-manager.env
```

Never put Robinhood credentials or MCP OAuth tokens in this file.

## 6. Initialize SQLite

```bash
sudo -u agentic-trader env DATA_DIR=/var/lib/agentic-trading-manager npm --prefix /opt/agentic-trading-manager/current run migrate
sudo chmod 0700 /var/lib/agentic-trading-manager
```

WAL, foreign keys, busy timeout and synchronous mode are configured by the application.

## 7. Install Codex and Robinhood MCP

Install/authenticate Codex for the `agentic-trader` user following [Codex setup](CODEX_SETUP.md). Then:

```bash
sudo -u agentic-trader -H codex mcp add robinhood-trading --url https://agent.robinhood.com/mcp/trading
```

Robinhood currently requires desktop onboarding for Agentic Account creation/authentication. Complete that supported flow on a desktop using the same Codex identity; do not attempt to automate login on the headless Pi. See [Robinhood setup](ROBINHOOD_SETUP.md).

## 8. Install systemd units and journal policy

```bash
sudo cp systemd/agentic-trading-manager.service /etc/systemd/system/
sudo cp systemd/agentic-trading-manager-backup.service /etc/systemd/system/
sudo cp systemd/agentic-trading-manager-backup.timer /etc/systemd/system/
sudo install -d -m 0755 /etc/systemd/journald.conf.d
sudo cp systemd/journald-agentic-trading-manager.conf /etc/systemd/journald.conf.d/agentic-trading-manager.conf
sudo systemctl restart systemd-journald
sudo systemctl daemon-reload
sudo systemctl enable --now agentic-trading-manager
sudo systemctl enable --now agentic-trading-manager-backup.timer
```

Verify:

```bash
sudo systemctl status agentic-trading-manager --no-pager
sudo journalctl -u agentic-trading-manager -n 100 --no-pager
curl --fail --silent http://127.0.0.1:4010/health | jq
systemctl list-timers agentic-trading-manager-backup.timer
```

The service uses `Restart=on-failure`, runs without root, and can write only application/backup paths. Node requires executable memory for V8 JIT, so `MemoryDenyWriteExecute` is not enabled.

## 9. Tailscale remote access

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh
tailscale ip -4
```

Keep `BIND_HOST=127.0.0.1`. Use Tailscale Serve to expose the local dashboard only to the tailnet, with HTTPS:

```bash
sudo tailscale serve --bg http://127.0.0.1:4010
tailscale serve status
```

Review Tailscale ACLs so only the operator's devices can reach this Pi. Do not use a public Funnel.

## 10. Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow in on tailscale0
sudo ufw allow OpenSSH
sudo ufw enable
sudo ufw status verbose
```

If SSH is restricted to Tailscale, test a second session before removing LAN SSH access.

## 11. First-run verification

1. Open the Tailscale HTTPS address.
2. Complete the wizard with **Simulation** visibly locked.
3. Use a strong local password.
4. Confirm three strategies and allocations at or below designated capital.
5. Optionally seed clearly labeled simulation data.
6. Add a research-only directive and verify a proposal is rejected.
7. Run the Simulation Lab for two strategies on the same ticker.
8. Sell only one strategy's portion and verify the other remains unchanged.
9. Run reconciliation and verify clear status.
10. Restart the Pi, sign in, and verify ownership/history persisted.
11. Trigger the backup unit and copy the result off-device.

```bash
sudo systemctl start agentic-trading-manager-backup.service
sudo journalctl -u agentic-trading-manager-backup.service -n 30 --no-pager
sudo reboot
```

## 12. Upgrade and rollback

Follow [Operations](OPERATIONS.md). Always create a verified backup before migration, set maintenance mode, keep live trading disabled, build/test the new tag, migrate, start, check health/reconciliation, and only then release maintenance. A rollback that crosses an incompatible migration requires restoring the pre-upgrade database; never edit ledger rows manually.

## Production checklist

- [ ] ARM64 OS fully updated
- [ ] USB SSD and free-space monitoring
- [ ] quality PSU/Ethernet/UPS
- [ ] non-root service user and file permissions
- [ ] 32+ character session secret
- [ ] Simulation environment gates
- [ ] all tests/build/audit pass on the Pi
- [ ] systemd restart and boot verified
- [ ] backup timer and off-device copy verified
- [ ] Tailscale ACLs and firewall reviewed
- [ ] dashboard not public
- [ ] Codex and official MCP read-only test completed
- [ ] repeated Read Only reconciliation before any LIVE discussion
