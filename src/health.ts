import type { CollectorOutcome } from './runner';
import type { RunRow } from './runs';

export interface HealthReport {
  ok: boolean;
  reasons: string[];
}

const LISTING_FAILURE_STREAK = 3;

export function evaluateHealth(
  outcomes: CollectorOutcome[], listingHistory: Record<string, Pick<RunRow, 'status'>[]>,
): HealthReport {
  const reasons: string[] = [];
  for (const o of outcomes) {
    if (o.kind === 'official' && o.status === 'failed') reasons.push(`${o.source} failed: ${o.error ?? 'unknown error'}`);
  }
  for (const [source, runs] of Object.entries(listingHistory)) {
    const recent = runs.slice(0, LISTING_FAILURE_STREAK);
    if (recent.length === LISTING_FAILURE_STREAK && recent.every((r) => r.status !== 'success')) {
      reasons.push(`${source} has not completed successfully in its last ${LISTING_FAILURE_STREAK} runs`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/** Monitoring must never break a run, so errors are swallowed. */
export async function pingHealthcheck(url: string, report: HealthReport, fetchImpl: typeof fetch = fetch): Promise<void> {
  const target = report.ok ? url : `${url.replace(/\/$/, '')}/fail`;
  try {
    await fetchImpl(target, { method: 'POST', body: report.reasons.join('\n') || 'ok', signal: AbortSignal.timeout(10_000) });
  } catch {
    // ignore
  }
}
