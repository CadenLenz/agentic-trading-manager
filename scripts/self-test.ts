import {runSelfTests} from '../packages/trading-v2/src/self-tests.js';
const result=await runSelfTests();process.stdout.write(JSON.stringify(result,null,2)+'\n');if(!result.ok)process.exitCode=1;
