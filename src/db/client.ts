import postgres from 'postgres';

export type Sql = postgres.Sql;
/** A handle usable inside a transaction (or a top-level connection, which also satisfies it). */
export type Tx = postgres.TransactionSql;

export function createSql(url: string): Sql {
  return postgres(url, { max: 5, onnotice: () => {} });
}
