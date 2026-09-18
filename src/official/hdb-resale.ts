import { z } from 'zod';
import type { Collector } from '../collectors/types';
import { monthToDate } from '../time';
import { parseCsv, validateRows } from './common';
import { createDataGovSgCollector, type DataGovSgDeps } from './datagovsg-collector';
import { DATAGOVSG_DATASETS } from './datagovsg';

const text = z.string().min(1);

const HdbResaleCsvRow = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  town: text,
  flat_type: text,
  block: text,
  street_name: text,
  storey_range: text,
  floor_area_sqm: z.coerce.number().positive(),
  flat_model: text,
  lease_commence_date: z.coerce.number().int().min(1900).max(2100),
  remaining_lease: z.string().optional(),
  resale_price: z.coerce.number().positive(),
});

export type HdbResaleRow = {
  month: string;
  town: string;
  flat_type: string;
  block: string;
  street_name: string;
  storey_range: string;
  floor_area_sqm: number;
  flat_model: string;
  lease_commence_year: number;
  remaining_lease: string | null;
  resale_price: number;
};

export function parseHdbResaleCsv(csv: string) {
  return validateRows(parseCsv(csv), HdbResaleCsvRow, (v): HdbResaleRow => ({
    month: monthToDate(v.month),
    town: v.town,
    flat_type: v.flat_type,
    block: v.block,
    street_name: v.street_name,
    storey_range: v.storey_range,
    floor_area_sqm: v.floor_area_sqm,
    flat_model: v.flat_model,
    lease_commence_year: v.lease_commence_date,
    remaining_lease: v.remaining_lease ? v.remaining_lease : null,
    resale_price: v.resale_price,
  }));
}

export function createHdbResaleCollector(deps: DataGovSgDeps): Collector {
  return createDataGovSgCollector<HdbResaleRow>({
    name: 'hdb-resale',
    datasetIds: (backfill) => backfill
      ? [...DATAGOVSG_DATASETS.hdbResaleHistorical, DATAGOVSG_DATASETS.hdbResaleCurrent]
      : [DATAGOVSG_DATASETS.hdbResaleCurrent],
    parse: parseHdbResaleCsv,
    periodOf: (r) => r.month,
    spec: {
      table: 'hdb_resale_txn',
      periodColumn: 'month',
      columns: ['month', 'town', 'flat_type', 'block', 'street_name', 'storey_range', 'floor_area_sqm',
        'flat_model', 'lease_commence_year', 'remaining_lease', 'resale_price', 'ingested_run_id'],
    },
    recentMonths: 3,
  }, deps);
}
