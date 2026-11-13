import { describe, expect, it, vi } from 'vitest';
import { ChannelSender, SendError, TEST_SENDING } from '../src/channels/sender.js';

const db = { query: async () => ({ rows: [{ day: 0, minute: 0, age: 30 }] }) } as never;

describe('a send that never answers', () => {
  it('times out instead of blocking the channel: the caller gets "try again" and the next message goes out', async () => {
    vi.useFakeTimers();
    try {
      const s = new ChannelSender(db, () => Date.now(), async () => undefined);
      const hung = s.run('ch', TEST_SENDING, () => new Promise<never>(() => undefined), { maxWaitMs: 8_000 });
      const hungErr = hung.catch((e: Error) => e);
      const next = s.run('ch', TEST_SENDING, async () => 'sent', { maxWaitMs: 8_000 });
      await vi.advanceTimersByTimeAsync(46_000);            // the platform call's own limit
      expect(String(await hungErr)).toMatch(/send_timeout|send_throttled/);
      expect(await next).toBe('sent');                        // the lane moved on
      const third = s.run('ch', TEST_SENDING, async () => 'ok', { maxWaitMs: 8_000 });
      await vi.advanceTimersByTimeAsync(10);
      expect(await third).toBe('ok');
    } finally { vi.useRealTimers(); }
  });

  it('a caller never waits forever behind a stuck queue', async () => {
    vi.useFakeTimers();
    try {
      const s = new ChannelSender(db, () => Date.now(), async () => undefined);
      void s.run('c2', TEST_SENDING, () => new Promise<never>(() => undefined), { maxWaitMs: 1_000 }).catch(() => undefined);
      const waiting = s.run('c2', TEST_SENDING, async () => 'late', { maxWaitMs: 1_000 }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(60_000);
      const r = await waiting;
      expect(r === 'late' || (r instanceof SendError && r.code === 'send_throttled')).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
