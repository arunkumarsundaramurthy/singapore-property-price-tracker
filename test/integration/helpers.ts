import { inject } from 'vitest';
import { createSql, type Sql } from '../../src/db/client';

export function connect(): Sql {
  return createSql(inject('databaseUrl'));
}

export async function truncateAll(sql: Sql): Promise<void> {
  await sql`truncate listing_versions, listings, hdb_resale_txn, hdb_rental_txn,
    ura_private_txn, ura_private_rental, runs restart identity cascade`;
}

export async function makeRun(sql: Sql, source = 'test'): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    insert into runs (source, mode) values (${source}, 'daily') returning id::int as id`;
  return row.id;
}
