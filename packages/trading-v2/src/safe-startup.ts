import type {AppDatabase} from '../../database/src/database.js';
import {SLEEVES} from './model.js';

/** An unattended restart never restores permission to trade real money. */
export function enforceSafeStartup(db:AppDatabase){
  if(db.getMode()==='SIMULATION')return;
  db.raw.transaction(()=>{
    db.setSetting('operating_mode','READ_ONLY');
    db.setSetting('global_pause',true);
    db.setSetting('v2_live_activation',false);
    db.setSetting('live_db_confirmation',false);
    db.setSetting('reconciliation_clear',false);
    for(const strategy of SLEEVES){
      db.setStrategyEnabled(strategy,false,'STARTUP','Restart requires explicit operator review');
      const row=db.raw.prepare('SELECT config_json FROM sleeve_policies WHERE strategy_id=?').get(strategy) as {config_json:string};
      const policy=JSON.parse(row.config_json);policy.executionPolicy='MANUAL_APPROVAL';
      db.raw.prepare('UPDATE sleeve_policies SET config_json=? WHERE strategy_id=?').run(JSON.stringify(policy),strategy);
    }
    db.audit('STARTUP','SAFE_STARTUP_POSTURE','system',null,{mode:'READ_ONLY',paused:true,executionPolicy:'MANUAL_APPROVAL'});
  })();
}
