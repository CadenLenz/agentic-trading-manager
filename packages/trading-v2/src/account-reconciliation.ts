import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {ProposalService} from './proposals.js';
import {SLEEVES,sleeveSchema,type TradingBroker} from './model.js';
import {makeId,nowIso,roundMoney} from '../../core/src/utils.js';
import {weekKey} from './capital.js';

type Account=Awaited<ReturnType<TradingBroker['account']>>;
export const initialAccountImportSchema=z.object({
  token:z.string().length(64),confirmation:z.literal('IMPORT VERIFIED ACCOUNT'),review:z.string().min(20).max(2000),
  assignments:z.array(z.object({symbol:z.string(),strategy:sleeveSchema}).strict()),
  cash:z.object({SAFE_LONG_TERM:z.number().finite().nonnegative(),AGGRESSIVE_STOCKS:z.number().finite().nonnegative(),OPTIONS:z.number().finite().nonnegative()}).strict(),
}).strict();

/** One-time reviewed opening balance, never a repair of an established trading ledger. */
export class AccountReconciliationService {
  constructor(private readonly proposals:ProposalService){}
  private get db(){return this.proposals.db;}
  private guard(a:Account|null){
    if(this.db.getMode()!=='READ_ONLY'||!this.db.getSetting('global_pause',false))throw new Error('Pause the app in Read only before importing an opening balance.');
    if(this.db.getSetting('initial_account_import_v2',null))throw new Error('Opening balance already imported. Later differences require verified broker events, not another reset.');
    if(!a||!a.agentic||!a.complete||!a.healthy||a.accountId!==process.env.ROBINHOOD_AGENTIC_ACCOUNT_ID)throw new Error('A complete, healthy snapshot of the configured account is required.');
    if(!Number.isFinite(Date.parse(a.asOf))||Date.now()-Date.parse(a.asOf)>60000||Date.now()-Date.parse(a.asOf)<-5000)throw new Error('Sync the account to obtain a fresh broker snapshot.');
    if(a.options.length||a.orders.length||a.fills.length)throw new Error('Options or broker order/fill activity require individual verified-event review.');
    if(this.db.getSetting<string[]>('reconciliation_v2',[]).some(x=>!x.startsWith('Equity ownership mismatch: ')&&x!=='Cash/buying-power mismatch'))throw new Error('Resolve broker verification or execution discrepancies before importing an opening balance.');
    if(!Number.isFinite(a.cash)||a.cash<0||!Number.isFinite(a.buyingPower)||a.buyingPower<0||!Number.isFinite(a.netAccountValue)||a.netAccountValue<0)throw new Error('Broker balances are invalid.');
    if(new Set(a.positions.map(p=>p.symbol)).size!==a.positions.length||a.positions.some(p=>!Number.isFinite(p.quantity)||p.quantity<=0||!Number.isFinite(p.averageCost)||p.averageCost<0||!Number.isFinite(p.price)||p.price<=0))throw new Error('Broker holdings need individual review.');
    if(Math.abs(a.cash+a.positions.reduce((n,p)=>n+p.price*p.quantity,0)-a.netAccountValue)>.02)throw new Error('Broker net account value does not match cash and holdings. Review snapshot completeness.');
    const queries=[
      'SELECT 1 FROM strategy_positions LIMIT 1','SELECT 1 FROM strategy_lots LIMIT 1','SELECT 1 FROM fills LIMIT 1',
      'SELECT 1 FROM option_positions LIMIT 1','SELECT 1 FROM position_assignments LIMIT 1',
      "SELECT 1 FROM broker_events WHERE status='APPLIED' LIMIT 1",
      'SELECT 1 FROM virtual_transactions LIMIT 1',
      "SELECT 1 FROM orders WHERE mode<>'SIMULATION' OR status NOT IN ('REJECTED','CANCELED','CANCELLED') LIMIT 1",
      "SELECT 1 FROM executions_v2 LIMIT 1","SELECT 1 FROM capital_reservations WHERE status='ACTIVE' LIMIT 1",
      "SELECT 1 FROM strategy_capital WHERE killed=1 LIMIT 1",
    ];
    if(queries.some(q=>this.db.raw.prepare(q).get()))throw new Error('An established ledger, execution, reservation, or risk latch prevents opening-balance import. Review individual verified broker events.');
  }
  private token(a:Account){return createHash('sha256').update(JSON.stringify({accountId:a.accountId,cash:a.cash,buyingPower:a.buyingPower,positions:[...a.positions].sort((x,y)=>x.symbol.localeCompare(y.symbol)).map(p=>({symbol:p.symbol,quantity:p.quantity,averageCost:p.averageCost,assetClass:p.assetClass})),internalCash:SLEEVES.map(s=>this.proposals.ledger.getCash(s))})).digest('hex');}
  report(){
    const a=this.db.getSetting<Account|null>('broker_account_v2',null),internal=this.proposals.ledger.aggregatePositions();
    const internalCash=roundMoney(SLEEVES.reduce((n,s)=>n+this.proposals.ledger.getCash(s),0));
    let importBlocked:string|null=null;try{this.guard(a);}catch(e){importBlocked=e instanceof Error?e.message:String(e);}
    return {clear:this.db.getSetting('reconciliation_clear',false),lastRunAt:this.db.getSetting<string|null>('last_reconciliation_at',null),mismatches:this.db.getSetting<string[]>('reconciliation_v2',[]),
      positions:[...new Set([...internal.map(p=>p.symbol),...(a?.positions??[]).map(p=>p.symbol)])].map(symbol=>({symbol,internal:internal.find(p=>p.symbol===symbol)?.quantity??0,broker:a?.positions.find(p=>p.symbol===symbol)?.quantity??0})),
      cash:{internal:internalCash,broker:a?.cash??null,buyingPower:a?.buyingPower??null},account:a,
      initialImport:{available:!importBlocked,reason:importBlocked,token:a?this.token(a):null}};
  }
  async importOpeningBalance(input:unknown,actor:string){
    const b=initialAccountImportSchema.parse(input);
    // Re-read broker truth; a stale page cannot import changed quantities, basis, or cash.
    const {account:a}=await this.proposals.reconcile();this.guard(a);
    if(this.token(a)!==b.token)throw new Error('Account balances or holdings changed. Sync and review the updated opening balance.');
    if(b.assignments.length!==a.positions.length||new Set(b.assignments.map(p=>p.symbol)).size!==b.assignments.length||b.assignments.some(p=>!a.positions.some(x=>x.symbol===p.symbol)))throw new Error('Choose exactly one strategy for every broker holding.');
    if(SLEEVES.some(s=>Math.abs(b.cash[s]*100-Math.round(b.cash[s]*100))>0.000001)||Math.abs(SLEEVES.reduce((n,s)=>n+Math.round(b.cash[s]*100),0)-Math.round(a.cash*100))>0)throw new Error('Strategy cash must total verified broker cash exactly, in cents.');
    const before=this.report(),at=nowIso(),reference=makeId('opening');
    this.db.raw.transaction(()=>{
      this.guard(a);
      for(const s of SLEEVES){
        const previous=this.proposals.ledger.getCash(s);
        this.db.raw.prepare('UPDATE strategy_cash SET balance=?,updated_at=? WHERE strategy_id=?').run(b.cash[s],at,s);
        this.db.raw.prepare('INSERT INTO virtual_transactions VALUES(?,?,?,?,?,?,?,?,?,?)').run(makeId('txn'),reference+':'+s,s,'OPENING_BALANCE_CORRECTION',roundMoney(b.cash[s]-previous),null,null,reference,JSON.stringify({accountId:a.accountId,previous,verifiedCash:b.cash[s],review:b.review}),at);
      }
      for(const assignment of b.assignments){
        const p=a.positions.find(p=>p.symbol===assignment.symbol)!;
        this.db.raw.prepare('INSERT INTO strategy_positions VALUES(?,?,?,?,?,?,?,?)').run(assignment.strategy,p.symbol,p.quantity,p.averageCost,p.price,'Unknown',p.assetClass,at);
        this.db.raw.prepare('INSERT INTO strategy_lots VALUES(?,?,?,?,?,?,?,?)').run(makeId('lot'),assignment.strategy,p.symbol,p.quantity,p.averageCost,0,at,reference);
        this.db.raw.prepare('INSERT INTO position_assignments VALUES(?,?,?,?,?,?,?,?)').run(makeId('assignment'),p.symbol,null,assignment.strategy,p.quantity,b.review,actor,at);
      }
      // The opening account value is capital, not a loss from the fictitious setup balance.
      for(const s of SLEEVES){const equity=roundMoney(b.cash[s]+a.positions.filter(p=>b.assignments.find(x=>x.symbol===p.symbol)?.strategy===s).reduce((n,p)=>n+p.price*p.quantity,0));
        this.db.raw.prepare('UPDATE strategy_capital SET starting_capital=?,weekly_starting_capital=?,high_water_mark=?,week_key=? WHERE strategy_id=?').run(equity,equity,equity,weekKey(),s);}
      this.db.setSetting('initial_account_import_v2',{reference,accountId:a.accountId,at,actor});
      this.db.setSetting('reconciliation_clear',false);this.db.setSetting('global_pause',true);
      this.db.audit(actor,'INITIAL_ACCOUNT_IMPORT','account',a.accountId,{before,assignments:b.assignments,cash:b.cash,review:b.review,reference,brokerTradingPerformed:false});
    })();
    return this.proposals.reconcile();
  }
}
