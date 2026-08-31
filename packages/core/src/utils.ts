import { createHash, randomUUID } from 'node:crypto';

export const nowIso = (): string => new Date().toISOString();
export const makeId = (prefix: string): string => `${prefix}_${randomUUID()}`;
export const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
export const roundQuantity = (value: number): number => Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
export const parseJson = <T>(value: string): T => JSON.parse(value) as T;
export const stableHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function diffRecords(previous: Record<string, unknown>, next: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of keys) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) diff[key] = { from: previous[key], to: next[key] };
  }
  return diff;
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|secret|password|cookie|authorization/i.test(key) ? '[REDACTED]' : redact(item)]));
  }
  return value;
}
