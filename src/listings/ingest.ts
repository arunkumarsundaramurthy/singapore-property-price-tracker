import type { Payload } from '../archive';
import type { IngestContext, IngestResult } from '../collectors/types';
import type { Tx } from '../db/client';
import { NormalizedListingSchema } from './schema';
import { upsertListing } from './upsert';

const MAX_REJECT_RATE = 0.05;
const MAX_MISSING_SIZE_RATE = 0.05;
const MIN_SEEN_RATIO = 0.5;
const DELIST_AFTER_MISSES = 2;

export interface ListingIngestOptions {
  source: string;
  parsePayload: (p: Payload) => unknown[];
}

/** Counts a miss (at most once per day) for active listings not seen today; delists at the threshold. */
export async function markMissing(tx: Tx, source: string, runDate: string): Promise<{ missed: number; delisted: number }> {
  const rows = await tx<{ status: string }[]>`
    update listings set
      missed_complete_runs = missed_complete_runs + 1,
      last_missed_on = ${runDate},
      status = case when missed_complete_runs + 1 >= ${DELIST_AFTER_MISSES} then 'delisted' else status end
    where source = ${source} and status = 'active' and last_seen < ${runDate}
      and (last_missed_on is null or last_missed_on < ${runDate})
    returning status`;
  return { missed: rows.length, delisted: rows.filter((r) => r.status === 'delisted').length };
}

export async function ingestListings(
  tx: Tx, payloads: AsyncIterable<Payload>, ctx: IngestContext, opts: ListingIngestOptions,
): Promise<IngestResult> {
  const [{ n: activeBefore }] = await tx<{ n: number }[]>`
    select count(*)::int as n from listings where source = ${opts.source} and status = 'active'`;

  let valid = 0;
  let rejected = 0;
  let missingSize = 0;
  let unparsablePages = 0;
  let inserted = 0;
  let changed = 0;
  const samples: string[] = [];

  for await (const payload of payloads) {
    let items: unknown[];
    try {
      items = opts.parsePayload(payload);
    } catch (err) {
      unparsablePages++;
      ctx.logger.warn({ key: payload.key, err }, 'could not parse page');
      continue;
    }
    for (const item of items) {
      const parsed = NormalizedListingSchema.safeParse(item);
      if (!parsed.success) {
        rejected++;
        if (samples.length < 3) samples.push(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        continue;
      }
      valid++;
      if (parsed.data.floor_area_sqft === null) missingSize++;
      const outcome = await upsertListing(tx, opts.source, ctx.runId, ctx.runDate, parsed.data);
      if (outcome === 'inserted') inserted++;
      else if (outcome === 'changed') changed++;
    }
  }

  const [{ n: seenToday }] = await tx<{ n: number }[]>`
    select count(*)::int as n from listings where source = ${opts.source} and last_seen = ${ctx.runDate}`;
  const fetched = valid + rejected;
  const reasons: string[] = [];
  if (!ctx.fetchComplete) reasons.push('fetch incomplete');
  if (unparsablePages > 0) reasons.push(`${unparsablePages} unparsable page(s)`);
  if (fetched > 0 && rejected / fetched > MAX_REJECT_RATE) reasons.push(`${rejected}/${fetched} rejected`);
  if (valid > 0 && missingSize / valid > MAX_MISSING_SIZE_RATE) reasons.push(`${missingSize}/${valid} missing size`);
  if (activeBefore > 0 && seenToday < activeBefore * MIN_SEEN_RATIO) {
    reasons.push(`saw ${seenToday} of ${activeBefore} previously active listings`);
  }
  if (samples.length > 0) ctx.logger.warn({ samples }, 'rejected listings');

  const complete = reasons.length === 0;
  if (complete) {
    const res = await markMissing(tx, opts.source, ctx.runDate);
    ctx.logger.info(res, 'marked missing listings');
  } else {
    ctx.logger.warn({ reasons }, 'run incomplete: delisting skipped');
  }
  return { fetched, inserted, changed, rejected, complete };
}
