# Persistent application agent

Use Connections → CONNECT OPENAI with recent app-password authentication to save an API key/model in the encrypted server-only credential vault, or configure OPENAI_API_KEY/OPENAI_MODEL in the protected deployment environment. Environment values take precedence at startup; saving performs no network or paid model request. The default model identifier is configurable, not a guarantee of account access. Do not paste credentials into chat. Without a key, messages still persist but responses explicitly state that no model or tools ran.

The native HTTPS integration uses the [OpenAI Responses function-calling contract](https://developers.openai.com/api/docs/guides/function-calling): strict function schemas, no parallel side effects, store:false and function_call_output results. Bounded database history is supplied each turn. Reasoning/output items are retained inside a tool loop; the app limits turns to eight rounds and does not replay mutating actions after HTTP failure. Tests mock the transport; a real paid model request has not been executed.

ADVISOR permits account/strategy/position/order/report reads, research attachment and proposal drafting. OPERATOR permits draft/edit/review, pauses and guarded requests; material configuration, resume and broker cancellation requests become separately confirmable changes. AUTONOMOUS adds execution requests only for a sleeve explicitly configured AUTONOMOUS_RISK_APPROVED. A session mode never grants LIVE, manual approval, borrowing or policy activation authority.

## Allowlisted tools

25 tools: get_account_state, get_strategy_state, get_positions, get_orders, get_reports, inspect_application, research_equity, research_option_setup, create_trade_proposal, modify_trade_proposal, cancel_trade_proposal, request_risk_review, update_strategy_config, set_strategy_allocation, pause_strategy, pause_strategy_until, resume_strategy, request_position_exit, request_order_cancel, request_execution, propose_risk_configuration, preview_risk_configuration, run_full_system_test, propose_scheduler_configuration, propose_notification_preferences.

Inspection includes risk/history, fills, options, allocations, schedules, connectors, notifications, simulation and health. Structured risk edits produce explicit pending diffs, not applied mutations. API confirmation uses the same versioned configuration service and reauthentication. Actual persisted user message text is used in risk-change audit when available, not merely the model's paraphrase. Timed pause uses an expiring STRATEGY_PAUSE directive; expiration never enables an independently disabled/killed sleeve. Simulation is a safe isolated inspection tool even in ADVISOR mode.

`agent_summaries` stores a deterministic most-recent-turn summary containing actual instruction, actual response and action IDs. Full session/turn/action history remains authoritative. This is not a fabricated long-term thesis memory or a commissioned autonomous trading loop. The next pass must bind verifiable current research before unattended decisions.

Research tools currently attach supplied source-bearing checklist evidence; **they do not fetch news or verify source content**. No news/fundamental/option-chain research feed is integrated. The agent is instructed not to invent evidence; structural validation is not factual research verification. Automated source collection and evidence provenance remain required before autonomous LIVE acceptance.

SAFE checks fundamentals, balance sheet/FCF, valuation, sector/macro, news, thesis, price context and risks. AGGRESSIVE checks catalysts, earnings timing, liquidity, volume, trend, support/resistance, volatility, momentum, risk/reward and invalidation. OPTIONS additionally checks IV/event risk, strike, expiration, moneyness, contract liquidity/spread/open interest, theta, maximum loss, collateral and exits. Missing, future or stale evidence blocks approval.

Sessions are operator-owned; another operator cannot read them. agent_messages stores user/assistant turns; agent_actions records session, turn, user-message ID, tool, arguments, result and timestamp. General audit_events records application actions. Successful tools remain audited even when a later model request fails.

## Enable autonomy separately

In Trading Workspace → Sleeve Policies, select SAFE_LONG_TERM, AGGRESSIVE_STOCKS or OPTIONS. Review the full policy JSON. Set executionPolicy to AUTONOMOUS_RISK_APPROVED, enter a 20+ character risk review and exact UPDATE sleeve POLICY phrase, and apply. Repeat only for other sleeves you actually authorize. Their defaults stay MANUAL_APPROVAL.

Create a new AUTONOMOUS chat session. Only current researched/risk-approved/previewed proposals can execute. During a global/sleeve pause or kill, exits require separate manual approval; an autonomous session cannot use a protective exit to evade the pause. Setting policies does not create a background trading loop. Switching to MANUAL_APPROVAL takes effect on subsequent execution requests.
