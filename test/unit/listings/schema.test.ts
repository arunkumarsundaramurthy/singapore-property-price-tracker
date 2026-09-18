import { describe, expect, it } from 'vitest';
import { NormalizedListingSchema } from '../../../src/listings/schema';
import { fingerprint } from '../../../src/listings/upsert';

const base = {
  source_listing_id: '123', listing_type: 'sale', property_type: 'condo', price: 1_500_000, url: 'https://x.test/123',
};

describe('NormalizedListingSchema', () => {
  it('fills optional fields with null and extra with {}', () => {
    const l = NormalizedListingSchema.parse(base);
    expect(l).toMatchObject({ title: null, bedrooms: null, floor_area_sqft: null, lat: null, extra: {} });
  });

  it('rejects bad enums and non-positive prices', () => {
    expect(NormalizedListingSchema.safeParse({ ...base, listing_type: 'lease' }).success).toBe(false);
    expect(NormalizedListingSchema.safeParse({ ...base, price: 0 }).success).toBe(false);
  });
});

describe('fingerprint', () => {
  it('changes with tracked fields only', () => {
    const a = NormalizedListingSchema.parse({ ...base, floor_area_sqft: 1000 });
    expect(fingerprint(a)).toBe(fingerprint({ ...a, lat: 1.3, extra: { agent: 'x' } }));
    expect(fingerprint(a)).not.toBe(fingerprint({ ...a, price: 1_400_000 }));
    expect(fingerprint(a)).not.toBe(fingerprint({ ...a, title: 'New title' }));
  });
});
