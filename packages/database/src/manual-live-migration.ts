import type Database from 'better-sqlite3';

/** Preserve records and indexes while allowing genuinely unavailable external basis. */
export function migrateExternalBasis(db:Database.Database){
  for(const [table,column] of [['strategy_positions','average_cost'],['strategy_lots','entry_price'],['strategy_snapshots','unrealized'],['position_snapshots','unrealized'],['performance_snapshots','unrealized_pnl']]){
    const row=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {sql:string};
    const indexes=db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(table) as Array<{sql:string}>;
    const sql=row.sql.replace(new RegExp('CREATE TABLE(?: IF NOT EXISTS)? '+table,'i'),'CREATE TABLE '+table+'_basis_upgrade').replace(new RegExp(column+' REAL NOT NULL','i'),column+' REAL');
    db.exec(sql);db.exec(`INSERT INTO ${table}_basis_upgrade SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_basis_upgrade RENAME TO ${table};`);
    for(const index of indexes)db.exec(index.sql);
  }
}
