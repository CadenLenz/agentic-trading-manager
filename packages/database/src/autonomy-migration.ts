import type Database from 'better-sqlite3';

/** Imported holdings have verified quantity but no inferred strategy history. */
export function migrateAutonomyAccounting(db:Database.Database){
  db.exec(`CREATE TABLE legacy_positions (
    symbol TEXT PRIMARY KEY, quantity REAL NOT NULL CHECK(quantity>0), average_cost REAL,
    market_price REAL NOT NULL CHECK(market_price>0), asset_type TEXT NOT NULL,
    account_id TEXT NOT NULL, opening_reference TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
  for(const [table,column] of [['realized_pnl','amount'],['trade_reviews','realized_result'],['performance_snapshots','realized_pnl'],['strategy_snapshots','realized']]){
    const row=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {sql:string};
    const indexes=db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(table) as Array<{sql:string}>;
    const sql=row.sql.replace(new RegExp('CREATE TABLE(?: IF NOT EXISTS)?\\s+["`\\[]?'+table+'["`\\]]?','i'),'CREATE TABLE '+table+'_autonomy_upgrade').replace(new RegExp(column+' REAL NOT NULL','i'),column+' REAL');
    db.exec(sql);db.exec(`INSERT INTO ${table}_autonomy_upgrade SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_autonomy_upgrade RENAME TO ${table};`);
    for(const index of indexes)db.exec(index.sql);
  }
}
