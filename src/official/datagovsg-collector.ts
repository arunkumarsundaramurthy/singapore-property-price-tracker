import type { Collector } from '../collectors/types';
import type { Fetcher } from '../fetch/types';
import { addMonths } from '../time';
import { assertRejectRate } from './common';
import { downloadDatasetCsv, type DataGovSgOptions } from './datagovsg';
import { replacePeriods, type ReplaceSpec } from './replace';

export interface DataGovSgDeps {
  fetcher: Fetcher;
  dataGovSg?: DataGovSgOptions;
}

export interface DataGovSgCollectorConfig<R extends Record<string, unknown>> {
  name: string;
  datasetIds: (backfill: boolean) => readonly string[];
  parse: (csv: string) => { rows: R[]; rejected: number; samples: string[] };
  periodOf: (row: R) => string;
  spec: ReplaceSpec;
  /** How many of the latest months a daily run replaces. */
  recentMonths: number;
}

export function selectRecentMonths(months: string[], recent: number | null): string[] {
  const unique = [...new Set(months)].sort();
  if (recent === null || unique.length === 0) return unique;
  const cutoff = addMonths(unique[unique.length - 1], -(recent - 1));
  return unique.filter((m) => m >= cutoff);
}

export function createDataGovSgCollector<R extends Record<string, unknown>>(
  cfg: DataGovSgCollectorConfig<R>, deps: DataGovSgDeps,
): Collector {
  return {
    name: cfg.name,
    kind: 'official',

    async fetch(ctx, emit) {
      const ids = cfg.datasetIds(ctx.options.backfill).slice(0, ctx.options.limit ?? Infinity);
      for (const id of ids) {
        ctx.logger.info({ datasetId: id }, 'downloading dataset');
        const body = await downloadDatasetCsv(deps.fetcher, id, deps.dataGovSg);
        await emit({ key: `${id}.csv`, body });
      }
      return { complete: true };
    },

    async ingest(tx, payloads, ctx) {
      let fetched = 0;
      let inserted = 0;
      let rejected = 0;
      for await (const payload of payloads) {
        const parsed = cfg.parse(payload.body);
        const total = parsed.rows.length + parsed.rejected;
        fetched += total;
        rejected += parsed.rejected;
        if (parsed.samples.length > 0) {
          ctx.logger.warn({ key: payload.key, rejected: parsed.rejected, samples: parsed.samples }, 'rejected rows');
        }
        assertRejectRate(cfg.name, total, parsed.rejected);
        if (parsed.rows.length === 0) throw new Error(`${cfg.name}: ${payload.key} contained no valid rows`);

        const periods = selectRecentMonths(parsed.rows.map(cfg.periodOf), ctx.backfill ? null : cfg.recentMonths);
        const keep = new Set(periods);
        const rows = parsed.rows
          .filter((r) => keep.has(cfg.periodOf(r)))
          .map((r) => ({ ...r, ingested_run_id: ctx.runId }));
        const res = await replacePeriods(tx, cfg.spec, periods, rows);
        inserted += res.inserted;
        ctx.logger.info({ key: payload.key, periods: periods.length, ...res }, 'replaced periods');
      }
      return { fetched, inserted, changed: 0, rejected, complete: true };
    },
  };
}
