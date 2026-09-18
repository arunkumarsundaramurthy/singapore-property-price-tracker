import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { createSql } from '../../src/db/client';
import { migrate } from '../../src/db/migrate';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const url = container.getConnectionUri();
  const sql = createSql(url);
  await migrate(sql);
  await sql.end();
  project.provide('databaseUrl', url);
  return async () => {
    await container.stop();
  };
}
