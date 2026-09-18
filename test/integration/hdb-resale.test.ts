import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { IngestResult } from '../../src/collectors/types';
import { createHdbResaleCollector } from '../../src/official/hdb-resale';
import { FakeFetcher } from '../support/fake-fetcher';
import { toAsync } from '../support/async';
import { ingestCtx } from '../support/context';
import { connect, makeRun, truncateAll } from './helpers';

const sql = connect();
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

const HEADER = 'month,town,flat_type,block,street_name,storey_range,floor_area_sqm,flat_model,lease_commence_date,remaining_lease,resale_price';
const csv = (rows: Array<[string, number]>) =>
  [HEADER, ...rows.map(([m, p]) => `${m},ANG MO KIO,3 ROOM,108,ANG MO KIO AVE 4,01 TO 03,67,New Generation,1978,60 years 07 months,${p}`)].join('\n');

const collector = createHdbResaleCollector({ fetcher: new FakeFetcher([]) });

async function ingest(body: string, backfill: boolean): Promise<IngestResult> {
  const runId = await makeRun(sql, 'hdb-resale');
  return (await sql.begin((tx) =>
    collector.ingest(tx, toAsync([{ key: 'x.csv', body }]), ingestCtx(runId, { backfill })))) as IngestResult;
}

const byMonth = () => sql<{ month: string; n: number; price: number }[]>`
  select month::text as month, count(*)::int as n, max(resale_price)::int as price
  from hdb_resale_txn group by 1 order by 1`;

describe('hdb-resale ingest', () => {
  it('backfill replaces every month; daily replaces only the latest 3 months', async () => {
    const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
    const r1 = await ingest(csv(months.map((m) => [m, 100_000])), true);
    expect(r1).toEqual({ fetched: 5, inserted: 5, changed: 0, rejected: 0, complete: true });

    const r2 = await ingest(csv([...months.map((m): [string, number] => [m, 200_000]), ['2026-08', 200_000]]), false);
    expect(r2.inserted).toBe(4);
    expect(await byMonth()).toEqual([
      { month: '2026-04-01', n: 1, price: 100_000 },
      { month: '2026-05-01', n: 1, price: 100_000 },
      { month: '2026-06-01', n: 1, price: 200_000 },
      { month: '2026-07-01', n: 1, price: 200_000 },
      { month: '2026-08-01', n: 2, price: 200_000 },
    ]);
  });

  it('fails without writing when more than 5% of rows are invalid', async () => {
    const bad = `${csv([['2026-08', 1]])}\n2026-08,ANG MO KIO,3 ROOM,1,X,01 TO 03,67,Improved,1978,,`;
    await expect(ingest(bad, false)).rejects.toThrow(/failed validation/);
    expect(await byMonth()).toEqual([]);
  });

  it('fails on a payload with no valid rows', async () => {
    await expect(ingest(HEADER, false)).rejects.toThrow(/no valid rows/);
  });
});
