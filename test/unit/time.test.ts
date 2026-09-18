import { describe, expect, it } from 'vitest';
import {
  addMonths, daysBetween, monthToDate, previousUraQuarter, todaySgt,
  uraMmyyToDate, uraQuarter, uraQuartersBack,
} from '../../src/time';

describe('time helpers', () => {
  it('todaySgt uses Singapore time', () => {
    expect(todaySgt(new Date('2026-09-17T16:30:00Z'))).toBe('2026-09-18');
    expect(todaySgt(new Date('2026-09-17T15:59:00Z'))).toBe('2026-09-17');
  });
  it('monthToDate converts YYYY-MM and rejects junk', () => {
    expect(monthToDate('2026-07')).toBe('2026-07-01');
    expect(() => monthToDate('2026-7')).toThrow();
  });
  it('addMonths crosses year boundaries', () => {
    expect(addMonths('2026-01-01', -2)).toBe('2025-11-01');
    expect(addMonths('2025-11-01', 3)).toBe('2026-02-01');
  });
  it('uraMmyyToDate converts URA MMYY', () => {
    expect(uraMmyyToDate('0715')).toBe('2015-07-01');
    expect(() => uraMmyyToDate('1315')).toThrow();
    expect(() => uraMmyyToDate('715')).toThrow();
  });
  it('URA quarters', () => {
    expect(uraQuarter('2026-09-18')).toBe('26q3');
    expect(uraQuarter('2026-01-01')).toBe('26q1');
    expect(previousUraQuarter('26q1')).toBe('25q4');
    expect(previousUraQuarter('10q1')).toBe('09q4');
    expect(uraQuartersBack('2026-09-18', 3)).toEqual(['26q3', '26q2', '26q1']);
  });
  it('daysBetween counts calendar days', () => {
    expect(daysBetween('2026-07-20', '2026-09-18')).toBe(60);
  });
});
