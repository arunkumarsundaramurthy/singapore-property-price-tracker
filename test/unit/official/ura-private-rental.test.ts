import { describe, expect, it } from 'vitest';
import type { Payload } from '../../../src/archive';
import { createUraPrivateRentalCollector, parseUraRentalJson } from '../../../src/official/ura-private-rental';
import { fetchCtx } from '../../support/context';
import { FakeFetcher } from '../../support/fake-fetcher';

// Shape from URA's API documentation (verified 2026-09-18).
const SAMPLE = JSON.stringify({
  Status: 'Success',
  Result: [
    { project: 'THOMSON RISE ESTATE', street: 'JALAN BERJAYA', y: '37250.51289984', x: '29360.42681773',
      rental: [{ leaseDate: '0314', propertyType: 'Detached House', areaSqm: '150-200', areaSqft: '1500-2000', rent: 4300, district: '20' }] },
    { project: 'THE ESPIRA', street: 'LORONG L TELOK KURAU', y: '32747.03', x: '37045.35',
      rental: [
        { leaseDate: '0314', propertyType: 'Non-landed Properties', areaSqm: '100-110', areaSqft: '1100-1200', rent: 3100, district: '15', noOfBedRoom: '3' },
        { leaseDate: '0314', propertyType: 'Non-landed Properties', areaSqm: '50-60', areaSqft: '500-600', rent: 0, district: '15', noOfBedRoom: '1' },
      ] },
  ],
});

describe('parseUraRentalJson', () => {
  it('flattens rentals and tags the quarter', () => {
    const out = parseUraRentalJson(SAMPLE, '14q1');
    expect(out.rejected).toBe(1);
    expect(out.rows[0]).toEqual({
      project: 'THOMSON RISE ESTATE', street: 'JALAN BERJAYA', x: 29360.42681773, y: 37250.51289984,
      ref_quarter: '14q1', lease_month: '2014-03-01', property_type: 'Detached House', district: '20',
      area_sqm_range: '150-200', area_sqft_range: '1500-2000', no_of_bedroom: null, rent: 4300,
    });
    expect(out.rows[1]).toMatchObject({ no_of_bedroom: 3, rent: 3100 });
  });
});

describe('ura-private-rental fetch', () => {
  async function keys(options: Parameters<typeof fetchCtx>[0]) {
    const fetcher = new FakeFetcher([
      [/insertNewToken/, JSON.stringify({ Status: 'Success', Result: 't' })],
      [/invokeUraDS/, JSON.stringify({ Status: 'Success', Result: [] })],
    ]);
    const out: Payload[] = [];
    await createUraPrivateRentalCollector({ fetcher, uraAccessKey: 'k' })
      .fetch(fetchCtx(options, '2026-09-18'), async (p) => { out.push(p); });
    return out.map((p) => p.key);
  }

  it('daily fetches current and previous quarter; backfill fetches 21', async () => {
    expect(await keys({})).toEqual(['26q3.json', '26q2.json']);
    const bf = await keys({ backfill: true });
    expect(bf).toHaveLength(21);
    expect(bf.at(-1)).toBe('21q3.json');
  });
});
