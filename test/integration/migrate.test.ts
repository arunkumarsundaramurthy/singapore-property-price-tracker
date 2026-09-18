import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate';
import { connect } from './helpers';

const sql = connect();
afterAll(() => sql.end());

describe('migrate', () => {
  it('has created every table and is idempotent', async () => {
    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by table_name`;
    expect(tables.map((t) => t.table_name)).toEqual([
      'hdb_rental_txn', 'hdb_resale_txn', 'listing_versions', 'listings', 'runs',
      'schema_migrations', 'ura_private_rental', 'ura_private_txn',
    ]);
    expect(await migrate(sql)).toEqual([]);
  });
});
