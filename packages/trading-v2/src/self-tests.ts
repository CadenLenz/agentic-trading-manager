import {openDatabase} from '../../database/src/database.js';
import {VirtualPortfolioLedger} from '../../ledger/src/virtual-ledger.js';
import {SimulationMarketDataProvider} from '../../market-data/src/provider.js';
import {StrategyAllocationManager} from './capital.js';
import {SimulationTradingBroker} from './broker.js';
import {ProposalService} from './proposals.js';
import {RESEARCH_REQUIRED,type ProposalInput} from './model.js';
import {nowIso} from '../../core/src/utils.js';
export function exampleProposal():ProposalInput {
  return {schemaVersion:2,strategy:'AGGRESSIVE_STOCKS',assetClass:'EQUITY',symbol:'RKLB',underlying:null,side:'BUY',positionEffect:'OPEN',orderType:'LIMIT',quantity:1,dollarAmount:null,limitPrice:60,stopPrice:null,timeInForce:'DAY',marketHours:'REGULAR',createdAt:nowIso(),expiresAt:new Date(Date.now()+600000).toISOString(),option:null,researchSummary:'Synthetic isolated lifecycle acceptance fixture.',thesis:'Simulation only; never send to a real broker.',catalyst:'Synthetic fixture',technicalSetup:'Synthetic trend',fundamentalContext:'Not real research',riskFactors:['Simulation data only'],invalidation:'Any unsupported fact',expectedHoldingPeriod:'One simulated session',holdingTradingDays:1,exitPlan:'Close simulated ownership via a new validated proposal.'};
}
export async function runSelfTests(){
  const db=openDatabase(':memory:'),ledger=new VirtualPortfolioLedger(db),allocation=new StrategyAllocationManager(db,ledger),broker=new SimulationTradingBroker(db,ledger,new SimulationMarketDataProvider()),service=new ProposalService(db,ledger,allocation,()=>broker);
  const checks:Array<{name:string;passed:boolean}>=[];
  const assert=(name:string,passed:boolean)=>{checks.push({name,passed});if(!passed)throw new Error('Self-test failed: '+name);};
  try{
    await service.reconcile();
    const p=service.create(exampleProposal(),'SELF_TEST');
    let refused=false;try{await service.execute(p.id,'SELF_TEST');}catch{refused=true;}assert('DRAFT cannot execute',refused);
    service.research(p.id,{simulated:true,items:RESEARCH_REQUIRED[p.strategy].map(category=>({category,summary:'Synthetic evidence for isolated simulation testing only.',sources:['https://example.com/simulation-fixture'],observedAt:nowIso()}))},'SELF_TEST');
    await service.review(p.id,'SELF_TEST');assert('Risk and preview lead to READY',service.get(p.id).state==='READY_TO_EXECUTE');
    refused=false;try{await service.execute(p.id,'SELF_TEST');}catch{refused=true;}assert('Manual policy requires approval',refused);
    service.approve(p.id,1,'SELF_TEST');await service.execute(p.id,'SELF_TEST');assert('Simulation lifecycle FILLED',service.get(p.id).state==='FILLED');
    const cash=ledger.getCash(p.strategy);await service.execute(p.id,'SELF_TEST');assert('Execution replay is idempotent',ledger.getCash(p.strategy)===cash);
    db.setSetting('global_pause',true);const other=service.create(exampleProposal(),'SELF_TEST');assert('Global pause blocks risk',!(await service.risk(other.id)).approved);
    return {ok:true,checks,simulated:true,brokerCalls:'synthetic only'};
  }catch(error){return {ok:false,checks,error:error instanceof Error?error.message:'Self-test failure',simulated:true};}finally{db.close();}
}
