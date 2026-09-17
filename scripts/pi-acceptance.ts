import {resolve,join} from 'node:path';
import {existsSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {openDatabase} from '../packages/database/src/database.js';
import {PiAcceptanceService} from '../packages/trading-v2/src/pi-acceptance.js';
if(existsSync('.env'))loadEnvFile('.env');
const directory=resolve(process.env.DATA_DIR??'./data'),db=openDatabase(join(directory,'agentic-trading-manager.db'));
try{const result=await new PiAcceptanceService(db,join(directory,'acceptance-backups')).run();console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}finally{db.close();}
