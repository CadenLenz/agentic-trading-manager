import {nowIso} from '../../core/src/utils.js';
import type {ProposalService} from './proposals.js';
import {SLEEVES,type Sleeve,type ProposalInput} from './model.js';

/** Builds owned-position CLOSE drafts only. No research, preview, approval or placement is fabricated. */
export function prepareEmergencyCloses(service:ProposalService,strategy:Sleeve|null,actor:string,reason:string){
  return service.db.raw.transaction(()=>{
  const drafts=[];
  const base={schemaVersion:2 as const,positionEffect:'CLOSE' as const,orderType:'LIMIT' as const,dollarAmount:null,stopPrice:null,timeInForce:'DAY' as const,marketHours:'REGULAR' as const,createdAt:nowIso(),expiresAt:new Date(Date.now()+900000).toISOString(),researchSummary:'Operator emergency risk-reduction request; research checklist has not yet been supplied.',thesis:reason,catalyst:'Operator emergency control',technicalSetup:'Not evaluated',fundamentalContext:'Not evaluated',riskFactors:['Stale marks are not executable quotes. Fresh risk review and broker preview remain mandatory.'],invalidation:'Ownership discrepancy or unverifiable broker outcome',expectedHoldingPeriod:'Close existing owned risk only',holdingTradingDays:0,exitPlan:'Manual approval of each reviewed current proposal; no execution by this control.'};
  for(const sleeve of strategy?[strategy]:SLEEVES){const state=service.allocation.state(sleeve);
    for(const p of state.positions)drafts.push(service.create({...base,strategy:sleeve,assetClass:p.assetType==='ETF'?'ETF':'EQUITY',symbol:p.symbol,underlying:null,side:'SELL',quantity:p.quantity,limitPrice:p.marketPrice,option:null},actor));
    for(const p of state.options){const i=JSON.parse(p.instrument_json) as {underlying:string;type:'CALL'|'PUT';strike:number;expiration:string;optionId:string};if(p.mark_price<=0)throw new Error('Zero-mark/expired contracts require verified lifecycle events, not invented close prices');
      const type=p.contracts>0?(i.type==='CALL'?'LONG_CALL':'LONG_PUT'):(i.type==='CALL'?'COVERED_CALL':'CASH_SECURED_PUT');
      drafts.push(service.create({...base,strategy:sleeve,assetClass:'OPTION',symbol:i.underlying,underlying:i.underlying,side:p.contracts>0?'SELL':'BUY',quantity:Math.abs(p.contracts),limitPrice:p.mark_price,option:{...i,optionId:p.option_id,contracts:Math.abs(p.contracts),strategy:type,maxLoss:0,collateralRequired:0,estimatedPremium:0}} satisfies ProposalInput,actor));
    }
  }
  service.db.audit(actor,'EMERGENCY_CLOSE_DRAFTS','system',null,{strategy,reason,proposalIds:drafts.map(p=>p.id),ordersPlaced:0});return {drafts,ordersPlaced:0,requiresResearchRiskPreviewAndManualApproval:true};
  })();
}
