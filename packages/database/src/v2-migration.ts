import type Database from 'better-sqlite3';
import { DEFAULT_POLICIES, SLEEVES } from '../../trading-v2/src/model.js';
import { EXAMPLE_STRATEGY_CONFIGS } from '../../core/src/types.js';
import { makeId, nowIso } from '../../core/src/utils.js';

export const V2_SQL = [
  'ALTER TABLE strategies ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;',
  'ALTER TABLE strategies ADD COLUMN sleeve_kind TEXT;',
  'CREATE TABLE migration_archive(id TEXT PRIMARY KEY,table_name TEXT NOT NULL,row_json TEXT NOT NULL,created_at TEXT NOT NULL);',
  'CREATE TABLE strategy_aliases(legacy_id TEXT PRIMARY KEY REFERENCES strategies(id),sleeve_id TEXT NOT NULL REFERENCES strategies(id));',
  'CREATE TABLE sleeve_policies(strategy_id TEXT PRIMARY KEY REFERENCES strategies(id),config_json TEXT NOT NULL,updated_at TEXT NOT NULL);',
  'CREATE TABLE strategy_capital(strategy_id TEXT PRIMARY KEY REFERENCES strategies(id),starting_capital REAL NOT NULL,weekly_starting_capital REAL NOT NULL,high_water_mark REAL NOT NULL,week_key TEXT NOT NULL,killed INTEGER NOT NULL DEFAULT 0,kill_reason TEXT,reset_at TEXT);',
  'CREATE TABLE strategy_allocations(id TEXT PRIMARY KEY,week_key TEXT NOT NULL,strategy_id TEXT NOT NULL REFERENCES strategies(id),net_account_value REAL NOT NULL,target_amount REAL NOT NULL,actual_equity REAL NOT NULL,drift_percent REAL NOT NULL,created_at TEXT NOT NULL,UNIQUE(week_key,strategy_id));',
  'CREATE TABLE proposals(id TEXT PRIMARY KEY,version INTEGER NOT NULL,state TEXT NOT NULL,strategy_id TEXT NOT NULL REFERENCES strategies(id),body_json TEXT NOT NULL,research_json TEXT,preview_json TEXT,preview_hash TEXT,approval_json TEXT,order_id TEXT REFERENCES orders(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);',
  'CREATE TABLE proposal_transitions(id TEXT PRIMARY KEY,proposal_id TEXT NOT NULL REFERENCES proposals(id),from_state TEXT NOT NULL,to_state TEXT NOT NULL,version INTEGER NOT NULL,actor TEXT NOT NULL,details_json TEXT NOT NULL,created_at TEXT NOT NULL);',
  'CREATE TABLE risk_decisions_v2(id TEXT PRIMARY KEY,proposal_id TEXT NOT NULL REFERENCES proposals(id),version INTEGER NOT NULL,approved INTEGER NOT NULL,checks_json TEXT NOT NULL,facts_json TEXT NOT NULL,created_at TEXT NOT NULL);',
  'CREATE TABLE executions_v2(id TEXT PRIMARY KEY,proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id),idempotency_key TEXT NOT NULL UNIQUE,order_id TEXT NOT NULL REFERENCES orders(id),broker_order_id TEXT,status TEXT NOT NULL,order_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);',
  'CREATE TABLE capital_reservations(id TEXT PRIMARY KEY,proposal_id TEXT UNIQUE REFERENCES proposals(id),strategy_id TEXT NOT NULL REFERENCES strategies(id),cash_amount REAL NOT NULL,underlying TEXT,shares REAL NOT NULL DEFAULT 0,status TEXT NOT NULL,created_at TEXT NOT NULL);',
  'CREATE TABLE option_positions(option_id TEXT PRIMARY KEY,strategy_id TEXT NOT NULL REFERENCES strategies(id),instrument_json TEXT NOT NULL,contracts REAL NOT NULL,average_premium REAL NOT NULL,mark_price REAL NOT NULL,collateral REAL NOT NULL,reserved_shares REAL NOT NULL,updated_at TEXT NOT NULL);',
  'CREATE TABLE option_lots(id TEXT PRIMARY KEY,option_id TEXT NOT NULL,strategy_id TEXT NOT NULL REFERENCES strategies(id),contracts REAL NOT NULL,premium REAL NOT NULL,opened_at TEXT NOT NULL);',
  'CREATE TABLE position_assignments(id TEXT PRIMARY KEY,symbol TEXT NOT NULL,from_strategy TEXT,to_strategy TEXT NOT NULL REFERENCES strategies(id),quantity REAL NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL);',
  'CREATE TABLE trading_reports(id TEXT PRIMARY KEY,kind TEXT NOT NULL,period_key TEXT NOT NULL,body_json TEXT NOT NULL,created_at TEXT NOT NULL);',
  'CREATE TABLE scheduler_jobs_v2(id TEXT PRIMARY KEY,cron TEXT NOT NULL,timezone TEXT NOT NULL,kind TEXT NOT NULL,strategy_id TEXT REFERENCES strategies(id),market_day_only INTEGER NOT NULL,enabled INTEGER NOT NULL,last_slot TEXT,last_run_at TEXT,last_error TEXT);',
  'CREATE TABLE market_sessions(date TEXT PRIMARY KEY,opens_at TEXT NOT NULL,closes_at TEXT NOT NULL,source TEXT NOT NULL,verified_at TEXT NOT NULL);',
  'CREATE TABLE agent_sessions(id TEXT PRIMARY KEY,mode TEXT NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);',
  'CREATE TABLE agent_messages(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES agent_sessions(id),turn_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);',
  'CREATE TABLE agent_actions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES agent_sessions(id),turn_id TEXT NOT NULL,user_message_id TEXT NOT NULL,tool TEXT NOT NULL,arguments_json TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL);',
  'CREATE TABLE simulation_option_instruments(option_id TEXT PRIMARY KEY,body_json TEXT NOT NULL,premium REAL NOT NULL);',
].join('\n');

export function migrateOwnership(db: Database.Database): void {
  const timestamp = nowIso();
  const old = db.prepare('SELECT * FROM strategies WHERE archived=0').all() as Array<{ id: string; kind: string; allocation_amount: number }>;
  if (!old.length) return;
  const unsupported=db.prepare("SELECT symbol FROM strategy_positions WHERE quantity>0 AND asset_type NOT IN ('EQUITY','ETF')").all();
  if(unsupported.length)throw new Error('V2 migration requires explicit handling of unsupported legacy non-equity ownership; backup and source schema retained');
  const mapping: Record<string, string> = {};
  for (const row of old) mapping[row.id] = row.kind === 'LONG_TERM' ? 'SAFE_LONG_TERM' : 'AGGRESSIVE_STOCKS';
  const tables = ['strategies','strategy_cash','strategy_positions','strategy_lots','strategy_versions','orders','strategy_fills','realized_pnl','virtual_transactions','watchlists','directives','decisions','theses','performance_snapshots','trade_reviews','agent_runs','risk_events'];
  for (const table of tables) for (const row of db.prepare('SELECT * FROM ' + table).all()) db.prepare('INSERT INTO migration_archive VALUES(?,?,?,?)').run(makeId('archive'),table,JSON.stringify(row),timestamp);
  for (const sleeve of SLEEVES) {
    const legacyKind = sleeve === 'SAFE_LONG_TERM' ? 'LONG_TERM' : sleeve === 'AGGRESSIVE_STOCKS' ? 'AGGRESSIVE_GROWTH' : 'DAY_TRADER';
    const config = { ...EXAMPLE_STRATEGY_CONFIGS[legacyKind], allocationAmount: 0, allowedAssetTypes: sleeve === 'OPTIONS' ? ['OPTION'] : ['EQUITY','ETF'] };
    db.prepare('INSERT INTO strategies(id,name,kind,enabled,status,allocation_amount,config_json,created_at,updated_at,sleeve_kind) VALUES(?,?,?,?,?,?,?,?,?,?)').run(sleeve,sleeve,legacyKind,0,'PAUSED',0,JSON.stringify(config),timestamp,timestamp,sleeve);
    db.prepare('INSERT INTO strategy_cash VALUES(?,?,?)').run(sleeve,0,timestamp);
    db.prepare('INSERT INTO sleeve_policies VALUES(?,?,?)').run(sleeve,JSON.stringify(DEFAULT_POLICIES[sleeve]),timestamp);
  }
  for (const row of old) {
    const target = mapping[row.id]!;
    db.prepare('INSERT INTO strategy_aliases VALUES(?,?)').run(row.id,target);
    const cash = db.prepare('SELECT balance FROM strategy_cash WHERE strategy_id=?').get(row.id) as { balance: number };
    db.prepare('UPDATE strategy_cash SET balance=balance+? WHERE strategy_id=?').run(cash.balance,target);
    db.prepare('UPDATE strategy_cash SET balance=0 WHERE strategy_id=?').run(row.id);
    const positions = db.prepare('SELECT * FROM strategy_positions WHERE strategy_id=?').all(row.id) as Array<{ symbol:string; quantity:number; average_cost:number; market_price:number; sector:string; asset_type:string; updated_at:string }>;
    for (const p of positions) {
      const existing = db.prepare('SELECT quantity,average_cost FROM strategy_positions WHERE strategy_id=? AND symbol=?').get(target,p.symbol) as { quantity:number; average_cost:number } | undefined;
      const quantity = (existing?.quantity ?? 0) + p.quantity;
      const cost = quantity ? ((existing?.quantity ?? 0)*(existing?.average_cost ?? 0)+p.quantity*p.average_cost)/quantity : 0;
      db.prepare('INSERT INTO strategy_positions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(strategy_id,symbol) DO UPDATE SET quantity=excluded.quantity,average_cost=excluded.average_cost').run(target,p.symbol,quantity,cost,p.market_price,p.sector,p.asset_type,p.updated_at);
    }
    db.prepare('DELETE FROM strategy_positions WHERE strategy_id=?').run(row.id);
    const watch = db.prepare('SELECT * FROM watchlists WHERE strategy_id=?').all(row.id) as Array<{symbol:string;research_only:number;notes:string;created_at:string}>;
    for (const p of watch) db.prepare('INSERT INTO watchlists VALUES(?,?,?,?,?) ON CONFLICT(strategy_id,symbol) DO UPDATE SET research_only=MAX(research_only,excluded.research_only)').run(target,p.symbol,p.research_only,p.notes,p.created_at);
    db.prepare('DELETE FROM watchlists WHERE strategy_id=?').run(row.id);
    for (const table of tables.filter(t => !['strategies','strategy_cash','strategy_positions','watchlists','strategy_versions'].includes(t))) db.prepare('UPDATE ' + table + ' SET strategy_id=? WHERE strategy_id=?').run(target,row.id);
    db.prepare('UPDATE strategies SET archived=1,enabled=0,status=\'PAUSED\' WHERE id=?').run(row.id);
  }
  for (const sleeve of SLEEVES) {
    const equity = db.prepare('SELECT (SELECT balance FROM strategy_cash WHERE strategy_id=?) + COALESCE(SUM(quantity*market_price),0) AS value FROM strategy_positions WHERE strategy_id=?').get(sleeve,sleeve) as {value:number};
    const row = db.prepare('SELECT config_json FROM strategies WHERE id=?').get(sleeve) as {config_json:string};
    const config = { ...JSON.parse(row.config_json) as Record<string,unknown>, allocationAmount:equity.value };
    db.prepare('UPDATE strategies SET allocation_amount=?,config_json=? WHERE id=?').run(equity.value,JSON.stringify(config),sleeve);
    db.prepare('INSERT INTO strategy_versions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(makeId('sv'),sleeve,1,'MIGRATION','{}',JSON.stringify(config),'{}','SYSTEM','V2 migrated ownership; archived originals retained','{}',timestamp);
  }
  db.prepare('UPDATE pending_changes SET status=\'EXPIRED\' WHERE status=\'PENDING\'').run();
  const set = (key:string,value:unknown) => db.prepare('INSERT INTO settings VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at').run(key,JSON.stringify(value),timestamp);
  const mode = db.prepare('SELECT value_json FROM settings WHERE key=\'operating_mode\'').get() as {value_json:string} | undefined;
  set('operating_mode',mode?.value_json === '"SIMULATION"' ? 'SIMULATION':'READ_ONLY');
  set('live_db_confirmation',false); set('global_pause',true); set('v2_migration_review_required',true); set('v2_live_activation',false);
}
