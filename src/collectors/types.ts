import type { Logger } from 'pino';
import type { Payload } from '../archive';
import type { Tx } from '../db/client';

export type RunMode = 'daily' | 'backfill' | 'reprocess' | 'dry-run';

export interface RunOptions {
  backfill: boolean;
  dryRun: boolean;
  /** Maximum number of payloads to fetch; used for smoke tests. */
  limit?: number;
}

export interface FetchContext {
  runDate: string;
  logger: Logger;
  options: RunOptions;
}

export interface IngestContext {
  runId: number;
  runDate: string;
  logger: Logger;
  backfill: boolean;
  dryRun: boolean;
  fetchComplete: boolean;
}

export interface IngestResult {
  fetched: number;
  inserted: number;
  changed: number;
  rejected: number;
  complete: boolean;
}

export interface Collector {
  name: string;
  kind: 'official' | 'listing';
  fetch(ctx: FetchContext, emit: (p: Payload) => Promise<void>): Promise<{ complete: boolean }>;
  ingest(tx: Tx, payloads: AsyncIterable<Payload>, ctx: IngestContext): Promise<IngestResult>;
}
