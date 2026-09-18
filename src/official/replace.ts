import type { Tx } from '../db/client';

export interface ReplaceSpec {
  table: string;
  periodColumn: string;
  columns: string[];
}

export class VolumeGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VolumeGuardError';
  }
}

const CHUNK = 1000;

/**
 * Atomically swaps all rows for `periods` with `rows` (caller supplies the transaction).
 * Refuses when the new data is materially smaller than what is stored.
 */
export async function replacePeriods(
  tx: Tx, spec: ReplaceSpec, periods: string[], rows: Record<string, unknown>[], minRatio = 0.95,
): Promise<{ deleted: number; inserted: number }> {
  if (periods.length === 0) return { deleted: 0, inserted: 0 };
  const allowed = new Set(periods);
  const stray = rows.find((r) => !allowed.has(String(r[spec.periodColumn])));
  if (stray) {
    throw new Error(`${spec.table}: row with ${spec.periodColumn}=${String(stray[spec.periodColumn])} is outside the replaced periods`);
  }

  const [{ count }] = await tx<{ count: number }[]>`
    select count(*)::int as count from ${tx(spec.table)} where ${tx(spec.periodColumn)} in ${tx(periods)}`;
  if (count > 0 && rows.length < count * minRatio) {
    throw new VolumeGuardError(
      `${spec.table}: refusing to replace ${count} stored rows with ${rows.length} across ${periods.length} period(s)`,
    );
  }

  await tx`delete from ${tx(spec.table)} where ${tx(spec.periodColumn)} in ${tx(periods)}`;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await tx`insert into ${tx(spec.table)} ${tx(chunk, ...spec.columns)}`;
  }
  return { deleted: count, inserted: rows.length };
}
