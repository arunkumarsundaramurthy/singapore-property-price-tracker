import type { Logger } from 'pino';
import type { RawArchive } from './archive';
import type { Collector, IngestContext, IngestResult, RunMode, RunOptions } from './collectors/types';
import type { Sql } from './db/client';
import { finishRun, startRun } from './runs';
import { todaySgt } from './time';

export interface RunnerDeps {
  sql: Sql;
  archive: RawArchive;
  logger: Logger;
  now?: () => Date;
}

export interface CollectorOutcome {
  source: string;
  kind: Collector['kind'];
  runId: number;
  mode: RunMode;
  status: 'success' | 'incomplete' | 'failed';
  result?: IngestResult;
  error?: string;
}

class DryRunRollback extends Error {
  constructor(readonly result: IngestResult) {
    super('dry-run rollback');
  }
}

async function ingestFromArchive(
  deps: RunnerDeps, collector: Collector, label: string, ctx: IngestContext,
): Promise<IngestResult> {
  try {
    return (await deps.sql.begin(async (tx) => {
      const result = await collector.ingest(tx, deps.archive.read(collector.name, label), ctx);
      if (ctx.dryRun) throw new DryRunRollback(result);
      return result;
    })) as IngestResult;
  } catch (err) {
    if (err instanceof DryRunRollback) return err.result;
    throw err;
  }
}

async function succeed(
  deps: RunnerDeps, collector: Collector, runId: number, mode: RunMode, result: IngestResult, logger: Logger,
): Promise<CollectorOutcome> {
  const status = result.complete ? 'success' : 'incomplete';
  await finishRun(deps.sql, runId, { status, ...result });
  logger.info({ ...result, status }, 'collector finished');
  return { source: collector.name, kind: collector.kind, runId, mode, status, result };
}

async function fail(
  deps: RunnerDeps, collector: Collector, runId: number, mode: RunMode, err: unknown, logger: Logger,
): Promise<CollectorOutcome> {
  const error = err instanceof Error ? err.message : String(err);
  logger.error({ err }, 'collector failed');
  await finishRun(deps.sql, runId, { status: 'failed', error });
  return { source: collector.name, kind: collector.kind, runId, mode, status: 'failed', error };
}

export async function runCollector(
  deps: RunnerDeps, collector: Collector, options: RunOptions,
): Promise<CollectorOutcome> {
  const runDate = todaySgt(deps.now?.() ?? new Date());
  const mode: RunMode = options.dryRun ? 'dry-run' : options.backfill ? 'backfill' : 'daily';
  const label = options.dryRun ? `${runDate}-dryrun` : options.backfill ? `${runDate}-backfill` : runDate;
  const logger = deps.logger.child({ source: collector.name, mode });
  const runId = await startRun(deps.sql, collector.name, mode);
  try {
    const writer = await deps.archive.begin(collector.name, label);
    const { complete } = await collector.fetch({ runDate, logger, options }, (p) => writer.write(p));
    await writer.close(complete);
    const result = await ingestFromArchive(deps, collector, label, {
      runId, runDate, logger, backfill: options.backfill, dryRun: options.dryRun, fetchComplete: complete,
    });
    return await succeed(deps, collector, runId, mode, result, logger);
  } catch (err) {
    return fail(deps, collector, runId, mode, err, logger);
  } finally {
    if (options.dryRun) await deps.archive.remove(collector.name, label);
  }
}

export async function runAll(
  deps: RunnerDeps, collectors: Collector[], options: RunOptions,
): Promise<CollectorOutcome[]> {
  const ordered = [
    ...collectors.filter((c) => c.kind === 'official'),
    ...collectors.filter((c) => c.kind === 'listing'),
  ];
  const outcomes: CollectorOutcome[] = [];
  for (const c of ordered) outcomes.push(await runCollector(deps, c, options));
  return outcomes;
}

/** Re-ingests archived payloads (no network) for every archive dated on or after fromDate. */
export async function reprocess(
  deps: RunnerDeps, collector: Collector, fromDate: string,
): Promise<CollectorOutcome[]> {
  const outcomes: CollectorOutcome[] = [];
  const labels = (await deps.archive.labels(collector.name))
    .filter((l) => l.slice(0, 10) >= fromDate && !l.endsWith('-dryrun'));
  for (const label of labels) {
    const manifest = await deps.archive.readManifest(collector.name, label);
    const logger = deps.logger.child({ source: collector.name, mode: 'reprocess', label });
    if (!manifest) {
      logger.warn('skipping archive without manifest (its fetch never finished)');
      continue;
    }
    const runId = await startRun(deps.sql, collector.name, 'reprocess');
    try {
      const result = await ingestFromArchive(deps, collector, label, {
        runId, runDate: label.slice(0, 10), logger,
        backfill: label.endsWith('-backfill'), dryRun: false, fetchComplete: manifest.complete,
      });
      outcomes.push(await succeed(deps, collector, runId, 'reprocess', result, logger));
    } catch (err) {
      outcomes.push(await fail(deps, collector, runId, 'reprocess', err, logger));
    }
  }
  return outcomes;
}
