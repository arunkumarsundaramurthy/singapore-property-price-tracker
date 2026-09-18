import { parse } from 'csv-parse/sync';
import type { z } from 'zod';

export function parseCsv(csv: string): Record<string, string>[] {
  return parse(csv, { columns: true, skip_empty_lines: true, bom: true, trim: true }) as Record<string, string>[];
}

export function validateRows<S extends z.ZodType, R>(
  records: unknown[], schema: S, map: (v: z.infer<S>) => R,
): { rows: R[]; rejected: number; samples: string[] } {
  const rows: R[] = [];
  const samples: string[] = [];
  let rejected = 0;
  for (const record of records) {
    const result = schema.safeParse(record);
    if (result.success) {
      rows.push(map(result.data));
      continue;
    }
    rejected++;
    if (samples.length < 3) {
      samples.push(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
  }
  return { rows, rejected, samples };
}

export class RejectRateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RejectRateError';
  }
}

export function assertRejectRate(source: string, total: number, rejected: number, max = 0.05): void {
  if (total > 0 && rejected / total > max) {
    throw new RejectRateError(`${source}: ${rejected}/${total} records failed validation (limit ${max * 100}%)`);
  }
}

export function nullableNumber(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
