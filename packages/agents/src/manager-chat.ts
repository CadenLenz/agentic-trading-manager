import type { AppDatabase } from '../../database/src/database.js';
import { makeId, nowIso } from '../../core/src/utils.js';

type ChatKind = 'INFORMATIONAL_RESPONSE' | 'PROPOSED_CONFIGURATION_CHANGE' | 'PROPOSED_TRADE' | 'EXECUTED_ACTION';
export interface ManagerReply { kind: ChatKind; message: string; pendingChange?: { id: string; type: string; summary: string; expiresAt: string }; data?: unknown }

export class ManagerChatService {
  constructor(private readonly database: AppDatabase) {}

  interpret(message: string, actor: string): ManagerReply {
    const text = message.trim();
    const lower = text.toLowerCase();
    const strategy = this.matchStrategy(lower);
    const symbol = text.match(/\b[A-Z]{1,5}(?:[.-][A-Z])?\b/)?.[0] ?? null;
    if (/explain why/.test(lower)) {
      const rows = this.database.raw.prepare('SELECT symbol,action,confidence,rationale,status,created_at FROM decisions WHERE (? IS NULL OR strategy_id=?) AND (? IS NULL OR symbol=?) ORDER BY created_at DESC LIMIT 5').all(strategy, strategy, symbol, symbol);
      return { kind: 'INFORMATIONAL_RESPONSE', message: rows.length ? 'Here are the latest audit-ready decision summaries. No configuration or trade was changed.' : 'No matching decision history was found.', data: rows };
    }
    if (/which agent.*best|performed best|compare strateg/.test(lower)) {
      const rows = this.database.raw.prepare(`SELECT s.name,COALESCE(SUM(r.amount),0) AS realizedPnl FROM strategies s LEFT JOIN realized_pnl r ON r.strategy_id=s.id GROUP BY s.id ORDER BY realizedPnl DESC`).all();
      return { kind: 'INFORMATIONAL_RESPONSE', message: 'Performance comparison uses recorded realized results only; it is not a recommendation to reallocate capital.', data: rows };
    }
    if (/undo.*last|revert.*last/.test(lower) && strategy) {
      const current = this.database.getStrategy(strategy); if (!current || current.version <= 1) return { kind: 'INFORMATIONAL_RESPONSE', message: 'There is no earlier strategy version to restore.' };
      return this.pending('REVERT_STRATEGY', { strategyId: strategy, version: current.version - 1 }, actor, `Restore ${current.name} to version ${current.version - 1}`);
    }
    if (/pause/.test(lower) && (strategy || /all|trading/.test(lower))) {
      return this.pending(strategy ? 'SET_STRATEGY_ENABLED' : 'SET_GLOBAL_PAUSE', strategy ? { strategyId: strategy, enabled: false } : { paused: true }, actor, strategy ? `Pause ${this.database.getStrategy(strategy)?.name}` : 'Pause all autonomous trading');
    }
    if (/resume/.test(lower) && (strategy || /all|trading/.test(lower))) {
      return this.pending(strategy ? 'SET_STRATEGY_ENABLED' : 'SET_GLOBAL_PAUSE', strategy ? { strategyId: strategy, enabled: true } : { paused: false }, actor, strategy ? `Resume ${this.database.getStrategy(strategy)?.name}` : 'Resume autonomous trading');
    }
    const allocation = lower.match(/(?:allocation|allocate).*?(\d+(?:\.\d+)?)\s*(%|dollars?|\$)?/);
    if (allocation && strategy) {
      const number = Number(allocation[1]);
      const designated = this.database.getSetting<number>('designated_capital', 50_000);
      const amount = allocation[2] === '%' ? designated * number / 100 : number;
      return this.pending('SET_STRATEGY_ALLOCATION', { strategyId: strategy, amount }, actor, `Set ${this.database.getStrategy(strategy)?.name} allocation to $${amount.toFixed(2)}`);
    }
    if (symbol && /research|look into|don.t trade|don't trade/.test(lower)) {
      return this.pending('CREATE_DIRECTIVE', { strategyId: strategy, type: 'RESEARCH_ONLY', symbol, value: {}, reason: text, expiresAt: null }, actor, `Mark ${symbol} research-only${strategy ? ` for ${this.database.getStrategy(strategy)?.name}` : ' globally'}`);
    }
    if (symbol && /don.t let|don't let|forbid|cannot trade|can.t trade/.test(lower)) {
      return this.pending('CREATE_DIRECTIVE', { strategyId: strategy, type: 'FORBIDDEN_SYMBOL', symbol, value: {}, reason: text, expiresAt: null }, actor, `Forbid trading ${symbol}${strategy ? ` for ${this.database.getStrategy(strategy)?.name}` : ' globally'}`);
    }
    return { kind: 'INFORMATIONAL_RESPONSE', message: 'I can explain decisions, compare strategy results, or prepare confirmable changes such as pauses, allocations, and research-only/forbidden symbols. I will never convert chat text directly into an order.' };
  }

  private pending(type: string, payload: Record<string, unknown>, actor: string, summary: string): ManagerReply {
    const id = makeId('change'); const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    this.database.raw.prepare('INSERT INTO pending_changes(id,type,status,payload_json,requested_by,reason,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(id, type, 'PENDING', JSON.stringify(payload), actor, summary, nowIso(), expiresAt);
    this.database.audit(actor, 'CHANGE_PROPOSED', 'pending_change', id, { type, payload, summary });
    return { kind: 'PROPOSED_CONFIGURATION_CHANGE', message: 'Review and confirm this structured change. Nothing has been changed yet.', pendingChange: { id, type, summary, expiresAt } };
  }

  private matchStrategy(lower: string): string | null {
    if (/day trad/.test(lower)) return 'day-trader';
    if (/aggressive/.test(lower)) return 'aggressive-growth';
    if (/long.?term/.test(lower)) return 'long-term-investor';
    return null;
  }
}
