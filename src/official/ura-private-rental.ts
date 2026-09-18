import { z } from 'zod';
import type { Collector } from '../collectors/types';
import { uraMmyyToDate, uraQuartersBack } from '../time';
import { assertRejectRate, nullableNumber, validateRows } from './common';
import { replacePeriods, type ReplaceSpec } from './replace';
import { UraClient } from './ura-client';
import type { UraDeps } from './ura-private-txn';

const DAILY_QUARTERS = 2;
const BACKFILL_QUARTERS = 21;

const UraRentalRecord = z.object({
  project: z.string().min(1),
  street: z.string(),
  x: z.unknown().optional(),
  y: z.unknown().optional(),
  leaseDate: z.string().regex(/^(0[1-9]|1[0-2])\d{2}$/),
  propertyType: z.string().min(1),
  areaSqm: z.string(),
  areaSqft: z.string(),
  rent: z.coerce.number().positive(),
  district: z.string().min(1),
  noOfBedRoom: z.unknown().optional(),
});

export type UraRentalRow = {
  project: string;
  street: string;
  x: number | null;
  y: number | null;
  ref_quarter: string;
  lease_month: string;
  property_type: string;
  district: string;
  area_sqm_range: string;
  area_sqft_range: string;
  no_of_bedroom: number | null;
  rent: number;
};

const SPEC: ReplaceSpec = {
  table: 'ura_private_rental',
  periodColumn: 'ref_quarter',
  columns: ['project', 'street', 'x', 'y', 'ref_quarter', 'lease_month', 'property_type', 'district',
    'area_sqm_range', 'area_sqft_range', 'no_of_bedroom', 'rent', 'ingested_run_id'],
};

export function parseUraRentalJson(body: string, refQuarter: string) {
  const doc = JSON.parse(body) as { Status?: string; Result?: Array<Record<string, unknown> & { rental?: unknown }> };
  if (doc.Status !== 'Success' || !Array.isArray(doc.Result)) {
    throw new Error(`URA rental payload for ${refQuarter} not successful: ${String(doc.Status)}`);
  }
  const records = doc.Result.flatMap((p) =>
    (Array.isArray(p.rental) ? p.rental : []).map((r: object) => ({ ...r, project: p.project, street: p.street, x: p.x, y: p.y })));
  return validateRows(records, UraRentalRecord, (v): UraRentalRow => ({
    project: v.project,
    street: v.street,
    x: nullableNumber(v.x),
    y: nullableNumber(v.y),
    ref_quarter: refQuarter,
    lease_month: uraMmyyToDate(v.leaseDate),
    property_type: v.propertyType,
    district: v.district,
    area_sqm_range: v.areaSqm,
    area_sqft_range: v.areaSqft,
    no_of_bedroom: nullableNumber(v.noOfBedRoom),
    rent: v.rent,
  }));
}

export function createUraPrivateRentalCollector(deps: UraDeps): Collector {
  return {
    name: 'ura-private-rental',
    kind: 'official',

    async fetch(ctx, emit) {
      const client = new UraClient(deps.fetcher, deps.uraAccessKey);
      const quarters = uraQuartersBack(ctx.runDate, ctx.options.backfill ? BACKFILL_QUARTERS : DAILY_QUARTERS)
        .slice(0, ctx.options.limit ?? Infinity);
      for (const q of quarters) {
        ctx.logger.info({ quarter: q }, 'fetching URA rentals');
        await emit({ key: `${q}.json`, body: await client.invoke({ service: 'PMI_Resi_Rental', refPeriod: q }) });
      }
      return { complete: true };
    },

    async ingest(tx, payloads, ctx) {
      let fetched = 0;
      let inserted = 0;
      let rejected = 0;
      for await (const p of payloads) {
        const quarter = p.key.replace(/\.json$/, '');
        const parsed = parseUraRentalJson(p.body, quarter);
        const total = parsed.rows.length + parsed.rejected;
        fetched += total;
        rejected += parsed.rejected;
        if (parsed.samples.length > 0) ctx.logger.warn({ quarter, samples: parsed.samples }, 'rejected rows');
        assertRejectRate('ura-private-rental', total, parsed.rejected);
        const rows = parsed.rows.map((r) => ({ ...r, ingested_run_id: ctx.runId }));
        const res = await replacePeriods(tx, SPEC, [quarter], rows);
        inserted += res.inserted;
        ctx.logger.info({ quarter, ...res }, 'replaced quarter');
      }
      return { fetched, inserted, changed: 0, rejected, complete: true };
    },
  };
}
