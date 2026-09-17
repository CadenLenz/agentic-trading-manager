export const PREPRODUCTION_SQL = `
CREATE TABLE risk_config_versions(version INTEGER PRIMARY KEY, body_json TEXT NOT NULL, previous_json TEXT NOT NULL, diff_json TEXT NOT NULL, actor TEXT NOT NULL, instruction TEXT NOT NULL, interpretation TEXT NOT NULL, reason TEXT NOT NULL, session_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE simulation_runs(id TEXT PRIMARY KEY, actor TEXT NOT NULL, status TEXT NOT NULL, config_json TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL, finished_at TEXT);
CREATE TABLE simulation_events(run_id TEXT NOT NULL REFERENCES simulation_runs(id), sequence INTEGER NOT NULL, body_json TEXT NOT NULL, PRIMARY KEY(run_id,sequence));
CREATE TABLE portfolio_snapshots(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, mode TEXT NOT NULL, equity REAL NOT NULL, cash REAL NOT NULL, buying_power REAL, external_flow REAL NOT NULL DEFAULT 0, reason TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE strategy_snapshots(id TEXT PRIMARY KEY, portfolio_id TEXT NOT NULL REFERENCES portfolio_snapshots(id), strategy_id TEXT NOT NULL, equity REAL NOT NULL, cash REAL NOT NULL, realized REAL NOT NULL, unrealized REAL NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE position_snapshots(id TEXT PRIMARY KEY, portfolio_id TEXT NOT NULL REFERENCES portfolio_snapshots(id), strategy_id TEXT NOT NULL, instrument_id TEXT NOT NULL, quantity REAL NOT NULL, mark REAL NOT NULL, value REAL NOT NULL, unrealized REAL NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX snapshot_time ON portfolio_snapshots(account_id,mode,created_at);
CREATE TABLE option_telemetry(id TEXT PRIMARY KEY, option_id TEXT NOT NULL, body_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE notification_events(id TEXT PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, severity TEXT NOT NULL, body_json TEXT NOT NULL, read_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE notification_deliveries(id TEXT PRIMARY KEY, notification_id TEXT NOT NULL REFERENCES notification_events(id), channel TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(notification_id,channel));
CREATE TABLE connector_status(id TEXT PRIMARY KEY, body_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE acceptance_runs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, body_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE readiness_transitions(id TEXT PRIMARY KEY, from_stage TEXT NOT NULL, to_stage TEXT NOT NULL, actor TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE broker_events(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, type TEXT NOT NULL, body_json TEXT NOT NULL, status TEXT NOT NULL, actor TEXT, created_at TEXT NOT NULL);
CREATE TABLE economic_event_pnl(id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL REFERENCES strategies(id), symbol TEXT NOT NULL, amount REAL NOT NULL, event_id TEXT NOT NULL UNIQUE REFERENCES broker_events(id), created_at TEXT NOT NULL);
CREATE TABLE agent_summaries(session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id), summary TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL);
`;
