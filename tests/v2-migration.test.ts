import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,it,expect} from 'vitest';
import {AppDatabase,MIGRATIONS,openDatabase} from '../packages/database/src/database.js';
import {EXAMPLE_STRATEGY_CONFIGS} from '../packages/core/src/types.js';
import {VirtualPortfolioLedger} from '../packages/ledger/src/virtual-ledger.js';
import {nowIso} from '../packages/core/src/utils.js';
const cleanup:Array<()=>void>=[];
afterEach(()=>{while(cleanup.length)cleanup.pop()?.();});
it('backs up V1 before atomically preserving and migrating active ownership',()=>{
  const dir=mkdtempSync(join(tmpdir(),'atm-v2-migrate-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'state.db');
  const old=new AppDatabase(path);old.raw.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
  for(const migration of MIGRATIONS.slice(0,2)){old.raw.exec(migration.sql);old.raw.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(migration.version,nowIso());}
  for(const [id,kind,cash] of [['day-trader','DAY_TRADER',100],['aggressive-growth','AGGRESSIVE_GROWTH',200],['long-term-investor','LONG_TERM',300]] as const){
    old.raw.prepare('INSERT INTO strategies VALUES(?,?,?,?,?,?,?,?,?)').run(id,id,kind,1,'IDLE',cash,JSON.stringify(EXAMPLE_STRATEGY_CONFIGS[kind]),nowIso(),nowIso());
    old.raw.prepare('INSERT INTO strategy_cash VALUES(?,?,?)').run(id,cash,nowIso());
    old.raw.prepare('INSERT INTO strategy_positions VALUES(?,?,?,?,?,?,?,?)').run(id,'TEST',1,10,12,'Test','EQUITY',nowIso());
    old.raw.prepare('INSERT INTO strategy_lots VALUES(?,?,?,?,?,?,?,?)').run('lot-'+id,id,'TEST',1,10,0,nowIso(),'historic-fill');
  }
  old.setSetting('operating_mode','LIVE');old.setSetting('live_db_confirmation',true);old.setSetting('global_pause',false);old.close();
  const db=openDatabase(path);cleanup.push(()=>db.close());const ledger=new VirtualPortfolioLedger(db);
  expect(db.listStrategies().map(s=>s.id)).toEqual(['SAFE_LONG_TERM','AGGRESSIVE_STOCKS','OPTIONS']);
  expect(ledger.getCash('AGGRESSIVE_STOCKS')).toBe(300);expect(ledger.getPosition('AGGRESSIVE_STOCKS','TEST')?.quantity).toBe(2);
  expect(ledger.getCash('SAFE_LONG_TERM')).toBe(300);expect(ledger.getPosition('SAFE_LONG_TERM','TEST')?.quantity).toBe(1);expect(ledger.getCash('OPTIONS')).toBe(0);
  expect(db.getMode()).toBe('READ_ONLY');expect(db.getSetting('global_pause')).toBe(true);expect(db.getSetting('live_db_confirmation')).toBe(false);
  expect(db.raw.prepare('SELECT * FROM strategies WHERE archived=1').all()).toHaveLength(3);expect(db.raw.prepare('SELECT * FROM migration_archive WHERE table_name=?').all('strategy_positions')).toHaveLength(3);
  expect(readdirSync(join(dir,'backups'))).toHaveLength(1);expect(db.raw.pragma('foreign_key_check')).toEqual([]);
  db.migrate();expect(readdirSync(join(dir,'backups'))).toHaveLength(1);
});
it('migration failure rolls back schema and does not enable execution',()=>{
  const db=new AppDatabase(':memory:');cleanup.push(()=>db.close());db.raw.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
  for(const migration of MIGRATIONS.slice(0,2)){db.raw.exec(migration.sql);db.raw.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(migration.version,nowIso());}
  db.raw.prepare('INSERT INTO strategies VALUES(?,?,?,?,?,?,?,?,?)').run('bad','bad','DAY_TRADER',1,'IDLE',1,'{}',nowIso(),nowIso()); // Missing cash is an inconsistent legacy ledger.
  expect(()=>db.migrate()).toThrow();expect((db.raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {v:number}).v).toBe(2);
  expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE name='proposals'").get()).toBeUndefined();
});
