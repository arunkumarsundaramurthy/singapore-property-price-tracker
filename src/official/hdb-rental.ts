import { z } from 'zod';
import type { Collector } from '../collectors/types';
import { monthToDate } from '../time';
import { parseCsv, validateRows } from './common';
import { createDataGovSgCollector, type DataGovSgDeps } from './datagovsg-collector';
import { DATAGOVSG_DATASETS } from './datagovsg';

const text = z.string().min(1);

const HdbRentalCsvRow = z.object({
  rent_approval_date: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  town: text,
  block: text,
  street_name: text,
  flat_type: text,
  monthly_rent: z.coerce.number().positive(),
});

export type HdbRentalRow = {
  rent_approval_month: string;
  town: string;
  block: string;
  street_name: string;
  flat_type: string;
  monthly_rent: number;
};

export function parseHdbRentalCsv(csv: string) {
  return validateRows(parseCsv(csv), HdbRentalCsvRow, (v): HdbRentalRow => ({
    rent_approval_month: monthToDate(v.rent_approval_date),
    town: v.town,
    block: v.block,
    street_name: v.street_name,
    flat_type: v.flat_type,
    monthly_rent: v.monthly_rent,
  }));
}

export function createHdbRentalCollector(deps: DataGovSgDeps): Collector {
  return createDataGovSgCollector<HdbRentalRow>({
    name: 'hdb-rental',
    datasetIds: () => [DATAGOVSG_DATASETS.hdbRental],
    parse: parseHdbRentalCsv,
    periodOf: (r) => r.rent_approval_month,
    spec: {
      table: 'hdb_rental_txn',
      periodColumn: 'rent_approval_month',
      columns: ['rent_approval_month', 'town', 'block', 'street_name', 'flat_type', 'monthly_rent', 'ingested_run_id'],
    },
    recentMonths: 3,
  }, deps);
}
