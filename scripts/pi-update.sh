#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ "$EUID" != 0 || "$#" != 1 ]]; then echo "Usage: sudo bash scripts/pi-update.sh REVIEWED_GIT_REF"; exit 1; fi
ref="$1"
current="$(readlink -f /opt/agentic-trading-manager/current)"
case "$current" in /opt/agentic-trading-manager/releases/*) ;; *) echo "Unexpected current release path; stop and inspect."; exit 1;; esac
envfile=/etc/agentic-trading-manager/agentic-trading-manager.env
test -f "$envfile"
# Block new execution before fetching or staging an update. A failure leaves the service stopped.
systemctl stop agentic-trading-manager-backup.timer agentic-trading-manager-backup.service agentic-trading-manager
trap 'systemctl stop agentic-trading-manager || true; echo "Update failed. Service remains stopped; inspect retained releases/backups before recovery. Never start an old binary against a migrated DB automatically."' ERR
repo="$(mktemp -d /opt/agentic-trading-manager/source-XXXXXX)"
git clone --no-checkout https://github.com/CadenLenz/agentic-trading-manager.git "$repo"
git -C "$repo" checkout --detach "$ref"
sha="$(git -C "$repo" rev-parse --verify HEAD)"
release="/opt/agentic-trading-manager/releases/$sha"
if [[ -e "$release" ]]; then echo "Release path already exists; inspect it, do not overwrite."; exit 1; fi
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
# Service and backup timer have remained stopped throughout staging.
# Revoke deployment LIVE gates even if a later database step fails. Never source an environment file as root.
sed -i -e 's/^TRADING_MODE=.*/TRADING_MODE=READ_ONLY/' -e 's/^ALLOW_LIVE_TRADING=.*/ALLOW_LIVE_TRADING=false/' -e "s/^APP_GIT_SHA=.*/APP_GIT_SHA=$sha/" "$envfile"
cp --preserve=mode,ownership "$envfile" "/var/backups/agentic-trading-manager/environment-$sha.env"
DATA_DIR=/var/lib/agentic-trading-manager BACKUP_DIR=/var/backups/agentic-trading-manager runuser -u agentic-trader -- npm run backup
DATA_DIR=/var/lib/agentic-trading-manager runuser -u agentic-trader -- npm run upgrade:safe
next="/opt/agentic-trading-manager/current-next-$sha"
test ! -e "$next"
ln -s "$release" "$next"
mv -T "$next" /opt/agentic-trading-manager/current
install -m 0644 systemd/agentic-trading-manager.service systemd/agentic-trading-manager-backup.service systemd/agentic-trading-manager-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl start agentic-trading-manager
if ! curl --retry 10 --retry-delay 2 --retry-connrefused --fail --silent http://127.0.0.1:4010/health; then systemctl stop agentic-trading-manager; echo "Health check failed; service stopped."; exit 1; fi
systemctl start agentic-trading-manager-backup.timer
echo
echo "Updated $sha in Read Only and paused; previous release retained at $current. Review ownership, risk, tests and readiness before enabling any sleeve."
