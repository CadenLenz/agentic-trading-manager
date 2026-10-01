import { tradeProposalSchema } from '../../core/src/schemas.js';
import type { TradeProposal } from '../../core/src/types.js';
import { makeId, nowIso } from '../../core/src/utils.js';
import type { AppDatabase } from '../../database/src/database.js';
import type { VirtualPortfolioLedger } from '../../ledger/src/virtual-ledger.js';
import type { RiskEngine } from '../../risk/src/risk-engine.js';
import type { RobinhoodMcpAdapter } from '../../robinhood/src/adapter.js';
import type { SimulationBroker } from './simulation-broker.js';

export interface ExecutionResult { orderId: string | null; status: string; proposal: TradeProposal; risk: ReturnType<RiskEngine['evaluate']>; fill?: { realizedPnl: number|null; cash: number }; broker?: Record<string, unknown> }

export class ExecutionEngine {
  constructor(private readonly database: AppDatabase, private readonly ledger: VirtualPortfolioLedger, private readonly risk: RiskEngine, private readonly simulation: SimulationBroker, private readonly robinhood: RobinhoodMcpAdapter) {}

  async execute(input: unknown, idempotencyKey: string, actor = 'AGENT_MANAGER'): Promise<ExecutionResult> {
    const proposal = tradeProposalSchema.parse(input) as TradeProposal;
    if(this.database.getSetting('stopped',false))throw new Error('STOP latch blocks execution');
    if(this.database.getMode()!=='SIMULATION'||proposal.orderIntent?.assetType==='OPTION'||proposal.strategyId==='OPTIONS')throw new Error('Legacy execution is Simulation equity-only. Use the V2 proposal lifecycle.');
    const existing = this.database.raw.prepare('SELECT id,status FROM orders WHERE idempotency_key=?').get(idempotencyKey) as { id: string; status: string } | undefined;
    if (existing) return { orderId: existing.id, status: existing.status, proposal, risk: { approved: existing.status !== 'REJECTED', violations: [], evaluatedAt: nowIso() } };
    const riskDecision = this.risk.evaluate(proposal, this.risk.defaultContext());
    if (proposal.action === 'HOLD' || proposal.action === 'RESEARCH') {
      this.recordDecision(proposal, riskDecision.approved ? 'RECORDED' : 'REJECTED', riskDecision);
      return { orderId: null, status: riskDecision.approved ? 'RECORDED' : 'REJECTED', proposal, risk: riskDecision };
    }
    if (!proposal.orderIntent) throw new Error('Validated trade proposal is missing order intent');
    const orderId = this.ledger.createOrder({ idempotencyKey, strategyId: proposal.strategyId, symbol: proposal.symbol, side: proposal.orderIntent.side, quantity: proposal.orderIntent.quantity, orderType: proposal.orderIntent.orderType, ...(proposal.orderIntent.limitPrice !== undefined ? { limitPrice: proposal.orderIntent.limitPrice } : {}), ...(proposal.orderIntent.stopPrice !== undefined ? { stopPrice: proposal.orderIntent.stopPrice } : {}), mode: this.database.getMode(), source: proposal.source, sector: proposal.sector ?? 'Unknown', assetType: proposal.orderIntent.assetType });
    if (!riskDecision.approved) {
      this.ledger.rejectOrder(orderId, riskDecision.violations.map((violation) => violation.message).join('; '), 'RISK_REJECTED');
      this.recordDecision(proposal, 'RISK_REJECTED', riskDecision);
      return { orderId, status: 'REJECTED', proposal, risk: riskDecision };
    }
    const mode = this.database.getMode();
    if (mode === 'SIMULATION') {
      const applied = this.simulation.execute(orderId, proposal);
      this.recordDecision(proposal, 'EXECUTED_SIMULATION', { ...riskDecision, fill: applied });
      this.database.audit(actor, 'SIMULATION_ORDER_EXECUTED', 'order', orderId, { proposal, fill: applied });
      return { orderId, status: applied.orderStatus, proposal, risk: riskDecision, fill: { realizedPnl: applied.realizedPnl, cash: applied.cash } };
    }
    if (mode === 'READ_ONLY') {
      this.ledger.rejectOrder(orderId, 'READ_ONLY mode blocks placement', 'READ_ONLY_MODE');
      return { orderId, status: 'REJECTED', proposal, risk: riskDecision };
    }
    const request = { clientOrderId: orderId, symbol: proposal.symbol, side: proposal.orderIntent.side, quantity: proposal.orderIntent.quantity, orderType: proposal.orderIntent.orderType, timeInForce: proposal.orderIntent.timeInForce, ...(proposal.orderIntent.limitPrice !== undefined ? { limitPrice: proposal.orderIntent.limitPrice } : {}), ...(proposal.orderIntent.stopPrice !== undefined ? { stopPrice: proposal.orderIntent.stopPrice } : {}), assetType: proposal.orderIntent.assetType };
    const preview = await this.robinhood.previewOrder(request);
    try {
      const broker = await this.robinhood.placeOrder(request);
      this.ledger.updateOrder(orderId, broker.status, broker.brokerOrderId);
      this.recordDecision(proposal, 'SUBMITTED_LIVE', { ...riskDecision, preview, broker });
      return { orderId, status: broker.status, proposal, risk: riskDecision, broker: broker.raw };
    } catch (error) {
      this.ledger.updateOrder(orderId, 'UNKNOWN', undefined, { message: error instanceof Error ? error.message : String(error), requiresReconciliation: true });
      this.database.setSetting('reconciliation_clear', false);
      this.database.audit(actor, 'LIVE_ORDER_OUTCOME_UNKNOWN', 'order', orderId, { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private recordDecision(proposal: TradeProposal, status: string, outcome: unknown): void {
    this.database.raw.prepare('INSERT INTO decisions(id,strategy_id,agent_type,request_id,symbol,action,confidence,rationale,proposal_json,outcome_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(makeId('decision'), proposal.strategyId, proposal.source === 'USER' ? 'MANAGER' : proposal.strategyId.toUpperCase(), null, proposal.symbol, proposal.action, proposal.confidence, proposal.thesis, JSON.stringify(proposal), JSON.stringify(outcome), status, nowIso());
  }
}
