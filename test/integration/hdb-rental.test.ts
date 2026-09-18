import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHdbRentalCollector } from '../../src/official/hdb-rental';
import { FakeFetcher } from '../support/fake-fetcher';
import { toAsync } from '../support/async';
import { ingestCtx } from '../support/context';
import { connect, makeRun, truncateAll } from './helpers';

const sql = connect();
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

const csv = (months: string[], rent: number) => ['rent_approval_date,town,block,street_name,flat_type,monthly_rent',
  ...months.map((m) => `${m},BEDOK,1,BEDOK NTH RD,3-ROOM,${rent}`)].join('\n');

describe('hdb-rental ingest', () => {
  it('daily replaces the latest 3 months only', async () => {
    const c = createHdbRentalCollector({ fetcher: new FakeFetcher([]) });
    const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
    const run1 = await makeRun(sql, 'hdb-rental');
    await sql.begin((tx) => c.ingest(tx, toAsync([{ key: 'a', body: csv(months, 2000) }]), ingestCtx(run1, { backfill: true })));
    const run2 = await makeRun(sql, 'hdb-rental');
    await sql.begin((tx) => c.ingest(tx, toAsync([{ key: 'b', body: csv(months, 2500) }]), ingestCtx(run2)));
    const rows = await sql<{ m: string; rent: number }[]>`
      select rent_approval_month::text as m, monthly_rent::int as rent from hdb_rental_txn order by 1`;
    expect(rows.map((r) => r.rent)).toEqual([2000, 2000, 2500, 2500, 2500]);
  });
});
