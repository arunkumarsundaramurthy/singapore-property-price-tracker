import { describe, expect, it } from 'vitest';
import { parseUraTxnJson } from '../../../src/official/ura-private-txn';

// Shape from URA's API documentation (verified 2026-09-18).
const SAMPLE = JSON.stringify({
  Status: 'Success',
  Result: [{
    project: 'TURQUOISE', marketSegment: 'CCR', street: 'COVE DRIVE',
    y: '24997.821719180001', x: '28392.530515570001',
    transaction: [
      { contractDate: '0715', area: '203', price: '2900000', propertyType: 'Condominium', typeOfArea: 'Strata',
        tenure: '99 yrs lease commencing from 2007', floorRange: '01-05', typeOfSale: '3', district: '04', noOfUnits: '1' },
      { contractDate: '0116', area: '200', price: '3014200', nettPrice: '2950000', propertyType: 'Condominium', typeOfArea: 'Strata',
        tenure: '99 yrs lease commencing from 2007', floorRange: '01-05', typeOfSale: '1', district: '04', noOfUnits: '1' },
      { contractDate: '1316', area: '200', price: '1', propertyType: 'Condominium', typeOfArea: 'Strata',
        tenure: 'x', floorRange: '-', typeOfSale: '9', district: '04', noOfUnits: '1' },
    ],
  }],
});

describe('parseUraTxnJson', () => {
  it('flattens projects into transaction rows with decoded fields', () => {
    const out = parseUraTxnJson(SAMPLE);
    expect(out.rejected).toBe(1);
    expect(out.rows[0]).toEqual({
      project: 'TURQUOISE', street: 'COVE DRIVE', market_segment: 'CCR',
      x: 28392.530515570001, y: 24997.821719180001, contract_month: '2015-07-01',
      area_sqm: 203, price: 2900000, nett_price: null, property_type: 'Condominium',
      type_of_area: 'Strata', tenure: '99 yrs lease commencing from 2007', floor_range: '01-05',
      type_of_sale: 'resale', district: '04', no_of_units: 1,
    });
    expect(out.rows[1]).toMatchObject({ contract_month: '2016-01-01', type_of_sale: 'new sale', nett_price: 2950000 });
  });

  it('throws when URA did not return Success', () => {
    expect(() => parseUraTxnJson(JSON.stringify({ Status: 'Error', Message: 'x' }))).toThrow(/not successful/);
  });
});
