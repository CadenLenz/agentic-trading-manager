import {resolve} from 'node:path';
import {openDatabase} from '../packages/database/src/database.js';
import {SLEEVES} from '../packages/trading-v2/src/model.js';
const db=openDatabase(resolve(process.env.DATA_DIR??'./data','agentic-trading-manager.db'));
try{
  db.raw.transaction(()=>{
    db.setSetting('operating_mode','READ_ONLY');db.setSetting('global_pause',true);db.setSetting('live_db_confirmation',false);db.setSetting('v2_live_activation',false);
    db.setSetting('v2_migration_review_required',true);db.setSetting('self_tests_v2',false);db.setSetting('simulated_lifecycle_v2',false);
    for(const s of SLEEVES){db.setStrategyEnabled(s,false,'UPGRADE','Upgrade requires explicit ownership and risk review');const row=db.raw.prepare('SELECT config_json FROM sleeve_policies WHERE strategy_id=?').get(s) as {config_json:string};const config=JSON.parse(row.config_json);config.executionPolicy='MANUAL_APPROVAL';db.raw.prepare('UPDATE sleeve_policies SET config_json=? WHERE strategy_id=?').run(JSON.stringify(config),s);}
    db.audit('UPGRADE','SAFE_UPGRADE_POSTURE','system',null,{mode:'READ_ONLY',paused:true,autonomy:'MANUAL_APPROVAL'});
  })();
  process.stdout.write('Upgrade safety posture saved: Read Only, paused, manual approvals, LIVE revoked.\n');
}finally{db.close();}
