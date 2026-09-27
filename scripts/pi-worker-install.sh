#!/usr/bin/env bash
set -euo pipefail
if [[ "$EUID" != 0 ]]; then echo 'Run as root after building the reviewed release.'; exit 1; fi
release="$(readlink -f /opt/agentic-trading-manager/current)"
case "$release" in /opt/agentic-trading-manager/releases/*) ;; *) echo 'Unexpected release path'; exit 1;; esac
test -f "$release/dist/worker/index.js"
id cadenlenz >/dev/null
getent group agentic-codex >/dev/null || groupadd --system agentic-codex
# Both services execute reviewed root-owned code. The app cannot alter worker code.
chown -R root:root "$release"
chmod -R a+rX,go-w "$release"
chmod 0755 /opt/agentic-trading-manager /opt/agentic-trading-manager/releases "$release"
install -m 0644 "$release/systemd/agentic-codex-worker.service" /etc/systemd/system/
install -d -m 0755 /etc/systemd/system/agentic-trading-manager.service.d
cat > /etc/systemd/system/agentic-trading-manager.service.d/codex-worker.conf <<'UNIT'
[Unit]
Wants=agentic-codex-worker.service
After=agentic-codex-worker.service
[Service]
SupplementaryGroups=agentic-codex
Environment=CODEX_WORKER_SOCKET=/run/agentic-codex-worker/worker.sock
UNIT
systemctl daemon-reload
systemctl enable agentic-codex-worker
systemctl restart agentic-codex-worker
