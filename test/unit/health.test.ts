import { describe, expect, it, vi } from 'vitest';
import { evaluateHealth, pingHealthcheck } from '../../src/health';
import type { CollectorOutcome } from '../../src/runner';

const outcome = (source: string, kind: 'official' | 'listing', status: CollectorOutcome['status'], error?: string): CollectorOutcome =>
  ({ source, kind, status, runId: 1, mode: 'daily', error });

describe('evaluateHealth', () => {
  it('is ok when official collectors succeed and listings are not failing for 3 runs', () => {
    const report = evaluateHealth(
      [outcome('hdb-resale', 'official', 'success'), outcome('propertyguru', 'listing', 'incomplete')],
      { propertyguru: [{ status: 'incomplete' }, { status: 'success' }, { status: 'failed' }] },
    );
    expect(report).toEqual({ ok: true, reasons: [] });
  });

  it('flags any failed official collector', () => {
    const report = evaluateHealth([outcome('ura-private-txn', 'official', 'failed', 'token')], {});
    expect(report.ok).toBe(false);
    expect(report.reasons[0]).toMatch(/ura-private-txn failed: token/);
  });

  it('flags a listing source with 3 non-successful runs in a row', () => {
    const report = evaluateHealth([], { srx: [{ status: 'incomplete' }, { status: 'failed' }, { status: 'incomplete' }] });
    expect(report.reasons).toEqual(['srx has not completed successfully in its last 3 runs']);
  });
});

describe('pingHealthcheck', () => {
  it('pings the base URL on success and /fail on failure, swallowing errors', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok'));
    await pingHealthcheck('https://hc.test/abc', { ok: true, reasons: [] }, fetchImpl as unknown as typeof fetch);
    await pingHealthcheck('https://hc.test/abc/', { ok: false, reasons: ['x'] }, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual(['https://hc.test/abc', 'https://hc.test/abc/fail']);
    const broken = vi.fn(async () => { throw new Error('offline'); });
    await expect(pingHealthcheck('https://hc.test/abc', { ok: true, reasons: [] }, broken as unknown as typeof fetch)).resolves.toBeUndefined();
  });
});
