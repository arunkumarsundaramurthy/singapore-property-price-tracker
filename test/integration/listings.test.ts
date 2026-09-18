import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { IngestResult } from '../../src/collectors/types';
import { ingestListings } from '../../src/listings/ingest';
import { toAsync } from '../support/async';
import { ingestCtx } from '../support/context';
import { connect, makeRun, truncateAll } from './helpers';

const sql = connect();
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

const listing = (id: string, over: Record<string, unknown> = {}) => ({
  source_listing_id: id, listing_type: 'sale', property_type: 'condo', title: `Unit ${id}`,
  project_name: 'THE SAIL', address: '2 Marina Blvd', postal_code: '018987', district: '01',
  bedrooms: 2, bathrooms: 2, floor_area_sqft: 1000, price: 1_500_000, tenure: '99-year',
  built_year: 2008, lat: 1.28, lng: 103.85, url: `https://x.test/${id}`, extra: {}, ...over,
});

async function run(runDate: string, items: unknown[], fetchComplete = true): Promise<IngestResult> {
  const runId = await makeRun(sql, '99co');
  return (await sql.begin((tx) => ingestListings(
    tx, toAsync([{ key: 'page-1', body: JSON.stringify(items) }]),
    ingestCtx(runId, { runDate, fetchComplete }),
    { source: '99co', parsePayload: (p) => JSON.parse(p.body) },
  ))) as IngestResult;
}

const state = async (id: string) => (await sql<{
  status: string; missed: number; first_seen: string; last_seen: string; price: number; psf: number; versions: number;
}[]>`
  select l.status, l.missed_complete_runs as missed, l.first_seen::text, l.last_seen::text,
         l.price::float as price, l.psf::float as psf,
         (select count(*)::int from listing_versions v where v.listing_id = l.id) as versions
  from listings l where source = '99co' and source_listing_id = ${id}`)[0];

describe('ingestListings', () => {
  it('inserts new listings with a first version and computes psf', async () => {
    const res = await run('2026-09-01', [listing('a'), listing('b')]);
    expect(res).toEqual({ fetched: 2, inserted: 2, changed: 0, rejected: 0, complete: true });
    expect(await state('a')).toMatchObject({
      status: 'active', first_seen: '2026-09-01', last_seen: '2026-09-01', psf: 1500, versions: 1,
    });
  });

  it('adds no version for unchanged data, including a same-day re-run', async () => {
    await run('2026-09-01', [listing('a')]);
    const res = await run('2026-09-01', [listing('a')]);
    expect(res).toMatchObject({ inserted: 0, changed: 0 });
    await run('2026-09-02', [listing('a')]);
    expect(await state('a')).toMatchObject({ versions: 1, last_seen: '2026-09-02', first_seen: '2026-09-01' });
  });

  it('adds a version and updates current values when the price changes', async () => {
    await run('2026-09-01', [listing('a')]);
    const res = await run('2026-09-02', [listing('a', { price: 1_400_000 })]);
    expect(res.changed).toBe(1);
    expect(await state('a')).toMatchObject({ price: 1_400_000, versions: 2 });
  });

  it('delists after 2 complete runs without the listing, counting a day only once', async () => {
    await run('2026-09-01', [listing('a'), listing('b')]);
    await run('2026-09-02', [listing('a')]);
    expect(await state('b')).toMatchObject({ status: 'active', missed: 1 });
    await run('2026-09-02', [listing('a')]); // same-day re-run
    expect(await state('b')).toMatchObject({ status: 'active', missed: 1 });
    await run('2026-09-03', [listing('a')]);
    expect(await state('b')).toMatchObject({ status: 'delisted', missed: 2 });
  });

  it('never counts misses after an incomplete fetch', async () => {
    await run('2026-09-01', [listing('a'), listing('b')]);
    const res = await run('2026-09-02', [listing('a')], false);
    expect(res.complete).toBe(false);
    expect(await state('b')).toMatchObject({ status: 'active', missed: 0 });
  });

  it('reactivates a delisted listing that reappears', async () => {
    await run('2026-09-01', [listing('a'), listing('b')]);
    await run('2026-09-02', [listing('a')]);
    await run('2026-09-03', [listing('a')]);
    const res = await run('2026-09-04', [listing('a'), listing('b')]);
    expect(res).toMatchObject({ inserted: 0, changed: 0 });
    expect(await state('b')).toMatchObject({ status: 'active', missed: 0, versions: 1, last_seen: '2026-09-04' });
  });

  it('marks the run incomplete when rejects exceed 5%', async () => {
    await run('2026-09-01', [listing('a'), listing('b')]);
    const items = [...Array.from({ length: 9 }, (_, i) => listing(`n${i}`)), listing('bad', { price: -1 })];
    const res = await run('2026-09-02', items);
    expect(res).toMatchObject({ fetched: 10, rejected: 1, complete: false });
    expect(await state('a')).toMatchObject({ missed: 0 });
  });

  it('marks the run incomplete when size is missing on more than 5%', async () => {
    const items = Array.from({ length: 20 }, (_, i) => listing(`s${i}`, i < 2 ? { floor_area_sqft: null } : {}));
    expect((await run('2026-09-01', items)).complete).toBe(false);
  });

  it('marks the run incomplete when fewer than half the active listings are seen', async () => {
    await run('2026-09-01', Array.from({ length: 10 }, (_, i) => listing(`v${i}`)));
    const res = await run('2026-09-02', [listing('v0'), listing('v1'), listing('v2'), listing('v3')]);
    expect(res.complete).toBe(false);
    expect(await state('v9')).toMatchObject({ status: 'active', missed: 0 });
  });

  it('marks the run incomplete when a page cannot be parsed', async () => {
    const runId = await makeRun(sql, '99co');
    const res = (await sql.begin((tx) => ingestListings(
      tx, toAsync([{ key: 'p1', body: JSON.stringify([listing('a')]) }, { key: 'p2', body: '<html>captcha</html>' }]),
      ingestCtx(runId, { runDate: '2026-09-01' }),
      { source: '99co', parsePayload: (p) => JSON.parse(p.body) },
    ))) as IngestResult;
    expect(res).toMatchObject({ inserted: 1, complete: false });
  });
});
