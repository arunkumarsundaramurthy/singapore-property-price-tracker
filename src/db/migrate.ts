import { readdir, readFile } from 'node:fs/promises';
import type { Sql } from './client';

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

export async function migrate(sql: Sql): Promise<string[]> {
  await sql`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`;
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
  const done: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const text = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    done.push(file);
  }
  return done;
}
