import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { RawArchive } from '../../src/archive';
import type { Collector } from '../../src/collectors/types';
import { reprocess, runAll, runCollector, type RunnerDeps } from '../../src/runner';
import { lastRuns, recentRuns } from '../../src/runs';
import { silentLogger } from '../support/context';
import { connect, truncateAll } from './helpers';

const sql = connect();
afterAll(() => sql.end());

let deps: RunnerDeps;
beforeEach(async () => {
  await truncateAll(sql);
  const root = await mkdtemp(path.join(tmpdir(), 'runner-'));
  deps = { sql, archive: new RawArchive(root), logger: silentLogger, now: () => new Date('2026-09-18T02:00:00Z') };
});

const opts = { backfill: false, dryRun: false };

function fake(overrides: Partial<Collector> & { name: string }): Collector {
  return {
    kind: 'official',
    async fetch(_ctx, emit) {
      await emit({ key: 'a', body: '1' });
      await emit({ key: 'b', body: '2' });
      return { complete: true };
    },
    async ingest(tx, payloads) {
      let n = 0;
      for await (const _ of payloads) {
        n++;
        await tx`insert into runs (source, mode) values ('side-effect', 'x')`;
      }
      return { fetched: n, inserted: n, changed: 0, rejected: 0, complete: true };
    },
    ...overrides,
  };
}

const sideEffects = async () =>
  (await sql<{ n: number }[]>`select count(*)::int as n from runs where source = 'side-effect'`)[0].n;

describe('runner', () => {
  it('fetches, archives, ingests and records a successful run', async () => {
    const out = await runCollector(deps, fake({ name: 'a' }), opts);
    expect(out).toMatchObject({ source: 'a', status: 'success', mode: 'daily', result: { fetched: 2 } });
    const [run] = (await recentRuns(sql, 7)).filter((r) => r.source === 'a');
    expect(run).toMatchObject({ status: 'success', fetched: 2, inserted: 2, mode: 'daily' });
    expect(run.finished_at).toBeInstanceOf(Date);
    expect((await deps.archive.readManifest('a', '2026-09-18'))?.complete).toBe(true);
    expect(await sideEffects()).toBe(2);
  });

  it('isolates failures: a throwing collector is recorded and the next still runs', async () => {
    const broken = fake({ name: 'broken', async fetch() { throw new Error('site down'); } });
    const outcomes = await runAll(deps, [broken, fake({ name: 'ok' })], opts);
    expect(outcomes.map((o) => [o.source, o.status])).toEqual([['broken', 'failed'], ['ok', 'success']]);
    expect(outcomes[0].error).toBe('site down');
    const [run] = await lastRuns(sql, 'broken', 1);
    expect(run).toMatchObject({ status: 'failed', error: 'site down' });
  });

  it('rolls back ingest writes when ingest throws', async () => {
    const c = fake({
      name: 'half',
      async ingest(tx) {
        await tx`insert into runs (source, mode) values ('side-effect', 'x')`;
        throw new Error('bad data');
      },
    });
    const out = await runCollector(deps, c, opts);
    expect(out.status).toBe('failed');
    expect(await sideEffects()).toBe(0);
  });

  it('dry run ingests but rolls back and removes its archive', async () => {
    const out = await runCollector(deps, fake({ name: 'dry' }), { ...opts, dryRun: true });
    expect(out).toMatchObject({ status: 'success', mode: 'dry-run', result: { fetched: 2 } });
    expect(await sideEffects()).toBe(0);
    expect(await deps.archive.labels('dry')).toEqual([]);
  });

  it('passes fetch completeness to ingest and records incomplete runs', async () => {
    const seen: boolean[] = [];
    const c = fake({
      name: 'partial',
      kind: 'listing',
      async fetch(_ctx, emit) { await emit({ key: 'p1', body: '[]' }); return { complete: false }; },
      async ingest(_tx, payloads, ctx) {
        for await (const _ of payloads) { /* drain */ }
        seen.push(ctx.fetchComplete);
        return { fetched: 1, inserted: 0, changed: 0, rejected: 0, complete: ctx.fetchComplete };
      },
    });
    const out = await runCollector(deps, c, opts);
    expect(seen).toEqual([false]);
    expect(out.status).toBe('incomplete');
  });

  it('runs official collectors before listing collectors', async () => {
    const order: string[] = [];
    const mk = (name: string, kind: Collector['kind']) =>
      fake({ name, kind, async fetch() { order.push(name); return { complete: true }; } });
    await runAll(deps, [mk('l1', 'listing'), mk('o1', 'official'), mk('l2', 'listing'), mk('o2', 'official')], opts);
    expect(order).toEqual(['o1', 'o2', 'l1', 'l2']);
  });

  it('uses a backfill label and mode', async () => {
    const out = await runCollector(deps, fake({ name: 'bf' }), { ...opts, backfill: true });
    expect(out.mode).toBe('backfill');
    expect(await deps.archive.labels('bf')).toEqual(['2026-09-18-backfill']);
  });

  it('reprocess re-ingests archived payloads from a date onward', async () => {
    const c = fake({ name: 'rp' });
    await runCollector(deps, c, opts);
    const outcomes = await reprocess(deps, c, '2026-09-01');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ mode: 'reprocess', status: 'success', result: { fetched: 2 } });
    expect(await sideEffects()).toBe(4);
    expect(await reprocess(deps, c, '2026-09-19')).toEqual([]);
  });
});
