# Codex worker architecture and operations

The app runs as `agentic-trader`; the reasoning worker runs as `cadenlenz`, using that user's existing ChatGPT login and Codex-managed Robinhood OAuth. Credentials are never copied into the application or its database. ChatGPT authentication remains in the user-owned Codex home. Robinhood OAuth uses Codex's supported `keyring` mode inside a private Secret Service session whose dedicated random passphrase is encrypted by systemd's host credential store. The decrypted passphrase exists only in the worker's systemd credential directory at runtime; OAuth tokens remain in the worker-only keyring under `/var/lib/agentic-codex-worker/xdg`. The app cannot traverse that `0700` state directory or read the worker's home. Release code is root-owned so the app cannot change code executed by the more privileged worker.

The only IPC is `/run/agentic-codex-worker/worker.sock`, mode 0660 inside a 0750 directory owned by the worker and the dedicated `agentic-codex` group. The app receives that supplementary group through its systemd drop-in. No network listener or Funnel is added. The worker cannot access the trading database, backups, or environment file. Its own SQLite queue is under `/var/lib/agentic-codex-worker`, mode 0700.

## CLI contract and capabilities

Verified against installed Pi Codex CLI 0.157.1. Runs use explicit arguments, prompt stdin, `--strict-config --ignore-user-config --ignore-rules --ephemeral --sandbox read-only --output-schema --output-last-message`. Auth continues to use the external CODEX_HOME. Shell, browser, computer, plugins, apps, hooks, collaboration, memories, image and code-mode capabilities are disabled. API credentials are excluded from the child environment and ChatGPT login is required. Project instructions are disabled. The only configured MCP server is the fixed official Robinhood endpoint with an explicit read-tool allowlist already used by the repository. No placement, cancellation, exercise or transfer tool is exposed. Unsupported CLI versions fail closed.

References: [non-interactive CLI](https://developers.openai.com/codex/noninteractive), [configuration reference](https://developers.openai.com/codex/config-reference). Future CLI upgrades require rechecking capability controls and a read-only acceptance task. The runner never retries automatically and never selects an API fallback.

`codex mcp list` proves configuration and OAuth mechanism, not successful live account access. UI labels preserve that distinction. Missing broker auth is supported. The optional direct connector remains the only source for deterministic reconciliation; model text and MCP research never clear that gate. Real execution remains hard-locked by PREPRODUCTION_LIVE_LOCK.

## Tasks and authority

Each dashboard message creates a durable task ID. The app gathers bounded relevant context and stores template version, authority, source, actor, configuration hash, settings, CLI version, timestamps, response, source provenance, hash, action result and errors. Results/reports are readable from task history without rerunning Codex. Strict schemas are checked both in the worker and again in the app.

READ_ONLY / RESEARCH cannot return actions. CONFIGURE_PROPOSAL can pause, propose risk edits for existing confirmation, or launch isolated simulation. TRADE_PROPOSAL can only create a DRAFT. No execution authority is exposed by this task surface. Trade review, approval, reconciliation, broker preview and all deterministic risk checks remain independent.

App-side action application and the applied marker share a SQLite transaction. Duplicate IDs cannot create duplicate actions. Cancellation prevents app-side application even if the child finishes concurrently. Worker restart marks interrupted jobs UNKNOWN; queued jobs can resume. Uncertain IPC dispatch is UNKNOWN and never replayed. Operators can read worker history to investigate; a fresh task is an explicit new request. Do not resubmit an uncertain financial action.

Schedules use persisted elapsed-minute cadence (hourly, four-hourly, daily, weekly), explicit non-execution authority, target sleeve, timeout, version, next/last run. They start disabled unless explicitly saved/enabled by the operator. Missed intervals coalesce into a single occurrence and future occurrences remain scheduled after failure or usage exhaustion. Existing deterministic market-calendar schedules are retained.

## Deployment

Run the existing reviewed `sudo bash scripts/pi-update.sh EXACT_PUSHED_SHA`. It validates the release before switching, preserves database backups, installs the worker, and leaves READ_ONLY / GLOBAL PAUSE / MANUAL_APPROVAL. The installer is configured for this Pi's existing `cadenlenz` account and `/usr/bin/codex`; a different host must review those paths before installation. New installs also require that externally authenticated user.

Verify:

```sh
systemctl is-active agentic-trading-manager agentic-codex-worker
sudo -u cadenlenz -H codex login status
sudo -u cadenlenz -H codex mcp list
sudo -u cadenlenz -g agentic-codex curl --unix-socket /run/agentic-codex-worker/worker.sock http://localhost/health
curl --fail http://127.0.0.1:4010/health
tailscale serve status
readlink -f /opt/agentic-trading-manager/current
```

The socket check needs the dedicated group; a login shell does not inherit the service's SupplementaryGroups drop-in. Use `sudo -u cadenlenz -g agentic-codex` for a manual socket check, or inspect the app's authenticated Codex status page. Do not print configuration or auth files.

If ChatGPT auth expires, the operator runs `codex login --device-auth` as `cadenlenz`. If broker auth expires, the operator runs `codex mcp login robinhood-trading` as `cadenlenz` and completes provider interaction. Never copy tokens, automate passkeys, or ask for broker credentials. Neither provider outage prevents STOP, pause, dashboard, stored reports or deterministic controls.

The worker deliberately sets `mcp_oauth_credentials_store="keyring"`; it never permits Codex's `auto` mode to fall back to `.credentials.json`. The desktop Default Keyring is no longer part of production startup. Existing desktop-keyring OAuth material is not exported. Complete the one-time provider flow in the dedicated store with `sudo agentic-codex-mcp-login robinhood-trading`; finish Robinhood's normal browser/passkey interaction yourself. Subsequent boots decrypt only the dedicated random keyring passphrase through systemd and require no desktop login.

Worker health distinguishes connected, needs login, expired authentication, unavailable credential store, and unavailable MCP configuration. Every credential probe has a five-second process timeout. Stored-context tasks continue without MCP and disclose the missing live source. Research, position/options review, and proposal-generation tasks fail clearly before Codex runs when Robinhood is not connected.

Legacy API transport is retained only for explicit compatibility (`ENABLE_LEGACY_OPENAI_API=true`); no production route selects it. Legacy connection metadata is not readiness evidence. Normal operation uses no OpenAI API key and no API inference.
