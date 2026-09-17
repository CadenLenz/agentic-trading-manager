import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../packages/database/src/database.js';
import {FullSystemSimulation} from '../packages/trading-v2/src/system-simulation.js';
const directory=mkdtempSync(join(tmpdir(),'atm-system-test-')),db=openDatabase(join(directory,'test-runs.db'));
try{const run=await new FullSystemSimulation(db,join(directory,'isolated-portfolios')).runNow();writeFileSync(join(directory,'simulation-report.json'),JSON.stringify(run,null,2),{mode:0o600});console.log(JSON.stringify({id:run.id,status:run.status,passed:run.result?.passed,failed:run.result?.failed,failures:run.result?.assertions?.filter((a:{passed:boolean})=>!a.passed),liveBrokerCalls:run.result?.liveBrokerCalls,externalRequests:run.result?.externalRequests,artifacts:directory},null,2));if(run.status!=='PASSED')process.exitCode=1;}finally{db.close();}
