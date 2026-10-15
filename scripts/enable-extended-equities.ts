import {join} from 'node:path';
import {openDatabase} from '../packages/database/src/database.js';
import {enableExtendedEquities} from '../packages/trading-v2/src/extended-equity-config.js';
const db=openDatabase(join(process.env.DATA_DIR??'data','agentic-trading-manager.db'));
try{
  enableExtendedEquities(db);
  console.log(JSON.stringify({extendedEquities:true,optionsRegularSessionOnly:true}));
}finally{db.close();}
