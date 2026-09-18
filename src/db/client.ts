import postgres from 'postgres';

export type Sql = postgres.Sql;

export function createSql(url: string): Sql {
  return postgres(url, { max: 5, onnotice: () => {} });
}
