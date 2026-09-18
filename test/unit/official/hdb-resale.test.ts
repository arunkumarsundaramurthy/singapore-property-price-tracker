import { describe, expect, it } from 'vitest';
import { selectRecentMonths } from '../../../src/official/datagovsg-collector';
import { createHdbResaleCollector, parseHdbResaleCsv } from '../../../src/official/hdb-resale';
import type { Payload } from '../../../src/archive';
import { fetchCtx } from '../../support/context';
import { FakeFetcher } from '../../support/fake-fetcher';

// Real rows sampled from data.gov.sg on 2026-09-18.
const CURRENT = `month,town,flat_type,block,street_name,storey_range,floor_area_sqm,flat_model,lease_commence_date,remaining_lease,resale_price
2017-01,ANG MO KIO,2 ROOM,406,ANG MO KIO AVE 10,10 TO 12,44,Improved,1979,61 years 04 months,232000
2017-01,ANG MO KIO,3 ROOM,108,ANG MO KIO AVE 4,01 TO 03,67,New Generation,1978,60 years 07 months,250000`;
const Y1990 = `month,town,flat_type,block,street_name,storey_range,floor_area_sqm,flat_model,lease_commence_date,resale_price
1990-01,ANG MO KIO,1 ROOM,309,ANG MO KIO AVE 1,10 TO 12,31,IMPROVED,1977,9000`;
const Y2015 = `month,town,flat_type,block,street_name,storey_range,floor_area_sqm,flat_model,lease_commence_date,remaining_lease,resale_price
2015-01,ANG MO KIO,3 ROOM,174,ANG MO KIO AVE 4,07 TO 09,60,Improved,1986,70,255000`;

describe('parseHdbResaleCsv', () => {
  it('parses current, pre-2015 (no remaining_lease) and 2015-2016 formats', () => {
    expect(parseHdbResaleCsv(CURRENT).rows[1]).toEqual({
      month: '2017-01-01', town: 'ANG MO KIO', flat_type: '3 ROOM', block: '108', street_name: 'ANG MO KIO AVE 4',
      storey_range: '01 TO 03', floor_area_sqm: 67, flat_model: 'New Generation', lease_commence_year: 1978,
      remaining_lease: '60 years 07 months', resale_price: 250000,
    });
    expect(parseHdbResaleCsv(Y1990).rows[0]).toMatchObject({ month: '1990-01-01', remaining_lease: null, resale_price: 9000 });
    expect(parseHdbResaleCsv(Y2015).rows[0]).toMatchObject({ remaining_lease: '70' });
  });

  it('rejects rows with missing price or bad month', () => {
    const csv = `${CURRENT}\n2017-1,ANG MO KIO,3 ROOM,1,X,01 TO 03,67,Improved,1978,,250000\n2017-01,ANG MO KIO,3 ROOM,1,X,01 TO 03,67,Improved,1978,,`;
    const out = parseHdbResaleCsv(csv);
    expect(out.rows).toHaveLength(2);
    expect(out.rejected).toBe(2);
  });
});

describe('selectRecentMonths', () => {
  it('keeps the latest N months present, or all when null', () => {
    const months = ['2026-08-01', '2026-04-01', '2026-06-01', '2026-07-01', '2026-06-01'];
    expect(selectRecentMonths(months, 3)).toEqual(['2026-06-01', '2026-07-01', '2026-08-01']);
    expect(selectRecentMonths(months, null)).toEqual(['2026-04-01', '2026-06-01', '2026-07-01', '2026-08-01']);
    expect(selectRecentMonths([], 3)).toEqual([]);
  });
});

describe('hdb-resale fetch', () => {
  const fakeDataGov = () => new FakeFetcher([
    [/initiate-download$/, JSON.stringify({ code: 0, data: {} })],
    [/poll-download$/, (url) => JSON.stringify({ code: 0, data: { status: 'DOWNLOAD_SUCCESS', url: `https://s3.test/${url.split('/').at(-2)}` } })],
    [/^https:\/\/s3\.test\//, (url) => `csv:${url.split('/').at(-1)}`],
  ]);
  const deps = (fetcher: FakeFetcher) => ({ fetcher, dataGovSg: { sleep: async () => {}, pollIntervalMs: 0 } });

  async function keys(options: Parameters<typeof fetchCtx>[0]) {
    const fetcher = fakeDataGov();
    const emitted: Payload[] = [];
    const res = await createHdbResaleCollector(deps(fetcher)).fetch(fetchCtx(options), async (p) => { emitted.push(p); });
    expect(res.complete).toBe(true);
    return emitted.map((p) => p.key);
  }

  it('daily fetches only the current dataset', async () => {
    expect(await keys({})).toEqual(['d_8b84c4ee58e3cfc0ece0d773c8ca6abc.csv']);
  });

  it('backfill fetches historical datasets oldest first, then current; limit caps it', async () => {
    expect(await keys({ backfill: true })).toEqual([
      'd_ebc5ab87086db484f88045b47411ebc5.csv', 'd_43f493c6c50d54243cc1eab0df142d6a.csv',
      'd_2d5ff9ea31397b66239f245f57751537.csv', 'd_ea9ed51da2787afaf8e51f827c304208.csv',
      'd_8b84c4ee58e3cfc0ece0d773c8ca6abc.csv',
    ]);
    expect(await keys({ backfill: true, limit: 2 })).toHaveLength(2);
  });
});
