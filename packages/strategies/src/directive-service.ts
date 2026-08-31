import type { Directive, DirectiveType } from '../../core/src/types.js';
import { makeId, nowIso, parseJson } from '../../core/src/utils.js';
import type { AppDatabase } from '../../database/src/database.js';

interface DirectiveRow {
  id: string; strategy_id: string | null; type: DirectiveType; symbol: string | null; value_json: string;
  reason: string; expires_at: string | null; active: number; created_at: string;
}

export class DirectiveService {
  constructor(private readonly database: AppDatabase) {}

  create(input: Omit<Directive, 'id' | 'active' | 'createdAt'>, actor: string): Directive {
    if (input.strategyId && !this.database.getStrategy(input.strategyId)) throw new Error('Strategy not found');
    if (input.expiresAt && new Date(input.expiresAt).getTime() <= Date.now()) throw new Error('Directive expiration must be in the future');
    const id = makeId('dir');
    const createdAt = nowIso();
    this.database.raw.prepare('INSERT INTO directives(id,strategy_id,type,symbol,value_json,reason,expires_at,active,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, input.strategyId, input.type, input.symbol, JSON.stringify(input.value), input.reason, input.expiresAt, 1, createdAt);
    this.database.audit(actor, 'DIRECTIVE_CREATED', 'directive', id, input);
    return { id, ...input, active: true, createdAt };
  }

  list(strategyId?: string, includeInactive = false): Directive[] {
    this.expireDue();
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (strategyId) { clauses.push('(strategy_id=? OR strategy_id IS NULL)'); params.push(strategyId); }
    if (!includeInactive) clauses.push('active=1');
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.raw.prepare(`SELECT * FROM directives ${where} ORDER BY created_at DESC`).all(...params) as DirectiveRow[];
    return rows.map(this.map);
  }

  deactivate(id: string, actor: string): void {
    const result = this.database.raw.prepare('UPDATE directives SET active=0 WHERE id=? AND active=1').run(id);
    if (result.changes !== 1) throw new Error('Active directive not found');
    this.database.audit(actor, 'DIRECTIVE_DEACTIVATED', 'directive', id, {});
  }

  matching(strategyId: string, symbol: string): Directive[] {
    return this.list(strategyId).filter((directive) => directive.symbol === null || directive.symbol === symbol);
  }

  expireDue(): number {
    const result = this.database.raw.prepare('UPDATE directives SET active=0 WHERE active=1 AND expires_at IS NOT NULL AND expires_at<=?').run(nowIso());
    return result.changes;
  }

  private map = (row: DirectiveRow): Directive => ({
    id: row.id, strategyId: row.strategy_id, type: row.type, symbol: row.symbol, value: parseJson<Record<string, unknown>>(row.value_json),
    reason: row.reason, expiresAt: row.expires_at, active: row.active === 1, createdAt: row.created_at,
  });
}
