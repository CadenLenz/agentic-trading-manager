import { createHash } from 'node:crypto';
import type { AppDatabase } from '../../database/src/database.js';
import type { VirtualPortfolioLedger } from '../../ledger/src/virtual-ledger.js';
import { makeId, nowIso, roundMoney } from '../../core/src/utils.js';
import { StrategyAllocationManager } from './capital.js';
import {RiskConfigurationService} from './configuration.js';
import {pacificPeriodStart} from './periods.js';
import {BrokerBasisUnavailable} from './worker-broker.js';
import { DEFAULT_ACCOUNT_POLICY, accountPolicySchema, proposalSchema, researchSchema, RESEARCH_REQUIRED, SLEEVES, type Proposal, type ProposalState, type TradingBroker, type ExecutableOrder, type BrokerFill, type AgentMode } from './model.js';

interface Row {id:string;version:number;state:ProposalState;body_json:string;research_json:string|null;preview_json:string|null;preview_hash:string|null;approval_json:string|null;order_id:string|null}
export const TRANSITIONS:Partial<Record<ProposalState,ProposalState[]>>={
  DRAFT:['RESEARCHED','CANCELLED'], RESEARCHED:['SUBMITTED_TO_RISK','DRAFT','CANCELLED'],
  SUBMITTED_TO_RISK:['RISK_REJECTED','RISK_APPROVED','FAILED'],RISK_REJECTED:['DRAFT','SUBMITTED_TO_RISK','CANCELLED'],
  RISK_APPROVED:['BROKER_PREVIEWED','FAILED','CANCELLED'],BROKER_PREVIEWED:['READY_TO_EXECUTE','RISK_REJECTED','CANCELLED'],
  READY_TO_EXECUTE:['EXECUTION_SENT','RISK_REJECTED','DRAFT','CANCELLED'],EXECUTION_SENT:['BROKER_ACCEPTED','REJECTED','UNKNOWN_OUTCOME','RECONCILIATION_REQUIRED'],
  BROKER_ACCEPTED:['PARTIALLY_FILLED','FILLED','CANCELLED','UNKNOWN_OUTCOME','RECONCILIATION_REQUIRED'],PARTIALLY_FILLED:['PARTIALLY_FILLED','FILLED','CANCELLED','UNKNOWN_OUTCOME','RECONCILIATION_REQUIRED'],
  UNKNOWN_OUTCOME:['BROKER_ACCEPTED','PARTIALLY_FILLED','FILLED','CANCELLED','REJECTED'],
  FILLED:['CLOSED'],FAILED:['DRAFT','CANCELLED'],RECONCILIATION_REQUIRED:['BROKER_ACCEPTED','PARTIALLY_FILLED','FILLED','CANCELLED','REJECTED'],
};
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ProposalService {
  onEvent:(kind:string,detail:Record<string,unknown>)=>void=()=>{};
  onQuote:(proposal:Proposal,quote:import('./model.js').TrustedQuote)=>void=()=>{};
  reporter:((kind:string)=>unknown)|null=null;
  private busy=false;
  constructor(readonly db:AppDatabase,readonly ledger:VirtualPortfolioLedger,readonly allocation:StrategyAllocationManager,private readonly broker:()=>TradingBroker){}
  row(id:string):Row {const r=this.db.raw.prepare('SELECT * FROM proposals WHERE id=?').get(id) as Row|undefined;if(!r)throw new Error('Proposal not found');return r;}
  get(id:string):Proposal {const r=this.row(id);return {...proposalSchema.parse(JSON.parse(r.body_json)),id:r.id,version:r.version,state:r.state};}
  list(){return (this.db.raw.prepare('SELECT id FROM proposals ORDER BY created_at DESC LIMIT 200').all() as Array<{id:string}>).map(r=>this.get(r.id));}
  detail(id:string){return {proposal:this.get(id),research:JSON.parse(this.row(id).research_json??'null'),preview:JSON.parse(this.row(id).preview_json??'null'),approval:JSON.parse(this.row(id).approval_json??'null'),transitions:this.db.raw.prepare('SELECT * FROM proposal_transitions WHERE proposal_id=? ORDER BY rowid').all(id),risk:this.db.raw.prepare('SELECT * FROM risk_decisions_v2 WHERE proposal_id=? ORDER BY rowid').all(id),execution:this.db.raw.prepare('SELECT * FROM executions_v2 WHERE proposal_id=?').get(id)??null};}
  create(input:unknown,actor:string):Proposal {
    const p=proposalSchema.parse(input),id=makeId('proposal');
    this.db.raw.transaction(()=>{
      this.db.raw.prepare('INSERT INTO proposals(id,version,state,strategy_id,body_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,1,'DRAFT',p.strategy,JSON.stringify(p),nowIso(),nowIso());
      this.db.audit(actor,'PROPOSAL_CREATED','proposal',id,{p,version:1});
    })();return this.get(id);
  }
  transition(id:string,to:ProposalState,actor:string,details:unknown={}):void {
    const r=this.row(id);if(!TRANSITIONS[r.state]?.includes(to))throw new Error('Illegal proposal transition '+r.state+' → '+to);
    this.db.raw.transaction(()=>{
      this.db.raw.prepare('UPDATE proposals SET state=?,updated_at=? WHERE id=?').run(to,nowIso(),id);
      this.db.raw.prepare('INSERT INTO proposal_transitions VALUES(?,?,?,?,?,?,?,?)').run(makeId('transition'),id,r.state,to,r.version,actor,JSON.stringify(details),nowIso());
      this.db.audit(actor,'PROPOSAL_TRANSITION','proposal',id,{from:r.state,to,version:r.version,details});
      this.onEvent('PROPOSAL_TRANSITION',{id,to,from:r.state,details});
    })();
  }
  modify(id:string,input:unknown,actor:string):Proposal {
    if(this.busy)throw new Error('Trading workflow busy; proposal edits are locked');
    const r=this.row(id);if(!['DRAFT','RESEARCHED','RISK_REJECTED','READY_TO_EXECUTE','FAILED'].includes(r.state))throw new Error('Cannot modify an executing or terminal proposal');
    const p=proposalSchema.parse(input);if(p.strategy!==this.get(id).strategy)throw new Error('Proposal ownership cannot change');
    this.db.raw.transaction(()=>{
      if(r.state!=='DRAFT')this.transition(id,'DRAFT',actor,{reason:'Edit invalidates research, risk, preview and approval'});
      this.db.raw.prepare('UPDATE proposals SET version=version+1,body_json=?,research_json=NULL,preview_json=NULL,preview_hash=NULL,approval_json=NULL,updated_at=? WHERE id=?').run(JSON.stringify(p),nowIso(),id);
      this.db.audit(actor,'PROPOSAL_EDITED','proposal',id,{oldVersion:r.version,newVersion:r.version+1,p});
    })();return this.get(id);
  }
  research(id:string,input:unknown,actor:string){
    const p=this.get(id),r=researchSchema.parse(input);if(p.state!=='DRAFT')throw new Error('Research can only be attached to DRAFT');
    const missing=RESEARCH_REQUIRED[p.strategy].filter(c=>!r.items.some(i=>i.category===c));if(missing.length)throw new Error('Research missing: '+missing.join(', '));
    if(this.db.getMode()!=='SIMULATION'&&r.simulated)throw new Error('Synthetic research is forbidden outside Simulation');
    this.db.raw.transaction(()=>{this.db.raw.prepare('UPDATE proposals SET research_json=? WHERE id=?').run(JSON.stringify(r),id);this.transition(id,'RESEARCHED',actor,{categories:r.items.map(i=>i.category)});})();return this.get(id);
  }
  private order(p:Proposal,q:Awaited<ReturnType<TradingBroker['quote']>>):ExecutableOrder {
    return {clientOrderId:p.id+':v'+p.version,strategy:p.strategy,assetClass:p.assetClass,symbol:p.symbol,underlying:p.underlying,side:p.side,positionEffect:p.positionEffect,quantity:p.quantity,orderType:p.orderType,limitPrice:p.limitPrice,stopPrice:p.stopPrice,timeInForce:p.timeInForce,marketHours:p.marketHours,option:q.option??null};
  }
  async risk(id:string){
    const p=this.get(id),broker=this.broker(),account=await broker.account(),q=await broker.quote(p),now=Date.now();this.onQuote(p,q);
    const policy=accountPolicySchema.parse(this.db.getSetting('account_policy_v2',DEFAULT_ACCOUNT_POLICY));
    const sleeve=this.allocation.state(p.strategy),sleevePolicy=sleeve.policy;
    const riskConfig=new RiskConfigurationService(this.db),effective=riskConfig.effective(p.strategy,p.assetClass,p.underlying??p.symbol);
    const checks:Array<{code:string;ok:boolean;detail:string}>=[];
    const check=(code:string,ok:boolean,detail=code)=>checks.push({code,ok,detail});
    const closing=p.positionEffect==='CLOSE';
    check('CONFIG_TRADING_ENABLED',closing||effective.tradingEnabled);
    check('CONFIG_SYMBOL',closing||!effective.blockedSymbols.includes(p.symbol)&&!effective.blockedSymbols.includes(p.underlying??p.symbol)&&(effective.allowedSymbols.length===0||effective.allowedSymbols.includes(p.underlying??p.symbol)));
    check('CONFIG_SESSION',effective.allowedMarketSessions.includes(p.marketHours)&&(p.marketHours==='REGULAR'||effective.extendedHoursAllowed));
    check('CONFIG_FRACTIONAL',Number.isInteger(p.quantity)||effective.fractionalTradingAllowed&&p.assetClass!=='OPTION');
    check('CONFIG_PORTFOLIO_FRESH',now-Date.parse(account.asOf)<=effective.maxPortfolioAgeSeconds*1000);
    const reconciliationAt=this.db.getSetting<string|null>('last_reconciliation_at',null);
    check('CONFIG_RECONCILIATION_FRESH',!!reconciliationAt&&now-Date.parse(reconciliationAt)>=-5000&&now-Date.parse(reconciliationAt)<=effective.maxReconciliationAgeSeconds*1000);
    check('CONFIG_PROPOSAL_FRESH',now-Date.parse(p.createdAt)<=effective.maxProposalAgeSeconds*1000);
    check('CONFIG_QUOTE_FRESH',now-Date.parse(q.asOf)<=effective.maxQuoteAgeSeconds*1000);
    check('CONFIG_ASSET',closing||p.assetClass==='OPTION'||(p.assetClass==='ETF'?effective.etfAllowed:effective.equitiesAllowed));
    check('CONFIG_MIN_PRICE',p.option!==null||q.price>=effective.minEquityPrice);
    check('CONFIG_LIQUIDITY',closing||q.volume>=effective.minVolume&&(q.ask-q.bid)/q.ask*100<=effective.maxSpreadPercent);
    check('CONFIG_MARKET_CAP',closing||effective.minMarketCap===0||q.marketCap!==undefined&&q.marketCap>=effective.minMarketCap);
    check('CONFIG_RELATIVE_VOLUME',closing||effective.minRelativeVolume===0||q.relativeVolume!==undefined&&q.relativeVolume>=effective.minRelativeVolume);
    check('CONFIG_ATR',closing||effective.maxAtrPercent===null||q.atrPercent!==undefined&&q.atrPercent<=effective.maxAtrPercent);
    check('CONFIG_VALUATION',closing||effective.maxValuationPE===null||q.valuationPE!==undefined&&q.valuationPE<=effective.maxValuationPE);
    check('CONFIG_SETUP_SCORE',closing||effective.minSetupScore===0||q.setupScore!==undefined&&q.setupScore>=effective.minSetupScore);
    check('CONFIG_EARNINGS',closing||effective.earningsTradingAllowed||q.earningsWithinHolding===false);
    check('CONFIG_CATALYST',closing||!effective.catalystRequired||p.catalyst.trim().length>0);
    check('CONFIG_OVERNIGHT',closing||effective.overnightAllowed||p.holdingTradingDays===0);
    check('CONFIG_HOLDING',closing||p.strategy==='SAFE_LONG_TERM'||p.holdingTradingDays!==null&&p.holdingTradingDays<=effective.maxHoldingTradingDays);
    if(p.option){
      const dte=Math.ceil((Date.parse(p.option.expiration+'T20:00:00Z')-now)/86400000);
      check('CONFIG_OPTION_STRATEGY',effective.allowedOptionStrategies.includes(p.option.strategy)&&(!(p.option.strategy==='LONG_CALL')||effective.longCallsAllowed)&&(!(p.option.strategy==='LONG_PUT')||effective.longPutsAllowed));
      check('CONFIG_DTE',closing||dte>=effective.minDTE&&dte<=effective.maxDTE&&(dte>0||effective.expirationDayAllowed));
      check('CONFIG_CONTRACTS',p.quantity<=effective.maxContracts);
      check('CONFIG_OPEN_INTEREST',closing||effective.minOpenInterest===0||q.openInterest!==undefined&&q.openInterest>=effective.minOpenInterest);
      check('CONFIG_OPTION_VOLUME',closing||q.volume>=effective.minOptionVolume);
      check('CONFIG_OPTION_SPREAD',(q.ask-q.bid)/q.ask*100<=effective.maxOptionSpreadPercent);
      check('CONFIG_UNDERLYING_LIQUIDITY',closing||effective.minUnderlyingVolume===0||q.underlyingVolume!==undefined&&q.underlyingVolume>=effective.minUnderlyingVolume);
      check('CONFIG_DELTA',closing||(effective.minDelta===null||q.delta!==undefined&&q.delta>=effective.minDelta)&&(effective.maxDelta===null||q.delta!==undefined&&q.delta<=effective.maxDelta));
      check('CONFIG_IV',closing||(effective.minIV===null||q.iv!==undefined&&q.iv>=effective.minIV)&&(effective.maxIV===null||q.iv!==undefined&&q.iv<=effective.maxIV));
    }
    check('BROKER_HEALTH',broker.deterministic&&account.healthy&&account.complete&&account.agentic);
    check('ACCOUNT_SCOPE',this.db.getMode()==='SIMULATION'||account.accountId===process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID);
    check('FRESH_ACCOUNT',now-Date.parse(account.asOf)>=-5000&&now-Date.parse(account.asOf)<=policy.maxQuoteAgeSeconds*1000);
    check('NO_BORROWING',[account.cash,account.buyingPower,account.netAccountValue].every(Number.isFinite)&&account.cash>=0&&account.buyingPower>=0&&account.netAccountValue>0);
    check('GLOBAL_PAUSE',!this.db.getSetting('global_pause',false));
    check('MAINTENANCE_STOP',!this.db.getSetting('maintenance_mode',false)&&!this.db.getSetting('stopped',false));
    check('SLEEVE_ENABLED',!!this.db.getStrategy(p.strategy)?.enabled);
    check('RECONCILIATION',this.db.getSetting('reconciliation_clear',false)&&!this.db.getSetting('v2_migration_review_required',false));
    check('SLEEVE_KILL',p.positionEffect==='CLOSE'||!sleeve.killed);
    check('NORMAL_DRAWDOWN',p.positionEffect==='CLOSE'||sleeve.drawdown<Math.min(sleevePolicy.normalDrawdownPercent,this.db.getStrategy(p.strategy)!.config.maxDrawdownPercent));
    check('QUOTE',q.symbol===p.symbol&&q.price>0&&q.bid>0&&q.ask>=q.bid&&[q.price,q.bid,q.ask,q.volume].every(Number.isFinite)&&now-Date.parse(q.asOf)>=-5000&&now-Date.parse(q.asOf)<=policy.maxQuoteAgeSeconds*1000);
    check('DATA_ELIGIBLE',this.db.getMode()==='SIMULATION'||q.tradingEligible);
    check('US_LISTED_UNLEVERAGED',this.db.getMode()==='SIMULATION'||q.usListed===true&&q.leveraged===false&&q.assetClass===p.assetClass);
    check('PROPOSAL_FRESH',now<Date.parse(p.expiresAt)&&now-Date.parse(p.createdAt)>=-5000&&now-Date.parse(p.createdAt)<=policy.maxProposalAgeSeconds*1000);
    const research=researchSchema.safeParse(JSON.parse(this.row(id).research_json??'null'));
    check('RESEARCH_COMPLETE',research.success&&RESEARCH_REQUIRED[p.strategy].every(c=>research.data.items.some(i=>i.category===c)));
    check('RESEARCH_FRESH',research.success&&research.data.items.every(i=>now-Date.parse(i.observedAt)>=-5000&&now-Date.parse(i.observedAt)<=policy.maxResearchAgeHours*3600000));
    check('RESEARCH_REAL',this.db.getMode()==='SIMULATION'||(research.success&&!research.data.simulated));
    const session=this.db.raw.prepare('SELECT * FROM market_sessions WHERE opens_at<=? AND closes_at>?').get(nowIso(),nowIso()) as {verified_at:string}|undefined;
    check('MARKET_SESSION',this.db.getMode()==='SIMULATION'?this.db.getSetting('simulation_market_open',true):!!session&&now-Date.parse(session.verified_at)<7*86400000);
    check('SUPPORTED_ORDER',(p.orderType==='LIMIT'&&!p.option&&Number.isInteger(p.quantity)||p.orderType==='LIMIT'&&!!p.option||!p.option&&p.orderType==='MARKET')&&p.marketHours==='REGULAR'&&p.dollarAmount===null,'Official regular-hours equity market/whole-share limit and single-leg option limit orders only');
    check('SLEEVE_ASSET',p.strategy==='OPTIONS'?p.assetClass==='OPTION':p.assetClass!=='OPTION');
    check('HOLDING_PLAN',p.positionEffect==='CLOSE'||p.strategy==='SAFE_LONG_TERM'?(p.positionEffect==='CLOSE'||p.holdingTradingDays===null||p.holdingTradingDays>=90):(p.holdingTradingDays!==null&&p.holdingTradingDays<=sleevePolicy.maxHoldingTradingDays));
    const directives=this.db.raw.prepare("SELECT type,value_json FROM directives WHERE active=1 AND (strategy_id IS NULL OR strategy_id=?) AND (symbol IS NULL OR symbol IN (?,?)) AND (expires_at IS NULL OR expires_at>?)").all(p.strategy,p.symbol,p.underlying,nowIso()) as Array<{type:string;value_json:string}>;
    check('FORBIDDEN_SYMBOL',!directives.some(d=>d.type==='FORBIDDEN_SYMBOL'));
    check('RESEARCH_ONLY',!directives.some(d=>d.type==='RESEARCH_ONLY'));
    check('PAUSE_DIRECTIVE',!directives.some(d=>d.type==='STRATEGY_PAUSE'));
    check('LIQUIDITY',q.volume>=sleevePolicy.minVolume&&(q.ask-q.bid)/q.ask*100<=sleevePolicy.maxSpreadPercent);
    check('EQUITY_PRICE',p.option!==null||q.price>=sleevePolicy.minEquityPrice);
    const notional=p.quantity*(p.limitPrice??q.ask)*(p.option?100:1);
    const priorPreview=JSON.parse(this.row(id).preview_json??'null') as {raw?:{fees?:{total_fee?:string}}}|null;
    const previewFee=p.option&&priorPreview?.raw?.fees?.total_fee!==undefined?Number(priorPreview.raw.fees.total_fee):0;
    check('VERIFIED_PREVIEW_FEES',Number.isFinite(previewFee)&&previewFee>=0);
    let cashRequired=p.side==='BUY'?notional+previewFee:previewFee,sharesRequired=0,maxLoss=p.side==='BUY'?notional+previewFee:previewFee;
    const position=this.ledger.getPosition(p.strategy,p.symbol);
    check('COST_BASIS_FOR_SALE',!!p.option||p.side!=='SELL'||position?.averageCost!==null,'A sale with unavailable historical basis cannot book realized P&L; basis-dependent calculations are unavailable.');
    if(!p.option) {
      check('LONG_ONLY_EFFECT',p.side==='BUY'?p.positionEffect==='OPEN':p.positionEffect==='CLOSE');
      const reserved=this.db.raw.prepare("SELECT COALESCE(SUM(shares),0) AS shares FROM capital_reservations WHERE strategy_id=? AND underlying=? AND status='ACTIVE'").get(p.strategy,p.symbol) as {shares:number};
      const covered=sleeve.options.reduce((n,o)=>n+(JSON.parse(o.instrument_json).underlying===p.symbol?o.reserved_shares:0),0);
      check('OWNED_UNRESERVED_SHARES',p.side==='BUY'||(position?.quantity??0)-reserved.shares-covered>=p.quantity);
      if(p.side==='SELL')sharesRequired=p.quantity;
    } else {
      const instrument=q.option,o=p.option;
      check('LEVEL_TWO',account.optionsLevel===2&&policy.optionsLevel===2);
      check('CONTRACT_VERIFIED',!!instrument&&instrument.optionId===o.optionId&&instrument.underlying===p.underlying&&instrument.type===o.type&&instrument.strike===o.strike&&instrument.expiration===o.expiration&&instrument.multiplier===100&&Date.parse(o.expiration+'T20:00:00Z')>now);
      const long=o.strategy==='LONG_CALL'||o.strategy==='LONG_PUT',put=o.strategy==='LONG_PUT'||o.strategy==='CASH_SECURED_PUT';
      check('OPTION_DIRECTION',put?(o.type==='PUT'):(o.type==='CALL'));
      check('SINGLE_LEG_LEVEL_TWO',p.positionEffect==='OPEN'?(long?p.side==='BUY':p.side==='SELL'):(long?p.side==='SELL':p.side==='BUY'));
      const held=sleeve.options.find(o=>o.option_id===p.option?.optionId);
      const closing=this.db.raw.prepare("SELECT COALESCE(SUM(o.quantity-o.cumulative_filled_quantity),0) AS quantity FROM executions_v2 e JOIN orders o ON o.id=e.order_id WHERE e.status='PENDING' AND json_extract(e.order_json,'$.option.optionId')=? AND json_extract(e.order_json,'$.positionEffect')='CLOSE'").get(o.optionId) as {quantity:number};
      check('OWNED_OPTION',p.positionEffect==='OPEN'||!!held&&(long?held.contracts>0:held.contracts<0)&&Math.abs(held.contracts)-closing.quantity>=p.quantity);
      check('NO_OPPOSITE_CONTRACT',p.positionEffect==='CLOSE'||!held||(long?held.contracts>=0:held.contracts<=0));
      if(p.positionEffect==='OPEN'&&o.strategy==='CASH_SECURED_PUT'){cashRequired=o.strike*100*p.quantity+previewFee;maxLoss=cashRequired;}
      if(p.positionEffect==='OPEN'&&o.strategy==='COVERED_CALL'){
        sharesRequired=100*p.quantity;maxLoss=previewFee+sharesRequired*(this.ledger.getPosition('OPTIONS',p.underlying!)?.marketPrice??0);
        const covered=sleeve.options.reduce((n,v)=>n+(JSON.parse(v.instrument_json).underlying===p.underlying?v.reserved_shares:0),0);
        const pending=this.db.raw.prepare("SELECT COALESCE(SUM(shares),0) AS shares FROM capital_reservations WHERE strategy_id='OPTIONS' AND underlying=? AND status='ACTIVE'").get(p.underlying) as {shares:number};
        check('SAME_SLEEVE_COVERAGE',(this.ledger.getPosition('OPTIONS',p.underlying!)?.quantity??0)-covered-pending.shares>=sharesRequired);
      }
    }
    const legacy=this.db.getGlobalRisk(),config=this.db.getStrategy(p.strategy)!.config;
    const pendingCount=(this.db.raw.prepare("SELECT COUNT(*) AS n FROM capital_reservations WHERE status='ACTIVE'").get() as {n:number}).n;
    check('CONFIG_PENDING_LIMIT',closing||pendingCount<effective.maxPendingOrders);
    check('CONFIG_SIZING',closing||maxLoss+(p.option?0:position?.marketValue??0)<=sleeve.currentEquity*effective.maxPositionPercent/100);
    check('CONFIG_TRADE_RISK',closing||maxLoss<=sleeve.currentEquity*(p.option?effective.maxSleeveCapitalPerTradePercent:effective.perTradeRiskPercent)/100);
    check('CONFIG_ORDER_NOTIONAL',notional<=effective.maxOrderNotional);
    check('CONFIG_CASH',account.cash-cashRequired>=effective.minimumCashReserve);
    check('CONFIG_DRAWDOWN',closing||sleeve.drawdown<effective.normalDrawdownPercent);
    check('CONFIG_POSITIONS',closing||account.positions.length+account.options.length<effective.maxPositions||!!position);
    if(p.option){check('CONFIG_PREMIUM_RISK',closing||!['LONG_CALL','LONG_PUT'].includes(p.option.strategy)||notional<=sleeve.currentEquity*effective.maxPremiumRiskPercent/100);
      check('CONFIG_OPTION_COUNT',closing||sleeve.options.length<effective.maxConcurrentOptions);
      check('CONFIG_TOTAL_PREMIUM',closing||sleeve.options.filter(o=>o.contracts>0).reduce((n,o)=>n+o.contracts*100*o.average_premium,0)+notional<=effective.maxTotalPremiumAtRisk);
      check('CONFIG_COLLATERAL',closing||sleeve.options.reduce((n,o)=>n+o.collateral,0)+cashRequired<=effective.maxCollateral);
      const telemetry=this.db.raw.prepare('SELECT body_json FROM option_telemetry ORDER BY rowid DESC LIMIT 100').all() as Array<{body_json:string}>;
      const riskGreek=(key:'theta'|'vega',cap:number|null)=>{if(closing||cap===null)return true;if(q[key]===undefined)return false;let total=Math.abs(q[key]!)*p.quantity*100;for(const o of sleeve.options){const t=telemetry.map(r=>JSON.parse(r.body_json)).find(t=>t.optionId===o.option_id);if(typeof t?.[key]!=='number')return false;total+=Math.abs(t[key]*o.contracts*100);}return total<=cap;};
      check('CONFIG_THETA',riskGreek('theta',effective.maxThetaExposure));check('CONFIG_VEGA',riskGreek('vega',effective.maxVegaExposure));}
    check('MAX_ORDER_NOTIONAL',notional<=Math.min(policy.maxOrderNotional,legacy.maxOrderNotional));
    check('LEGACY_ACCOUNT_RESERVE',account.cash-cashRequired>=legacy.minimumReservedCash);
    check('LEGACY_SLEEVE_RESERVE',sleeve.availableCapital-cashRequired>=sleeve.currentEquity*config.targetCashReservePercent/100);
    check('LEGACY_OPTIONS_ENABLED',!p.option||legacy.optionsEnabled);
    check('LEGACY_POSITION_CAP',p.positionEffect==='CLOSE'||maxLoss+(p.option?0:position?.marketValue??0)<=sleeve.currentEquity*config.maxPositionPercent/100);
    const symbolExposure=this.ledger.listPositions().filter(v=>v.symbol===(p.underlying??p.symbol)).reduce((n,v)=>n+v.marketValue,0);
    check('LEGACY_TICKER_CAP',p.positionEffect==='CLOSE'||symbolExposure+maxLoss<=account.netAccountValue*legacy.maxTickerExposurePercent/100);
    check('SECTOR_VERIFIED',this.db.getMode()==='SIMULATION'||!!q.sector);
    const sector=this.ledger.listPositions().filter(v=>v.sector===(q.sector??'Unknown')).reduce((n,v)=>n+v.marketValue,0);
    check('LEGACY_SECTOR_CAP',p.positionEffect==='CLOSE'||sector+maxLoss<=account.netAccountValue*legacy.maxSectorExposurePercent/100);
    const ownSector=sleeve.positions.filter(v=>v.sector===(q.sector??'Unknown')).reduce((n,v)=>n+v.marketValue,0);
    check('LEGACY_SLEEVE_SECTOR_CAP',p.positionEffect==='CLOSE'||ownSector+maxLoss<=sleeve.currentEquity*config.maxSectorExposurePercent/100);
    const sleeveOrders=this.db.raw.prepare("SELECT COUNT(*) AS n FROM orders WHERE strategy_id=? AND created_at>=date('now')").get(p.strategy) as {n:number};
    check('SLEEVE_ORDER_LIMIT',sleeveOrders.n<config.maxTradesPerDay);
    check('SLEEVE_POSITION_LIMIT',p.positionEffect==='CLOSE'||!!position||sleeve.positions.length+sleeve.options.length<config.maxSimultaneousPositions);
    check('MAX_ALLOCATION_DIRECTIVE',directives.filter(d=>d.type==='MAX_ALLOCATION').every(d=>{const a=JSON.parse(d.value_json) as {maxAmount?:number};return a.maxAmount===undefined||notional<=a.maxAmount;}));
    check('SLEEVE_POSITION_RISK',p.positionEffect==='CLOSE'||maxLoss+(p.option?0:position?.marketValue??0)<=sleeve.currentEquity*sleevePolicy.maxPositionRiskPercent/100);
    check('CASH_COLLATERAL',cashRequired<=sleeve.availableCapital&&cashRequired<=account.buyingPower&&account.cash-cashRequired>=policy.minimumCashReserve);
    const gross=SLEEVES.reduce((n,s)=>n+this.allocation.state(s).capitalAtRisk,0);
    const pendingGross=this.db.raw.prepare("SELECT COALESCE(SUM(cash_amount),0) AS total FROM capital_reservations WHERE status='ACTIVE'").get() as {total:number};
    check('GROSS_EXPOSURE',p.positionEffect==='CLOSE'||gross+pendingGross.total+maxLoss<=account.netAccountValue*Math.min(policy.maxGrossExposurePercent,legacy.maxTotalExposurePercent)/100);
    const pendingPositions=(this.db.raw.prepare("SELECT COUNT(*) AS n FROM capital_reservations WHERE status='ACTIVE'").get() as {n:number}).n;
    check('POSITION_LIMIT',p.positionEffect==='CLOSE'||account.positions.length+account.options.length+pendingPositions<Math.min(policy.maxPositions,legacy.maxOpenPositions)||!!position||sleeve.options.some(o=>o.option_id===p.option?.optionId));
    const day=new Date(pacificPeriodStart('DAY'));
    const daily=this.db.raw.prepare('SELECT COUNT(*) AS n FROM orders WHERE created_at>=?').get(day.toISOString()) as {n:number};
    const minute=this.db.raw.prepare('SELECT COUNT(*) AS n FROM executions_v2 WHERE created_at>=?').get(new Date(now-60000).toISOString()) as {n:number};
    check('ORDER_RATE',daily.n<Math.min(policy.maxOrdersPerDay,legacy.maxNewTradesPerDay)&&minute.n<policy.maxOrdersPerMinute);
    const realized=this.ledger.getRealizedPnl(undefined,day.toISOString());
    check('CONFIG_DAILY_LOSS',closing||realized>-effective.maxDailyRealizedLoss);
    check('CONFIG_SLEEVE_LOSS',closing||this.ledger.getRealizedPnl(p.strategy,day.toISOString())>-effective.maxDailySleeveLoss);
    check('CONFIG_ORDER_RATE',daily.n<effective.maxOrdersPerDay&&minute.n<effective.maxOrdersPerMinute);
    check('CONFIG_NEW_POSITION_RATE',closing||(this.db.raw.prepare("SELECT COUNT(*) AS n FROM proposals WHERE strategy_id=? AND state IN ('FILLED','PARTIALLY_FILLED','BROKER_ACCEPTED') AND created_at>=? AND json_extract(body_json,'$.positionEffect')='OPEN'").get(p.strategy,day.toISOString()) as {n:number}).n<effective.maxNewPositionsPerDay);
    check('CONFIG_GROSS_NET',closing||gross+pendingGross.total+maxLoss<=account.netAccountValue*Math.min(effective.maxGrossExposurePercent,effective.maxNetExposurePercent)/100);
    check('DAILY_REALIZED_LOSS',closing||realized>-Math.min(policy.maxDailyRealizedLoss,account.netAccountValue*legacy.maxDailyDrawdownPercent/100));
    const baseline=this.db.getSetting<{date:string;equity:number}>('daily_equity_baseline_v2',{date:day.toISOString(),equity:account.netAccountValue});
    if(baseline.date!==day.toISOString())this.db.setSetting('daily_equity_baseline_v2',{date:day.toISOString(),equity:account.netAccountValue});
    else if(!this.db.getSetting('daily_equity_baseline_v2',null))this.db.setSetting('daily_equity_baseline_v2',baseline);
    check('DAILY_TOTAL_LOSS',closing||baseline.date!==day.toISOString()||baseline.equity-account.netAccountValue<policy.maxTotalDailyLoss);
    check('CONFIG_TOTAL_LOSS',closing||baseline.date!==day.toISOString()||baseline.equity-account.netAccountValue<effective.maxTotalDailyLoss);
    const weeklyStart=SLEEVES.reduce((n,s)=>n+this.allocation.state(s).weeklyStartingCapital,0);
    check('CONFIG_WEEKLY_LOSS',closing||weeklyStart-account.netAccountValue<effective.maxWeeklyLoss);
    check('LEGACY_WEEKLY_LOSS',p.positionEffect==='CLOSE'||account.netAccountValue>=weeklyStart*(1-legacy.maxWeeklyDrawdownPercent/100));
    check('SLEEVE_WEEKLY_LOSS',p.positionEffect==='CLOSE'||sleeve.currentEquity>=sleeve.weeklyStartingCapital*(1-config.maxDrawdownPercent/100));
    const loss=this.db.raw.prepare('SELECT MAX(created_at) AS at FROM (SELECT strategy_id,amount,created_at FROM realized_pnl UNION ALL SELECT strategy_id,amount,created_at FROM economic_event_pnl) WHERE strategy_id=? AND amount<0').get(p.strategy) as {at:string|null};
    check('LOSS_COOLDOWN',p.positionEffect==='CLOSE'||!loss.at||now-Date.parse(loss.at)>policy.lossCooldownMinutes*60000);
    check('CONFIG_COOLDOWN',closing||!loss.at||now-Date.parse(loss.at)>effective.lossCooldownMinutes*60000);
    const configLosses=this.db.raw.prepare('SELECT amount FROM (SELECT id,strategy_id,amount,created_at FROM realized_pnl UNION ALL SELECT id,strategy_id,amount,created_at FROM economic_event_pnl) WHERE strategy_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(p.strategy,effective.maxConsecutiveLosses) as Array<{amount:number}>;
    check('CONFIG_CONSECUTIVE_LOSSES',closing||effective.maxConsecutiveLosses===0||configLosses.length<effective.maxConsecutiveLosses||configLosses.some(v=>v.amount>=0));
    const consecutive=this.db.raw.prepare('SELECT amount FROM (SELECT id,strategy_id,amount,created_at FROM realized_pnl UNION ALL SELECT id,strategy_id,amount,created_at FROM economic_event_pnl) WHERE strategy_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(p.strategy,legacy.maxConsecutiveLosses) as Array<{amount:number}>;
    const losing=legacy.maxConsecutiveLosses>0&&consecutive.length===legacy.maxConsecutiveLosses&&consecutive.every(v=>v.amount<0);
    check('CONSECUTIVE_LOSSES',p.positionEffect==='CLOSE'||!losing);
    if(losing)this.db.setStrategyEnabled(p.strategy,false,'RISK_ENGINE','Consecutive losing trades trigger review');
    const order=this.order(p,q),approved=checks.every(c=>c.ok),facts={account,q,sleeve,notional,cashRequired,sharesRequired,maxLoss,order,orderHash:fingerprint(order)};
    this.db.raw.prepare('INSERT INTO risk_decisions_v2 VALUES(?,?,?,?,?,?,?)').run(makeId('riskv2'),id,p.version,approved?1:0,JSON.stringify(checks),JSON.stringify(facts),nowIso());
    this.db.audit('RISK_ENGINE','PROPOSAL_RISK_REVIEW','proposal',id,{approved,checks,version:p.version});
    return {approved,checks,facts};
  }
  async review(id:string,actor:string){
    if(this.busy)throw new Error('Trading workflow busy');this.busy=true;
    try{
      if(this.db.getMode()!=='SIMULATION')await this.reconcile();
      const p=this.get(id);if(!['RESEARCHED','RISK_REJECTED'].includes(p.state))throw new Error('Research first; review requires RESEARCHED or RISK_REJECTED');
      this.transition(id,'SUBMITTED_TO_RISK',actor);
      const r=await this.risk(id);this.transition(id,r.approved?'RISK_APPROVED':'RISK_REJECTED','RISK_ENGINE',{checks:r.checks});
      if(!r.approved)return this.detail(id);
      const preview=await this.broker().preview(r.facts.order);
      this.db.raw.prepare('UPDATE proposals SET preview_json=?,preview_hash=? WHERE id=?').run(JSON.stringify(preview),r.facts.orderHash,id);
      this.transition(id,'BROKER_PREVIEWED','BROKER_ADAPTER',{preview,hash:r.facts.orderHash});
      const second=p.option?await this.risk(id):r;
      const valid=second.approved&&preview.approved&&Number.isFinite(preview.estimatedCost)&&preview.estimatedCost>=0&&preview.estimatedCost<=second.facts.notional+(second.facts.cashRequired-(p.side==='BUY'?second.facts.notional:0))+.01&&Number.isFinite(preview.collateralRequired)&&preview.collateralRequired>=0&&preview.collateralRequired<=second.facts.cashRequired&&Date.now()-Date.parse(preview.asOf)>=-5000&&Date.now()-Date.parse(preview.asOf)<=60000;
      this.transition(id,valid?'READY_TO_EXECUTE':'RISK_REJECTED','RISK_ENGINE',{previewValid:valid});return this.detail(id);
    }catch(e){if(['SUBMITTED_TO_RISK','RISK_APPROVED'].includes(this.get(id).state))this.transition(id,'FAILED','WORKFLOW',{reason:e instanceof Error?e.message:'Error'});throw e;}finally{this.busy=false;}
  }
  approve(id:string,version:number,actor:string){const p=this.get(id),r=this.row(id);if(p.state!=='READY_TO_EXECUTE'||p.version!==version)throw new Error('Approval requires current READY_TO_EXECUTE version');const approval={version,hash:r.preview_hash,actor,expiresAt:new Date(Math.min(Date.parse(p.expiresAt),Date.now()+300000)).toISOString()};this.db.raw.prepare('UPDATE proposals SET approval_json=? WHERE id=?').run(JSON.stringify(approval),id);this.db.audit(actor,'MANUAL_EXECUTION_APPROVAL','proposal',id,approval);return approval;}
  async execute(id:string,actor:string,agentMode?:AgentMode){
    const existing=this.db.raw.prepare('SELECT * FROM executions_v2 WHERE proposal_id=?').get(id);if(existing)return existing;
    if(this.busy)throw new Error('Trading workflow busy');this.busy=true;
    try{
      const p=this.get(id),row=this.row(id);if(p.state!=='READY_TO_EXECUTE')throw new Error('Proposal is not ready');
      if(this.db.getMode()==='READ_ONLY')throw new Error('Read Only blocks execution');
      if(this.db.getMode()==='LIVE'&&agentMode)throw new Error('Manual LIVE submission must come from the operator dashboard, not an agent');
      if(this.db.getMode()==='LIVE'&&(!this.db.getSetting('v2_live_activation',false)||!this.db.getSetting('live_db_confirmation',false)))throw new Error('Master LIVE activation is disabled');
      const policy=this.allocation.policy(p.strategy);
      const autonomous=this.db.getMode()==='SIMULATION'&&agentMode==='AUTONOMOUS'&&policy.executionPolicy==='AUTONOMOUS_RISK_APPROVED'&&!this.db.getSetting('global_pause',false)&&!this.allocation.state(p.strategy).killed&&!!this.db.getStrategy(p.strategy)?.enabled;
      const approval=JSON.parse(row.approval_json??'null') as {version:number;hash:string;expiresAt:string}|null;
      if(!autonomous&&(!approval||approval.version!==p.version||approval.hash!==row.preview_hash||Date.parse(approval.expiresAt)<=Date.now()))throw new Error('Explicit approval for this version/preview required');
      if(agentMode==='ADVISOR')throw new Error('ADVISOR cannot execute');
      if(this.db.getMode()!=='SIMULATION')await this.reconcile();
      const r=await this.risk(id);
      if(r.approved&&(this.db.getSetting('stopped',false)||this.db.getSetting('global_pause',false)||this.db.getSetting('maintenance_mode',false)))throw new Error('STOP or pause blocks all execution');
      const preview=JSON.parse(row.preview_json??'null') as {asOf:string}|null;
      if(!r.approved||r.facts.orderHash!==row.preview_hash||!preview||Date.now()-Date.parse(preview.asOf)>60000){this.transition(id,'RISK_REJECTED','RISK_ENGINE',{secondRisk:r.checks,previewStale:!preview||Date.now()-Date.parse(preview.asOf)>60000});return this.detail(id);}
      let orderId='';
      this.db.raw.transaction(()=>{
        orderId=this.ledger.createOrder({idempotencyKey:p.id+':v'+p.version,strategyId:p.strategy,symbol:p.symbol,side:p.side,quantity:p.quantity,orderType:p.orderType,limitPrice:p.limitPrice!,mode:this.db.getMode(),source:'V2_PROPOSAL',assetType:p.assetClass,sector:r.facts.q.sector??'Unknown'});
        this.db.raw.prepare('INSERT INTO executions_v2 VALUES(?,?,?,?,?,?,?,?,?)').run(makeId('exec'),id,p.id+':v'+p.version,orderId,null,'PENDING',JSON.stringify(r.facts.order),nowIso(),nowIso());
        this.db.raw.prepare('INSERT INTO capital_reservations VALUES(?,?,?,?,?,?,?,?)').run(makeId('reserve'),id,p.strategy,r.facts.cashRequired,p.underlying??p.symbol,r.facts.sharesRequired,'ACTIVE',nowIso());
        this.db.raw.prepare('UPDATE proposals SET order_id=? WHERE id=?').run(orderId,id);
        this.transition(id,'EXECUTION_SENT','EXECUTION_ENGINE',{orderId,hash:r.facts.orderHash});
      })();
      try{
        const result=await this.broker().place(r.facts.order);
        if(result.status==='UNKNOWN')throw new Error('Broker placement outcome unknown');
        this.db.raw.prepare('UPDATE executions_v2 SET broker_order_id=? WHERE proposal_id=?').run(result.id,id);
        if(result.status==='REJECTED'){this.ledger.rejectOrder(orderId,'Broker rejection','BROKER_REJECTED');this.transition(id,'REJECTED','BROKER_ADAPTER');this.release(id);return this.detail(id);}
        this.ledger.updateOrder(orderId,'SUBMITTED',result.id);this.transition(id,'BROKER_ACCEPTED','BROKER_ADAPTER',{brokerOrderId:result.id});
        for(const fill of result.fills)this.applyFill(id,fill);
        return this.detail(id);
      }catch(e){
        this.ledger.updateOrder(orderId,'UNKNOWN');this.db.raw.prepare("UPDATE executions_v2 SET status='UNKNOWN_OUTCOME' WHERE proposal_id=?").run(id);this.transition(id,'UNKNOWN_OUTCOME','EXECUTION_ENGINE',{reason:e instanceof Error?e.message:'Unknown outcome'});
        this.db.setSetting('reconciliation_clear',false);this.db.setSetting('global_pause',true);this.db.setSetting('v2_live_activation',false);this.db.setSetting('live_db_confirmation',false);if(this.db.getMode()==='LIVE')this.db.setSetting('operating_mode','READ_ONLY');throw e;
      }
    }finally{this.busy=false;}
  }
  private release(id:string){this.db.raw.prepare("UPDATE capital_reservations SET status='RELEASED' WHERE proposal_id=?").run(id);this.db.raw.prepare("UPDATE executions_v2 SET status='TERMINAL',updated_at=? WHERE proposal_id=?").run(nowIso(),id);}
  applyFill(id:string,fill:BrokerFill){
    const p=this.get(id),r=this.row(id);if(!r.order_id)throw new Error('Execution attribution missing');
    if(fill.fees===null)throw new Error('Broker fill fees unavailable: review the actual broker receipt before booking this fill');
    if(!Number.isFinite(fill.price)||fill.price<=0||!Number.isFinite(fill.quantity)||fill.quantity<=0||!Number.isFinite(fill.fees)||fill.fees<0)throw new Error('Invalid fill');
    const execution=this.db.raw.prepare('SELECT broker_order_id FROM executions_v2 WHERE proposal_id=?').get(id) as {broker_order_id:string};
    if(fill.brokerOrderId!==execution.broker_order_id)throw new Error('Fill broker attribution mismatch');
    this.db.raw.transaction(()=>{
      if(this.db.raw.prepare('SELECT id FROM fills WHERE broker_fill_id=?').get(fill.id))return;
      if(p.option)this.optionFill(p,r.order_id!,fill);
      else this.ledger.applyFill({brokerFillId:fill.id,orderId:r.order_id!,quantity:fill.quantity,price:fill.price,fees:fill.fees!,executedAt:fill.executedAt});
      const order=this.db.raw.prepare('SELECT cumulative_filled_quantity FROM orders WHERE id=?').get(r.order_id) as {cumulative_filled_quantity:number};
      const remaining=p.quantity-order.cumulative_filled_quantity;
      this.db.raw.prepare("UPDATE capital_reservations SET cash_amount=cash_amount*?,shares=shares*? WHERE proposal_id=? AND status='ACTIVE'").run(Math.max(0,(remaining)/(remaining+fill.quantity)),Math.max(0,remaining/(remaining+fill.quantity)),id);
      this.transition(id,remaining<=0.000001?'FILLED':'PARTIALLY_FILLED','LEDGER',{fill});
      if(remaining<=0.000001)this.release(id);
      if(p.option)this.report('OPTIONS_EXPOSURE_CHANGE');
    })();
  }
  private optionFill(p:Proposal,orderId:string,f:BrokerFill){
    if(f.fees===null)throw new Error("Verified option fill fees required");
    const o=p.option!;if(!Number.isInteger(f.quantity))throw new Error('Option fill quantity must be contracts');
    const order=this.db.raw.prepare('SELECT cumulative_filled_quantity FROM orders WHERE id=?').get(orderId) as {cumulative_filled_quantity:number};
    if(order.cumulative_filled_quantity+f.quantity>p.quantity)throw new Error('Overfill');
    const held=this.db.raw.prepare('SELECT * FROM option_positions WHERE option_id=?').get(o.optionId) as {contracts:number;average_premium:number;collateral:number;reserved_shares:number}|undefined;
    const delta=p.side==='BUY'?f.quantity:-f.quantity,old=held?.contracts??0;
    if(p.positionEffect==='CLOSE'&&(!held||Math.abs(old)<f.quantity||Math.sign(old)===Math.sign(delta)))throw new Error('Cannot close unowned option');
    const cashDelta=(p.side==='BUY'?-1:1)*f.quantity*100*f.price-f.fees;
    if(this.ledger.getCash(p.strategy)+cashDelta<0)throw new Error('Option fill would borrow');
    const contracts=old+delta;
    const average=p.positionEffect==='OPEN'?(Math.abs(old)*(held?.average_premium??0)+f.quantity*f.price)/Math.abs(contracts):(held?.average_premium??0);
    const collateral=contracts<0&&o.type==='PUT'?Math.abs(contracts)*100*o.strike:0;
    const shares=contracts<0&&o.type==='CALL'?Math.abs(contracts)*100:0;
    const fillId=makeId('fill');
    this.db.raw.prepare('INSERT INTO fills VALUES(?,?,?,?,?,?,?)').run(fillId,f.id,orderId,f.quantity,f.price,f.fees,f.executedAt);
    this.db.raw.prepare('INSERT INTO strategy_fills VALUES(?,?,?,?,?,?,?,?,?)').run(makeId('sf'),fillId,p.strategy,p.symbol,p.side,f.quantity,f.price,f.fees,f.executedAt);
    this.db.raw.prepare('UPDATE strategy_cash SET balance=balance+?,updated_at=? WHERE strategy_id=?').run(roundMoney(cashDelta),nowIso(),p.strategy);
    this.db.raw.prepare('INSERT INTO option_positions VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(option_id) DO UPDATE SET contracts=excluded.contracts,average_premium=excluded.average_premium,mark_price=excluded.mark_price,collateral=excluded.collateral,reserved_shares=excluded.reserved_shares,updated_at=excluded.updated_at').run(o.optionId,p.strategy,JSON.stringify({optionId:o.optionId,underlying:p.underlying,type:o.type,strike:o.strike,expiration:o.expiration,multiplier:100}),contracts,average,f.price,collateral,shares,nowIso());
    if(p.positionEffect==='OPEN')this.db.raw.prepare('INSERT INTO option_lots VALUES(?,?,?,?,?,?)').run(makeId('olot'),o.optionId,p.strategy,delta,f.price+(p.side==='BUY'?1:-1)*f.fees/(100*f.quantity),f.executedAt);
    else{
      let left=f.quantity,basis=0;
      const lots=this.db.raw.prepare('SELECT * FROM option_lots WHERE option_id=? AND contracts<>0 ORDER BY opened_at,id').all(o.optionId) as Array<{id:string;contracts:number;premium:number}>;
      for(const lot of lots){const n=Math.min(left,Math.abs(lot.contracts));basis+=n*100*lot.premium;this.db.raw.prepare('UPDATE option_lots SET contracts=contracts-? WHERE id=?').run(Math.sign(lot.contracts)*n,lot.id);left-=n;if(left===0)break;}
      if(left!==0)throw new Error('Option lot mismatch');
      const realized=(old>0?f.quantity*100*f.price-basis:basis-f.quantity*100*f.price)-f.fees;
      this.db.raw.prepare('INSERT INTO realized_pnl VALUES(?,?,?,?,?,?,?)').run(makeId('pnl'),p.strategy,p.symbol,orderId,fillId,roundMoney(realized),f.executedAt);
    }
    const optionBasis=this.db.raw.prepare('SELECT COALESCE(SUM(ABS(contracts)*premium),0) AS basis,COALESCE(SUM(ABS(contracts)),0) AS quantity FROM option_lots WHERE option_id=? AND contracts<>0').get(o.optionId) as {basis:number;quantity:number};
    this.db.raw.prepare('UPDATE option_positions SET average_premium=? WHERE option_id=?').run(optionBasis.quantity?optionBasis.basis/optionBasis.quantity:0,o.optionId);
    const cumulative=order.cumulative_filled_quantity+f.quantity;
    this.db.raw.prepare('UPDATE orders SET cumulative_filled_quantity=?,status=?,updated_at=? WHERE id=?').run(cumulative,cumulative===p.quantity?'FILLED':'PARTIALLY_FILLED',nowIso(),orderId);
    this.db.audit('LEDGER','OPTION_FILL_APPLIED','order',orderId,{f,contracts,collateral,shares});
    this.db.raw.prepare('INSERT INTO virtual_transactions(id,idempotency_key,strategy_id,type,amount,symbol,quantity,reference_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(makeId('vtx'),'option-fill:'+f.id,p.strategy,'OPTION_'+p.positionEffect,roundMoney(cashDelta),p.symbol,f.quantity,fillId,JSON.stringify({optionId:o.optionId,contracts,collateral,reservedShares:shares}),f.executedAt);
  }
  async linkUnknown(id:string,brokerOrderId:string,review:string,actor:string){
    if(this.busy||this.db.getMode()!=='READ_ONLY'||!this.db.getSetting('global_pause',false))throw new Error('Pause in Read only before reviewing an unknown outcome');
    const p=this.get(id),e=this.db.raw.prepare('SELECT order_id,order_json,broker_order_id,created_at FROM executions_v2 WHERE proposal_id=?').get(id) as {order_id:string;order_json:string;broker_order_id:string|null;created_at:string}|undefined;
    if(p.state!=='UNKNOWN_OUTCOME'||!e||e.broker_order_id)throw new Error('Unlinked unknown execution required');
    const broker=this.broker();if(!broker.lookup)throw new Error('Scoped broker order lookup unavailable');
    const result=await broker.lookup(JSON.parse(e.order_json),brokerOrderId);
    if(result.order.status==='UNKNOWN'||this.db.raw.prepare('SELECT id FROM executions_v2 WHERE broker_order_id=?').get(brokerOrderId))throw new Error('Broker outcome is unknown or already attributed');
    this.db.raw.transaction(()=>{const linked=this.db.raw.prepare('UPDATE executions_v2 SET broker_order_id=? WHERE proposal_id=? AND broker_order_id IS NULL').run(brokerOrderId,id);if(linked.changes!==1)throw new Error('Unknown execution was already reviewed');this.ledger.updateOrder(e.order_id,'SUBMITTED',brokerOrderId);this.db.audit(actor,'UNKNOWN_OUTCOME_ORDER_LINK_REVIEW','proposal',id,{brokerOrderId,review,clientOrderId:JSON.parse(e.order_json).clientOrderId,ordersPlaced:0});})();return this.reconcile();
  }
  async cancel(id:string,actor:string){
    if(this.busy)throw new Error('Trading workflow busy; cancel after the current action settles');
    const p=this.get(id),row=this.row(id);
    if(['EXECUTION_SENT','UNKNOWN_OUTCOME','RECONCILIATION_REQUIRED'].includes(p.state))throw new Error('Unknown broker outcome must reconcile, not cancel locally');
    if(['BROKER_ACCEPTED','PARTIALLY_FILLED'].includes(p.state)){
      const exec=this.db.raw.prepare('SELECT broker_order_id FROM executions_v2 WHERE proposal_id=?').get(id) as {broker_order_id:string};
      const cancellation=await this.broker().cancel(exec.broker_order_id);if(!cancellation.cancelled){if(cancellation.pending){this.db.audit(actor,'BROKER_CANCEL_REQUEST_PENDING','proposal',id,{brokerOrderId:exec.broker_order_id});return this.get(id);}throw new Error('Broker cancellation not confirmed');}
      this.ledger.cancelOrder(row.order_id!,'V2 confirmed cancellation');this.release(id);
    }
    this.transition(id,'CANCELLED',actor);return this.get(id);
  }
  report(kind:string){
    if(this.reporter){const body=this.reporter(kind);this.onEvent(kind,{body});return body;}
    const sleeves=SLEEVES.map(s=>this.allocation.state(s)),safe=sleeves[0]!;
    const trades=(this.db.raw.prepare("SELECT COUNT(*) AS n FROM orders WHERE strategy_id='SAFE_LONG_TERM' AND created_at>=date('now')").get() as {n:number}).n;
    const material=safe.drawdown>=5||safe.killed||trades>0||kind==='WEEKLY_REPORT';
    const body={kind,mode:this.db.getMode(),simulated:this.db.getMode()==='SIMULATION',at:nowIso(),account:this.db.getSetting('broker_account_v2',null),safeSummary:material?safe:'SAFE: low-turnover monitoring; no material recorded trade/drawdown event.',aggressive:sleeves[1],options:sleeves[2],sleeves:kind==='WEEKLY_REPORT'?sleeves:undefined};
    this.db.raw.prepare('INSERT INTO trading_reports VALUES(?,?,?,?,?)').run(makeId('report'),kind,nowIso().slice(0,10),JSON.stringify(body),nowIso());return body;
  }
  async reconcile(){
    this.db.setSetting('reconciliation_clear',false);
    try{
    const account=await this.broker().account();const mismatches:string[]=[];
    if(!account.agentic||!account.complete||!account.healthy||!this.broker().deterministic)mismatches.push('Broker account scope/completeness/health unverified');
    if(this.db.getMode()!=='SIMULATION'&&account.accountId!==process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID)mismatches.push('Wrong Agentic Account');
    if(Date.now()-Date.parse(account.asOf)>60000||Date.now()-Date.parse(account.asOf)<-5000)mismatches.push('Stale account snapshot');
    // Import only attributable fills from verified scope before comparing broker ownership/cash.
    if(this.db.getMode()!=='SIMULATION'&&mismatches.length===0){
      const pending=this.db.raw.prepare("SELECT proposal_id,broker_order_id FROM executions_v2 WHERE status IN ('PENDING','UNKNOWN_OUTCOME')").all() as Array<{proposal_id:string;broker_order_id:string|null}>;
      for(const e of pending){if(!e.broker_order_id)continue;
        const observed=account.orders.find(o=>o.id===e.broker_order_id);if(observed&&this.get(e.proposal_id).state==='UNKNOWN_OUTCOME'&&['ACCEPTED','PARTIALLY_FILLED','FILLED'].includes(observed.status)){this.transition(e.proposal_id,'BROKER_ACCEPTED','RECONCILIATION',{brokerOrderId:observed.id});this.db.raw.prepare("UPDATE executions_v2 SET status='PENDING' WHERE proposal_id=?").run(e.proposal_id);}
        for(const f of account.fills.filter(f=>f.brokerOrderId===e.broker_order_id)){if(f.fees===null){mismatches.push('Actual broker fill fees require review: '+f.id);continue;}this.applyFill(e.proposal_id,f);}
        const order=account.orders.find(o=>o.id===e.broker_order_id),p=this.get(e.proposal_id),row=this.row(e.proposal_id);
        if(order){const internalOrder=this.db.raw.prepare('SELECT cumulative_filled_quantity FROM orders WHERE id=?').get(row.order_id) as {cumulative_filled_quantity:number};if(Math.abs(order.filledQuantity-internalOrder.cumulative_filled_quantity)>0.000001){mismatches.push('Broker fill history incomplete '+e.broker_order_id);continue;}
          if(['CANCELLED','REJECTED'].includes(order.status)&&!['FILLED','CANCELLED','REJECTED'].includes(p.state)){if(order.status==='REJECTED'&&internalOrder.cumulative_filled_quantity===0)this.ledger.rejectOrder(row.order_id!,'Verified broker rejection','BROKER_REJECTED');else this.ledger.cancelOrder(row.order_id!,'Verified broker terminal status '+order.status);this.release(p.id);this.transition(p.id,order.status==='REJECTED'&&internalOrder.cumulative_filled_quantity===0?'REJECTED':'CANCELLED','RECONCILIATION',{brokerStatus:order.status,brokerOrderId:order.id});}
          if(order.status==='UNKNOWN'||order.status==='FILLED'&&this.get(p.id).state!=='FILLED')mismatches.push('Broker terminal outcome unresolved '+order.id);
        }else if(!['FILLED','CANCELLED','REJECTED'].includes(p.state))mismatches.push('Missing broker order '+e.broker_order_id);
      }
    }
    const unavailableBasis=account.positions.filter(p=>p.averageCost===null).map(p=>p.symbol);
    this.db.setSetting('reconciliation_warnings_v2',unavailableBasis.length?['Historical cost basis unavailable: '+unavailableBasis.join(', ')]:[]);
    if(unavailableBasis.length&&!this.db.getSetting('initial_account_import_v2',null))mismatches.push('Unavailable basis acknowledgement required');
    const internal=this.ledger.aggregatePositions();
    for(const symbol of new Set([...internal.map(p=>p.symbol),...account.positions.map(p=>p.symbol)])){const actual=account.positions.filter(p=>p.symbol===symbol).reduce((n,p)=>n+p.quantity,0),virtual=internal.find(p=>p.symbol===symbol)?.quantity??0;if(Math.abs(actual-virtual)>0.000001)mismatches.push('Equity ownership mismatch: '+symbol);}
    const options=this.db.raw.prepare('SELECT option_id,contracts,collateral,instrument_json,reserved_shares FROM option_positions WHERE contracts<>0').all() as Array<{option_id:string;contracts:number;collateral:number;instrument_json:string;reserved_shares:number}>;
    for(const optionId of new Set([...options.map(p=>p.option_id),...account.options.map(p=>p.optionId)])){const a=account.options.find(p=>p.optionId===optionId),v=options.find(p=>p.option_id===optionId);if(a?.contracts!==v?.contracts||Math.abs((a?.collateral??0)-(v?.collateral??0))>0.01)mismatches.push('Options ownership/collateral mismatch: '+optionId);}
    for(const o of options){const i=JSON.parse(o.instrument_json);if(o.contracts<0&&i.type==='CALL'&&(this.ledger.getPosition('OPTIONS',i.underlying)?.quantity??0)<o.reserved_shares)mismatches.push('Covered call shares missing');}
    const cash=SLEEVES.reduce((n,s)=>n+this.ledger.getCash(s),0);if(Math.abs(cash-account.cash)>0.01||account.buyingPower<0)mismatches.push('Cash/buying-power mismatch');
    const unknown=this.db.raw.prepare("SELECT proposal_id FROM executions_v2 WHERE status IN ('PENDING','UNKNOWN_OUTCOME') AND broker_order_id IS NULL").all() as Array<{proposal_id:string}>;
    for(const e of unknown)mismatches.push('Unknown execution outcome '+e.proposal_id);
    this.ledger.markPrices(account.positions.map(p=>({symbol:p.symbol,price:p.price})));
    for(const o of account.options)this.db.raw.prepare('UPDATE option_positions SET mark_price=?,updated_at=? WHERE option_id=?').run(o.price,nowIso(),o.optionId);
    if(this.db.getMode()!=='SIMULATION'){
      for(const o of account.orders)if(!['FILLED','CANCELLED','REJECTED'].includes(o.status)&&!this.db.raw.prepare('SELECT id FROM executions_v2 WHERE broker_order_id=?').get(o.id))mismatches.push('Unattributed broker order '+o.id);
    }
    this.db.setSetting('reconciliation_clear',mismatches.length===0);this.db.setSetting('last_reconciliation_at',nowIso());this.db.setSetting('broker_account_v2',account);this.db.setSetting('reconciliation_v2',mismatches);
    this.db.setSetting('broker_account_observation_v2',null);
    this.db.setSetting('broker_verification_mode_v2',this.db.getMode());
    if(mismatches.length){this.db.setSetting('global_pause',true);this.db.setSetting('v2_live_activation',false);this.db.setSetting('live_db_confirmation',false);if(this.db.getMode()==='LIVE')this.db.setSetting('operating_mode','READ_ONLY');}
    this.db.audit('RECONCILIATION','V2_RECONCILIATION','account',account.accountId,{mismatches});this.onEvent(mismatches.length?'RECONCILIATION_FAILURE':'RECONCILED',{accountId:account.accountId,mismatches});return {clear:mismatches.length===0,mismatches,account};
    }catch(error){this.db.setSetting('v2_live_activation',false);this.db.setSetting('live_db_confirmation',false);if(this.db.getMode()==='LIVE')this.db.setSetting('operating_mode','READ_ONLY');this.db.setSetting('reconciliation_clear',false);this.db.setSetting('global_pause',true);
      if(error instanceof BrokerBasisUnavailable){
        const a=error.observation,internal=this.ledger.aggregatePositions(),cash=SLEEVES.reduce((n,s)=>n+this.ledger.getCash(s),0);
        const differences=[error.message,...[...new Set([...internal.map(p=>p.symbol),...a.positions.map(p=>p.symbol)])].filter(symbol=>Math.abs((a.positions.find(p=>p.symbol===symbol)?.quantity??0)-(internal.find(p=>p.symbol===symbol)?.quantity??0))>.000001).map(symbol=>'Equity ownership mismatch: '+symbol)];
        if(Math.abs(cash-a.cash)>.01||a.buyingPower<0)differences.push('Cash/buying-power mismatch');
        this.db.setSetting('broker_account_v2',null);this.db.setSetting('broker_account_observation_v2',a);this.db.setSetting('last_reconciliation_at',nowIso());this.db.setSetting('reconciliation_v2',differences);
      }else this.db.setSetting('reconciliation_v2',['Broker verification/reconciliation failed']);
      this.db.audit('RECONCILIATION','V2_RECONCILIATION_FAILED','system',null,{reason:error instanceof Error?error.message:'Invalid broker state'});throw error;}
  }
}
