import pino from 'pino';
import type { FetchContext, IngestContext, RunOptions } from '../../src/collectors/types';

export const silentLogger = pino({ level: 'silent' });

export function ingestCtx(runId: number, overrides: Partial<IngestContext> = {}): IngestContext {
  return {
    runId, runDate: '2026-09-18', logger: silentLogger,
    backfill: false, dryRun: false, fetchComplete: true, ...overrides,
  };
}

export function fetchCtx(options: Partial<RunOptions> = {}, runDate = '2026-09-18'): FetchContext {
  return { runDate, logger: silentLogger, options: { backfill: false, dryRun: false, ...options } };
}
