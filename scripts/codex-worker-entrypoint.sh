#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ "${ATM_CODEX_PRIVATE_BUS:-}" != "1" ]]; then
  export ATM_CODEX_PRIVATE_BUS=1
  exec /usr/bin/dbus-run-session -- "$0" "$@"
fi

credential="${CREDENTIALS_DIRECTORY:?systemd credential directory is required}/keyring-passphrase"
test -r "$credential"
test "$(stat -c %a "$credential")" = "400"
install -d -m 0700 "$XDG_DATA_HOME/keyrings"
/usr/bin/gnome-keyring-daemon --unlock --components=secrets < "$credential" >/dev/null

if (($#)); then exec "$@"; fi
exec /usr/bin/node /opt/agentic-trading-manager/current/dist/worker/index.js
