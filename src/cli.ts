import { Command, InvalidArgumentError } from 'commander';
import pino from 'pino';
import { RawArchive } from './archive';
import { buildCollectors, selectCollectors } from './collectors';
import type { Collector } from './collectors/types';
import { loadConfig, type Config } from './config';
import { createSql, type Sql } from './db/client';
import { migrate } from './db/migrate';
import { HttpFetcher } from './fetch/http';
import { evaluateHealth, pingHealthcheck } from './health';
import { acquireLock } from './lock';
import { reprocess, runAll, type CollectorOutcome, type RunnerDeps } from './runner';
import { lastRuns, recentRuns } from './runs';
import { todaySgt } from './time';

const LISTING_ARCHIVE_KEEP_DAYS = 60;

interface App extends RunnerDeps {
  config: Config;
  sql: Sql;
  collectors: Collector[];
}

async function withApp(fn: (app: App) => Promise<void>): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });
  const sql = createSql(config.databaseUrl);
  try {
    await migrate(sql);
    const collectors = buildCollectors({ fetcher: new HttpFetcher(), config });
    await fn({ config, logger, sql, archive: new RawArchive(config.rawArchiveDir), collectors });
  } finally {
    await sql.end();
  }
}

async function withLock(app: App, fn: () => Promise<void>): Promise<void> {
  const release = await acquireLock(app.config.lockFile);
  try {
    await fn();
  } finally {
    await release();
  }
}

function printOutcomes(outcomes: CollectorOutcome[]): void {
  console.table(outcomes.map((o) => ({
    source: o.source, mode: o.mode, status: o.status,
    fetched: o.result?.fetched ?? 0, inserted: o.result?.inserted ?? 0,
    changed: o.result?.changed ?? 0, rejected: o.result?.rejected ?? 0, error: o.error ?? '',
  })));
  if (outcomes.some((o) => o.status === 'failed')) process.exitCode = 1;
}

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('must be a positive integer');
  return n;
}

function isoDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new InvalidArgumentError('must be YYYY-MM-DD');
  return value;
}

const program = new Command().name('collect').description('Singapore property price collector');

program.command('run')
  .description('fetch and ingest sources')
  .argument('[sources...]', 'source names')
  .option('--all', 'run every source')
  .option('--backfill', 'fetch full history')
  .option('--dry-run', 'fetch and parse but write nothing')
  .option('--limit <n>', 'max payloads per source', positiveInt)
  .action((sources: string[], opts: { all?: boolean; backfill?: boolean; dryRun?: boolean; limit?: number }) =>
    withApp(async (app) => {
      const selected = selectCollectors(app.collectors, sources, !!opts.all);
      const options = { backfill: !!opts.backfill, dryRun: !!opts.dryRun, limit: opts.limit };
      await withLock(app, async () => {
        const outcomes = await runAll(app, selected, options);
        printOutcomes(outcomes);
        if (options.dryRun) return;
        for (const c of app.collectors.filter((k) => k.kind === 'listing')) {
          await app.archive.prune(c.name, LISTING_ARCHIVE_KEEP_DAYS, todaySgt());
        }
        if (opts.all && !options.backfill && app.config.healthcheckUrl) {
          const history: Record<string, Awaited<ReturnType<typeof lastRuns>>> = {};
          for (const c of app.collectors.filter((k) => k.kind === 'listing')) history[c.name] = await lastRuns(app.sql, c.name, 3);
          const report = evaluateHealth(outcomes, history);
          if (!report.ok) app.logger.warn({ reasons: report.reasons }, 'health check failing');
          await pingHealthcheck(app.config.healthcheckUrl, report);
        }
      });
    }));

program.command('status')
  .description('show runs from the last 7 days')
  .action(() => withApp(async (app) => {
    const runs = await recentRuns(app.sql, 7);
    console.table(runs.map((r) => ({
      id: r.id, source: r.source, mode: r.mode, started: r.started_at.toISOString(), status: r.status,
      fetched: r.fetched, inserted: r.inserted, changed: r.changed, rejected: r.rejected,
      error: (r.error ?? '').slice(0, 80),
    })));
  }));

program.command('reprocess')
  .description('re-ingest archived payloads without fetching')
  .argument('<source>')
  .requiredOption('--from <date>', 'first archive date (YYYY-MM-DD)', isoDate)
  .action((source: string, opts: { from: string }) => withApp(async (app) => {
    const [collector] = selectCollectors(app.collectors, [source], false);
    await withLock(app, async () => printOutcomes(await reprocess(app, collector, opts.from)));
  }));

program.command('migrate')
  .description('apply database migrations')
  .action(() => withApp(async () => { console.log('migrations applied'); }));

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
