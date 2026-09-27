import {describe,it,expect} from 'vitest';
import {openDatabase} from '../packages/database/src/database.js';
import {enforceSafeStartup} from '../packages/trading-v2/src/safe-startup.js';
import {SLEEVES} from '../packages/trading-v2/src/model.js';
describe('Unattended startup',()=>{
  it.each(['LIVE','READ_ONLY'])('revokes trading authority from %s regardless of saved configuration',mode=>{
    const db=openDatabase(':memory:');
    try{
      db.setSetting('operating_mode',mode);db.setSetting('global_pause',false);db.setSetting('v2_live_activation',true);db.setSetting('live_db_confirmation',true);db.setSetting('reconciliation_clear',true);
      for(const id of SLEEVES){const row=db.raw.prepare('SELECT config_json FROM sleeve_policies WHERE strategy_id=?').get(id) as {config_json:string};const p=JSON.parse(row.config_json);p.executionPolicy='AUTONOMOUS_RISK_APPROVED';db.raw.prepare('UPDATE sleeve_policies SET config_json=? WHERE strategy_id=?').run(JSON.stringify(p),id);db.setStrategyEnabled(id,true,'TEST','Test fixture');}
      enforceSafeStartup(db);
      expect(db.getMode()).toBe('READ_ONLY');expect(db.getSetting('global_pause',false)).toBe(true);expect(db.getSetting('v2_live_activation',true)).toBe(false);expect(db.getSetting('live_db_confirmation',true)).toBe(false);expect(db.getSetting('reconciliation_clear',true)).toBe(false);
      for(const id of SLEEVES){expect(db.getStrategy(id)?.enabled).toBe(false);const row=db.raw.prepare('SELECT config_json FROM sleeve_policies WHERE strategy_id=?').get(id) as {config_json:string};expect(JSON.parse(row.config_json).executionPolicy).toBe('MANUAL_APPROVAL');}
    }finally{db.close();}
  });
  it('does not disturb an isolated simulation',()=>{const db=openDatabase(':memory:');try{db.setSetting('operating_mode','SIMULATION');db.setSetting('global_pause',false);enforceSafeStartup(db);expect(db.getMode()).toBe('SIMULATION');expect(db.getSetting('global_pause',true)).toBe(false);}finally{db.close();}});
});
