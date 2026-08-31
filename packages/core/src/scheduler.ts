export interface ScheduledTask { id: string; kind: 'INTERVAL' | 'CRON'; expression: number | (() => string); timezone: string; run: () => Promise<void> }

export class Scheduler {
  private readonly tasks: ScheduledTask[] = [];
  private readonly lastRuns = new Map<string, string | number>();
  private readonly running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  every(id: string, intervalMs: number, run: () => Promise<void>): void { this.tasks.push({ id, kind: 'INTERVAL', expression: intervalMs, timezone: 'UTC', run }); }
  cron(id: string, expression: () => string, timezone: string, run: () => Promise<void>): void { this.tasks.push({ id, kind: 'CRON', expression, timezone, run }); }
  start(): void { if (this.timer) return; this.timer = setInterval(() => { void this.tick(); }, 15_000); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick(date = new Date()): Promise<void> {
    await Promise.all(this.tasks.map(async (task) => {
      if (this.running.has(task.id) || !this.due(task, date)) return;
      this.running.add(task.id);
      try { await task.run(); } finally { this.running.delete(task.id); this.lastRuns.set(task.id, task.kind === 'CRON' ? this.minuteKey(date, task.timezone) : Date.now()); }
    }));
  }

  private due(task: ScheduledTask, date: Date): boolean {
    if (task.kind === 'INTERVAL') return Date.now() - Number(this.lastRuns.get(task.id) ?? 0) >= Number(task.expression);
    const key = this.minuteKey(date, task.timezone);
    if (this.lastRuns.get(task.id) === key) return false;
    return cronMatches((task.expression as () => string)(), date, task.timezone);
  }

  private minuteKey(date: Date, timezone: string): string {
    const parts = dateParts(date, timezone);
    return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}-${parts.minute}`;
  }
}

interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }
function dateParts(date: Date, timezone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' });
  const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), weekday: weekdays[values.weekday ?? 'Sun'] ?? 0 };
}

export function cronMatches(expression: string, date: Date, timezone: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const parts = dateParts(date, timezone);
  return fieldMatches(fields[0]!, parts.minute, 0, 59) && fieldMatches(fields[1]!, parts.hour, 0, 23) && fieldMatches(fields[2]!, parts.day, 1, 31) && fieldMatches(fields[3]!, parts.month, 1, 12) && fieldMatches(fields[4]!, parts.weekday, 0, 7, true);
}

function fieldMatches(field: string, value: number, minimum: number, maximum: number, sundayAlias = false): boolean {
  return field.split(',').some((segment) => {
    const [rangePart, stepPart] = segment.split('/'); const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) return false;
    let start = minimum; let end = maximum;
    if (rangePart !== '*') {
      const bounds = rangePart!.split('-').map(Number);
      start = bounds[0] ?? Number.NaN; end = bounds.length === 2 ? bounds[1]! : start;
    }
    const normalizedValue = sundayAlias && value === 0 && start === 7 ? 7 : value;
    return Number.isInteger(start) && Number.isInteger(end) && normalizedValue >= start && normalizedValue <= end && (normalizedValue - start) % step === 0;
  });
}
