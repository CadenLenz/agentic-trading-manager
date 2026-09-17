import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppDatabase } from '../../database/src/database.js';
import { nowIso } from '../../core/src/utils.js';
import { DEFAULT_ACCOUNT_POLICY, SLEEVES, sleeveSchema, type Sleeve } from './model.js';
import {VirtualPortfolioLedger} from '../../ledger/src/virtual-ledger.js';
import {StrategyAllocationManager} from './capital.js';

const pct=z.number().min(0).max(100), money=z.number().finite().nonnegative(), count=z.number().int().nonnegative(), age=z.number().int().min(1).max(86400);
const symbols=z.array(z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/)).max(1000);
export const riskSettingsSchema=z.object({
  tradingEnabled:z.boolean(), minimumCashReserve:money, maxGrossExposurePercent:pct, maxNetExposurePercent:pct,
  maxDailyRealizedLoss:money, maxTotalDailyLoss:money, maxWeeklyLoss:money, maxOrderNotional:money,
  maxPositions:count, maxPendingOrders:count, maxOrdersPerDay:count, maxOrdersPerMinute:count,
  maxQuoteAgeSeconds:age, maxPortfolioAgeSeconds:age, maxProposalAgeSeconds:age, maxReconciliationAgeSeconds:age,
  maxResearchAgeHours:z.number().positive().max(168), lossCooldownMinutes:count, maxConsecutiveLosses:count,
  allowedMarketSessions:z.array(z.enum(['REGULAR','EXTENDED'])).min(1), extendedHoursAllowed:z.boolean(), fractionalTradingAllowed:z.boolean(),
  allocationTolerancePercent:pct, emergencyDrawdownPercent:z.literal(60), normalDrawdownPercent:pct,
  maxPositionPercent:pct, perTradeRiskPercent:pct, maxNewPositionsPerDay:count, maxDailySleeveLoss:money,
  allowedSymbols:symbols, blockedSymbols:symbols, etfAllowed:z.boolean(), equitiesAllowed:z.boolean(),
  minEquityPrice:money, minMarketCap:money, minVolume:money, minRelativeVolume:money,
  maxSpreadPercent:pct, maxAtrPercent:pct.nullable(), maxValuationPE:money.nullable(), minSetupScore:z.number().min(0).max(100),
  maxHoldingTradingDays:count, overnightAllowed:z.boolean(), earningsTradingAllowed:z.boolean(), catalystRequired:z.boolean(),
  exitMethod:z.enum(['THESIS','ATR','PERCENT','MANUAL']), stopPercent:pct, takeProfitPercent:pct,
  executionPolicy:z.enum(['MANUAL_APPROVAL','AUTONOMOUS_RISK_APPROVED']),
  maxPremiumRiskPercent:pct, maxSleeveCapitalPerTradePercent:pct, maxContracts:count, maxConcurrentOptions:count,
  allowedOptionStrategies:z.array(z.enum(['LONG_CALL','LONG_PUT','COVERED_CALL','CASH_SECURED_PUT'])).min(1),
  minDTE:count,maxDTE:count,minDelta:z.number().min(-1).max(1).nullable(),maxDelta:z.number().min(-1).max(1).nullable(),
  minOpenInterest:count,minOptionVolume:count,maxOptionSpreadPercent:pct,minIV:money.nullable(),maxIV:money.nullable(),
  expirationDayAllowed:z.boolean(), minUnderlyingVolume:money,maxThetaExposure:money.nullable(),maxVegaExposure:money.nullable(),
  maxTotalPremiumAtRisk:money,maxCollateral:money, coveredCallMinimumShares:z.literal(100),cspFullCollateral:z.literal(true),
  longCallsAllowed:z.boolean(),longPutsAllowed:z.boolean(),assignmentReviewRequired:z.boolean(),
  emergencyStopBehavior:z.literal('BLOCK_AND_REVOKE_LIVE'), minimumBrokerHealth:z.literal('HEALTHY'),
}).strict();
export type RiskSettings=z.infer<typeof riskSettingsSchema>;
const overrides=riskSettingsSchema.partial();
export const riskConfigurationSchema=z.object({schemaVersion:z.literal(1),global:riskSettingsSchema,
  strategies:z.object({SAFE_LONG_TERM:overrides,AGGRESSIVE_STOCKS:overrides,OPTIONS:overrides}).strict(),
  assetClasses:z.object({EQUITY:overrides,ETF:overrides,OPTION:overrides}).strict(),
  symbols:z.record(z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/),overrides),
}).strict();
export type RiskConfiguration=z.infer<typeof riskConfigurationSchema>;
export const DEFAULT_RISK:RiskConfiguration={schemaVersion:1,global:{
  ...DEFAULT_ACCOUNT_POLICY, tradingEnabled:true,maxNetExposurePercent:90,maxWeeklyLoss:100,maxPendingOrders:8,
  maxPortfolioAgeSeconds:60,maxReconciliationAgeSeconds:120,maxConsecutiveLosses:3,allowedMarketSessions:['REGULAR'],
  extendedHoursAllowed:false,fractionalTradingAllowed:false,allocationTolerancePercent:5,emergencyDrawdownPercent:60,normalDrawdownPercent:10,
  maxPositionPercent:25,perTradeRiskPercent:25,maxNewPositionsPerDay:5,maxDailySleeveLoss:25,
  allowedSymbols:[],blockedSymbols:[],etfAllowed:true,equitiesAllowed:true,minEquityPrice:5,minMarketCap:0,minVolume:100000,
  minRelativeVolume:0,maxSpreadPercent:1,maxAtrPercent:null,maxValuationPE:null,minSetupScore:0,maxHoldingTradingDays:10,
  overnightAllowed:true,earningsTradingAllowed:false,catalystRequired:false,exitMethod:'MANUAL',stopPercent:5,takeProfitPercent:10,
  executionPolicy:'MANUAL_APPROVAL',maxPremiumRiskPercent:5,maxSleeveCapitalPerTradePercent:25,maxContracts:3,maxConcurrentOptions:5,
  allowedOptionStrategies:['LONG_CALL','LONG_PUT','COVERED_CALL','CASH_SECURED_PUT'],minDTE:7,maxDTE:365,minDelta:null,maxDelta:null,
  minOpenInterest:100,minOptionVolume:10,maxOptionSpreadPercent:15,minIV:null,maxIV:null,expirationDayAllowed:false,
  minUnderlyingVolume:100000,maxThetaExposure:null,maxVegaExposure:null,maxTotalPremiumAtRisk:1000,maxCollateral:10000,
  coveredCallMinimumShares:100,cspFullCollateral:true,longCallsAllowed:true,longPutsAllowed:true,assignmentReviewRequired:true,
  emergencyStopBehavior:'BLOCK_AND_REVOKE_LIVE',minimumBrokerHealth:'HEALTHY',
} as RiskSettings,strategies:{SAFE_LONG_TERM:{maxPositionPercent:20,normalDrawdownPercent:15,maxHoldingTradingDays:0,minVolume:100000},AGGRESSIVE_STOCKS:{minVolume:500000,maxSpreadPercent:.75},OPTIONS:{minVolume:100,maxSpreadPercent:15}},assetClasses:{EQUITY:{},ETF:{},OPTION:{}},symbols:{}};
// Strip legacy immutable fields which are intentionally not editable through this model.
DEFAULT_RISK.global=riskSettingsSchema.parse(Object.fromEntries(Object.entries(DEFAULT_RISK.global).filter(([k])=>Object.hasOwn(riskSettingsSchema.shape,k))));
export const configHash=(c:unknown)=>createHash('sha256').update(JSON.stringify(c)).digest('hex');
export function configurationEvidenceSnapshot(db:AppDatabase){return {risk:new RiskConfigurationService(db).current().config,legacyRisk:db.getGlobalRisk(),accountPolicy:db.getSetting('account_policy_v2',DEFAULT_ACCOUNT_POLICY),strategies:db.listStrategies().map(s=>({id:s.id,config:s.config,enabled:s.enabled})),sleeves:db.raw.prepare('SELECT strategy_id,config_json FROM sleeve_policies ORDER BY strategy_id').all()};}
export function configurationEvidenceHash(db:AppDatabase){return configHash(configurationEvidenceSnapshot(db));}
export function resolveRisk(c:RiskConfiguration,strategy:Sleeve,asset:'EQUITY'|'ETF'|'OPTION',symbol:string):RiskSettings{
  return riskSettingsSchema.parse({...c.global,...c.strategies[strategy],...c.assetClasses[asset],...c.symbols[symbol]});
}
function changes(a:unknown,b:unknown,prefix=''):Array<{key:string;before:unknown;after:unknown}>{
  if(JSON.stringify(a)===JSON.stringify(b))return [];
  if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b))return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(k=>changes((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k],prefix?prefix+'.'+k:k));
  return [{key:prefix,before:a??null,after:b??null}];
}
export class RiskConfigurationService{
  constructor(readonly db:AppDatabase){}
  current(){const r=this.db.raw.prepare('SELECT version,body_json FROM risk_config_versions ORDER BY version DESC LIMIT 1').get() as {version:number;body_json:string}|undefined;return {version:r?.version??0,config:r?riskConfigurationSchema.parse(JSON.parse(r.body_json)):structuredClone(DEFAULT_RISK)};}
  validate(input:unknown){const c=riskConfigurationSchema.parse(input);for(const s of SLEEVES)for(const a of ['EQUITY','ETF','OPTION'] as const)for(const symbol of ['DEFAULT',...Object.keys(c.symbols)]){const r=resolveRisk(c,s,a,symbol);if(r.minDTE>r.maxDTE||r.minDelta!==null&&r.maxDelta!==null&&r.minDelta>r.maxDelta||r.minIV!==null&&r.maxIV!==null&&r.minIV>r.maxIV||r.normalDrawdownPercent>60)throw new Error('Inconsistent inherited risk ranges');}return c;}
  effective(strategy:Sleeve,asset:'EQUITY'|'ETF'|'OPTION',symbol:string){return resolveRisk(this.current().config,strategy,asset,symbol);}
  preview(input:unknown){const current=this.current(),config=this.validate(input),allocation=new StrategyAllocationManager(this.db,new VirtualPortfolioLedger(this.db));return {expectedVersion:current.version,config,diff:changes(current.config,config),impacts:SLEEVES.map(strategy=>{const r=resolveRisk(config,strategy,strategy==='OPTIONS'?'OPTION':'EQUITY','DEFAULT'),equity=allocation.state(strategy).currentEquity;return {strategy,currentSleeveEquity:equity,maxPositionPercent:r.maxPositionPercent,maxPositionDollars:equity*r.maxPositionPercent/100,premiumRiskPercent:r.maxPremiumRiskPercent,premiumRiskDollars:equity*r.maxPremiumRiskPercent/100};})};}
  apply(input:unknown,expectedVersion:number,actor:string,reason:string,confirmation:string,context:{instruction?:string;interpretation?:string;sessionId?:string}={}){
    if(confirmation!=='APPLY RISK CONFIGURATION'||reason.length<20)throw new Error('Exact confirmation and 20-character review required');
    const previous=this.current();if(previous.version!==expectedVersion)throw new Error('Configuration changed; review a fresh diff');
    const c=this.validate(input),diff=changes(previous.config,c),version=previous.version+1;
    this.db.raw.transaction(()=>{this.db.raw.prepare('INSERT INTO risk_config_versions VALUES(?,?,?,?,?,?,?,?,?,?)').run(version,JSON.stringify(c),JSON.stringify(previous.config),JSON.stringify(diff),actor,context.instruction??reason,context.interpretation??reason,reason,context.sessionId??null,nowIso());
      const allocation=new StrategyAllocationManager(this.db,new VirtualPortfolioLedger(this.db));
      for(const strategy of SLEEVES){const old=resolveRisk(previous.config,strategy,strategy==='OPTIONS'?'OPTION':'EQUITY','DEFAULT'),r=resolveRisk(c,strategy,strategy==='OPTIONS'?'OPTION':'EQUITY','DEFAULT'),p=allocation.policy(strategy);
        if(old.executionPolicy!==r.executionPolicy)p.executionPolicy=r.executionPolicy;
        if(old.allocationTolerancePercent!==r.allocationTolerancePercent)p.tolerancePercent=r.allocationTolerancePercent;
        allocation.updatePolicy(strategy,p,actor);
      }
      this.db.setSetting('full_simulation_evidence',null);this.db.setSetting('readiness_stage','DEVELOPMENT');
      this.db.audit(actor,'RISK_CONFIGURATION_CHANGED','risk_config',String(version),{before:previous.config,after:c,changedKeys:diff.map(d=>d.key),reason,...context});
    })();return {version,config:c,diff};
  }
  rollback(version:number,actor:string,reason:string,confirmation:string){if(version===0)return this.apply(structuredClone(DEFAULT_RISK),this.current().version,actor,reason,confirmation);const r=this.db.raw.prepare('SELECT body_json FROM risk_config_versions WHERE version=?').get(version) as {body_json:string}|undefined;if(!r)throw new Error('Configuration version not found');return this.apply(JSON.parse(r.body_json),this.current().version,actor,reason,confirmation);}
  history(){return this.db.raw.prepare('SELECT * FROM risk_config_versions ORDER BY version DESC LIMIT 100').all();}
  descriptors(){return Object.entries(riskSettingsSchema.shape).map(([key,schema])=>{const json=z.toJSONSchema(schema),planning=['exitMethod','stopPercent','takeProfitPercent'].includes(key);return {key,dataType:json.type??'enum',validRange:{min:json.minimum??null,max:json.maximum??null,enum:json.enum??(Object.hasOwn(json,'const')?[json.const]:null)},default:DEFAULT_RISK.global[key as keyof RiskSettings],scope:['GLOBAL','STRATEGY','ASSET_CLASS','SYMBOL'],enforcement:planning?'STORED_EXIT_POLICY':'DETERMINISTIC',explanation:key.replace(/([A-Z])/g,' $1').toLowerCase()+(planning?'. Stored exit-planning policy. No automatic ATR/thesis/percent protective-order monitor is commissioned; exits need a separately validated proposal.':'. Applied deterministically; missing required trusted facts fail closed. Legacy limits remain additional caps.'),requiresConfirmation:true,requiresRecalculation:true};});}
  propose(changes:RiskEdit[],actor:string,context:{reason:string;instruction:string;interpretation:string;sessionId:string}){
    const preview=this.previewEdits(changes),id='risk-change-'+crypto.randomUUID();this.db.raw.prepare('INSERT INTO pending_changes(id,type,status,payload_json,requested_by,reason,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(id,'RISK_CONFIGURATION','PENDING',JSON.stringify({...preview,...context}),actor,context.reason,nowIso(),new Date(Date.now()+900000).toISOString());return {pendingChangeId:id,requiresOperatorConfirmation:true,...preview};
  }
  previewEdits(changes:RiskEdit[]){
    const current=this.current();for(const edit of changes){const target=edit.scope==='GLOBAL'?current.config.global:edit.scope==='STRATEGY'?current.config.strategies[sleeveSchema.parse(edit.strategy)]:edit.scope==='ASSET_CLASS'?current.config.assetClasses[z.enum(['EQUITY','ETF','OPTION']).parse(edit.assetClass)]:current.config.symbols[edit.symbol??'']??(current.config.symbols[edit.symbol??'']={});
      if(edit.scope==='SYMBOL'&&!/^[A-Z][A-Z0-9.-]{0,9}$/.test(edit.symbol??''))throw new Error('Symbol override target invalid');(target as Record<string,unknown>)[edit.key]=JSON.parse(edit.valueJson);}
    return this.preview(current.config);
  }
}
export const riskEditSchema=z.object({scope:z.enum(['GLOBAL','STRATEGY','ASSET_CLASS','SYMBOL']),strategy:sleeveSchema.nullable(),assetClass:z.enum(['EQUITY','ETF','OPTION']).nullable(),symbol:z.string().nullable(),key:z.enum(Object.keys(riskSettingsSchema.shape) as [keyof RiskSettings,...Array<keyof RiskSettings>]),valueJson:z.string().min(1).max(5000)}).strict();
export type RiskEdit=z.infer<typeof riskEditSchema>;
export const strategyOverrideSchema=z.object({strategy:sleeveSchema,settings:overrides,reason:z.string().min(20)}).strict();
