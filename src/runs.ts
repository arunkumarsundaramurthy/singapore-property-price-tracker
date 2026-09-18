import type { Sql } from './db/client';
import type { RunMode } from './collectors/types';

export type RunStatus = 'running' | 'success' | 'incomplete' | 'failed';

export interface RunRow {
  id: number;
  source: string;
  mode: RunMode;
  started_at: Date;
  finished_at: Date | null;
  status: RunStatus;
  fetched: number;
  inserted: number;
  changed: number;
  rejected: number;
  error: string | null;
}

export interface RunFinish {
  status: Exclude<RunStatus, 'running'>;
  fetched?: number;
  inserted?: number;
  changed?: number;
  rejected?: number;
  error?: string | null;
}

export async function startRun(sql: Sql, source: string, mode: RunMode): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    insert into runs (source, mode) values (${source}, ${mode}) returning id::int as id`;
  return row.id;
}

export async function finishRun(sql: Sql, id: number, f: RunFinish): Promise<void> {
  await sql`
    update runs set
      finished_at = now(), status = ${f.status},
      fetched = ${f.fetched ?? 0}, inserted = ${f.inserted ?? 0},
      changed = ${f.changed ?? 0}, rejected = ${f.rejected ?? 0},
      error = ${f.error ?? null}
    where id = ${id}`;
}

export async function recentRuns(sql: Sql, days: number): Promise<RunRow[]> {
  return sql<RunRow[]>`
    select id::int as id, source, mode, started_at, finished_at, status,
           fetched, inserted, changed, rejected, error
    from runs
    where started_at > now() - make_interval(days => ${days})
    order by started_at desc, id desc`;
}

export async function lastRuns(sql: Sql, source: string, n: number): Promise<RunRow[]> {
  return sql<RunRow[]>`
    select id::int as id, source, mode, started_at, finished_at, status,
           fetched, inserted, changed, rejected, error
    from runs
    where source = ${source} and mode = 'daily'
    order by started_at desc, id desc
    limit ${n}`;
}
