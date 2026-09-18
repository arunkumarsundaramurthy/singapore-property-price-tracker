import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Payload } from '../../src/archive';
import { createUraPrivateTxnCollector } from '../../src/official/ura-private-txn';
import { FakeFetcher } from '../support/fake-fetcher';
import { toAsync } from '../support/async';
import { ingestCtx } from '../support/context';
import { connect, makeRun, truncateAll } from './helpers';

const sql = connect();
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

const txn = (mmyy: string, price: number, district: string) => ({
  contractDate: mmyy, area: '100', price: String(price), propertyType: 'Condominium', typeOfArea: 'Strata',
  tenure: 'Freehold', floorRange: '06-10', typeOfSale: '3', district, noOfUnits: '1',
});
const batch = (n: number, txns: object[]): Payload => ({
  key: `batch-${n}.json`,
  body: JSON.stringify({ Status: 'Success', Result: [{ project: `P${n}`, street: 'S', marketSegment: 'OCR', x: '1', y: '2', transaction: txns }] }),
});

const collector = createUraPrivateTxnCollector({ fetcher: new FakeFetcher([]), uraAccessKey: 'k' });

const byMonth = () => sql<{ m: string; n: number; total: number }[]>`
  select contract_month::text as m, count(*)::int as n, sum(price)::int as total from ura_private_txn group by 1 order by 1`;

describe('ura-private-txn ingest', () => {
  it('replaces every month except the earliest, across all 4 batches', async () => {
    // Pre-existing data for the earliest month in the window: must survive.
    const seed = await makeRun(sql);
    await sql`insert into ura_private_txn (project, street, market_segment, contract_month, area_sqm, price,
      property_type, type_of_area, tenure, floor_range, type_of_sale, district, no_of_units, ingested_run_id)
      values ('OLD', 'S', 'OCR', '2021-09-01', 100, 999, 'Condominium', 'Strata', 'Freehold', '01-05', 'resale', '01', 1, ${seed}),
             ('OLD', 'S', 'OCR', '2021-09-01', 100, 999, 'Condominium', 'Strata', 'Freehold', '01-05', 'resale', '01', 1, ${seed})`;

    const runId = await makeRun(sql, 'ura-private-txn');
    const payloads = [
      batch(1, [txn('0921', 1, '01'), txn('0826', 100, '01')]),
      batch(2, [txn('0826', 200, '09')]),
      batch(3, [txn('0726', 300, '15')]),
      batch(4, [txn('0726', 400, '22')]),
    ];
    const res = await sql.begin((tx) => collector.ingest(tx, toAsync(payloads), ingestCtx(runId)));
    expect(res).toMatchObject({ fetched: 5, inserted: 4, rejected: 0, complete: true });
    expect(await byMonth()).toEqual([
      { m: '2021-09-01', n: 2, total: 1998 },
      { m: '2026-07-01', n: 2, total: 700 },
      { m: '2026-08-01', n: 2, total: 300 },
    ]);
  });

  it('refuses to replace with fewer than 4 batches (except in dry runs)', async () => {
    const runId = await makeRun(sql);
    const one = [batch(1, [txn('0726', 1, '01'), txn('0826', 1, '01')])];
    await expect(sql.begin((tx) => collector.ingest(tx, toAsync(one), ingestCtx(runId)))).rejects.toThrow(/all 4 batches/);
    await expect(sql.begin((tx) => collector.ingest(tx, toAsync(one), ingestCtx(runId, { dryRun: true })))).resolves.toBeTruthy();
  });
});
