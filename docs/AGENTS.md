# Current reasoning architecture

Dashboard reasoning now uses the isolated authenticated Codex worker described in [CODEX_WORKER.md](CODEX_WORKER.md). Historical logical-agent details below remain for deterministic simulation. Ambient model invocation is disabled; explicit requests and approved local schedules use the durable task queue. No automatic retries or API fallback.

# Agent system

## Logical agents

- **Manager** interprets operator requests, answers portfolio questions, and creates confirmable configuration proposals. It cannot convert chat into an order.
- **Day Trader** evaluates scanner/watcher events and proposes intraday research, entries or discretionary exits.
- **Aggressive Growth** researches higher-volatility multi-session opportunities and conviction changes.
- **Long-Term Investor** reviews portfolio construction, quality, diversification and low-turnover rebalancing.

Each strategy's canonical context is rebuilt from SQLite: versioned config, hard limits, active directives, virtual positions/cash, relevant broker aggregate, P/L, recent decisions, theses, watchlist, risk events, mode and fresh market event. Long chat history is not treated as state.

## CodexRunner

The runner uses documented commands observed from the installed CLI (`codex-cli 0.150.0-alpha.8` during development):

```text
codex exec --ephemeral --skip-git-repo-check --sandbox read-only \
  --output-schema <temporary-schema> --output-last-message <temporary-output> \
  --cd <explicit-workdir> -
```

It uses argument arrays with `shell:false`, never interpolated shell strings. Each run has a request ID, explicit logical agent, schema, workdir, timeout, cancellation signal, bounded retry, one-run default concurrency, stderr cap, and health status. Simultaneous duplicate request IDs share the existing promise. Temporary schema/output files are mode-restricted and removed.

Agent output is validated again with Zod. Malformed output fails; natural language never becomes an order.

## Job priorities

```text
CRITICAL RISK (100)
USER REQUEST (80)
POSITION EVENT (60)
MARKET EVENT (40)
SCHEDULED REVIEW (20)
BACKGROUND RESEARCH (10)
```

The SQLite-backed queue deduplicates active jobs, supports cancellation, and avoids uncontrolled agent concurrency. V1 exposes direct analysis and persists queue machinery; additional scheduled tasks can register handlers without changing the authority model.

## Observability

Agent states are `IDLE`, `WATCHING`, `QUEUED`, `ANALYZING`, `AWAITING_DATA`, `PROPOSING`, `RISK_CHECK`, `EXECUTING`, `PAUSED`, or `ERROR`. The UI shows current task, last successful run, average duration, last decision and failure count. Stored rationale is concise and audit-intended; hidden chain-of-thought is never requested or displayed.

## Safe local testing

In the Agents page, leave “Invoke Codex” off to produce a deterministic mock research decision. Turning it on performs analysis only; the prompt explicitly prohibits brokerage order tools. Test order routing separately in the Simulation Lab.
