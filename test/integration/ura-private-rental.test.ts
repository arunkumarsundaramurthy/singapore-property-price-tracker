import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createUraPrivateRentalCollector } from '../../src/official/ura-private-rental';
import { FakeFetcher } from '../support/fake-fetcher';
import { toAsync } from '../support/async';
import { ingestCtx } from '../support/context';
import { connect, makeRun, truncateAll } from './helpers';

const sql = connect();
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

const body = (rents: number[]) => JSON.stringify({
  Status: 'Success',
  Result: [{ project: 'P', street: 'S', x: '1', y: '2', rental: rents.map((rent) => ({
    leaseDate: '0726', propertyType: 'Non-landed Properties', areaSqm: '50-60', areaSqft: '500-600', rent, district: '15', noOfBedRoom: '1',
  })) }],
});

describe('ura-private-rental ingest', () => {
  it('replaces each quarter independently and tolerates an empty quarter', async () => {
    const c = createUraPrivateRentalCollector({ fetcher: new FakeFetcher([]), uraAccessKey: 'k' });
    const r1 = await makeRun(sql);
    await sql.begin((tx) => c.ingest(tx, toAsync([{ key: '26q2.json', body: body([1000, 1100]) }]), ingestCtx(r1)));
    const r2 = await makeRun(sql);
    const res = await sql.begin((tx) => c.ingest(tx, toAsync([
      { key: '26q3.json', body: body([]) },
      { key: '26q2.json', body: body([2000, 2100, 2200]) },
    ]), ingestCtx(r2)));
    expect(res).toMatchObject({ fetched: 3, inserted: 3, complete: true });
    const rows = await sql<{ q: string; n: number }[]>`
      select ref_quarter as q, count(*)::int as n from ura_private_rental group by 1 order by 1`;
    expect(rows).toEqual([{ q: '26q2', n: 3 }]);
  });
});
