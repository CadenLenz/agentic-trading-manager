import type { AppDatabase } from '../../database/src/database.js';
import { makeId, nowIso, parseJson } from '../../core/src/utils.js';

export const JOB_PRIORITY = { CRITICAL_RISK: 100, USER_REQUEST: 80, POSITION_EVENT: 60, MARKET_EVENT: 40, SCHEDULED_REVIEW: 20, BACKGROUND_RESEARCH: 10 } as const;
export interface Job { id: string; type: string; priority: number; status: string; payload: Record<string, unknown>; cancelRequested: boolean }
type Handler = (job: Job, signal: AbortSignal) => Promise<void>;

export class JobQueue {
  private handlers = new Map<string, Handler>();
  private running = false;
  private controller: AbortController | null = null;
  constructor(private readonly database: AppDatabase) {}
  register(type: string, handler: Handler): void { this.handlers.set(type, handler); }
  enqueue(type: string, priority: number, payload: Record<string, unknown>, dedupeKey?: string): string {
    const id = makeId('job');
    try { this.database.raw.prepare('INSERT INTO jobs(id,type,priority,status,dedupe_key,payload_json,created_at) VALUES(?,?,?,?,?,?,?)').run(id, type, priority, 'QUEUED', dedupeKey ?? null, JSON.stringify(payload), nowIso()); }
    catch (error) {
      if (dedupeKey) {
        const existing = this.database.raw.prepare("SELECT id FROM jobs WHERE dedupe_key=? AND status IN ('QUEUED','RUNNING')").get(dedupeKey) as { id: string } | undefined;
        if (existing) return existing.id;
      }
      throw error;
    }
    void this.drain(); return id;
  }
  cancel(id: string): void { this.database.raw.prepare('UPDATE jobs SET cancel_requested=1,status=CASE WHEN status=\'QUEUED\' THEN \'CANCELED\' ELSE status END WHERE id=?').run(id); if (this.controller && this.currentJobId() === id) this.controller.abort(); }
  start(): void { void this.drain(); }
  stop(): void { this.running = false; this.controller?.abort(); }

  private async drain(): Promise<void> {
    if (this.running) return; this.running = true;
    while (this.running) {
      const row = this.database.raw.prepare("SELECT id,type,priority,status,payload_json,cancel_requested FROM jobs WHERE status='QUEUED' ORDER BY priority DESC,created_at ASC LIMIT 1").get() as { id: string; type: string; priority: number; status: string; payload_json: string; cancel_requested: number } | undefined;
      if (!row) break;
      const handler = this.handlers.get(row.type);
      if (!handler) { this.database.raw.prepare('UPDATE jobs SET status=\'FAILED\',completed_at=? WHERE id=?').run(nowIso(), row.id); continue; }
      this.database.raw.prepare('UPDATE jobs SET status=\'RUNNING\',started_at=? WHERE id=?').run(nowIso(), row.id);
      this.controller = new AbortController();
      const job: Job = { id: row.id, type: row.type, priority: row.priority, status: 'RUNNING', payload: parseJson(row.payload_json), cancelRequested: row.cancel_requested === 1 };
      try { await handler(job, this.controller.signal); this.database.raw.prepare('UPDATE jobs SET status=?,completed_at=? WHERE id=?').run(this.controller.signal.aborted ? 'CANCELED' : 'COMPLETED', nowIso(), row.id); }
      catch (error) { this.database.raw.prepare('UPDATE jobs SET status=?,payload_json=?,completed_at=? WHERE id=?').run(this.controller.signal.aborted ? 'CANCELED' : 'FAILED', JSON.stringify({ ...job.payload, error: error instanceof Error ? error.message : String(error) }), nowIso(), row.id); }
      this.controller = null;
    }
    this.running = false;
  }
  private currentJobId(): string | null { const row = this.database.raw.prepare("SELECT id FROM jobs WHERE status='RUNNING' ORDER BY started_at DESC LIMIT 1").get() as { id: string } | undefined; return row?.id ?? null; }
}
