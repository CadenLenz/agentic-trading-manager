#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ "$EUID" != 0 ]]; then echo "Run with sudo."; exit 1; fi
if [[ "$#" != 1 ]]; then echo "Usage: sudo bash scripts/pi-install.sh REVIEWED_GIT_REF"; exit 1; fi
ref="$1"
command -v node >/dev/null
command -v npm >/dev/null
command -v git >/dev/null
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13))process.exit(1)'
if [[ "$(uname -m)" != "aarch64" ]]; then echo "A Raspberry Pi 64-bit ARM installation is required."; exit 1; fi
if [[ -e /opt/agentic-trading-manager/current ]]; then echo "Existing installation: use pi-update.sh instead."; exit 1; fi
if ! id agentic-trader >/dev/null 2>&1; then useradd --system --home /var/lib/agentic-trading-manager --shell /usr/sbin/nologin agentic-trader; fi
install -d -m 0755 /opt/agentic-trading-manager /opt/agentic-trading-manager/releases
install -d -m 0700 -o agentic-trader -g agentic-trader /var/lib/agentic-trading-manager /var/backups/agentic-trading-manager /etc/agentic-trading-manager
repo="$(mktemp -d /opt/agentic-trading-manager/source-XXXXXX)"
git clone --no-checkout https://github.com/CadenLenz/agentic-trading-manager.git "$repo"
git -C "$repo" checkout --detach "$ref"
sha="$(git -C "$repo" rev-parse --verify HEAD)"
release="/opt/agentic-trading-manager/releases/$sha"
install -d -m 0700 -o agentic-trader -g agentic-trader "$release"
git -C "$repo" archive HEAD | tar -x -C "$release"
chown -R agentic-trader:agentic-trader "$release"
cd "$release"
runuser -u agentic-trader -- npm ci
runuser -u agentic-trader -- npm run lint
runuser -u agentic-trader -- npm run typecheck
runuser -u agentic-trader -- npm test
runuser -u agentic-trader -- npm run self-test
runuser -u agentic-trader -- npm run test:system
runuser -u agentic-trader -- npm run build
runuser -u agentic-trader -- npm audit --omit=dev
envfile="/etc/agentic-trading-manager/agentic-trading-manager.env"
if [[ -e "$envfile" ]]; then echo "Existing environment file found; preserve it and finish installation manually."; exit 1; fi
install -m 0600 -o agentic-trader -g agentic-trader .env.example "$envfile"
secret="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("hex"))')"
sed -i -e 's/^NODE_ENV=.*/NODE_ENV=production/' -e 's|^DATA_DIR=.*|DATA_DIR=/var/lib/agentic-trading-manager|' -e 's/^TRADING_MODE=.*/TRADING_MODE=READ_ONLY/' -e "s/^SESSION_SECRET=.*/SESSION_SECRET=$secret/" -e "s/^APP_GIT_SHA=.*/APP_GIT_SHA=$sha/" "$envfile"
DATA_DIR=/var/lib/agentic-trading-manager runuser -u agentic-trader -- npm run upgrade:safe
ln -s "$release" /opt/agentic-trading-manager/current
install -m 0644 systemd/agentic-trading-manager.service /etc/systemd/system/
install -m 0644 systemd/agentic-trading-manager-backup.service systemd/agentic-trading-manager-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now agentic-trading-manager agentic-trading-manager-backup.timer
if ! curl --retry 10 --retry-delay 2 --retry-connrefused --fail --silent http://127.0.0.1:4010/health; then systemctl stop agentic-trading-manager; echo "Health check failed; service stopped."; exit 1; fi
echo
echo "Installed $sha in Read Only and paused. Configure HTTPS/Tailscale and complete the dashboard checklist. Source and staging directories were retained."
