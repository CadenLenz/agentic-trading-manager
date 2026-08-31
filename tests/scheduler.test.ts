import { describe, expect, it } from 'vitest';
import { cronMatches, Scheduler } from '../packages/core/src/scheduler.js';

describe('Scheduler', () => {
  it('matches configured cron expressions in the strategy timezone', () => {
    const mondayAtTenEastern = new Date('2026-08-31T14:00:00.000Z');
    expect(cronMatches('0 10 * * 1-5', mondayAtTenEastern, 'America/New_York')).toBe(true);
    expect(cronMatches('30 10 * * 1-5', mondayAtTenEastern, 'America/New_York')).toBe(false);
  });

  it('deduplicates a cron task within the same minute', async () => {
    const scheduler = new Scheduler();
    let runs = 0;
    scheduler.cron('review', () => '* * * * *', 'UTC', async () => { runs += 1; });
    const time = new Date('2026-08-31T14:00:05.000Z');
    await scheduler.tick(time);
    await scheduler.tick(new Date('2026-08-31T14:00:45.000Z'));
    expect(runs).toBe(1);
  });
});
