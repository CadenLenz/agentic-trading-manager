import { z } from 'zod';
import type { TradeProposal } from '../../core/src/types.js';
import { makeId, nowIso } from '../../core/src/utils.js';
import type { AppDatabase } from '../../database/src/database.js';
import type { MarketDataProvider } from '../../market-data/src/provider.js';
import type { CodexRunner } from './codex-runner.js';

const decisionSchema = {
  type: 'object', additionalProperties: false,
  required: ['action', 'confidence', 'thesis', 'timeHorizon', 'riskFactors', 'invalidationConditions', 'requestedCapital', 'requiresImmediateAction', 'rationale'],
  properties: {
    action: { type: 'string', enum: ['BUY', 'SELL', 'HOLD', 'RESEARCH'] }, confidence: { type: 'number', minimum: 0, maximum: 1 }, thesis: { type: 'string' }, timeHorizon: { type: 'string' },
    riskFactors: { type: 'array', items: { type: 'string' } }, invalidationConditions: { type: 'array', items: { type: 'string' } }, requestedCapital: { type: 'number', minimum: 0 }, requiresImmediateAction: { type: 'boolean' }, rationale: { type: 'string' },
  },
};
const decisionValidator = z.object({ action: z.enum(['BUY', 'SELL', 'HOLD', 'RESEARCH']), confidence: z.number().min(0).max(1), thesis: z.string(), timeHorizon: z.string(), riskFactors: z.array(z.string()), invalidationConditions: z.array(z.string()), requestedCapital: z.number().min(0), requiresImmediateAction: z.boolean(), rationale: z.string() });

export class AgentOrchestrator {
  constructor(private readonly database: AppDatabase, private readonly market: MarketDataProvider, private readonly runner: CodexRunner, private readonly workingDirectory: string) {}

  async analyze(strategyId: string, symbol: string, useCodex: boolean): Promise<{ decisionId: string; proposal: TradeProposal; rationale: string; simulatedReasoning: boolean }> {
    if(useCodex)throw new Error('V2 disables the ambient Codex tool surface for trading analysis. Use the persistent OpenAI app-tool agent.');
    const strategy = this.database.getStrategy(strategyId);
    if (!strategy) throw new Error('Strategy not found');
    const normalized = symbol.toUpperCase();
    const quote = await this.market.getQuote(normalized);
    const runId = makeId('run'); const requestId = makeId('analysis'); const started = nowIso();
    this.database.raw.prepare('INSERT INTO agent_runs(id,agent_type,strategy_id,status,task,request_id,metadata_json,started_at) VALUES(?,?,?,?,?,?,?,?)').run(runId, strategy.kind, strategy.id, 'ANALYZING', `Analyze ${normalized}`, requestId, JSON.stringify({ quoteSource: quote.source }), started);
    this.database.raw.prepare('UPDATE strategies SET status=\'ANALYZING\',updated_at=? WHERE id=?').run(nowIso(), strategy.id);
    const context = { strategy: { id: strategy.id, name: strategy.name, kind: strategy.kind, config: strategy.config, allocation: strategy.allocationAmount, cash: strategy.cash }, mode: this.database.getMode(), quote, activeDirectives: this.database.raw.prepare("SELECT type,symbol,value_json,reason,expires_at FROM directives WHERE active=1 AND (strategy_id=? OR strategy_id IS NULL) AND (expires_at IS NULL OR expires_at>?)").all(strategy.id, nowIso()), positions: this.database.raw.prepare('SELECT symbol,quantity,average_cost,market_price FROM strategy_positions WHERE strategy_id=?').all(strategy.id) };
    try {
      const result = useCodex
        ? (await this.runner.run({ requestId, agent: `${strategy.name.toUpperCase()} AGENT`, workingDirectory: this.workingDirectory, schema: decisionSchema, validate: (value) => decisionValidator.parse(value), prompt: `Analyze ${normalized} using this canonical application context: ${JSON.stringify(context)}. This is analysis only. Do not call brokerage order tools. You may use read-only research capabilities. Return a proposal; the deterministic manager will decide whether it can execute.` })).value
        : { action: 'RESEARCH' as const, confidence: 0.63, thesis: `${normalized} meets a simulated review trigger; gather current fundamentals and catalyst evidence before taking risk.`, timeHorizon: strategy.kind === 'DAY_TRADER' ? 'Intraday' : 'Multi-session', riskFactors: ['Simulation quote is not suitable for live execution', 'Catalyst and liquidity require verification'], invalidationConditions: ['Verified market data contradicts the trigger'], requestedCapital: 0, requiresImmediateAction: false, rationale: 'A safe simulation analysis records a structured research decision without creating an order.' };
      const proposal: TradeProposal = { strategyId, symbol: normalized, action: result.action, confidence: result.confidence, thesis: result.thesis, timeHorizon: result.timeHorizon, riskFactors: result.riskFactors, invalidationConditions: result.invalidationConditions, requestedCapital: result.requestedCapital, requiresImmediateAction: result.requiresImmediateAction, marketPrice: quote.price, marketDataAsOf: quote.asOf, sector: 'Unknown', source: 'AGENT' };
      const decisionId = makeId('decision');
      this.database.raw.prepare('INSERT INTO decisions(id,strategy_id,agent_type,request_id,symbol,action,confidence,rationale,proposal_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(decisionId, strategy.id, strategy.kind, requestId, normalized, result.action, result.confidence, result.rationale, JSON.stringify(proposal), 'PROPOSED', nowIso());
      this.database.raw.prepare('UPDATE agent_runs SET status=\'COMPLETED\',duration_ms=?,completed_at=? WHERE id=?').run(Date.now() - new Date(started).getTime(), nowIso(), runId);
      this.database.raw.prepare('UPDATE strategies SET status=?,updated_at=? WHERE id=?').run(strategy.kind === 'DAY_TRADER' ? 'WATCHING' : 'IDLE', nowIso(), strategy.id);
      return { decisionId, proposal, rationale: result.rationale, simulatedReasoning: !useCodex };
    } catch (error) {
      this.database.raw.prepare('UPDATE agent_runs SET status=\'FAILED\',error=?,duration_ms=?,completed_at=? WHERE id=?').run(error instanceof Error ? error.message : String(error), Date.now() - new Date(started).getTime(), nowIso(), runId);
      this.database.raw.prepare('UPDATE strategies SET status=\'ERROR\',updated_at=? WHERE id=?').run(nowIso(), strategy.id);
      throw error;
    }
  }
}
