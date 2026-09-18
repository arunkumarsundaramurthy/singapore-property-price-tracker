import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assertRejectRate, nullableNumber, parseCsv, RejectRateError, validateRows } from '../../../src/official/common';

describe('official/common', () => {
  it('parseCsv reads headers, trims and skips blank lines', () => {
    expect(parseCsv('﻿a,b\n 1 ,2\n\n3,4\n')).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  });

  it('validateRows maps valid rows and counts rejects with samples', () => {
    const schema = z.object({ n: z.coerce.number().positive() });
    const out = validateRows([{ n: '1' }, { n: '-1' }, { n: 'x' }, { n: '2' }], schema, (v) => v.n * 10);
    expect(out.rows).toEqual([10, 20]);
    expect(out.rejected).toBe(2);
    expect(out.samples).toHaveLength(2);
    expect(out.samples[0]).toMatch(/^n: /);
  });

  it('assertRejectRate throws above the threshold only', () => {
    expect(() => assertRejectRate('s', 100, 5)).not.toThrow();
    expect(() => assertRejectRate('s', 100, 6)).toThrow(RejectRateError);
    expect(() => assertRejectRate('s', 0, 0)).not.toThrow();
  });

  it('nullableNumber', () => {
    expect(nullableNumber('')).toBeNull();
    expect(nullableNumber(undefined)).toBeNull();
    expect(nullableNumber('abc')).toBeNull();
    expect(nullableNumber('24997.8217')).toBe(24997.8217);
    expect(nullableNumber(3)).toBe(3);
  });
});
