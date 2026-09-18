import { z } from 'zod';
import type { Collector } from '../collectors/types';
import type { Fetcher } from '../fetch/types';
import { uraMmyyToDate } from '../time';
import { assertRejectRate, nullableNumber, validateRows } from './common';
import { replacePeriods, type ReplaceSpec } from './replace';
import { UraClient } from './ura-client';

export interface UraDeps {
  fetcher: Fetcher;
  uraAccessKey?: string;
}

const SALE_TYPES = { '1': 'new sale', '2': 'sub sale', '3': 'resale' } as const;
const BATCHES = [1, 2, 3, 4];

const UraTxnRecord = z.object({
  project: z.string().min(1),
  street: z.string(),
  marketSegment: z.string(),
  x: z.unknown().optional(),
  y: z.unknown().optional(),
  contractDate: z.string().regex(/^(0[1-9]|1[0-2])\d{2}$/),
  area: z.coerce.number().positive(),
  price: z.coerce.number().positive(),
  nettPrice: z.unknown().optional(),
  propertyType: z.string().min(1),
  typeOfArea: z.string(),
  tenure: z.string(),
  floorRange: z.string(),
  typeOfSale: z.enum(['1', '2', '3']),
  district: z.string().min(1),
  noOfUnits: z.coerce.number().int().positive(),
});

export type UraTxnRow = {
  project: string;
  street: string;
  market_segment: string;
  x: number | null;
  y: number | null;
  contract_month: string;
  area_sqm: number;
  price: number;
  nett_price: number | null;
  property_type: string;
  type_of_area: string;
  tenure: string;
  floor_range: string;
  type_of_sale: string;
  district: string;
  no_of_units: number;
};

const SPEC: ReplaceSpec = {
  table: 'ura_private_txn',
  periodColumn: 'contract_month',
  columns: ['project', 'street', 'market_segment', 'x', 'y', 'contract_month', 'area_sqm', 'price', 'nett_price',
    'property_type', 'type_of_area', 'tenure', 'floor_range', 'type_of_sale', 'district', 'no_of_units', 'ingested_run_id'],
};

interface ProjectEnvelope {
  Status?: string;
  Result?: Array<Record<string, unknown> & { transaction?: unknown }>;
}

export function parseUraTxnJson(body: string) {
  const doc = JSON.parse(body) as ProjectEnvelope;
  if (doc.Status !== 'Success' || !Array.isArray(doc.Result)) {
    throw new Error(`URA transaction payload not successful: ${String(doc.Status)}`);
  }
  const records = doc.Result.flatMap((p) =>
    (Array.isArray(p.transaction) ? p.transaction : []).map((t: object) => ({
      ...t, project: p.project, street: p.street, marketSegment: p.marketSegment, x: p.x, y: p.y,
    })));
  return validateRows(records, UraTxnRecord, (v): UraTxnRow => ({
    project: v.project,
    street: v.street,
    market_segment: v.marketSegment,
    x: nullableNumber(v.x),
    y: nullableNumber(v.y),
    contract_month: uraMmyyToDate(v.contractDate),
    area_sqm: v.area,
    price: v.price,
    nett_price: nullableNumber(v.nettPrice),
    property_type: v.propertyType,
    type_of_area: v.typeOfArea,
    tenure: v.tenure,
    floor_range: v.floorRange,
    type_of_sale: SALE_TYPES[v.typeOfSale],
    district: v.district,
    no_of_units: v.noOfUnits,
  }));
}

export function createUraPrivateTxnCollector(deps: UraDeps): Collector {
  return {
    name: 'ura-private-txn',
    kind: 'official',

    async fetch(ctx, emit) {
      const client = new UraClient(deps.fetcher, deps.uraAccessKey);
      for (const b of BATCHES.slice(0, ctx.options.limit ?? BATCHES.length)) {
        ctx.logger.info({ batch: b }, 'fetching URA transactions');
        await emit({ key: `batch-${b}.json`, body: await client.invoke({ service: 'PMI_Resi_Transaction', batch: String(b) }) });
      }
      return { complete: true };
    },

    async ingest(tx, payloads, ctx) {
      const rows: UraTxnRow[] = [];
      let rejected = 0;
      let batches = 0;
      for await (const p of payloads) {
        const parsed = parseUraTxnJson(p.body);
        batches++;
        rows.push(...parsed.rows);
        rejected += parsed.rejected;
        if (parsed.samples.length > 0) ctx.logger.warn({ key: p.key, samples: parsed.samples }, 'rejected rows');
      }
      if (batches !== BATCHES.length && !ctx.dryRun) {
        throw new Error(`ura-private-txn: ingest needs all 4 batches, got ${batches}`);
      }
      const fetched = rows.length + rejected;
      assertRejectRate('ura-private-txn', fetched, rejected);
      if (rows.length === 0) throw new Error('ura-private-txn: no valid rows');

      // URA serves a rolling 5-year window: the earliest month may be partial, so never replace it.
      const months = [...new Set(rows.map((r) => r.contract_month))].sort().slice(1);
      const keep = new Set(months);
      const toInsert = rows.filter((r) => keep.has(r.contract_month)).map((r) => ({ ...r, ingested_run_id: ctx.runId }));
      const res = await replacePeriods(tx, SPEC, months, toInsert);
      ctx.logger.info({ months: months.length, ...res }, 'replaced contract months');
      return { fetched, inserted: res.inserted, changed: 0, rejected, complete: true };
    },
  };
}
