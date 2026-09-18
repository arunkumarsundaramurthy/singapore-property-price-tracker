import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { replacePeriods, VolumeGuardError, type ReplaceSpec } from '../../src/official/replace';
import { connect, makeRun, truncateAll } from './helpers';

const sql = connect();
afterAll(() => sql.end());

const SPEC: ReplaceSpec = {
  table: 'hdb_rental_txn',
  periodColumn: 'rent_approval_month',
  columns: ['rent_approval_month', 'town', 'block', 'street_name', 'flat_type', 'monthly_rent', 'ingested_run_id'],
};

let runId: number;
beforeEach(async () => {
  await truncateAll(sql);
  runId = await makeRun(sql);
});

const row = (month: string, rent: number) => ({
  rent_approval_month: month, town: 'BEDOK', block: '1', street_name: 'BEDOK NTH RD',
  flat_type: '3-ROOM', monthly_rent: rent, ingested_run_id: runId,
});

const monthCounts = async () =>
  sql<{ month: string; n: number; total: number }[]>`
    select rent_approval_month::text as month, count(*)::int as n, sum(monthly_rent)::int as total
    from hdb_rental_txn group by 1 order by 1`;

describe('replacePeriods', () => {
  it('replaces only the given periods and keeps legitimate duplicates', async () => {
    await sql.begin((tx) => replacePeriods(tx, SPEC,
      ['2026-06-01', '2026-07-01'], [row('2026-06-01', 2000), row('2026-07-01', 2100)]));
    const res = await sql.begin((tx) => replacePeriods(tx, SPEC,
      ['2026-07-01', '2026-08-01'],
      [row('2026-07-01', 3000), row('2026-08-01', 3100), row('2026-08-01', 3100)]));
    expect(res).toEqual({ deleted: 1, inserted: 3 });
    expect(await monthCounts()).toEqual([
      { month: '2026-06-01', n: 1, total: 2000 },
      { month: '2026-07-01', n: 1, total: 3000 },
      { month: '2026-08-01', n: 2, total: 6200 },
    ]);
  });

  it('allows a shrink within 5% but refuses a larger one', async () => {
    const hundred = Array.from({ length: 100 }, () => row('2026-08-01', 2000));
    await sql.begin((tx) => replacePeriods(tx, SPEC, ['2026-08-01'], hundred));
    await sql.begin((tx) => replacePeriods(tx, SPEC, ['2026-08-01'], hundred.slice(0, 95)));
    await expect(sql.begin((tx) => replacePeriods(tx, SPEC, ['2026-08-01'], hundred.slice(0, 90))))
      .rejects.toBeInstanceOf(VolumeGuardError);
    expect((await monthCounts())[0].n).toBe(95);
  });

  it('refuses rows outside the declared periods', async () => {
    await expect(sql.begin((tx) => replacePeriods(tx, SPEC, ['2026-08-01'], [row('2026-07-01', 1)])))
      .rejects.toThrow(/outside the replaced periods/);
  });

  it('is a no-op for no periods and inserts in chunks', async () => {
    expect(await sql.begin((tx) => replacePeriods(tx, SPEC, [], []))).toEqual({ deleted: 0, inserted: 0 });
    const many = Array.from({ length: 2500 }, () => row('2026-01-01', 1));
    await sql.begin((tx) => replacePeriods(tx, SPEC, ['2026-01-01'], many));
    expect((await monthCounts())[0].n).toBe(2500);
  });
});
