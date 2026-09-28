#!/usr/bin/env bash
set -euo pipefail
if [[ "$EUID" != "0" || "$#" != "1" || "$1" != "robinhood-trading" ]]; then
  echo 'Usage: sudo agentic-codex-mcp-login robinhood-trading' >&2
  exit 2
fi

systemd-run --quiet --wait --collect --pty \
  --unit=agentic-codex-mcp-login \
  --property=User=cadenlenz \
  --property=Group=agentic-codex \
  --property=WorkingDirectory=/opt/agentic-trading-manager/current \
  --property=Environment=HOME=/home/cadenlenz \
  --property=Environment=CODEX_HOME=/home/cadenlenz/.codex \
  --property=Environment=XDG_DATA_HOME=/var/lib/agentic-codex-worker/xdg \
  --property=LoadCredentialEncrypted=keyring-passphrase:/etc/credstore.encrypted/agentic-codex-worker-keyring-passphrase \
  --property=NoNewPrivileges=yes \
  --property=ProtectSystem=strict \
  --property=ProtectHome=read-only \
  --property=BindPaths=/home/cadenlenz/.codex \
  --property='ReadWritePaths=/var/lib/agentic-codex-worker /home/cadenlenz/.codex' \
  --property='InaccessiblePaths=/var/lib/agentic-trading-manager /etc/agentic-trading-manager /var/backups/agentic-trading-manager' \
  /usr/local/libexec/agentic-codex-worker-entrypoint \
  /usr/bin/codex -c 'mcp_oauth_credentials_store="keyring"' mcp login robinhood-trading
