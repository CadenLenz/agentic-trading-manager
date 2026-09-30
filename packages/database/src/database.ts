import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { EXAMPLE_GLOBAL_RISK, EXAMPLE_STRATEGY_CONFIGS, STRATEGY_IDS, type AgentStatus, type GlobalRiskConfig, type OperatingMode, type Strategy, type StrategyConfig, type StrategyKind } from '../../core/src/types.js';
import { diffRecords, makeId, nowIso, parseJson, redact,roundMoney } from '../../core/src/utils.js';
import { migrateOwnership, V2_SQL } from './v2-migration.js';
import {migrateExternalBasis} from './manual-live-migration.js';
import { PREPRODUCTION_SQL } from './preproduction-migration.js';
import { DEFAULT_POLICIES, SLEEVES } from '../../trading-v2/src/model.js';

export const MIGRATIONS: Array<{ version: number; sql: string; run?: (db: Database.Database) => void }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS strategies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('DAY_TRADER','AGGRESSIVE_GROWTH','LONG_TERM')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        status TEXT NOT NULL,
        allocation_amount REAL NOT NULL CHECK(allocation_amount >= 0),
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS strategy_versions (
        id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        source TEXT NOT NULL,
        previous_json TEXT NOT NULL,
        new_json TEXT NOT NULL,
        diff_json TEXT NOT NULL,
        origin TEXT NOT NULL,
        reason TEXT NOT NULL,
        portfolio_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(strategy_id, version)
      );
      CREATE TABLE IF NOT EXISTS strategy_cash (
        strategy_id TEXT PRIMARY KEY REFERENCES strategies(id) ON DELETE CASCADE,
        balance REAL NOT NULL CHECK(balance >= -0.000001),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS strategy_positions (
        strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,
        quantity REAL NOT NULL CHECK(quantity >= -0.000001),
        average_cost REAL NOT NULL CHECK(average_cost >= 0),
        market_price REAL NOT NULL CHECK(market_price >= 0),
        sector TEXT NOT NULL DEFAULT 'Unknown',
        asset_type TEXT NOT NULL DEFAULT 'EQUITY',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(strategy_id, symbol)
      );
      CREATE TABLE IF NOT EXISTS strategy_lots (
        id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,
        remaining_quantity REAL NOT NULL CHECK(remaining_quantity >= -0.000001),
        entry_price REAL NOT NULL,
        fees REAL NOT NULL DEFAULT 0,
        opened_at TEXT NOT NULL,
        source_fill_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lots_owner_symbol ON strategy_lots(strategy_id, symbol, opened_at);
      CREATE TABLE IF NOT EXISTS broker_positions (
        symbol TEXT PRIMARY KEY,
        quantity REAL NOT NULL,
        average_cost REAL NOT NULL,
        asset_type TEXT NOT NULL,
        sector TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        strategy_id TEXT REFERENCES strategies(id),
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
        quantity REAL NOT NULL CHECK(quantity > 0),
        order_type TEXT NOT NULL,
        limit_price REAL,
        stop_price REAL,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        source TEXT NOT NULL,
        broker_order_id TEXT UNIQUE,
        cumulative_filled_quantity REAL NOT NULL DEFAULT 0,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fills (
        id TEXT PRIMARY KEY,
        broker_fill_id TEXT NOT NULL UNIQUE,
        order_id TEXT NOT NULL REFERENCES orders(id),
        quantity REAL NOT NULL CHECK(quantity > 0),
        price REAL NOT NULL CHECK(price > 0),
        fees REAL NOT NULL DEFAULT 0 CHECK(fees >= 0),
        executed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS strategy_fills (
        id TEXT PRIMARY KEY,
        fill_id TEXT NOT NULL UNIQUE REFERENCES fills(id),
        strategy_id TEXT NOT NULL REFERENCES strategies(id),
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity REAL NOT NULL,
        price REAL NOT NULL,
        fees REAL NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS realized_pnl (
        id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL REFERENCES strategies(id),
        symbol TEXT NOT NULL,
        order_id TEXT NOT NULL REFERENCES orders(id),
        fill_id TEXT NOT NULL REFERENCES fills(id),
        amount REAL NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS virtual_transactions (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        strategy_id TEXT REFERENCES strategies(id),
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        symbol TEXT,
        quantity REAL,
        reference_id TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reconciliation_events (
        id TEXT PRIMARY KEY,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        kind TEXT NOT NULL,
        symbol TEXT,
        internal_value TEXT NOT NULL,
        broker_value TEXT NOT NULL,
        difference REAL NOT NULL,
        details_json TEXT NOT NULL,
        resolution_json TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS directives (
        id TEXT PRIMARY KEY,
        strategy_id TEXT REFERENCES strategies(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        symbol TEXT,
        value_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        expires_at TEXT,
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_directives_active ON directives(strategy_id, symbol, active, expires_at);
      CREATE TABLE IF NOT EXISTS watchlists (
        strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,
        research_only INTEGER NOT NULL DEFAULT 0 CHECK(research_only IN (0,1)),
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        PRIMARY KEY(strategy_id, symbol)
      );
      CREATE TABLE IF NOT EXISTS risk_events (
        id TEXT PRIMARY KEY,
        strategy_id TEXT REFERENCES strategies(id),
        severity TEXT NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        scope TEXT NOT NULL,
        proposal_json TEXT,
        metadata_json TEXT NOT NULL,
        acknowledged_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        strategy_id TEXT REFERENCES strategies(id),
        agent_type TEXT NOT NULL,
        request_id TEXT,
        symbol TEXT,
        action TEXT NOT NULL,
        confidence REAL,
        rationale TEXT NOT NULL,
        proposal_json TEXT,
        outcome_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS theses (
        id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL REFERENCES strategies(id),
        symbol TEXT NOT NULL,
        status TEXT NOT NULL,
        thesis TEXT NOT NULL,
        confidence REAL NOT NULL,
        invalidation_json TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS performance_snapshots (
        id TEXT PRIMARY KEY,
        strategy_id TEXT REFERENCES strategies(id),
        equity REAL NOT NULL,
        cash REAL NOT NULL,
        exposure REAL NOT NULL,
        realized_pnl REAL NOT NULL,
        unrealized_pnl REAL NOT NULL,
        drawdown_percent REAL NOT NULL,
        benchmark_value REAL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_performance_owner_time ON performance_snapshots(strategy_id, created_at);
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        details_json TEXT NOT NULL,
        ip_address TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_changes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        confirmed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        agent_type TEXT NOT NULL,
        strategy_id TEXT REFERENCES strategies(id),
        status TEXT NOT NULL,
        task TEXT NOT NULL,
        request_id TEXT NOT NULL UNIQUE,
        duration_ms INTEGER,
        error TEXT,
        metadata_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        priority INTEGER NOT NULL,
        status TEXT NOT NULL,
        dedupe_key TEXT,
        payload_json TEXT NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED','RUNNING');
      CREATE TABLE IF NOT EXISTS daily_briefs (
        id TEXT PRIMARY KEY,
        report_date TEXT NOT NULL UNIQUE,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trade_reviews (
        id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL REFERENCES strategies(id),
        symbol TEXT NOT NULL,
        thesis_id TEXT REFERENCES theses(id),
        entry_summary_json TEXT NOT NULL,
        exit_summary_json TEXT NOT NULL,
        realized_result REAL NOT NULL,
        followed_rules INTEGER NOT NULL,
        notes TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        read_at TEXT,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE orders ADD COLUMN sector TEXT NOT NULL DEFAULT 'Unknown';
      ALTER TABLE orders ADD COLUMN asset_type TEXT NOT NULL DEFAULT 'EQUITY';
    `,
  },
  { version: 3, sql: V2_SQL, run: migrateOwnership },
  { version: 4, sql: PREPRODUCTION_SQL },
  {version:5,sql:"",run:migrateExternalBasis},
];

interface StrategyRow {
  id: string; name: string; kind: StrategyKind; enabled: number; status: AgentStatus; allocation_amount: number;
  config_json: string; created_at: string; updated_at: string; cash: number; version: number; sleeve_kind: StrategyKind | null;
}

export class AppDatabase {
  readonly raw: Database.Database;

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path);
    this.raw.pragma('foreign_keys = ON');
    this.raw.pragma('busy_timeout = 5000');
    if (path !== ':memory:') this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('synchronous = NORMAL');
  }

  migrate(): void {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set((this.raw.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((row) => row.version));
    if (this.path !== ':memory:' && applied.size > 0 && MIGRATIONS.some(m => !applied.has(m.version))) {
      const directory = join(dirname(this.path), 'backups'); mkdirSync(directory, { recursive: true });
      const backup = join(directory, 'pre-migration-' + Date.now() + '.db');
      this.raw.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600);
    }
    const apply = this.raw.transaction((migration: { version: number; sql: string; run?: (db: Database.Database) => void }) => {
      this.raw.exec(migration.sql);
      migration.run?.(this.raw);
      this.raw.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(migration.version, nowIso());
    });
    for (const migration of MIGRATIONS) if (!applied.has(migration.version)) apply(migration);
  }

  seedFoundation(): void {
    const timestamp = nowIso();
    const setDefault = this.raw.prepare('INSERT OR IGNORE INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)');
    const defaults: Record<string, unknown> = {
      setup_complete: false,
      operating_mode: 'SIMULATION' satisfies OperatingMode,
      live_db_confirmation: false,
      global_pause: false,
      maintenance_mode: false,
      reconciliation_clear: true,
      designated_capital: 50_000,
      global_risk: EXAMPLE_GLOBAL_RISK,
      startup_ready: false,
      last_reconciliation_at: null,
      market_data_trading_eligible: false,
      codex_reasoning_enabled: false,
    };
    const seed = this.raw.transaction(() => {
      for (const [key, value] of Object.entries(defaults)) setDefault.run(key, JSON.stringify(value), timestamp);
      const rows: Array<{ id: string; name: string; kind: 'DAY_TRADER' | 'AGGRESSIVE_GROWTH' | 'LONG_TERM' }> = [
        { id: STRATEGY_IDS.safe, name: 'SAFE', kind: 'LONG_TERM' },
        { id: STRATEGY_IDS.aggressive, name: 'AGGRESSIVE', kind: 'AGGRESSIVE_GROWTH' },
        { id: STRATEGY_IDS.options, name: 'OPTIONS', kind: 'DAY_TRADER' },
      ];
      for (const row of rows) {
        const capital=this.getSetting<number>('designated_capital',50000),third=roundMoney(capital/3);
        const config = { ...EXAMPLE_STRATEGY_CONFIGS[row.kind], allocationAmount: row.id==='OPTIONS'?roundMoney(capital-2*third):third, allowedAssetTypes: row.id === 'OPTIONS' ? ['OPTION'] : ['EQUITY','ETF'] };
        this.raw.prepare(`INSERT OR IGNORE INTO strategies(id,name,kind,enabled,status,allocation_amount,config_json,created_at,updated_at,sleeve_kind) VALUES(?,?,?,?,?,?,?,?,?,?)`)
          .run(row.id, row.name, row.kind, 1, 'IDLE', config.allocationAmount, JSON.stringify(config), timestamp, timestamp,row.id);
        this.raw.prepare('INSERT OR IGNORE INTO strategy_cash(strategy_id,balance,updated_at) VALUES(?,?,?)').run(row.id, config.allocationAmount, timestamp);
        const hasVersion = this.raw.prepare('SELECT 1 FROM strategy_versions WHERE strategy_id=?').get(row.id);
        if (!hasVersion) {
          this.raw.prepare(`INSERT INTO strategy_versions(id,strategy_id,version,source,previous_json,new_json,diff_json,origin,reason,portfolio_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
            .run(makeId('sv'), row.id, 1, 'SYSTEM', '{}', JSON.stringify(config), JSON.stringify(config), 'INSTALL', 'EXAMPLE DEFAULTS created at installation; not investment recommendations.', '{}', timestamp);
        }
      }
      for (const sleeve of SLEEVES) this.raw.prepare('INSERT OR IGNORE INTO sleeve_policies VALUES(?,?,?)').run(sleeve,JSON.stringify(DEFAULT_POLICIES[sleeve]),timestamp);
    });
    seed();
  }

  getSetting<T>(key: string, fallback?: T): T {
    const row = this.raw.prepare('SELECT value_json FROM settings WHERE key=?').get(key) as { value_json: string } | undefined;
    if (!row) {
      if (fallback !== undefined) return fallback;
      throw new Error(`Missing setting: ${key}`);
    }
    return parseJson<T>(row.value_json);
  }

  setSetting(key: string, value: unknown): void {
    this.raw.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), nowIso());
  }

  getMode(): OperatingMode { return this.getSetting<OperatingMode>('operating_mode', 'SIMULATION'); }
  getGlobalRisk(): GlobalRiskConfig { return this.getSetting<GlobalRiskConfig>('global_risk', EXAMPLE_GLOBAL_RISK); }

  listStrategies(): Strategy[] {
    const rows = this.raw.prepare(`SELECT s.*, c.balance AS cash, COALESCE((SELECT MAX(version) FROM strategy_versions v WHERE v.strategy_id=s.id),1) AS version FROM strategies s JOIN strategy_cash c ON c.strategy_id=s.id WHERE s.archived=0 ORDER BY CASE s.sleeve_kind WHEN 'SAFE_LONG_TERM' THEN 1 WHEN 'AGGRESSIVE_STOCKS' THEN 2 ELSE 3 END`).all() as StrategyRow[];
    return rows.map((row) => this.mapStrategy(row));
  }

  getStrategy(id: string): Strategy | null {
    const row = this.raw.prepare(`SELECT s.*, c.balance AS cash, COALESCE((SELECT MAX(version) FROM strategy_versions v WHERE v.strategy_id=s.id),1) AS version FROM strategies s JOIN strategy_cash c ON c.strategy_id=s.id WHERE s.id=? AND s.archived=0`).get(id) as StrategyRow | undefined;
    return row ? this.mapStrategy(row) : null;
  }

  updateStrategy(id: string, config: StrategyConfig, source: string, origin: string, reason: string): Strategy {
    const current = this.getStrategy(id);
    if (!current) throw new Error('Strategy not found');
    if(config.allocationAmount!==current.allocationAmount&&source!=='SETUP')throw new Error('V2 allocation changes must use cash-conserving StrategyAllocationManager, not legacy capital creation');
    if(id!=='OPTIONS'&&config.allowedAssetTypes.some(a=>a!=='EQUITY'&&a!=='ETF'))throw new Error('Stock sleeves cannot enable options or crypto');
    if(id==='OPTIONS'&&config.allowedAssetTypes.some(a=>a!=='OPTION'))throw new Error('OPTIONS execution is single-leg Level 2 only');
    const version = current.version + 1;
    const timestamp = nowIso();
    const portfolio = this.raw.prepare('SELECT symbol,quantity,average_cost,market_price FROM strategy_positions WHERE strategy_id=?').all(id);
    this.raw.transaction(() => {
      this.raw.prepare('UPDATE strategies SET allocation_amount=?,config_json=?,updated_at=? WHERE id=?').run(config.allocationAmount, JSON.stringify(config), timestamp, id);
      const allocationDelta = config.allocationAmount - current.allocationAmount;
      if (allocationDelta !== 0) {
        if (current.cash + allocationDelta < -0.000001) throw new Error('Allocation cannot be reduced below invested capital');
        this.raw.prepare('UPDATE strategy_cash SET balance=balance+?,updated_at=? WHERE strategy_id=?').run(allocationDelta, timestamp, id);
        this.raw.prepare(`INSERT INTO virtual_transactions(id,idempotency_key,strategy_id,type,amount,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)`)
          .run(makeId('vtx'), `allocation:${id}:${version}`, id, 'ALLOCATION_CHANGE', allocationDelta, JSON.stringify({ from: current.allocationAmount, to: config.allocationAmount }), timestamp);
      }
      const previousRecord = current.config as unknown as Record<string, unknown>;
      const nextRecord = config as unknown as Record<string, unknown>;
      this.raw.prepare(`INSERT INTO strategy_versions(id,strategy_id,version,source,previous_json,new_json,diff_json,origin,reason,portfolio_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(makeId('sv'), id, version, source, JSON.stringify(current.config), JSON.stringify(config), JSON.stringify(diffRecords(previousRecord, nextRecord)), origin, reason, JSON.stringify(portfolio), timestamp);
      this.audit(origin, 'STRATEGY_UPDATED', 'strategy', id, { version, reason, diff: diffRecords(previousRecord, nextRecord) });
    })();
    return this.getStrategy(id) as Strategy;
  }

  revertStrategy(id: string, version: number, actor: string): Strategy {
    const row = this.raw.prepare('SELECT new_json FROM strategy_versions WHERE strategy_id=? AND version=?').get(id, version) as { new_json: string } | undefined;
    if (!row) throw new Error('Strategy version not found');
    return this.updateStrategy(id, parseJson<StrategyConfig>(row.new_json), 'REVERT', actor, `Reverted to strategy version ${version}`);
  }

  setStrategyEnabled(id: string, enabled: boolean, actor: string, reason: string): void {
    if(!this.getStrategy(id))throw new Error('Active strategy not found');
    if(enabled&&(this.raw.prepare('SELECT killed FROM strategy_capital WHERE strategy_id=?').get(id) as {killed:number}|undefined)?.killed)throw new Error('Latched emergency kill requires explicit weekly review/reset');
    const status: AgentStatus = enabled ? 'IDLE' : 'PAUSED';
    const result = this.raw.prepare('UPDATE strategies SET enabled=?,status=?,updated_at=? WHERE id=?').run(enabled ? 1 : 0, status, nowIso(), id);
    if (result.changes !== 1) throw new Error('Strategy not found');
    this.audit(actor, enabled ? 'STRATEGY_RESUMED' : 'STRATEGY_PAUSED', 'strategy', id, { reason });
  }

  audit(actor: string, action: string, entityType: string, entityId: string | null, details: unknown, ipAddress?: string): void {
    this.raw.prepare('INSERT INTO audit_events(id,actor,action,entity_type,entity_id,details_json,ip_address,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(makeId('audit'), actor, action, entityType, entityId, JSON.stringify(redact(details)), ipAddress ?? null, nowIso());
  }

  close(): void { this.raw.close(); }

  private mapStrategy(row: StrategyRow): Strategy {
    return {
      id: row.id, name: row.name, kind: row.sleeve_kind ?? row.kind, enabled: row.enabled === 1, status: row.status,
      allocationAmount: row.allocation_amount, cash: row.cash, config: parseJson<StrategyConfig>(row.config_json),
      version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
}

export function openDatabase(path: string): AppDatabase {
  const database = new AppDatabase(path);
  try{database.migrate();database.seedFoundation();return database;}catch(error){database.close();throw error;}
}
