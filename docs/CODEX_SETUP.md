# Codex setup

Codex is an optional intelligence service in Simulation and required for the V1 Robinhood MCP transport. It is never the authority for hard risk or mode gates.

## Prerequisites and login

Install a supported Codex CLI using the official OpenAI instructions for the target desktop/ARM64 environment. Authenticate the same OS user that runs Agentic Trading Manager:

```bash
codex --version
codex --help
codex login
codex doctor
```

During implementation, the installed CLI reported `codex-cli 0.150.0-alpha.8`. The runner uses only flags verified with `codex exec --help`: explicit workdir, ephemeral run, read-only sandbox, output JSON schema, final-message file, timeout/cancellation controlled by the parent process, and stdin prompt.

## Robinhood MCP

```bash
codex mcp add robinhood-trading --url https://agent.robinhood.com/mcp/trading
codex mcp list --json
```

Then launch `codex`, enter `/mcp`, select `robinhood-trading`, and complete official desktop authentication/onboarding. See [Robinhood setup](ROBINHOOD_SETUP.md).

## Application invocation

`CodexRunner` launches `codex exec` without a shell. It supplies:

- an explicit working directory;
- a logical agent identity and concise canonical state;
- read-only sandbox;
- a JSON response schema;
- request ID/deduplication;
- bounded timeout, cancellation and retry;
- concurrency limit (one by default);
- captured/redacted diagnostics.

Agent analysis prompts prohibit broker order tools. A separate adapter call can authorize exactly one already-approved typed broker operation only after deterministic execution gates.

## Permissions

The service identity needs:

- execute access to the Codex binary;
- access to its own Codex authentication/config directory;
- read access to the application working directory;
- write access to the application data directory (handled by AgenticManager, not Codex).

Codex itself is launched `--sandbox read-only` and does not need write access for analysis output because the runner's temporary output contract is managed by the parent process.

## Test without trades

1. Keep application mode Simulation.
2. Leave `ALLOW_LIVE_TRADING=false`.
3. Open Agents.
4. Select a logical agent and symbol.
5. First run with “Invoke Codex” off to verify deterministic mock reasoning.
6. Turn it on to verify the structured analysis contract.
7. Confirm a decision appears but no order is created.
8. Test the order pipeline separately in Simulation Lab.

## Failure modes

- CLI missing/unauthenticated: agent run fails and records an error; trading is unaffected.
- Timeout/cancellation: bounded failure; no infinite retry.
- Malformed schema output: validation failure; no proposal/order.
- Duplicate request: shared in-flight run prevents simultaneous duplicate reasoning.
- MCP auth expired: Robinhood status becomes unauthenticated, Read Only reconciliation blocks, and LIVE cannot enable.
- MCP capability changed: discovery returns current tools; unsupported calls fail closed rather than guessing names.

Never use `--dangerously-bypass-approvals-and-sandbox` in this application's runner.
