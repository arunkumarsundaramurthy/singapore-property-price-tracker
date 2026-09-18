import { describe, expect, it } from 'vitest';
import { parseHdbRentalCsv } from '../../../src/official/hdb-rental';

// Real rows sampled from data.gov.sg on 2026-09-18.
const CSV = `rent_approval_date,town,block,street_name,flat_type,monthly_rent
2026-08,QUEENSTOWN,3,DOVER RD,3-ROOM,3000
2026-08,BUKIT MERAH,53,LENGKOK BAHRU,4-ROOM,3900
2026-08,BUKIT MERAH,53,LENGKOK BAHRU,4-ROOM,`;

describe('parseHdbRentalCsv', () => {
  it('parses rows and rejects a missing rent', () => {
    const out = parseHdbRentalCsv(CSV);
    expect(out.rows[0]).toEqual({
      rent_approval_month: '2026-08-01', town: 'QUEENSTOWN', block: '3',
      street_name: 'DOVER RD', flat_type: '3-ROOM', monthly_rent: 3000,
    });
    expect(out.rows).toHaveLength(2);
    expect(out.rejected).toBe(1);
  });
});
