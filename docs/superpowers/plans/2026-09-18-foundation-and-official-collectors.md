# SG Property Collector — Plan 1: Foundation and Official Collectors

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a daily collector that stores HDB resale, HDB rental, URA private sale and URA private rental transactions in Postgres. Include the listing change-tracking engine that Plan 2's site collectors will use.

**Architecture:** One TypeScript CLI app. Each collector fetches raw payloads into a gzipped on-disk archive, then ingests them back from the archive inside one Postgres transaction. Official data is stored with replace-by-period and volume guards. Listings use upsert with versions and a two-miss delisting rule. The app runs daily from cron via Docker Compose on a VM.

**Tech Stack:** Node 22, TypeScript 5.9 (ESM, run with `tsx`), `postgres` (porsager) 3.x, zod 4, csv-parse 7, commander 15, pino 10, Vitest 5, `@testcontainers/postgresql` 12, Postgres 17.

**Spec:** `docs/superpowers/specs/2026-09-18-sg-property-collector-design.md`

## Global Constraints

- Node.js ≥ 22 and TypeScript. ESM (`"type": "module"`), `moduleResolution: "Bundler"`, extensionless relative imports.
- The database is Postgres 17 and is never mocked in tests. Integration tests use Testcontainers, so **Docker must be running** for `npm test`.
- All "today" dates are Singapore dates (`Asia/Singapore`), formatted `YYYY-MM-DD`.
- Month columns are stored as `date` on the first of the month. URA quarters are text in URA's `yyqq` form, e.g. `26q3`.
- Official data: a reject rate above 5% fails the run before any write. The volume guard fails the run if new rows are fewer than 95% of the stored rows for the replaced periods.
- Listings: delist after 2 consecutive complete runs without seeing the listing. Incomplete runs never change the missed counter or status. The run is incomplete when rejects are above 5%, size is missing on more than 5%, or fewer than 50% of the previously active listings are seen.
- data.gov.sg dataset IDs (verified live 2026-09-18):
  - resale 2017+: `d_8b84c4ee58e3cfc0ece0d773c8ca6abc`
  - 1990–1999: `d_ebc5ab87086db484f88045b47411ebc5`
  - 2000–Feb 2012: `d_43f493c6c50d54243cc1eab0df142d6a`
  - Mar 2012–2014: `d_2d5ff9ea31397b66239f245f57751537`
  - 2015–2016: `d_ea9ed51da2787afaf8e51f827c304208`
  - rental 2021+: `d_c9f57187485a850908655db0e8cfe651`
- data.gov.sg download API: `GET https://api-open.data.gov.sg/v1/public/api/datasets/{id}/initiate-download`, then `.../poll-download` until `data.status === "DOWNLOAD_SUCCESS"`, then GET `data.url`. Response body `code: 24` means rate limited: wait about 12 s. The optional API key goes in the `x-api-key` header.
- URA endpoints:
  - Token: `GET https://eservice.ura.gov.sg/uraDataService/insertNewToken/v1` with header `AccessKey`, which returns `{Status, Result}`.
  - Data: `GET .../invokeUraDS/v1?service=PMI_Resi_Transaction&batch=1..4` or `?service=PMI_Resi_Rental&refPeriod=26q3`, with headers `AccessKey` and `Token`.
- Commit after every task. Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Work on branch `design/collector-spec` (already checked out), or a branch created from it.

## File Map

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, .env.example, README.md
Dockerfile, docker-compose.yml, ops/crontab.example, ops/backup.sh
src/
  config.ts                   loadConfig(env) → Config
  time.ts                     SGT date, month and URA quarter helpers
  archive.ts                  RawArchive / ArchiveWriter / Payload / Manifest
  runs.ts                     runs table: startRun, finishRun, recentRuns, lastRuns
  runner.ts                   runCollector, runAll, reprocess (archive → ingest in tx)
  lock.ts                     acquireLock
  health.ts                   evaluateHealth, pingHealthcheck
  cli.ts                      commander entry point
  db/client.ts                createSql, type Sql
  db/migrate.ts               migrate(sql)
  db/migrations/001_init.sql  all tables
  fetch/types.ts              Fetcher, RequestOptions, HttpError
  fetch/http.ts               HttpFetcher, sleep
  collectors/types.ts         Collector, RunOptions, FetchContext, IngestContext, IngestResult, RunMode
  collectors/index.ts         buildCollectors
  official/common.ts          parseCsv, validateRows, assertRejectRate, nullableNumber, RejectRateError
  official/replace.ts         replacePeriods, VolumeGuardError, ReplaceSpec
  official/datagovsg.ts       DATAGOVSG_DATASETS, downloadDatasetCsv
  official/datagovsg-collector.ts  createDataGovSgCollector, selectRecentMonths
  official/hdb-resale.ts      parseHdbResaleCsv, createHdbResaleCollector
  official/hdb-rental.ts      parseHdbRentalCsv, createHdbRentalCollector
  official/ura-client.ts      UraClient
  official/ura-private-txn.ts parseUraTxnJson, createUraPrivateTxnCollector
  official/ura-private-rental.ts parseUraRentalJson, createUraPrivateRentalCollector
  listings/schema.ts          NormalizedListingSchema, NormalizedListing
  listings/upsert.ts          fingerprint, upsertListing
  listings/ingest.ts          ingestListings, markMissing
test/
  support/fake-fetcher.ts, support/async.ts, support/context.ts
  unit/…                      no Docker needed
  integration/global-setup.ts, integration/helpers.ts, integration/…
```

---

### Task 1: Project scaffold, config and time helpers

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `src/config.ts`, `src/time.ts`
- Test: `test/unit/config.test.ts`, `test/unit/time.test.ts`

**Interfaces:**
- Produces:
  - `loadConfig(env?: Record<string, string | undefined>): Config`, where `Config = { databaseUrl: string; uraAccessKey?: string; dataGovSgApiKey?: string; healthcheckUrl?: string; rawArchiveDir: string; lockFile: string; logLevel: string }`
  - `todaySgt(now?: Date): string`
  - `monthToDate(ym: string): string`
  - `addMonths(date: string, n: number): string`
  - `uraMmyyToDate(mmyy: string): string`
  - `uraQuarter(date: string): string`
  - `previousUraQuarter(q: string): string`
  - `uraQuartersBack(date: string, count: number): string[]`
  - `daysBetween(from: string, to: string): number`

- [ ] **Step 1: Create the project files and install dependencies**

`package.json`:
```json
{
  "name": "sg-property-collector",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "collect": "node --env-file-if-exists=.env --import tsx src/cli.ts",
    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "typecheck": "tsc --noEmit"
  }
}
```

Run:
```bash
npm install postgres@3 zod@4 csv-parse@7 commander@15 pino@10 tsx@4
npm install -D typescript@5.9 vitest@5 @types/node@22 @testcontainers/postgresql@12
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
```

`.gitignore`:
```
node_modules/
.env
data/
raw/
backups/
logs/
*.lock
```

`.env.example`:
```
POSTGRES_PASSWORD=change-me
DATABASE_URL=postgres://collector:change-me@localhost:5432/collector
URA_ACCESS_KEY=
DATA_GOV_SG_API_KEY=
HEALTHCHECK_URL=
RAW_ARCHIVE_DIR=./raw
LOCK_FILE=./collector.lock
LOG_LEVEL=info
```

- [ ] **Step 2: Write failing tests**

`test/unit/time.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  addMonths, daysBetween, monthToDate, previousUraQuarter, todaySgt,
  uraMmyyToDate, uraQuarter, uraQuartersBack,
} from '../../src/time';

describe('time helpers', () => {
  it('todaySgt uses Singapore time', () => {
    expect(todaySgt(new Date('2026-09-17T16:30:00Z'))).toBe('2026-09-18');
    expect(todaySgt(new Date('2026-09-17T15:59:00Z'))).toBe('2026-09-17');
  });
  it('monthToDate converts YYYY-MM and rejects junk', () => {
    expect(monthToDate('2026-07')).toBe('2026-07-01');
    expect(() => monthToDate('2026-7')).toThrow();
  });
  it('addMonths crosses year boundaries', () => {
    expect(addMonths('2026-01-01', -2)).toBe('2025-11-01');
    expect(addMonths('2025-11-01', 3)).toBe('2026-02-01');
  });
  it('uraMmyyToDate converts URA MMYY', () => {
    expect(uraMmyyToDate('0715')).toBe('2015-07-01');
    expect(() => uraMmyyToDate('1315')).toThrow();
    expect(() => uraMmyyToDate('715')).toThrow();
  });
  it('URA quarters', () => {
    expect(uraQuarter('2026-09-18')).toBe('26q3');
    expect(uraQuarter('2026-01-01')).toBe('26q1');
    expect(previousUraQuarter('26q1')).toBe('25q4');
    expect(previousUraQuarter('10q1')).toBe('09q4');
    expect(uraQuartersBack('2026-09-18', 3)).toEqual(['26q3', '26q2', '26q1']);
  });
  it('daysBetween counts calendar days', () => {
    expect(daysBetween('2026-07-20', '2026-09-18')).toBe(60);
  });
});
```

`test/unit/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';

describe('loadConfig', () => {
  it('applies defaults and treats empty strings as unset', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x', URA_ACCESS_KEY: '', HEALTHCHECK_URL: '' });
    expect(c).toEqual({
      databaseUrl: 'postgres://x',
      uraAccessKey: undefined,
      dataGovSgApiKey: undefined,
      healthcheckUrl: undefined,
      rawArchiveDir: './raw',
      lockFile: './collector.lock',
      logLevel: 'info',
    });
  });
  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
  it('rejects a malformed HEALTHCHECK_URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', HEALTHCHECK_URL: 'nope' })).toThrow();
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run --project unit`
Expected: FAIL, because `src/time` and `src/config` cannot be resolved.

- [ ] **Step 4: Implement**

`src/time.ts`:
```ts
const SGT_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function todaySgt(now: Date = new Date()): string {
  return SGT_DATE.format(now);
}

export function monthToDate(ym: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw new Error(`Invalid month: ${ym}`);
  return `${ym}-01`;
}

export function addMonths(date: string, n: number): string {
  const [y, m] = date.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}-01`;
}

export function uraMmyyToDate(mmyy: string): string {
  if (!/^(0[1-9]|1[0-2])\d{2}$/.test(mmyy)) throw new Error(`Invalid URA MMYY: ${mmyy}`);
  return `20${mmyy.slice(2)}-${mmyy.slice(0, 2)}-01`;
}

export function uraQuarter(date: string): string {
  return `${date.slice(2, 4)}q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
}

export function previousUraQuarter(q: string): string {
  const m = /^(\d{2})q([1-4])$/.exec(q);
  if (!m) throw new Error(`Invalid URA quarter: ${q}`);
  let year = Number(m[1]);
  let quarter = Number(m[2]) - 1;
  if (quarter === 0) { quarter = 4; year -= 1; }
  return `${String(year).padStart(2, '0')}q${quarter}`;
}

/** Newest first: [current, previous, ...]. */
export function uraQuartersBack(date: string, count: number): string[] {
  const out = [uraQuarter(date)];
  while (out.length < count) out.push(previousUraQuarter(out[out.length - 1]));
  return out;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
```

`src/config.ts`:
```ts
import { z } from 'zod';

const blank = (v: unknown) => (v === '' ? undefined : v);
const optionalString = z.preprocess(blank, z.string().optional());

const EnvSchema = z.object({
  DATABASE_URL: z.string({ error: 'DATABASE_URL is required' }).min(1, 'DATABASE_URL is required'),
  URA_ACCESS_KEY: optionalString,
  DATA_GOV_SG_API_KEY: optionalString,
  HEALTHCHECK_URL: z.preprocess(blank, z.url().optional()),
  RAW_ARCHIVE_DIR: z.preprocess(blank, z.string().default('./raw')),
  LOCK_FILE: z.preprocess(blank, z.string().default('./collector.lock')),
  LOG_LEVEL: z.preprocess(blank, z.string().default('info')),
});

export interface Config {
  databaseUrl: string;
  uraAccessKey?: string;
  dataGovSgApiKey?: string;
  healthcheckUrl?: string;
  rawArchiveDir: string;
  lockFile: string;
  logLevel: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }
  const e = result.data;
  return {
    databaseUrl: e.DATABASE_URL,
    uraAccessKey: e.URA_ACCESS_KEY,
    dataGovSgApiKey: e.DATA_GOV_SG_API_KEY,
    healthcheckUrl: e.HEALTHCHECK_URL,
    rawArchiveDir: e.RAW_ARCHIVE_DIR,
    lockFile: e.LOCK_FILE,
    logLevel: e.LOG_LEVEL,
  };
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run --project unit && npx tsc --noEmit`
Expected: all PASS, and no type errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example src/config.ts src/time.ts test/unit
git commit -m "feat: scaffold project with config and time helpers

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Database client, schema migration and integration test harness

**Files:**
- Create: `src/db/client.ts`, `src/db/migrate.ts`, `src/db/migrations/001_init.sql`, `test/integration/global-setup.ts`, `test/integration/helpers.ts`, `test/support/async.ts`
- Test: `test/integration/migrate.test.ts`

**Interfaces:**
- Produces:
  - `type Sql = postgres.Sql`
  - `createSql(url: string): Sql`
  - `migrate(sql: Sql): Promise<string[]>` (the names of newly applied files)
  - Test helpers `connect(): Sql`, `truncateAll(sql)` and `makeRun(sql, source?): Promise<number>`
  - `toAsync<T>(items: T[]): AsyncGenerator<T>`

- [ ] **Step 1: Write the schema**

`src/db/migrations/001_init.sql`:
```sql
create table runs (
  id bigserial primary key,
  source text not null,
  mode text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  fetched integer not null default 0,
  inserted integer not null default 0,
  changed integer not null default 0,
  rejected integer not null default 0,
  error text
);
create index runs_source_started_idx on runs (source, started_at desc);

create table hdb_resale_txn (
  id bigserial primary key,
  month date not null,
  town text not null,
  flat_type text not null,
  block text not null,
  street_name text not null,
  storey_range text not null,
  floor_area_sqm numeric not null,
  flat_model text not null,
  lease_commence_year integer not null,
  remaining_lease text,
  resale_price numeric not null,
  ingested_run_id bigint not null references runs(id)
);
create index hdb_resale_txn_month_idx on hdb_resale_txn (month);

create table hdb_rental_txn (
  id bigserial primary key,
  rent_approval_month date not null,
  town text not null,
  block text not null,
  street_name text not null,
  flat_type text not null,
  monthly_rent numeric not null,
  ingested_run_id bigint not null references runs(id)
);
create index hdb_rental_txn_month_idx on hdb_rental_txn (rent_approval_month);

create table ura_private_txn (
  id bigserial primary key,
  project text not null,
  street text not null,
  market_segment text not null,
  x numeric,
  y numeric,
  contract_month date not null,
  area_sqm numeric not null,
  price numeric not null,
  nett_price numeric,
  property_type text not null,
  type_of_area text not null,
  tenure text not null,
  floor_range text not null,
  type_of_sale text not null,
  district text not null,
  no_of_units integer not null,
  ingested_run_id bigint not null references runs(id)
);
create index ura_private_txn_month_idx on ura_private_txn (contract_month);

create table ura_private_rental (
  id bigserial primary key,
  project text not null,
  street text not null,
  x numeric,
  y numeric,
  ref_quarter text not null,
  lease_month date not null,
  property_type text not null,
  district text not null,
  area_sqm_range text not null,
  area_sqft_range text not null,
  no_of_bedroom integer,
  rent numeric not null,
  ingested_run_id bigint not null references runs(id)
);
create index ura_private_rental_quarter_idx on ura_private_rental (ref_quarter);

create table listings (
  id bigserial primary key,
  source text not null,
  source_listing_id text not null,
  listing_type text not null,
  property_type text not null,
  title text,
  project_name text,
  address text,
  postal_code text,
  district text,
  bedrooms integer,
  bathrooms integer,
  floor_area_sqft numeric,
  price numeric not null,
  psf numeric,
  tenure text,
  built_year integer,
  lat double precision,
  lng double precision,
  url text not null,
  extra jsonb not null default '{}'::jsonb,
  first_seen date not null,
  last_seen date not null,
  status text not null default 'active',
  missed_complete_runs integer not null default 0,
  last_missed_on date,
  updated_run_id bigint references runs(id),
  unique (source, source_listing_id)
);
create index listings_source_status_idx on listings (source, status);

create table listing_versions (
  id bigserial primary key,
  listing_id bigint not null references listings(id),
  observed_on date not null,
  price numeric not null,
  psf numeric,
  floor_area_sqft numeric,
  fingerprint text not null,
  run_id bigint references runs(id)
);
create index listing_versions_listing_idx on listing_versions (listing_id, observed_on desc, id desc);
```

- [ ] **Step 2: Write the client, the migrator and the test harness**

`src/db/client.ts`:
```ts
import postgres from 'postgres';

export type Sql = postgres.Sql;

export function createSql(url: string): Sql {
  return postgres(url, { max: 5, onnotice: () => {} });
}
```

`src/db/migrate.ts`:
```ts
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
```

`test/integration/global-setup.ts`:
```ts
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
```

`test/integration/helpers.ts`:
```ts
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
```

`test/support/async.ts`:
```ts
export async function* toAsync<T>(items: T[]): AsyncGenerator<T> {
  yield* items;
}
```

- [ ] **Step 3: Write the failing test**

`test/integration/migrate.test.ts`:
```ts
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
```

- [ ] **Step 4: Run it**

Start Docker Desktop first.
Run: `npx vitest run --project integration`
Expected: PASS. If you see a Testcontainers "Could not find a working container runtime" error, Docker isn't running; start it and re-run.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/db test/integration test/support/async.ts
git commit -m "feat: add Postgres schema, migrator and integration harness

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Raw archive

**Files:**
- Create: `src/archive.ts`
- Test: `test/unit/archive.test.ts`

**Interfaces:**
- Produces:
  - `interface Payload { key: string; body: string }`
  - `interface Manifest { source: string; label: string; complete: boolean; finishedAt: string; entries: { file: string; key: string }[] }`
  - `class RawArchive(root: string)` with:
    - `begin(source, label): Promise<ArchiveWriter>` (clears any existing dir for that label)
    - `read(source, label): AsyncGenerator<Payload>`
    - `readManifest(source, label): Promise<Manifest | null>`
    - `labels(source): Promise<string[]>` (sorted)
    - `remove(source, label): Promise<void>`
    - `prune(source, keepDays, today): Promise<string[]>`
  - `class ArchiveWriter` with `write(p: Payload)` and `close(complete: boolean)`
- Label convention: `YYYY-MM-DD` (daily), `YYYY-MM-DD-backfill`, `YYYY-MM-DD-dryrun`. Pruning and reprocess use the first 10 characters as the date.

- [ ] **Step 1: Write the failing test**

`test/unit/archive.test.ts`:
```ts
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { RawArchive, type Payload } from '../../src/archive';

let root: string;
let archive: RawArchive;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'archive-'));
  archive = new RawArchive(root);
});

async function collect(it: AsyncIterable<Payload>) {
  const out: Payload[] = [];
  for await (const p of it) out.push(p);
  return out;
}

describe('RawArchive', () => {
  it('round-trips payloads in order with a manifest', async () => {
    const w = await archive.begin('hdb-resale', '2026-09-18');
    await w.write({ key: 'a.csv', body: 'month,town\n2026-08,BEDOK' });
    await w.write({ key: 'b.csv', body: 'x'.repeat(10_000) });
    await w.close(true);

    expect(await collect(archive.read('hdb-resale', '2026-09-18'))).toEqual([
      { key: 'a.csv', body: 'month,town\n2026-08,BEDOK' },
      { key: 'b.csv', body: 'x'.repeat(10_000) },
    ]);
    const m = await archive.readManifest('hdb-resale', '2026-09-18');
    expect(m?.complete).toBe(true);
    expect(m?.entries.map((e) => e.file)).toEqual(['00001.gz', '00002.gz']);
  });

  it('begin() replaces an earlier archive for the same label', async () => {
    const w1 = await archive.begin('s', '2026-09-18');
    await w1.write({ key: 'old', body: 'old' });
    await w1.close(true);
    const w2 = await archive.begin('s', '2026-09-18');
    await w2.write({ key: 'new', body: 'new' });
    await w2.close(false);
    expect(await collect(archive.read('s', '2026-09-18'))).toEqual([{ key: 'new', body: 'new' }]);
    expect((await archive.readManifest('s', '2026-09-18'))?.complete).toBe(false);
  });

  it('has no manifest when the writer never closed', async () => {
    const w = await archive.begin('s', '2026-09-18');
    await w.write({ key: 'k', body: 'b' });
    expect(await archive.readManifest('s', '2026-09-18')).toBeNull();
    await expect(collect(archive.read('s', '2026-09-18'))).rejects.toThrow(/No archive/);
  });

  it('lists labels sorted, removes and prunes by age', async () => {
    for (const label of ['2026-09-18', '2026-07-01', '2026-07-20-backfill', '2026-07-19']) {
      const w = await archive.begin('99co', label);
      await w.close(true);
    }
    expect(await archive.labels('99co')).toEqual(['2026-07-01', '2026-07-19', '2026-07-20-backfill', '2026-09-18']);
    expect(await archive.labels('missing')).toEqual([]);

    const removed = await archive.prune('99co', 60, '2026-09-18');
    expect(removed).toEqual(['2026-07-01', '2026-07-19']);
    expect(await readdir(path.join(root, '99co'))).toEqual(['2026-07-20-backfill', '2026-09-18']);

    await archive.remove('99co', '2026-09-18');
    expect(await archive.labels('99co')).toEqual(['2026-07-20-backfill']);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run --project unit test/unit/archive.test.ts`
Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement**

`src/archive.ts`:
```ts
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { daysBetween } from './time';

export interface Payload {
  key: string;
  body: string;
}

export interface Manifest {
  source: string;
  label: string;
  complete: boolean;
  finishedAt: string;
  entries: { file: string; key: string }[];
}

const MANIFEST = 'manifest.json';

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export class ArchiveWriter {
  private readonly entries: Manifest['entries'] = [];

  constructor(private readonly dir: string, private readonly source: string, private readonly label: string) {}

  async write(p: Payload): Promise<void> {
    const file = `${String(this.entries.length + 1).padStart(5, '0')}.gz`;
    await writeFile(path.join(this.dir, file), gzipSync(p.body));
    this.entries.push({ file, key: p.key });
  }

  async close(complete: boolean): Promise<void> {
    const manifest: Manifest = {
      source: this.source, label: this.label, complete,
      finishedAt: new Date().toISOString(), entries: this.entries,
    };
    await writeFile(path.join(this.dir, MANIFEST), JSON.stringify(manifest, null, 2));
  }
}

export class RawArchive {
  constructor(private readonly root: string) {}

  private dir(source: string, label: string): string {
    return path.join(this.root, source, label);
  }

  async begin(source: string, label: string): Promise<ArchiveWriter> {
    const dir = this.dir(source, label);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    return new ArchiveWriter(dir, source, label);
  }

  async readManifest(source: string, label: string): Promise<Manifest | null> {
    try {
      return JSON.parse(await readFile(path.join(this.dir(source, label), MANIFEST), 'utf8')) as Manifest;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async *read(source: string, label: string): AsyncGenerator<Payload> {
    const manifest = await this.readManifest(source, label);
    if (!manifest) throw new Error(`No archive for ${source}/${label}`);
    for (const entry of manifest.entries) {
      const body = gunzipSync(await readFile(path.join(this.dir(source, label), entry.file))).toString('utf8');
      yield { key: entry.key, body };
    }
  }

  async labels(source: string): Promise<string[]> {
    try {
      return (await readdir(path.join(this.root, source))).sort();
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  async remove(source: string, label: string): Promise<void> {
    await rm(this.dir(source, label), { recursive: true, force: true });
  }

  /** Deletes archives whose date (first 10 chars of the label) is more than keepDays before today. */
  async prune(source: string, keepDays: number, today: string): Promise<string[]> {
    const removed: string[] = [];
    for (const label of await this.labels(source)) {
      if (daysBetween(label.slice(0, 10), today) > keepDays) {
        await this.remove(source, label);
        removed.push(label);
      }
    }
    return removed;
  }
}
```

In the test, `2026-07-20` is exactly 60 days before `2026-09-18`, so it is kept (the rule is `> keepDays`). `2026-07-19` is 61 days before and is removed.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run --project unit test/unit/archive.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/archive.ts test/unit/archive.test.ts
git commit -m "feat: add gzipped raw-response archive

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---
### Task 4: HTTP fetcher and fake fetcher

**Files:**
- Create: `src/fetch/types.ts`, `src/fetch/http.ts`, `test/support/fake-fetcher.ts`
- Test: `test/unit/fetch/http.test.ts`

**Interfaces:**
- Produces:
  - `interface RequestOptions { headers?: Record<string, string> }`
  - `interface Fetcher { text(url: string, opts?: RequestOptions): Promise<string>; json<T = unknown>(url: string, opts?: RequestOptions): Promise<T> }`
  - `class HttpError extends Error { status: number; url: string }`
  - `class HttpFetcher implements Fetcher`, constructed with `new HttpFetcher(opts?: HttpFetcherOptions)`
  - `sleep(ms: number): Promise<void>`
  - Test-only: `class FakeFetcher implements Fetcher`. It takes `routes: Array<[string | RegExp, string | ((url: string) => string)]>` and records `calls: { url: string; headers: Record<string, string> }[]`.
- Retry policy: 3 attempts in total. Network errors and 5xx back off exponentially (`baseDelayMs * 2^attempt`). A 429 waits `rateLimitDelayMs` (default 12 000). Any other 4xx throws immediately.

- [ ] **Step 1: Write the failing test**

`test/unit/fetch/http.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../src/fetch/types';
import { HttpFetcher } from '../../../src/fetch/http';

function setup(responses: Array<Response | Error>) {
  const delays: number[] = [];
  const fetchImpl = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const fetcher = new HttpFetcher({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: async (ms) => { delays.push(ms); },
    baseDelayMs: 100,
    rateLimitDelayMs: 5000,
  });
  return { fetcher, fetchImpl, delays };
}

describe('HttpFetcher', () => {
  it('returns the body and sends a user agent plus custom headers', async () => {
    const { fetcher, fetchImpl } = setup([new Response('hello')]);
    expect(await fetcher.text('https://x.test/a', { headers: { AccessKey: 'k' } })).toBe('hello');
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ AccessKey: 'k' });
    expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/sg-property-collector/);
  });

  it('parses JSON', async () => {
    const { fetcher } = setup([new Response('{"a":1}')]);
    expect(await fetcher.json('https://x.test')).toEqual({ a: 1 });
  });

  it('retries 5xx and network errors with exponential backoff', async () => {
    const { fetcher, delays } = setup([new Response('boom', { status: 502 }), new Error('ECONNRESET'), new Response('ok')]);
    expect(await fetcher.text('https://x.test')).toBe('ok');
    expect(delays).toEqual([100, 200]);
  });

  it('waits the rate-limit delay on 429', async () => {
    const { fetcher, delays } = setup([new Response('slow down', { status: 429 }), new Response('ok')]);
    expect(await fetcher.text('https://x.test')).toBe('ok');
    expect(delays).toEqual([5000]);
  });

  it('gives up after 3 attempts with the last error', async () => {
    const { fetcher, fetchImpl } = setup([
      new Response('a', { status: 500 }), new Response('b', { status: 500 }), new Response('c', { status: 503 }),
    ]);
    await expect(fetcher.text('https://x.test')).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry other 4xx', async () => {
    const { fetcher, fetchImpl } = setup([new Response('nope', { status: 403 })]);
    const err = await fetcher.text('https://x.test').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run --project unit test/unit/fetch`
Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement**

`src/fetch/types.ts`:
```ts
export interface RequestOptions {
  headers?: Record<string, string>;
}

export interface Fetcher {
  text(url: string, opts?: RequestOptions): Promise<string>;
  json<T = unknown>(url: string, opts?: RequestOptions): Promise<T>;
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string, body: string) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}
```

`src/fetch/http.ts`:
```ts
import { HttpError, type Fetcher, type RequestOptions } from './types';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface HttpFetcherOptions {
  attempts?: number;
  baseDelayMs?: number;
  rateLimitDelayMs?: number;
  timeoutMs?: number;
  userAgent?: string;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export class HttpFetcher implements Fetcher {
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly rateLimitDelayMs: number;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpFetcherOptions = {}) {
    this.attempts = opts.attempts ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.rateLimitDelayMs = opts.rateLimitDelayMs ?? 12_000;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.userAgent = opts.userAgent ?? 'sg-property-collector/0.1 (+personal research)';
    this.sleep = opts.sleep ?? sleep;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async text(url: string, opts: RequestOptions = {}): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const isLast = attempt === this.attempts - 1;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: { 'User-Agent': this.userAgent, ...opts.headers },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastError = err;
        if (!isLast) await this.sleep(this.baseDelayMs * 2 ** attempt);
        continue;
      }
      const body = await res.text();
      if (res.ok) return body;
      const err = new HttpError(res.status, url, body);
      if (res.status !== 429 && res.status < 500) throw err;
      lastError = err;
      if (!isLast) await this.sleep(res.status === 429 ? this.rateLimitDelayMs : this.baseDelayMs * 2 ** attempt);
    }
    throw lastError;
  }

  async json<T = unknown>(url: string, opts?: RequestOptions): Promise<T> {
    return JSON.parse(await this.text(url, opts)) as T;
  }
}
```

`test/support/fake-fetcher.ts`:
```ts
import type { Fetcher, RequestOptions } from '../../src/fetch/types';

type Route = [string | RegExp, string | ((url: string) => string)];

export class FakeFetcher implements Fetcher {
  readonly calls: { url: string; headers: Record<string, string> }[] = [];

  constructor(private readonly routes: Route[]) {}

  async text(url: string, opts: RequestOptions = {}): Promise<string> {
    this.calls.push({ url, headers: opts.headers ?? {} });
    const route = this.routes.find(([m]) => (typeof m === 'string' ? m === url : m.test(url)));
    if (!route) throw new Error(`FakeFetcher: no route for ${url}`);
    return typeof route[1] === 'function' ? route[1](url) : route[1];
  }

  async json<T = unknown>(url: string, opts?: RequestOptions): Promise<T> {
    return JSON.parse(await this.text(url, opts)) as T;
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run --project unit && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fetch test/support/fake-fetcher.ts test/unit/fetch
git commit -m "feat: add retrying HTTP fetcher

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Collector contract, run records and runner

**Files:**
- Create: `src/collectors/types.ts`, `src/runs.ts`, `src/runner.ts`, `test/support/context.ts`
- Test: `test/integration/runner.test.ts`

**Interfaces:**
- Consumes: `Sql` (Task 2), `RawArchive`/`Payload` (Task 3), `todaySgt` (Task 1).
- Produces:
  - `src/collectors/types.ts`:
    - `RunMode = 'daily' | 'backfill' | 'reprocess' | 'dry-run'`
    - `RunOptions`, `FetchContext`, `IngestContext`, `IngestResult` and `Collector`, exactly as in the spec's "Collector interface" section
  - `src/runs.ts`:
    - `RunStatus = 'running' | 'success' | 'incomplete' | 'failed'`
    - `RunRow`
    - `startRun(sql, source, mode): Promise<number>`
    - `finishRun(sql, id, f: RunFinish)`
    - `recentRuns(sql, days): Promise<RunRow[]>`
    - `lastRuns(sql, source, n): Promise<RunRow[]>` (daily runs only, newest first)
  - `src/runner.ts`:
    - `RunnerDeps { sql; archive; logger; now?: () => Date }`
    - `CollectorOutcome { source; kind; runId; mode; status: 'success' | 'incomplete' | 'failed'; result?; error? }`
    - `runCollector(deps, collector, options)`
    - `runAll(deps, collectors, options)` (official collectors first; never throws for a collector failure)
    - `reprocess(deps, collector, fromDate)`
  - `test/support/context.ts`: `silentLogger`, `ingestCtx(runId, overrides?)` and `fetchCtx(options?, runDate?)`

- [ ] **Step 1: Write the types and test support**

`src/collectors/types.ts`:
```ts
import type { Logger } from 'pino';
import type { Payload } from '../archive';
import type { Sql } from '../db/client';

export type RunMode = 'daily' | 'backfill' | 'reprocess' | 'dry-run';

export interface RunOptions {
  backfill: boolean;
  dryRun: boolean;
  /** Maximum number of payloads to fetch; used for smoke tests. */
  limit?: number;
}

export interface FetchContext {
  runDate: string;
  logger: Logger;
  options: RunOptions;
}

export interface IngestContext {
  runId: number;
  runDate: string;
  logger: Logger;
  backfill: boolean;
  dryRun: boolean;
  fetchComplete: boolean;
}

export interface IngestResult {
  fetched: number;
  inserted: number;
  changed: number;
  rejected: number;
  complete: boolean;
}

export interface Collector {
  name: string;
  kind: 'official' | 'listing';
  fetch(ctx: FetchContext, emit: (p: Payload) => Promise<void>): Promise<{ complete: boolean }>;
  ingest(tx: Sql, payloads: AsyncIterable<Payload>, ctx: IngestContext): Promise<IngestResult>;
}
```

`test/support/context.ts`:
```ts
import pino from 'pino';
import type { FetchContext, IngestContext, RunOptions } from '../../src/collectors/types';

export const silentLogger = pino({ level: 'silent' });

export function ingestCtx(runId: number, overrides: Partial<IngestContext> = {}): IngestContext {
  return {
    runId, runDate: '2026-09-18', logger: silentLogger,
    backfill: false, dryRun: false, fetchComplete: true, ...overrides,
  };
}

export function fetchCtx(options: Partial<RunOptions> = {}, runDate = '2026-09-18'): FetchContext {
  return { runDate, logger: silentLogger, options: { backfill: false, dryRun: false, ...options } };
}
```

- [ ] **Step 2: Write the failing test**

`test/integration/runner.test.ts`:
```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { RawArchive } from '../../src/archive';
import type { Collector } from '../../src/collectors/types';
import { reprocess, runAll, runCollector, type RunnerDeps } from '../../src/runner';
import { lastRuns, recentRuns } from '../../src/runs';
import { silentLogger } from '../support/context';
import { connect, truncateAll } from './helpers';

const sql = connect();
afterAll(() => sql.end());

let deps: RunnerDeps;
beforeEach(async () => {
  await truncateAll(sql);
  const root = await mkdtemp(path.join(tmpdir(), 'runner-'));
  deps = { sql, archive: new RawArchive(root), logger: silentLogger, now: () => new Date('2026-09-18T02:00:00Z') };
});

const opts = { backfill: false, dryRun: false };

function fake(overrides: Partial<Collector> & { name: string }): Collector {
  return {
    kind: 'official',
    async fetch(_ctx, emit) {
      await emit({ key: 'a', body: '1' });
      await emit({ key: 'b', body: '2' });
      return { complete: true };
    },
    async ingest(tx, payloads) {
      let n = 0;
      for await (const _ of payloads) {
        n++;
        await tx`insert into runs (source, mode) values ('side-effect', 'x')`;
      }
      return { fetched: n, inserted: n, changed: 0, rejected: 0, complete: true };
    },
    ...overrides,
  };
}

const sideEffects = async () =>
  (await sql<{ n: number }[]>`select count(*)::int as n from runs where source = 'side-effect'`)[0].n;

describe('runner', () => {
  it('fetches, archives, ingests and records a successful run', async () => {
    const out = await runCollector(deps, fake({ name: 'a' }), opts);
    expect(out).toMatchObject({ source: 'a', status: 'success', mode: 'daily', result: { fetched: 2 } });
    const [run] = (await recentRuns(sql, 7)).filter((r) => r.source === 'a');
    expect(run).toMatchObject({ status: 'success', fetched: 2, inserted: 2, mode: 'daily' });
    expect(run.finished_at).toBeInstanceOf(Date);
    expect((await deps.archive.readManifest('a', '2026-09-18'))?.complete).toBe(true);
    expect(await sideEffects()).toBe(2);
  });

  it('isolates failures: a throwing collector is recorded and the next still runs', async () => {
    const broken = fake({ name: 'broken', async fetch() { throw new Error('site down'); } });
    const outcomes = await runAll(deps, [broken, fake({ name: 'ok' })], opts);
    expect(outcomes.map((o) => [o.source, o.status])).toEqual([['broken', 'failed'], ['ok', 'success']]);
    expect(outcomes[0].error).toBe('site down');
    const [run] = await lastRuns(sql, 'broken', 1);
    expect(run).toMatchObject({ status: 'failed', error: 'site down' });
  });

  it('rolls back ingest writes when ingest throws', async () => {
    const c = fake({
      name: 'half',
      async ingest(tx) {
        await tx`insert into runs (source, mode) values ('side-effect', 'x')`;
        throw new Error('bad data');
      },
    });
    const out = await runCollector(deps, c, opts);
    expect(out.status).toBe('failed');
    expect(await sideEffects()).toBe(0);
  });

  it('dry run ingests but rolls back and removes its archive', async () => {
    const out = await runCollector(deps, fake({ name: 'dry' }), { ...opts, dryRun: true });
    expect(out).toMatchObject({ status: 'success', mode: 'dry-run', result: { fetched: 2 } });
    expect(await sideEffects()).toBe(0);
    expect(await deps.archive.labels('dry')).toEqual([]);
  });

  it('passes fetch completeness to ingest and records incomplete runs', async () => {
    const seen: boolean[] = [];
    const c = fake({
      name: 'partial',
      kind: 'listing',
      async fetch(_ctx, emit) { await emit({ key: 'p1', body: '[]' }); return { complete: false }; },
      async ingest(_tx, payloads, ctx) {
        for await (const _ of payloads) { /* drain */ }
        seen.push(ctx.fetchComplete);
        return { fetched: 1, inserted: 0, changed: 0, rejected: 0, complete: ctx.fetchComplete };
      },
    });
    const out = await runCollector(deps, c, opts);
    expect(seen).toEqual([false]);
    expect(out.status).toBe('incomplete');
  });

  it('runs official collectors before listing collectors', async () => {
    const order: string[] = [];
    const mk = (name: string, kind: Collector['kind']) =>
      fake({ name, kind, async fetch() { order.push(name); return { complete: true }; } });
    await runAll(deps, [mk('l1', 'listing'), mk('o1', 'official'), mk('l2', 'listing'), mk('o2', 'official')], opts);
    expect(order).toEqual(['o1', 'o2', 'l1', 'l2']);
  });

  it('uses a backfill label and mode', async () => {
    const out = await runCollector(deps, fake({ name: 'bf' }), { ...opts, backfill: true });
    expect(out.mode).toBe('backfill');
    expect(await deps.archive.labels('bf')).toEqual(['2026-09-18-backfill']);
  });

  it('reprocess re-ingests archived payloads from a date onward', async () => {
    const c = fake({ name: 'rp' });
    await runCollector(deps, c, opts);
    const outcomes = await reprocess(deps, c, '2026-09-01');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ mode: 'reprocess', status: 'success', result: { fetched: 2 } });
    expect(await sideEffects()).toBe(4);
    expect(await reprocess(deps, c, '2026-09-19')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run --project integration test/integration/runner.test.ts`
Expected: FAIL, because `src/runner` and `src/runs` aren't found.

- [ ] **Step 4: Implement**

`src/runs.ts`:
```ts
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
```


`src/runner.ts`:
```ts
import type { Logger } from 'pino';
import type { RawArchive } from './archive';
import type { Collector, IngestContext, IngestResult, RunMode, RunOptions } from './collectors/types';
import type { Sql } from './db/client';
import { finishRun, startRun } from './runs';
import { todaySgt } from './time';

export interface RunnerDeps {
  sql: Sql;
  archive: RawArchive;
  logger: Logger;
  now?: () => Date;
}

export interface CollectorOutcome {
  source: string;
  kind: Collector['kind'];
  runId: number;
  mode: RunMode;
  status: 'success' | 'incomplete' | 'failed';
  result?: IngestResult;
  error?: string;
}

class DryRunRollback extends Error {
  constructor(readonly result: IngestResult) {
    super('dry-run rollback');
  }
}

async function ingestFromArchive(
  deps: RunnerDeps, collector: Collector, label: string, ctx: IngestContext,
): Promise<IngestResult> {
  try {
    return (await deps.sql.begin(async (tx) => {
      const result = await collector.ingest(tx, deps.archive.read(collector.name, label), ctx);
      if (ctx.dryRun) throw new DryRunRollback(result);
      return result;
    })) as IngestResult;
  } catch (err) {
    if (err instanceof DryRunRollback) return err.result;
    throw err;
  }
}

async function succeed(
  deps: RunnerDeps, collector: Collector, runId: number, mode: RunMode, result: IngestResult, logger: Logger,
): Promise<CollectorOutcome> {
  const status = result.complete ? 'success' : 'incomplete';
  await finishRun(deps.sql, runId, { status, ...result });
  logger.info({ ...result, status }, 'collector finished');
  return { source: collector.name, kind: collector.kind, runId, mode, status, result };
}

async function fail(
  deps: RunnerDeps, collector: Collector, runId: number, mode: RunMode, err: unknown, logger: Logger,
): Promise<CollectorOutcome> {
  const error = err instanceof Error ? err.message : String(err);
  logger.error({ err }, 'collector failed');
  await finishRun(deps.sql, runId, { status: 'failed', error });
  return { source: collector.name, kind: collector.kind, runId, mode, status: 'failed', error };
}

export async function runCollector(
  deps: RunnerDeps, collector: Collector, options: RunOptions,
): Promise<CollectorOutcome> {
  const runDate = todaySgt(deps.now?.() ?? new Date());
  const mode: RunMode = options.dryRun ? 'dry-run' : options.backfill ? 'backfill' : 'daily';
  const label = options.dryRun ? `${runDate}-dryrun` : options.backfill ? `${runDate}-backfill` : runDate;
  const logger = deps.logger.child({ source: collector.name, mode });
  const runId = await startRun(deps.sql, collector.name, mode);
  try {
    const writer = await deps.archive.begin(collector.name, label);
    const { complete } = await collector.fetch({ runDate, logger, options }, (p) => writer.write(p));
    await writer.close(complete);
    const result = await ingestFromArchive(deps, collector, label, {
      runId, runDate, logger, backfill: options.backfill, dryRun: options.dryRun, fetchComplete: complete,
    });
    return await succeed(deps, collector, runId, mode, result, logger);
  } catch (err) {
    return fail(deps, collector, runId, mode, err, logger);
  } finally {
    if (options.dryRun) await deps.archive.remove(collector.name, label);
  }
}

export async function runAll(
  deps: RunnerDeps, collectors: Collector[], options: RunOptions,
): Promise<CollectorOutcome[]> {
  const ordered = [
    ...collectors.filter((c) => c.kind === 'official'),
    ...collectors.filter((c) => c.kind === 'listing'),
  ];
  const outcomes: CollectorOutcome[] = [];
  for (const c of ordered) outcomes.push(await runCollector(deps, c, options));
  return outcomes;
}

/** Re-ingests archived payloads (no network) for every archive dated on or after fromDate. */
export async function reprocess(
  deps: RunnerDeps, collector: Collector, fromDate: string,
): Promise<CollectorOutcome[]> {
  const outcomes: CollectorOutcome[] = [];
  const labels = (await deps.archive.labels(collector.name))
    .filter((l) => l.slice(0, 10) >= fromDate && !l.endsWith('-dryrun'));
  for (const label of labels) {
    const manifest = await deps.archive.readManifest(collector.name, label);
    const logger = deps.logger.child({ source: collector.name, mode: 'reprocess', label });
    if (!manifest) {
      logger.warn('skipping archive without manifest (its fetch never finished)');
      continue;
    }
    const runId = await startRun(deps.sql, collector.name, 'reprocess');
    try {
      const result = await ingestFromArchive(deps, collector, label, {
        runId, runDate: label.slice(0, 10), logger,
        backfill: label.endsWith('-backfill'), dryRun: false, fetchComplete: manifest.complete,
      });
      outcomes.push(await succeed(deps, collector, runId, 'reprocess', result, logger));
    } catch (err) {
      outcomes.push(await fail(deps, collector, runId, 'reprocess', err, logger));
    }
  }
  return outcomes;
}
```


- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run --project integration test/integration/runner.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/collectors/types.ts src/runs.ts src/runner.ts test/support/context.ts test/integration/runner.test.ts
git commit -m "feat: add collector contract, run records and runner

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Shared validation and replace-by-period

**Files:**
- Create: `src/official/common.ts`, `src/official/replace.ts`
- Test: `test/unit/official/common.test.ts`, `test/integration/replace.test.ts`

**Interfaces:**
- Consumes: `Sql` (Task 2).
- Produces:
  - `parseCsv(csv: string): Record<string, string>[]`
  - `validateRows<S extends z.ZodType, R>(records: unknown[], schema: S, map: (v: z.infer<S>) => R): { rows: R[]; rejected: number; samples: string[] }` (at most 3 samples)
  - `class RejectRateError extends Error`
  - `assertRejectRate(source: string, total: number, rejected: number, max = 0.05): void`
  - `nullableNumber(v: unknown): number | null`
  - `interface ReplaceSpec { table: string; periodColumn: string; columns: string[] }`
  - `class VolumeGuardError extends Error`
  - `replacePeriods(tx: Sql, spec: ReplaceSpec, periods: string[], rows: Record<string, unknown>[], minRatio = 0.95): Promise<{ deleted: number; inserted: number }>`

- [ ] **Step 1: Write the failing tests**

`test/unit/official/common.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assertRejectRate, nullableNumber, parseCsv, RejectRateError, validateRows } from '../../../src/official/common';

describe('official/common', () => {
  it('parseCsv reads headers, trims and skips blank lines', () => {
    expect(parseCsv('﻿a,b\n 1 ,2\n\n3,4\n')).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  });

  it('validateRows maps valid rows and counts rejects with samples', () => {
    const schema = z.object({ n: z.coerce.number().positive() });
    const out = validateRows([{ n: '1' }, { n: '-1' }, { n: 'x' }, { n: '2' }], schema, (v) => v.n * 10);
    expect(out.rows).toEqual([10, 20]);
    expect(out.rejected).toBe(2);
    expect(out.samples).toHaveLength(2);
    expect(out.samples[0]).toMatch(/^n: /);
  });

  it('assertRejectRate throws above the threshold only', () => {
    expect(() => assertRejectRate('s', 100, 5)).not.toThrow();
    expect(() => assertRejectRate('s', 100, 6)).toThrow(RejectRateError);
    expect(() => assertRejectRate('s', 0, 0)).not.toThrow();
  });

  it('nullableNumber', () => {
    expect(nullableNumber('')).toBeNull();
    expect(nullableNumber(undefined)).toBeNull();
    expect(nullableNumber('abc')).toBeNull();
    expect(nullableNumber('24997.8217')).toBe(24997.8217);
    expect(nullableNumber(3)).toBe(3);
  });
});
```

`test/integration/replace.test.ts`:
```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { replacePeriods, VolumeGuardError, type ReplaceSpec } from '../../src/official/replace';
import { connect, makeRun, truncateAll } from './helpers';

const sql = connect();
afterAll(() => sql.end());

const SPEC: ReplaceSpec = {
  table: 'hdb_rental_txn',
  periodColumn: 'rent_approval_month',
  columns: ['rent_approval_month', 'town', 'block', 'street_name', 'flat_type', 'monthly_rent', 'ingested_run_id'],
};

let runId: number;
beforeEach(async () => {
  await truncateAll(sql);
  runId = await makeRun(sql);
});

const row = (month: string, rent: number) => ({
  rent_approval_month: month, town: 'BEDOK', block: '1', street_name: 'BEDOK NTH RD',
  flat_type: '3-ROOM', monthly_rent: rent, ingested_run_id: runId,
});

const monthCounts = async () =>
  sql<{ month: string; n: number; total: number }[]>`
    select rent_approval_month::text as month, count(*)::int as n, sum(monthly_rent)::int as total
    from hdb_rental_txn group by 1 order by 1`;

describe('replacePeriods', () => {
  it('replaces only the given periods and keeps legitimate duplicates', async () => {
    await sql.begin((tx) => replacePeriods(tx, SPEC,
      ['2026-06-01', '2026-07-01'], [row('2026-06-01', 2000), row('2026-07-01', 2100)]));
    const res = await sql.begin((tx) => replacePeriods(tx, SPEC,
      ['2026-07-01', '2026-08-01'],
      [row('2026-07-01', 3000), row('2026-08-01', 3100), row('2026-08-01', 3100)]));
    expect(res).toEqual({ deleted: 1, inserted: 3 });
    expect(await monthCounts()).toEqual([
      { month: '2026-06-01', n: 1, total: 2000 },
      { month: '2026-07-01', n: 1, total: 3000 },
      { month: '2026-08-01', n: 2, total: 6200 },
    ]);
  });

  it('allows a shrink within 5% but refuses a larger one', async () => {
    const hundred = Array.from({ length: 100 }, () => row('2026-08-01', 2000));
    await sql.begin((tx) => replacePeriods(tx, SPEC, ['2026-08-01'], hundred));
    await sql.begin((tx) => replacePeriods(tx, SPEC, ['2026-08-01'], hundred.slice(0, 95)));
    await expect(sql.begin((tx) => replacePeriods(tx, SPEC, ['2026-08-01'], hundred.slice(0, 90))))
      .rejects.toBeInstanceOf(VolumeGuardError);
    expect((await monthCounts())[0].n).toBe(95);
  });

  it('refuses rows outside the declared periods', async () => {
    await expect(sql.begin((tx) => replacePeriods(tx, SPEC, ['2026-08-01'], [row('2026-07-01', 1)])))
      .rejects.toThrow(/outside the replaced periods/);
  });

  it('is a no-op for no periods and inserts in chunks', async () => {
    expect(await sql.begin((tx) => replacePeriods(tx, SPEC, [], []))).toEqual({ deleted: 0, inserted: 0 });
    const many = Array.from({ length: 2500 }, () => row('2026-01-01', 1));
    await sql.begin((tx) => replacePeriods(tx, SPEC, ['2026-01-01'], many));
    expect((await monthCounts())[0].n).toBe(2500);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/unit/official test/integration/replace.test.ts`
Expected: FAIL, because the modules aren't found.

- [ ] **Step 3: Implement**

`src/official/common.ts`:
```ts
import { parse } from 'csv-parse/sync';
import type { z } from 'zod';

export function parseCsv(csv: string): Record<string, string>[] {
  return parse(csv, { columns: true, skip_empty_lines: true, bom: true, trim: true }) as Record<string, string>[];
}

export function validateRows<S extends z.ZodType, R>(
  records: unknown[], schema: S, map: (v: z.infer<S>) => R,
): { rows: R[]; rejected: number; samples: string[] } {
  const rows: R[] = [];
  const samples: string[] = [];
  let rejected = 0;
  for (const record of records) {
    const result = schema.safeParse(record);
    if (result.success) {
      rows.push(map(result.data));
      continue;
    }
    rejected++;
    if (samples.length < 3) {
      samples.push(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
  }
  return { rows, rejected, samples };
}

export class RejectRateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RejectRateError';
  }
}

export function assertRejectRate(source: string, total: number, rejected: number, max = 0.05): void {
  if (total > 0 && rejected / total > max) {
    throw new RejectRateError(`${source}: ${rejected}/${total} records failed validation (limit ${max * 100}%)`);
  }
}

export function nullableNumber(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
```

`src/official/replace.ts`:
```ts
import type { Sql } from '../db/client';

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
  tx: Sql, spec: ReplaceSpec, periods: string[], rows: Record<string, unknown>[], minRatio = 0.95,
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
```

If `tsc` rejects `tx(chunk, ...spec.columns)` because of the `postgres` helper's generic typing, write `tx(chunk as Record<string, unknown>[], ...(spec.columns as string[]))`. The runtime behaviour is the same.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/unit/official test/integration/replace.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/official/common.ts src/official/replace.ts test/unit/official test/integration/replace.test.ts
git commit -m "feat: add row validation and guarded replace-by-period

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: data.gov.sg download client

**Files:**
- Create: `src/official/datagovsg.ts`
- Test: `test/unit/official/datagovsg.test.ts`

**Interfaces:**
- Consumes: `Fetcher` (Task 4), `FakeFetcher` (tests).
- Produces:
  - `DATAGOVSG_DATASETS = { hdbResaleCurrent, hdbResaleHistorical: string[] (oldest first), hdbRental }`
  - `interface DataGovSgOptions { apiKey?: string; sleep?: (ms: number) => Promise<void>; pollIntervalMs?: number; maxPolls?: number; rateLimitDelayMs?: number }`
  - `downloadDatasetCsv(fetcher: Fetcher, datasetId: string, opts?: DataGovSgOptions): Promise<string>`

- [ ] **Step 1: Write the failing test**

`test/unit/official/datagovsg.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { downloadDatasetCsv } from '../../../src/official/datagovsg';
import { FakeFetcher } from '../../support/fake-fetcher';

const ID = 'd_test';
const BASE = `https://api-open.data.gov.sg/v1/public/api/datasets/${ID}`;
const noWait = { sleep: async () => {}, pollIntervalMs: 0 };

describe('downloadDatasetCsv', () => {
  it('initiates, polls until ready and downloads the CSV', async () => {
    let polls = 0;
    const fetcher = new FakeFetcher([
      [`${BASE}/initiate-download`, JSON.stringify({ code: 0, data: { message: 'initiated' } })],
      [`${BASE}/poll-download`, () => JSON.stringify(++polls < 2
        ? { code: 0, data: { status: 'IN_PROGRESS' } }
        : { code: 0, data: { status: 'DOWNLOAD_SUCCESS', url: 'https://s3.test/file.csv' } })],
      ['https://s3.test/file.csv', 'month,town\n2026-08,BEDOK\n'],
    ]);
    expect(await downloadDatasetCsv(fetcher, ID, { ...noWait, apiKey: 'k' })).toBe('month,town\n2026-08,BEDOK\n');
    expect(polls).toBe(2);
    expect(fetcher.calls[0].headers).toEqual({ 'x-api-key': 'k' });
    expect(fetcher.calls.at(-1)?.headers).toEqual({});
  });

  it('waits and retries on the rate-limit code 24', async () => {
    const waits: number[] = [];
    let initiates = 0;
    const fetcher = new FakeFetcher([
      [`${BASE}/initiate-download`, () => JSON.stringify(++initiates === 1
        ? { code: 24, errorMsg: 'Rate limit exceeded' } : { code: 0, data: {} })],
      [`${BASE}/poll-download`, JSON.stringify({ code: 0, data: { status: 'DOWNLOAD_SUCCESS', url: 'https://s3.test/f' } })],
      ['https://s3.test/f', 'csv'],
    ]);
    await downloadDatasetCsv(fetcher, ID, { sleep: async (ms) => { waits.push(ms); }, pollIntervalMs: 0, rateLimitDelayMs: 12_000 });
    expect(initiates).toBe(2);
    expect(waits).toContain(12_000);
  });

  it('fails on other API error codes', async () => {
    const fetcher = new FakeFetcher([[`${BASE}/initiate-download`, JSON.stringify({ code: 4, errorMsg: 'Not found' })]]);
    await expect(downloadDatasetCsv(fetcher, ID, noWait)).rejects.toThrow(/Not found/);
  });

  it('gives up when the download never becomes ready', async () => {
    const fetcher = new FakeFetcher([
      [`${BASE}/initiate-download`, JSON.stringify({ code: 0, data: {} })],
      [`${BASE}/poll-download`, JSON.stringify({ code: 0, data: { status: 'IN_PROGRESS' } })],
    ]);
    await expect(downloadDatasetCsv(fetcher, ID, { ...noWait, maxPolls: 3 })).rejects.toThrow(/not ready after 3 polls/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run --project unit test/unit/official/datagovsg.test.ts`
Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement**

`src/official/datagovsg.ts`:
```ts
import { sleep as realSleep } from '../fetch/http';
import type { Fetcher } from '../fetch/types';

/** Verified against data.gov.sg on 2026-09-18. */
export const DATAGOVSG_DATASETS = {
  hdbResaleCurrent: 'd_8b84c4ee58e3cfc0ece0d773c8ca6abc', // Jan 2017 onwards (registration date)
  hdbResaleHistorical: [
    'd_ebc5ab87086db484f88045b47411ebc5', // 1990–1999 (approval date)
    'd_43f493c6c50d54243cc1eab0df142d6a', // 2000–Feb 2012 (approval date)
    'd_2d5ff9ea31397b66239f245f57751537', // Mar 2012–Dec 2014 (registration date)
    'd_ea9ed51da2787afaf8e51f827c304208', // Jan 2015–Dec 2016 (registration date)
  ],
  hdbRental: 'd_c9f57187485a850908655db0e8cfe651', // Renting out of flats, Jan 2021 onwards
} as const;

const BASE = 'https://api-open.data.gov.sg/v1/public/api/datasets';
const RATE_LIMITED = 24;

interface ApiResponse {
  code: number;
  errorMsg?: string;
  data: { status?: string; url?: string; message?: string } | null;
}

export interface DataGovSgOptions {
  apiKey?: string;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
  rateLimitDelayMs?: number;
}

export async function downloadDatasetCsv(
  fetcher: Fetcher, datasetId: string, opts: DataGovSgOptions = {},
): Promise<string> {
  const sleep = opts.sleep ?? realSleep;
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;
  const maxPolls = opts.maxPolls ?? 20;
  const rateLimitDelayMs = opts.rateLimitDelayMs ?? 12_000;
  const headers: Record<string, string> = opts.apiKey ? { 'x-api-key': opts.apiKey } : {};

  const call = async (action: 'initiate-download' | 'poll-download') => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetcher.json<ApiResponse>(`${BASE}/${datasetId}/${action}`, { headers });
      if (res.code === 0) return res.data ?? {};
      if (res.code === RATE_LIMITED) {
        await sleep(rateLimitDelayMs);
        continue;
      }
      throw new Error(`data.gov.sg ${action} failed for ${datasetId}: ${res.errorMsg ?? `code ${res.code}`}`);
    }
    throw new Error(`data.gov.sg ${action} for ${datasetId}: still rate limited after 5 attempts`);
  };

  await call('initiate-download');
  for (let poll = 0; poll < maxPolls; poll++) {
    await sleep(pollIntervalMs);
    const data = await call('poll-download');
    if (data.status === 'DOWNLOAD_SUCCESS' && data.url) return fetcher.text(data.url);
  }
  throw new Error(`data.gov.sg download for ${datasetId} not ready after ${maxPolls} polls`);
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run --project unit && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/official/datagovsg.ts test/unit/official/datagovsg.test.ts
git commit -m "feat: add data.gov.sg dataset download client

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: data.gov.sg collector base and the HDB resale collector

**Files:**
- Create: `src/official/datagovsg-collector.ts`, `src/official/hdb-resale.ts`
- Test: `test/unit/official/hdb-resale.test.ts`, `test/integration/hdb-resale.test.ts`

**Interfaces:**
- Consumes:
  - `downloadDatasetCsv`, `DATAGOVSG_DATASETS` and `DataGovSgOptions` (Task 7)
  - `replacePeriods` and `ReplaceSpec` (Task 6)
  - `parseCsv`, `validateRows` and `assertRejectRate` (Task 6)
  - `Collector` (Task 5)
  - `addMonths` and `monthToDate` (Task 1)
- Produces:
  - `selectRecentMonths(months: string[], recent: number | null): string[]` (unique and sorted; `null` means all)
  - `createDataGovSgCollector<R extends Record<string, unknown>>(cfg: DataGovSgCollectorConfig<R>, deps: DataGovSgDeps): Collector`
  - `interface DataGovSgDeps { fetcher: Fetcher; dataGovSg?: DataGovSgOptions }`
  - `type HdbResaleRow`
  - `parseHdbResaleCsv(csv): { rows: HdbResaleRow[]; rejected; samples }`
  - `createHdbResaleCollector(deps: DataGovSgDeps): Collector` (named `hdb-resale`)
- Behaviour:
  - Daily fetches only the current dataset and replaces the latest 3 months present in it.
  - Backfill fetches the 4 historical datasets and then the current one, replacing every month in each.
  - A payload with 0 valid rows fails the run.

- [ ] **Step 1: Write the failing unit test**

`test/unit/official/hdb-resale.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { selectRecentMonths } from '../../../src/official/datagovsg-collector';
import { createHdbResaleCollector, parseHdbResaleCsv } from '../../../src/official/hdb-resale';
import type { Payload } from '../../../src/archive';
import { fetchCtx } from '../../support/context';
import { FakeFetcher } from '../../support/fake-fetcher';

// Real rows sampled from data.gov.sg on 2026-09-18.
const CURRENT = `month,town,flat_type,block,street_name,storey_range,floor_area_sqm,flat_model,lease_commence_date,remaining_lease,resale_price
2017-01,ANG MO KIO,2 ROOM,406,ANG MO KIO AVE 10,10 TO 12,44,Improved,1979,61 years 04 months,232000
2017-01,ANG MO KIO,3 ROOM,108,ANG MO KIO AVE 4,01 TO 03,67,New Generation,1978,60 years 07 months,250000`;
const Y1990 = `month,town,flat_type,block,street_name,storey_range,floor_area_sqm,flat_model,lease_commence_date,resale_price
1990-01,ANG MO KIO,1 ROOM,309,ANG MO KIO AVE 1,10 TO 12,31,IMPROVED,1977,9000`;
const Y2015 = `month,town,flat_type,block,street_name,storey_range,floor_area_sqm,flat_model,lease_commence_date,remaining_lease,resale_price
2015-01,ANG MO KIO,3 ROOM,174,ANG MO KIO AVE 4,07 TO 09,60,Improved,1986,70,255000`;

describe('parseHdbResaleCsv', () => {
  it('parses current, pre-2015 (no remaining_lease) and 2015-2016 formats', () => {
    expect(parseHdbResaleCsv(CURRENT).rows[1]).toEqual({
      month: '2017-01-01', town: 'ANG MO KIO', flat_type: '3 ROOM', block: '108', street_name: 'ANG MO KIO AVE 4',
      storey_range: '01 TO 03', floor_area_sqm: 67, flat_model: 'New Generation', lease_commence_year: 1978,
      remaining_lease: '60 years 07 months', resale_price: 250000,
    });
    expect(parseHdbResaleCsv(Y1990).rows[0]).toMatchObject({ month: '1990-01-01', remaining_lease: null, resale_price: 9000 });
    expect(parseHdbResaleCsv(Y2015).rows[0]).toMatchObject({ remaining_lease: '70' });
  });

  it('rejects rows with missing price or bad month', () => {
    const csv = `${CURRENT}\n2017-1,ANG MO KIO,3 ROOM,1,X,01 TO 03,67,Improved,1978,,250000\n2017-01,ANG MO KIO,3 ROOM,1,X,01 TO 03,67,Improved,1978,,`;
    const out = parseHdbResaleCsv(csv);
    expect(out.rows).toHaveLength(2);
    expect(out.rejected).toBe(2);
  });
});

describe('selectRecentMonths', () => {
  it('keeps the latest N months present, or all when null', () => {
    const months = ['2026-08-01', '2026-04-01', '2026-06-01', '2026-07-01', '2026-06-01'];
    expect(selectRecentMonths(months, 3)).toEqual(['2026-06-01', '2026-07-01', '2026-08-01']);
    expect(selectRecentMonths(months, null)).toEqual(['2026-04-01', '2026-06-01', '2026-07-01', '2026-08-01']);
    expect(selectRecentMonths([], 3)).toEqual([]);
  });
});

describe('hdb-resale fetch', () => {
  const fakeDataGov = () => new FakeFetcher([
    [/initiate-download$/, JSON.stringify({ code: 0, data: {} })],
    [/poll-download$/, (url) => JSON.stringify({ code: 0, data: { status: 'DOWNLOAD_SUCCESS', url: `https://s3.test/${url.split('/').at(-2)}` } })],
    [/^https:\/\/s3\.test\//, (url) => `csv:${url.split('/').at(-1)}`],
  ]);
  const deps = (fetcher: FakeFetcher) => ({ fetcher, dataGovSg: { sleep: async () => {}, pollIntervalMs: 0 } });

  async function keys(options: Parameters<typeof fetchCtx>[0]) {
    const fetcher = fakeDataGov();
    const emitted: Payload[] = [];
    const res = await createHdbResaleCollector(deps(fetcher)).fetch(fetchCtx(options), async (p) => { emitted.push(p); });
    expect(res.complete).toBe(true);
    return emitted.map((p) => p.key);
  }

  it('daily fetches only the current dataset', async () => {
    expect(await keys({})).toEqual(['d_8b84c4ee58e3cfc0ece0d773c8ca6abc.csv']);
  });

  it('backfill fetches historical datasets oldest first, then current; limit caps it', async () => {
    expect(await keys({ backfill: true })).toEqual([
      'd_ebc5ab87086db484f88045b47411ebc5.csv', 'd_43f493c6c50d54243cc1eab0df142d6a.csv',
      'd_2d5ff9ea31397b66239f245f57751537.csv', 'd_ea9ed51da2787afaf8e51f827c304208.csv',
      'd_8b84c4ee58e3cfc0ece0d773c8ca6abc.csv',
    ]);
    expect(await keys({ backfill: true, limit: 2 })).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Write the failing integration test**

`test/integration/hdb-resale.test.ts`:
```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { IngestResult } from '../../src/collectors/types';
import { createHdbResaleCollector } from '../../src/official/hdb-resale';
import { FakeFetcher } from '../support/fake-fetcher';
import { toAsync } from '../support/async';
import { ingestCtx } from '../support/context';
import { connect, makeRun, truncateAll } from './helpers';

const sql = connect();
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

const HEADER = 'month,town,flat_type,block,street_name,storey_range,floor_area_sqm,flat_model,lease_commence_date,remaining_lease,resale_price';
const csv = (rows: Array<[string, number]>) =>
  [HEADER, ...rows.map(([m, p]) => `${m},ANG MO KIO,3 ROOM,108,ANG MO KIO AVE 4,01 TO 03,67,New Generation,1978,60 years 07 months,${p}`)].join('\n');

const collector = createHdbResaleCollector({ fetcher: new FakeFetcher([]) });

async function ingest(body: string, backfill: boolean): Promise<IngestResult> {
  const runId = await makeRun(sql, 'hdb-resale');
  return (await sql.begin((tx) =>
    collector.ingest(tx, toAsync([{ key: 'x.csv', body }]), ingestCtx(runId, { backfill })))) as IngestResult;
}

const byMonth = () => sql<{ month: string; n: number; price: number }[]>`
  select month::text as month, count(*)::int as n, max(resale_price)::int as price
  from hdb_resale_txn group by 1 order by 1`;

describe('hdb-resale ingest', () => {
  it('backfill replaces every month; daily replaces only the latest 3 months', async () => {
    const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
    const r1 = await ingest(csv(months.map((m) => [m, 100_000])), true);
    expect(r1).toEqual({ fetched: 5, inserted: 5, changed: 0, rejected: 0, complete: true });

    const r2 = await ingest(csv([...months.map((m): [string, number] => [m, 200_000]), ['2026-08', 200_000]]), false);
    expect(r2.inserted).toBe(4);
    expect(await byMonth()).toEqual([
      { month: '2026-04-01', n: 1, price: 100_000 },
      { month: '2026-05-01', n: 1, price: 100_000 },
      { month: '2026-06-01', n: 1, price: 200_000 },
      { month: '2026-07-01', n: 1, price: 200_000 },
      { month: '2026-08-01', n: 2, price: 200_000 },
    ]);
  });

  it('fails without writing when more than 5% of rows are invalid', async () => {
    const bad = `${csv([['2026-08', 1]])}\n2026-08,ANG MO KIO,3 ROOM,1,X,01 TO 03,67,Improved,1978,,`;
    await expect(ingest(bad, false)).rejects.toThrow(/failed validation/);
    expect(await byMonth()).toEqual([]);
  });

  it('fails on a payload with no valid rows', async () => {
    await expect(ingest(HEADER, false)).rejects.toThrow(/no valid rows/);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run test/unit/official/hdb-resale.test.ts test/integration/hdb-resale.test.ts`
Expected: FAIL, because the modules aren't found.

- [ ] **Step 4: Implement**

`src/official/datagovsg-collector.ts`:
```ts
import type { Collector } from '../collectors/types';
import type { Fetcher } from '../fetch/types';
import { addMonths } from '../time';
import { assertRejectRate } from './common';
import { downloadDatasetCsv, type DataGovSgOptions } from './datagovsg';
import { replacePeriods, type ReplaceSpec } from './replace';

export interface DataGovSgDeps {
  fetcher: Fetcher;
  dataGovSg?: DataGovSgOptions;
}

export interface DataGovSgCollectorConfig<R extends Record<string, unknown>> {
  name: string;
  datasetIds: (backfill: boolean) => readonly string[];
  parse: (csv: string) => { rows: R[]; rejected: number; samples: string[] };
  periodOf: (row: R) => string;
  spec: ReplaceSpec;
  /** How many of the latest months a daily run replaces. */
  recentMonths: number;
}

export function selectRecentMonths(months: string[], recent: number | null): string[] {
  const unique = [...new Set(months)].sort();
  if (recent === null || unique.length === 0) return unique;
  const cutoff = addMonths(unique[unique.length - 1], -(recent - 1));
  return unique.filter((m) => m >= cutoff);
}

export function createDataGovSgCollector<R extends Record<string, unknown>>(
  cfg: DataGovSgCollectorConfig<R>, deps: DataGovSgDeps,
): Collector {
  return {
    name: cfg.name,
    kind: 'official',

    async fetch(ctx, emit) {
      const ids = cfg.datasetIds(ctx.options.backfill).slice(0, ctx.options.limit ?? Infinity);
      for (const id of ids) {
        ctx.logger.info({ datasetId: id }, 'downloading dataset');
        const body = await downloadDatasetCsv(deps.fetcher, id, deps.dataGovSg);
        await emit({ key: `${id}.csv`, body });
      }
      return { complete: true };
    },

    async ingest(tx, payloads, ctx) {
      let fetched = 0;
      let inserted = 0;
      let rejected = 0;
      for await (const payload of payloads) {
        const parsed = cfg.parse(payload.body);
        const total = parsed.rows.length + parsed.rejected;
        fetched += total;
        rejected += parsed.rejected;
        if (parsed.samples.length > 0) {
          ctx.logger.warn({ key: payload.key, rejected: parsed.rejected, samples: parsed.samples }, 'rejected rows');
        }
        assertRejectRate(cfg.name, total, parsed.rejected);
        if (parsed.rows.length === 0) throw new Error(`${cfg.name}: ${payload.key} contained no valid rows`);

        const periods = selectRecentMonths(parsed.rows.map(cfg.periodOf), ctx.backfill ? null : cfg.recentMonths);
        const keep = new Set(periods);
        const rows = parsed.rows
          .filter((r) => keep.has(cfg.periodOf(r)))
          .map((r) => ({ ...r, ingested_run_id: ctx.runId }));
        const res = await replacePeriods(tx, cfg.spec, periods, rows);
        inserted += res.inserted;
        ctx.logger.info({ key: payload.key, periods: periods.length, ...res }, 'replaced periods');
      }
      return { fetched, inserted, changed: 0, rejected, complete: true };
    },
  };
}
```

`src/official/hdb-resale.ts`:
```ts
import { z } from 'zod';
import type { Collector } from '../collectors/types';
import { monthToDate } from '../time';
import { parseCsv, validateRows } from './common';
import { createDataGovSgCollector, type DataGovSgDeps } from './datagovsg-collector';
import { DATAGOVSG_DATASETS } from './datagovsg';

const text = z.string().min(1);

const HdbResaleCsvRow = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  town: text,
  flat_type: text,
  block: text,
  street_name: text,
  storey_range: text,
  floor_area_sqm: z.coerce.number().positive(),
  flat_model: text,
  lease_commence_date: z.coerce.number().int().min(1900).max(2100),
  remaining_lease: z.string().optional(),
  resale_price: z.coerce.number().positive(),
});

export type HdbResaleRow = {
  month: string;
  town: string;
  flat_type: string;
  block: string;
  street_name: string;
  storey_range: string;
  floor_area_sqm: number;
  flat_model: string;
  lease_commence_year: number;
  remaining_lease: string | null;
  resale_price: number;
};

export function parseHdbResaleCsv(csv: string) {
  return validateRows(parseCsv(csv), HdbResaleCsvRow, (v): HdbResaleRow => ({
    month: monthToDate(v.month),
    town: v.town,
    flat_type: v.flat_type,
    block: v.block,
    street_name: v.street_name,
    storey_range: v.storey_range,
    floor_area_sqm: v.floor_area_sqm,
    flat_model: v.flat_model,
    lease_commence_year: v.lease_commence_date,
    remaining_lease: v.remaining_lease ? v.remaining_lease : null,
    resale_price: v.resale_price,
  }));
}

export function createHdbResaleCollector(deps: DataGovSgDeps): Collector {
  return createDataGovSgCollector<HdbResaleRow>({
    name: 'hdb-resale',
    datasetIds: (backfill) => backfill
      ? [...DATAGOVSG_DATASETS.hdbResaleHistorical, DATAGOVSG_DATASETS.hdbResaleCurrent]
      : [DATAGOVSG_DATASETS.hdbResaleCurrent],
    parse: parseHdbResaleCsv,
    periodOf: (r) => r.month,
    spec: {
      table: 'hdb_resale_txn',
      periodColumn: 'month',
      columns: ['month', 'town', 'flat_type', 'block', 'street_name', 'storey_range', 'floor_area_sqm',
        'flat_model', 'lease_commence_year', 'remaining_lease', 'resale_price', 'ingested_run_id'],
    },
    recentMonths: 3,
  }, deps);
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/unit/official test/integration/hdb-resale.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/official/datagovsg-collector.ts src/official/hdb-resale.ts test/unit/official/hdb-resale.test.ts test/integration/hdb-resale.test.ts
git commit -m "feat: add HDB resale collector

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: HDB rental collector

**Files:**
- Create: `src/official/hdb-rental.ts`
- Test: `test/unit/official/hdb-rental.test.ts`, `test/integration/hdb-rental.test.ts`

**Interfaces:**
- Consumes: `createDataGovSgCollector` and `DataGovSgDeps` (Task 8), `DATAGOVSG_DATASETS` (Task 7), `parseCsv` and `validateRows` (Task 6), `monthToDate` (Task 1).
- Produces:
  - `type HdbRentalRow`
  - `parseHdbRentalCsv(csv)`
  - `createHdbRentalCollector(deps: DataGovSgDeps): Collector` (named `hdb-rental`)
- The same dataset is used for daily and backfill. Daily replaces the latest 3 months; backfill replaces all.

- [ ] **Step 1: Write the failing tests**

`test/unit/official/hdb-rental.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseHdbRentalCsv } from '../../../src/official/hdb-rental';

// Real rows sampled from data.gov.sg on 2026-09-18.
const CSV = `rent_approval_date,town,block,street_name,flat_type,monthly_rent
2026-08,QUEENSTOWN,3,DOVER RD,3-ROOM,3000
2026-08,BUKIT MERAH,53,LENGKOK BAHRU,4-ROOM,3900
2026-08,BUKIT MERAH,53,LENGKOK BAHRU,4-ROOM,`;

describe('parseHdbRentalCsv', () => {
  it('parses rows and rejects a missing rent', () => {
    const out = parseHdbRentalCsv(CSV);
    expect(out.rows[0]).toEqual({
      rent_approval_month: '2026-08-01', town: 'QUEENSTOWN', block: '3',
      street_name: 'DOVER RD', flat_type: '3-ROOM', monthly_rent: 3000,
    });
    expect(out.rows).toHaveLength(2);
    expect(out.rejected).toBe(1);
  });
});
```

`test/integration/hdb-rental.test.ts`:
```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHdbRentalCollector } from '../../src/official/hdb-rental';
import { FakeFetcher } from '../support/fake-fetcher';
import { toAsync } from '../support/async';
import { ingestCtx } from '../support/context';
import { connect, makeRun, truncateAll } from './helpers';

const sql = connect();
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

const csv = (months: string[], rent: number) => ['rent_approval_date,town,block,street_name,flat_type,monthly_rent',
  ...months.map((m) => `${m},BEDOK,1,BEDOK NTH RD,3-ROOM,${rent}`)].join('\n');

describe('hdb-rental ingest', () => {
  it('daily replaces the latest 3 months only', async () => {
    const c = createHdbRentalCollector({ fetcher: new FakeFetcher([]) });
    const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
    const run1 = await makeRun(sql, 'hdb-rental');
    await sql.begin((tx) => c.ingest(tx, toAsync([{ key: 'a', body: csv(months, 2000) }]), ingestCtx(run1, { backfill: true })));
    const run2 = await makeRun(sql, 'hdb-rental');
    await sql.begin((tx) => c.ingest(tx, toAsync([{ key: 'b', body: csv(months, 2500) }]), ingestCtx(run2)));
    const rows = await sql<{ m: string; rent: number }[]>`
      select rent_approval_month::text as m, monthly_rent::int as rent from hdb_rental_txn order by 1`;
    expect(rows.map((r) => r.rent)).toEqual([2000, 2000, 2500, 2500, 2500]);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/unit/official/hdb-rental.test.ts test/integration/hdb-rental.test.ts`
Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement**

`src/official/hdb-rental.ts`:
```ts
import { z } from 'zod';
import type { Collector } from '../collectors/types';
import { monthToDate } from '../time';
import { parseCsv, validateRows } from './common';
import { createDataGovSgCollector, type DataGovSgDeps } from './datagovsg-collector';
import { DATAGOVSG_DATASETS } from './datagovsg';

const text = z.string().min(1);

const HdbRentalCsvRow = z.object({
  rent_approval_date: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  town: text,
  block: text,
  street_name: text,
  flat_type: text,
  monthly_rent: z.coerce.number().positive(),
});

export type HdbRentalRow = {
  rent_approval_month: string;
  town: string;
  block: string;
  street_name: string;
  flat_type: string;
  monthly_rent: number;
};

export function parseHdbRentalCsv(csv: string) {
  return validateRows(parseCsv(csv), HdbRentalCsvRow, (v): HdbRentalRow => ({
    rent_approval_month: monthToDate(v.rent_approval_date),
    town: v.town,
    block: v.block,
    street_name: v.street_name,
    flat_type: v.flat_type,
    monthly_rent: v.monthly_rent,
  }));
}

export function createHdbRentalCollector(deps: DataGovSgDeps): Collector {
  return createDataGovSgCollector<HdbRentalRow>({
    name: 'hdb-rental',
    datasetIds: () => [DATAGOVSG_DATASETS.hdbRental],
    parse: parseHdbRentalCsv,
    periodOf: (r) => r.rent_approval_month,
    spec: {
      table: 'hdb_rental_txn',
      periodColumn: 'rent_approval_month',
      columns: ['rent_approval_month', 'town', 'block', 'street_name', 'flat_type', 'monthly_rent', 'ingested_run_id'],
    },
    recentMonths: 3,
  }, deps);
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/unit/official test/integration/hdb-rental.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/official/hdb-rental.ts test/unit/official/hdb-rental.test.ts test/integration/hdb-rental.test.ts
git commit -m "feat: add HDB rental collector

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: URA client and private transactions collector

**Files:**
- Create: `src/official/ura-client.ts`, `src/official/ura-private-txn.ts`
- Test: `test/unit/official/ura-client.test.ts`, `test/unit/official/ura-private-txn.test.ts`, `test/integration/ura-private-txn.test.ts`

**Interfaces:**
- Consumes: `Fetcher` (Task 4), `validateRows`, `assertRejectRate` and `nullableNumber` (Task 6), `replacePeriods` (Task 6), `uraMmyyToDate` (Task 1), `Collector` (Task 5).
- Produces:
  - `class UraClient(fetcher: Fetcher, accessKey: string | undefined)` with `invoke(params: Record<string, string>): Promise<string>`. It returns the raw JSON text and only returns it if `Status === "Success"`. It fetches the token lazily and refreshes it once on a token error.
  - `interface UraDeps { fetcher: Fetcher; uraAccessKey?: string }`
  - `type UraTxnRow`
  - `parseUraTxnJson(body: string): { rows: UraTxnRow[]; rejected; samples }`
  - `createUraPrivateTxnCollector(deps: UraDeps): Collector` (named `ura-private-txn`)
- Behaviour:
  - Fetches batches 1–4 (capped by `limit`).
  - Ingest requires exactly 4 payloads unless `dryRun` is set.
  - It replaces every contract month present except the earliest.

- [ ] **Step 1: Write the failing unit tests**

`test/unit/official/ura-client.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { UraClient } from '../../../src/official/ura-client';
import { FakeFetcher } from '../../support/fake-fetcher';

const TOKEN_URL = 'https://eservice.ura.gov.sg/uraDataService/insertNewToken/v1';
const ok = JSON.stringify({ Status: 'Success', Result: [] });

describe('UraClient', () => {
  it('gets a token once and sends AccessKey + Token headers', async () => {
    const fetcher = new FakeFetcher([
      [TOKEN_URL, JSON.stringify({ Status: 'Success', Result: 'tok-1', Message: '' })],
      [/invokeUraDS/, ok],
    ]);
    const client = new UraClient(fetcher, 'key-1');
    await client.invoke({ service: 'PMI_Resi_Transaction', batch: '1' });
    await client.invoke({ service: 'PMI_Resi_Transaction', batch: '2' });
    expect(fetcher.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
    const data = fetcher.calls.find((c) => c.url.includes('batch=2'))!;
    expect(data.url).toBe('https://eservice.ura.gov.sg/uraDataService/invokeUraDS/v1?service=PMI_Resi_Transaction&batch=2');
    expect(data.headers).toEqual({ AccessKey: 'key-1', Token: 'tok-1' });
  });

  it('refreshes the token once on a token error', async () => {
    let tokens = 0;
    let calls = 0;
    const fetcher = new FakeFetcher([
      [TOKEN_URL, () => JSON.stringify({ Status: 'Success', Result: `tok-${++tokens}` })],
      [/invokeUraDS/, () => (++calls === 1 ? JSON.stringify({ Status: 'Error', Message: 'Invalid Token' }) : ok)],
    ]);
    expect(await new UraClient(fetcher, 'k').invoke({ service: 'X' })).toBe(ok);
    expect(tokens).toBe(2);
  });

  it('fails clearly without an access key, on a bad key, and on non-JSON', async () => {
    await expect(new UraClient(new FakeFetcher([]), undefined).invoke({ service: 'X' })).rejects.toThrow(/URA_ACCESS_KEY/);
    const badKey = new FakeFetcher([[TOKEN_URL, JSON.stringify({ Status: 'Error', Message: 'Invalid Access Key', Result: '' })]]);
    await expect(new UraClient(badKey, 'k').invoke({ service: 'X' })).rejects.toThrow(/Invalid Access Key/);
    const html = new FakeFetcher([[TOKEN_URL, JSON.stringify({ Status: 'Success', Result: 't' })], [/invokeUraDS/, '<html>blocked</html>']]);
    await expect(new UraClient(html, 'k').invoke({ service: 'X' })).rejects.toThrow(/non-JSON/);
  });
});
```

`test/unit/official/ura-private-txn.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseUraTxnJson } from '../../../src/official/ura-private-txn';

// Shape from URA's API documentation (verified 2026-09-18).
const SAMPLE = JSON.stringify({
  Status: 'Success',
  Result: [{
    project: 'TURQUOISE', marketSegment: 'CCR', street: 'COVE DRIVE',
    y: '24997.821719180001', x: '28392.530515570001',
    transaction: [
      { contractDate: '0715', area: '203', price: '2900000', propertyType: 'Condominium', typeOfArea: 'Strata',
        tenure: '99 yrs lease commencing from 2007', floorRange: '01-05', typeOfSale: '3', district: '04', noOfUnits: '1' },
      { contractDate: '0116', area: '200', price: '3014200', nettPrice: '2950000', propertyType: 'Condominium', typeOfArea: 'Strata',
        tenure: '99 yrs lease commencing from 2007', floorRange: '01-05', typeOfSale: '1', district: '04', noOfUnits: '1' },
      { contractDate: '1316', area: '200', price: '1', propertyType: 'Condominium', typeOfArea: 'Strata',
        tenure: 'x', floorRange: '-', typeOfSale: '9', district: '04', noOfUnits: '1' },
    ],
  }],
});

describe('parseUraTxnJson', () => {
  it('flattens projects into transaction rows with decoded fields', () => {
    const out = parseUraTxnJson(SAMPLE);
    expect(out.rejected).toBe(1);
    expect(out.rows[0]).toEqual({
      project: 'TURQUOISE', street: 'COVE DRIVE', market_segment: 'CCR',
      x: 28392.530515570001, y: 24997.821719180001, contract_month: '2015-07-01',
      area_sqm: 203, price: 2900000, nett_price: null, property_type: 'Condominium',
      type_of_area: 'Strata', tenure: '99 yrs lease commencing from 2007', floor_range: '01-05',
      type_of_sale: 'resale', district: '04', no_of_units: 1,
    });
    expect(out.rows[1]).toMatchObject({ contract_month: '2016-01-01', type_of_sale: 'new sale', nett_price: 2950000 });
  });

  it('throws when URA did not return Success', () => {
    expect(() => parseUraTxnJson(JSON.stringify({ Status: 'Error', Message: 'x' }))).toThrow(/not successful/);
  });
});
```

- [ ] **Step 2: Write the failing integration test**

`test/integration/ura-private-txn.test.ts`:
```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Payload } from '../../src/archive';
import { createUraPrivateTxnCollector } from '../../src/official/ura-private-txn';
import { FakeFetcher } from '../support/fake-fetcher';
import { toAsync } from '../support/async';
import { ingestCtx } from '../support/context';
import { connect, makeRun, truncateAll } from './helpers';

const sql = connect();
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

const txn = (mmyy: string, price: number, district: string) => ({
  contractDate: mmyy, area: '100', price: String(price), propertyType: 'Condominium', typeOfArea: 'Strata',
  tenure: 'Freehold', floorRange: '06-10', typeOfSale: '3', district, noOfUnits: '1',
});
const batch = (n: number, txns: object[]): Payload => ({
  key: `batch-${n}.json`,
  body: JSON.stringify({ Status: 'Success', Result: [{ project: `P${n}`, street: 'S', marketSegment: 'OCR', x: '1', y: '2', transaction: txns }] }),
});

const collector = createUraPrivateTxnCollector({ fetcher: new FakeFetcher([]), uraAccessKey: 'k' });

const byMonth = () => sql<{ m: string; n: number; total: number }[]>`
  select contract_month::text as m, count(*)::int as n, sum(price)::int as total from ura_private_txn group by 1 order by 1`;

describe('ura-private-txn ingest', () => {
  it('replaces every month except the earliest, across all 4 batches', async () => {
    // Pre-existing data for the earliest month in the window: must survive.
    const seed = await makeRun(sql);
    await sql`insert into ura_private_txn (project, street, market_segment, contract_month, area_sqm, price,
      property_type, type_of_area, tenure, floor_range, type_of_sale, district, no_of_units, ingested_run_id)
      values ('OLD', 'S', 'OCR', '2021-09-01', 100, 999, 'Condominium', 'Strata', 'Freehold', '01-05', 'resale', '01', 1, ${seed}),
             ('OLD', 'S', 'OCR', '2021-09-01', 100, 999, 'Condominium', 'Strata', 'Freehold', '01-05', 'resale', '01', 1, ${seed})`;

    const runId = await makeRun(sql, 'ura-private-txn');
    const payloads = [
      batch(1, [txn('0921', 1, '01'), txn('0826', 100, '01')]),
      batch(2, [txn('0826', 200, '09')]),
      batch(3, [txn('0726', 300, '15')]),
      batch(4, [txn('0726', 400, '22')]),
    ];
    const res = await sql.begin((tx) => collector.ingest(tx, toAsync(payloads), ingestCtx(runId)));
    expect(res).toMatchObject({ fetched: 5, inserted: 4, rejected: 0, complete: true });
    expect(await byMonth()).toEqual([
      { m: '2021-09-01', n: 2, total: 1998 },
      { m: '2026-07-01', n: 2, total: 700 },
      { m: '2026-08-01', n: 2, total: 300 },
    ]);
  });

  it('refuses to replace with fewer than 4 batches (except in dry runs)', async () => {
    const runId = await makeRun(sql);
    const one = [batch(1, [txn('0726', 1, '01'), txn('0826', 1, '01')])];
    await expect(sql.begin((tx) => collector.ingest(tx, toAsync(one), ingestCtx(runId)))).rejects.toThrow(/all 4 batches/);
    await expect(sql.begin((tx) => collector.ingest(tx, toAsync(one), ingestCtx(runId, { dryRun: true })))).resolves.toBeTruthy();
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run test/unit/official/ura-client.test.ts test/unit/official/ura-private-txn.test.ts test/integration/ura-private-txn.test.ts`
Expected: FAIL, because the modules aren't found.

- [ ] **Step 4: Implement**

`src/official/ura-client.ts`:
```ts
import type { Fetcher } from '../fetch/types';

const URA_BASE = 'https://eservice.ura.gov.sg/uraDataService';

interface UraEnvelope {
  Status?: string;
  Message?: string;
  Result?: unknown;
}

function parseEnvelope(body: string): UraEnvelope {
  try {
    return JSON.parse(body) as UraEnvelope;
  } catch {
    throw new Error(`URA returned non-JSON: ${body.slice(0, 200)}`);
  }
}

export class UraClient {
  private token?: string;

  constructor(private readonly fetcher: Fetcher, private readonly accessKey: string | undefined) {}

  private async newToken(): Promise<string> {
    if (!this.accessKey) throw new Error('URA_ACCESS_KEY is not set; register at https://eservice.ura.gov.sg/maps/api/reg.html');
    const res = parseEnvelope(await this.fetcher.text(`${URA_BASE}/insertNewToken/v1`, {
      headers: { AccessKey: this.accessKey },
    }));
    if (res.Status !== 'Success' || typeof res.Result !== 'string' || !res.Result) {
      throw new Error(`URA token request failed: ${res.Message ?? res.Status}`);
    }
    return res.Result;
  }

  /** Returns the raw JSON body of a successful call. */
  async invoke(params: Record<string, string>): Promise<string> {
    const url = `${URA_BASE}/invokeUraDS/v1?${new URLSearchParams(params)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      this.token ??= await this.newToken();
      const body = await this.fetcher.text(url, { headers: { AccessKey: this.accessKey!, Token: this.token } });
      const env = parseEnvelope(body);
      if (env.Status === 'Success') return body;
      if (attempt === 0 && /token/i.test(env.Message ?? '')) {
        this.token = undefined;
        continue;
      }
      throw new Error(`URA ${params.service} failed: ${env.Message ?? env.Status}`);
    }
    throw new Error(`URA ${params.service} failed after token refresh`);
  }
}
```

`src/official/ura-private-txn.ts`:
```ts
import { z } from 'zod';
import type { Collector } from '../collectors/types';
import type { Fetcher } from '../fetch/types';
import { uraMmyyToDate } from '../time';
import { assertRejectRate, nullableNumber, validateRows } from './common';
import { replacePeriods, type ReplaceSpec } from './replace';
import { UraClient } from './ura-client';

export interface UraDeps {
  fetcher: Fetcher;
  uraAccessKey?: string;
}

const SALE_TYPES = { '1': 'new sale', '2': 'sub sale', '3': 'resale' } as const;
const BATCHES = [1, 2, 3, 4];

const UraTxnRecord = z.object({
  project: z.string().min(1),
  street: z.string(),
  marketSegment: z.string(),
  x: z.unknown(),
  y: z.unknown(),
  contractDate: z.string().regex(/^(0[1-9]|1[0-2])\d{2}$/),
  area: z.coerce.number().positive(),
  price: z.coerce.number().positive(),
  nettPrice: z.unknown(),
  propertyType: z.string().min(1),
  typeOfArea: z.string(),
  tenure: z.string(),
  floorRange: z.string(),
  typeOfSale: z.enum(['1', '2', '3']),
  district: z.string().min(1),
  noOfUnits: z.coerce.number().int().positive(),
});

export type UraTxnRow = {
  project: string;
  street: string;
  market_segment: string;
  x: number | null;
  y: number | null;
  contract_month: string;
  area_sqm: number;
  price: number;
  nett_price: number | null;
  property_type: string;
  type_of_area: string;
  tenure: string;
  floor_range: string;
  type_of_sale: string;
  district: string;
  no_of_units: number;
};

const SPEC: ReplaceSpec = {
  table: 'ura_private_txn',
  periodColumn: 'contract_month',
  columns: ['project', 'street', 'market_segment', 'x', 'y', 'contract_month', 'area_sqm', 'price', 'nett_price',
    'property_type', 'type_of_area', 'tenure', 'floor_range', 'type_of_sale', 'district', 'no_of_units', 'ingested_run_id'],
};

interface ProjectEnvelope {
  Status?: string;
  Result?: Array<Record<string, unknown> & { transaction?: unknown }>;
}

export function parseUraTxnJson(body: string) {
  const doc = JSON.parse(body) as ProjectEnvelope;
  if (doc.Status !== 'Success' || !Array.isArray(doc.Result)) {
    throw new Error(`URA transaction payload not successful: ${String(doc.Status)}`);
  }
  const records = doc.Result.flatMap((p) =>
    (Array.isArray(p.transaction) ? p.transaction : []).map((t: object) => ({
      ...t, project: p.project, street: p.street, marketSegment: p.marketSegment, x: p.x, y: p.y,
    })));
  return validateRows(records, UraTxnRecord, (v): UraTxnRow => ({
    project: v.project,
    street: v.street,
    market_segment: v.marketSegment,
    x: nullableNumber(v.x),
    y: nullableNumber(v.y),
    contract_month: uraMmyyToDate(v.contractDate),
    area_sqm: v.area,
    price: v.price,
    nett_price: nullableNumber(v.nettPrice),
    property_type: v.propertyType,
    type_of_area: v.typeOfArea,
    tenure: v.tenure,
    floor_range: v.floorRange,
    type_of_sale: SALE_TYPES[v.typeOfSale],
    district: v.district,
    no_of_units: v.noOfUnits,
  }));
}

export function createUraPrivateTxnCollector(deps: UraDeps): Collector {
  return {
    name: 'ura-private-txn',
    kind: 'official',

    async fetch(ctx, emit) {
      const client = new UraClient(deps.fetcher, deps.uraAccessKey);
      for (const b of BATCHES.slice(0, ctx.options.limit ?? BATCHES.length)) {
        ctx.logger.info({ batch: b }, 'fetching URA transactions');
        await emit({ key: `batch-${b}.json`, body: await client.invoke({ service: 'PMI_Resi_Transaction', batch: String(b) }) });
      }
      return { complete: true };
    },

    async ingest(tx, payloads, ctx) {
      const rows: UraTxnRow[] = [];
      let rejected = 0;
      let batches = 0;
      for await (const p of payloads) {
        const parsed = parseUraTxnJson(p.body);
        batches++;
        rows.push(...parsed.rows);
        rejected += parsed.rejected;
        if (parsed.samples.length > 0) ctx.logger.warn({ key: p.key, samples: parsed.samples }, 'rejected rows');
      }
      if (batches !== BATCHES.length && !ctx.dryRun) {
        throw new Error(`ura-private-txn: ingest needs all 4 batches, got ${batches}`);
      }
      const fetched = rows.length + rejected;
      assertRejectRate('ura-private-txn', fetched, rejected);
      if (rows.length === 0) throw new Error('ura-private-txn: no valid rows');

      // URA serves a rolling 5-year window: the earliest month may be partial, so never replace it.
      const months = [...new Set(rows.map((r) => r.contract_month))].sort().slice(1);
      const keep = new Set(months);
      const toInsert = rows.filter((r) => keep.has(r.contract_month)).map((r) => ({ ...r, ingested_run_id: ctx.runId }));
      const res = await replacePeriods(tx, SPEC, months, toInsert);
      ctx.logger.info({ months: months.length, ...res }, 'replaced contract months');
      return { fetched, inserted: res.inserted, changed: 0, rejected, complete: true };
    },
  };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/unit/official test/integration/ura-private-txn.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/official/ura-client.ts src/official/ura-private-txn.ts test/unit/official/ura-client.test.ts test/unit/official/ura-private-txn.test.ts test/integration/ura-private-txn.test.ts
git commit -m "feat: add URA client and private transactions collector

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: URA private rental collector

**Files:**
- Create: `src/official/ura-private-rental.ts`
- Test: `test/unit/official/ura-private-rental.test.ts`, `test/integration/ura-private-rental.test.ts`

**Interfaces:**
- Consumes: `UraClient` and `UraDeps` (Task 10), `validateRows`, `assertRejectRate` and `nullableNumber` (Task 6), `replacePeriods` (Task 6), `uraMmyyToDate` and `uraQuartersBack` (Task 1).
- Produces:
  - `type UraRentalRow`
  - `parseUraRentalJson(body: string, refQuarter: string)`
  - `createUraPrivateRentalCollector(deps: UraDeps): Collector` (named `ura-private-rental`)
- Behaviour:
  - Daily fetches the current quarter and the previous one. Backfill fetches 21 quarters (the current one plus 5 years).
  - Payload keys are `<yyqq>.json`, and each payload replaces its own quarter.
  - An empty quarter is allowed, because the current quarter may not be published yet.

- [ ] **Step 1: Write the failing tests**

`test/unit/official/ura-private-rental.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Payload } from '../../../src/archive';
import { createUraPrivateRentalCollector, parseUraRentalJson } from '../../../src/official/ura-private-rental';
import { fetchCtx } from '../../support/context';
import { FakeFetcher } from '../../support/fake-fetcher';

// Shape from URA's API documentation (verified 2026-09-18).
const SAMPLE = JSON.stringify({
  Status: 'Success',
  Result: [
    { project: 'THOMSON RISE ESTATE', street: 'JALAN BERJAYA', y: '37250.51289984', x: '29360.42681773',
      rental: [{ leaseDate: '0314', propertyType: 'Detached House', areaSqm: '150-200', areaSqft: '1500-2000', rent: 4300, district: '20' }] },
    { project: 'THE ESPIRA', street: 'LORONG L TELOK KURAU', y: '32747.03', x: '37045.35',
      rental: [
        { leaseDate: '0314', propertyType: 'Non-landed Properties', areaSqm: '100-110', areaSqft: '1100-1200', rent: 3100, district: '15', noOfBedRoom: '3' },
        { leaseDate: '0314', propertyType: 'Non-landed Properties', areaSqm: '50-60', areaSqft: '500-600', rent: 0, district: '15', noOfBedRoom: '1' },
      ] },
  ],
});

describe('parseUraRentalJson', () => {
  it('flattens rentals and tags the quarter', () => {
    const out = parseUraRentalJson(SAMPLE, '14q1');
    expect(out.rejected).toBe(1);
    expect(out.rows[0]).toEqual({
      project: 'THOMSON RISE ESTATE', street: 'JALAN BERJAYA', x: 29360.42681773, y: 37250.51289984,
      ref_quarter: '14q1', lease_month: '2014-03-01', property_type: 'Detached House', district: '20',
      area_sqm_range: '150-200', area_sqft_range: '1500-2000', no_of_bedroom: null, rent: 4300,
    });
    expect(out.rows[1]).toMatchObject({ no_of_bedroom: 3, rent: 3100 });
  });
});

describe('ura-private-rental fetch', () => {
  async function keys(options: Parameters<typeof fetchCtx>[0]) {
    const fetcher = new FakeFetcher([
      [/insertNewToken/, JSON.stringify({ Status: 'Success', Result: 't' })],
      [/invokeUraDS/, JSON.stringify({ Status: 'Success', Result: [] })],
    ]);
    const out: Payload[] = [];
    await createUraPrivateRentalCollector({ fetcher, uraAccessKey: 'k' })
      .fetch(fetchCtx(options, '2026-09-18'), async (p) => { out.push(p); });
    return out.map((p) => p.key);
  }

  it('daily fetches current and previous quarter; backfill fetches 21', async () => {
    expect(await keys({})).toEqual(['26q3.json', '26q2.json']);
    const bf = await keys({ backfill: true });
    expect(bf).toHaveLength(21);
    expect(bf.at(-1)).toBe('21q3.json');
  });
});
```

`test/integration/ura-private-rental.test.ts`:
```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createUraPrivateRentalCollector } from '../../src/official/ura-private-rental';
import { FakeFetcher } from '../support/fake-fetcher';
import { toAsync } from '../support/async';
import { ingestCtx } from '../support/context';
import { connect, makeRun, truncateAll } from './helpers';

const sql = connect();
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

const body = (rents: number[]) => JSON.stringify({
  Status: 'Success',
  Result: [{ project: 'P', street: 'S', x: '1', y: '2', rental: rents.map((rent) => ({
    leaseDate: '0726', propertyType: 'Non-landed Properties', areaSqm: '50-60', areaSqft: '500-600', rent, district: '15', noOfBedRoom: '1',
  })) }],
});

describe('ura-private-rental ingest', () => {
  it('replaces each quarter independently and tolerates an empty quarter', async () => {
    const c = createUraPrivateRentalCollector({ fetcher: new FakeFetcher([]), uraAccessKey: 'k' });
    const r1 = await makeRun(sql);
    await sql.begin((tx) => c.ingest(tx, toAsync([{ key: '26q2.json', body: body([1000, 1100]) }]), ingestCtx(r1)));
    const r2 = await makeRun(sql);
    const res = await sql.begin((tx) => c.ingest(tx, toAsync([
      { key: '26q3.json', body: body([]) },
      { key: '26q2.json', body: body([2000, 2100, 2200]) },
    ]), ingestCtx(r2)));
    expect(res).toMatchObject({ fetched: 3, inserted: 3, complete: true });
    const rows = await sql<{ q: string; n: number }[]>`
      select ref_quarter as q, count(*)::int as n from ura_private_rental group by 1 order by 1`;
    expect(rows).toEqual([{ q: '26q2', n: 3 }]);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/unit/official/ura-private-rental.test.ts test/integration/ura-private-rental.test.ts`
Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement**

`src/official/ura-private-rental.ts`:
```ts
import { z } from 'zod';
import type { Collector } from '../collectors/types';
import { uraMmyyToDate, uraQuartersBack } from '../time';
import { assertRejectRate, nullableNumber, validateRows } from './common';
import { replacePeriods, type ReplaceSpec } from './replace';
import { UraClient } from './ura-client';
import type { UraDeps } from './ura-private-txn';

const DAILY_QUARTERS = 2;
const BACKFILL_QUARTERS = 21;

const UraRentalRecord = z.object({
  project: z.string().min(1),
  street: z.string(),
  x: z.unknown(),
  y: z.unknown(),
  leaseDate: z.string().regex(/^(0[1-9]|1[0-2])\d{2}$/),
  propertyType: z.string().min(1),
  areaSqm: z.string(),
  areaSqft: z.string(),
  rent: z.coerce.number().positive(),
  district: z.string().min(1),
  noOfBedRoom: z.unknown(),
});

export type UraRentalRow = {
  project: string;
  street: string;
  x: number | null;
  y: number | null;
  ref_quarter: string;
  lease_month: string;
  property_type: string;
  district: string;
  area_sqm_range: string;
  area_sqft_range: string;
  no_of_bedroom: number | null;
  rent: number;
};

const SPEC: ReplaceSpec = {
  table: 'ura_private_rental',
  periodColumn: 'ref_quarter',
  columns: ['project', 'street', 'x', 'y', 'ref_quarter', 'lease_month', 'property_type', 'district',
    'area_sqm_range', 'area_sqft_range', 'no_of_bedroom', 'rent', 'ingested_run_id'],
};

export function parseUraRentalJson(body: string, refQuarter: string) {
  const doc = JSON.parse(body) as { Status?: string; Result?: Array<Record<string, unknown> & { rental?: unknown }> };
  if (doc.Status !== 'Success' || !Array.isArray(doc.Result)) {
    throw new Error(`URA rental payload for ${refQuarter} not successful: ${String(doc.Status)}`);
  }
  const records = doc.Result.flatMap((p) =>
    (Array.isArray(p.rental) ? p.rental : []).map((r: object) => ({ ...r, project: p.project, street: p.street, x: p.x, y: p.y })));
  return validateRows(records, UraRentalRecord, (v): UraRentalRow => ({
    project: v.project,
    street: v.street,
    x: nullableNumber(v.x),
    y: nullableNumber(v.y),
    ref_quarter: refQuarter,
    lease_month: uraMmyyToDate(v.leaseDate),
    property_type: v.propertyType,
    district: v.district,
    area_sqm_range: v.areaSqm,
    area_sqft_range: v.areaSqft,
    no_of_bedroom: nullableNumber(v.noOfBedRoom),
    rent: v.rent,
  }));
}

export function createUraPrivateRentalCollector(deps: UraDeps): Collector {
  return {
    name: 'ura-private-rental',
    kind: 'official',

    async fetch(ctx, emit) {
      const client = new UraClient(deps.fetcher, deps.uraAccessKey);
      const quarters = uraQuartersBack(ctx.runDate, ctx.options.backfill ? BACKFILL_QUARTERS : DAILY_QUARTERS)
        .slice(0, ctx.options.limit ?? Infinity);
      for (const q of quarters) {
        ctx.logger.info({ quarter: q }, 'fetching URA rentals');
        await emit({ key: `${q}.json`, body: await client.invoke({ service: 'PMI_Resi_Rental', refPeriod: q }) });
      }
      return { complete: true };
    },

    async ingest(tx, payloads, ctx) {
      let fetched = 0;
      let inserted = 0;
      let rejected = 0;
      for await (const p of payloads) {
        const quarter = p.key.replace(/\.json$/, '');
        const parsed = parseUraRentalJson(p.body, quarter);
        const total = parsed.rows.length + parsed.rejected;
        fetched += total;
        rejected += parsed.rejected;
        if (parsed.samples.length > 0) ctx.logger.warn({ quarter, samples: parsed.samples }, 'rejected rows');
        assertRejectRate('ura-private-rental', total, parsed.rejected);
        const rows = parsed.rows.map((r) => ({ ...r, ingested_run_id: ctx.runId }));
        const res = await replacePeriods(tx, SPEC, [quarter], rows);
        inserted += res.inserted;
        ctx.logger.info({ quarter, ...res }, 'replaced quarter');
      }
      return { fetched, inserted, changed: 0, rejected, complete: true };
    },
  };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/unit/official test/integration/ura-private-rental.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/official/ura-private-rental.ts test/unit/official/ura-private-rental.test.ts test/integration/ura-private-rental.test.ts
git commit -m "feat: add URA private rental collector

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Listing change-tracking engine

This is the shared engine for Plan 2's site collectors. It's tested here with no site involved.

**Files:**
- Create: `src/listings/schema.ts`, `src/listings/upsert.ts`, `src/listings/ingest.ts`
- Test: `test/unit/listings/schema.test.ts`, `test/integration/listings.test.ts`

**Interfaces:**
- Consumes: `Sql` (Task 2), `Payload` (Task 3), `IngestContext` and `IngestResult` (Task 5).
- Produces:
  - `NormalizedListingSchema` (zod) and `type NormalizedListing`
  - `fingerprint(l: NormalizedListing): string`
  - `upsertListing(tx: Sql, source: string, runId: number, runDate: string, l: NormalizedListing): Promise<'inserted' | 'changed' | 'unchanged'>`
  - `markMissing(tx: Sql, source: string, runDate: string): Promise<{ missed: number; delisted: number }>`
  - `interface ListingIngestOptions { source: string; parsePayload: (p: Payload) => unknown[] }`
  - `ingestListings(tx: Sql, payloads: AsyncIterable<Payload>, ctx: IngestContext, opts: ListingIngestOptions): Promise<IngestResult>`
- Plan 2's site collectors implement `ingest` as `(tx, payloads, ctx) => ingestListings(tx, payloads, ctx, { source: name, parsePayload })`.

- [ ] **Step 1: Write the failing unit test**

`test/unit/listings/schema.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { NormalizedListingSchema } from '../../../src/listings/schema';
import { fingerprint } from '../../../src/listings/upsert';

const base = {
  source_listing_id: '123', listing_type: 'sale', property_type: 'condo', price: 1_500_000, url: 'https://x.test/123',
};

describe('NormalizedListingSchema', () => {
  it('fills optional fields with null and extra with {}', () => {
    const l = NormalizedListingSchema.parse(base);
    expect(l).toMatchObject({ title: null, bedrooms: null, floor_area_sqft: null, lat: null, extra: {} });
  });

  it('rejects bad enums and non-positive prices', () => {
    expect(NormalizedListingSchema.safeParse({ ...base, listing_type: 'lease' }).success).toBe(false);
    expect(NormalizedListingSchema.safeParse({ ...base, price: 0 }).success).toBe(false);
  });
});

describe('fingerprint', () => {
  it('changes with tracked fields only', () => {
    const a = NormalizedListingSchema.parse({ ...base, floor_area_sqft: 1000 });
    expect(fingerprint(a)).toBe(fingerprint({ ...a, lat: 1.3, extra: { agent: 'x' } }));
    expect(fingerprint(a)).not.toBe(fingerprint({ ...a, price: 1_400_000 }));
    expect(fingerprint(a)).not.toBe(fingerprint({ ...a, title: 'New title' }));
  });
});
```

- [ ] **Step 2: Write the failing integration test**

`test/integration/listings.test.ts`:
```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { IngestResult } from '../../src/collectors/types';
import { ingestListings } from '../../src/listings/ingest';
import { toAsync } from '../support/async';
import { ingestCtx } from '../support/context';
import { connect, makeRun, truncateAll } from './helpers';

const sql = connect();
afterAll(() => sql.end());
beforeEach(() => truncateAll(sql));

const listing = (id: string, over: Record<string, unknown> = {}) => ({
  source_listing_id: id, listing_type: 'sale', property_type: 'condo', title: `Unit ${id}`,
  project_name: 'THE SAIL', address: '2 Marina Blvd', postal_code: '018987', district: '01',
  bedrooms: 2, bathrooms: 2, floor_area_sqft: 1000, price: 1_500_000, tenure: '99-year',
  built_year: 2008, lat: 1.28, lng: 103.85, url: `https://x.test/${id}`, extra: {}, ...over,
});

async function run(runDate: string, items: unknown[], fetchComplete = true): Promise<IngestResult> {
  const runId = await makeRun(sql, '99co');
  return (await sql.begin((tx) => ingestListings(
    tx, toAsync([{ key: 'page-1', body: JSON.stringify(items) }]),
    ingestCtx(runId, { runDate, fetchComplete }),
    { source: '99co', parsePayload: (p) => JSON.parse(p.body) },
  ))) as IngestResult;
}

const state = async (id: string) => (await sql<{
  status: string; missed: number; first_seen: string; last_seen: string; price: number; psf: number; versions: number;
}[]>`
  select l.status, l.missed_complete_runs as missed, l.first_seen::text, l.last_seen::text,
         l.price::float as price, l.psf::float as psf,
         (select count(*)::int from listing_versions v where v.listing_id = l.id) as versions
  from listings l where source = '99co' and source_listing_id = ${id}`)[0];

describe('ingestListings', () => {
  it('inserts new listings with a first version and computes psf', async () => {
    const res = await run('2026-09-01', [listing('a'), listing('b')]);
    expect(res).toEqual({ fetched: 2, inserted: 2, changed: 0, rejected: 0, complete: true });
    expect(await state('a')).toMatchObject({
      status: 'active', first_seen: '2026-09-01', last_seen: '2026-09-01', psf: 1500, versions: 1,
    });
  });

  it('adds no version for unchanged data, including a same-day re-run', async () => {
    await run('2026-09-01', [listing('a')]);
    const res = await run('2026-09-01', [listing('a')]);
    expect(res).toMatchObject({ inserted: 0, changed: 0 });
    await run('2026-09-02', [listing('a')]);
    expect(await state('a')).toMatchObject({ versions: 1, last_seen: '2026-09-02', first_seen: '2026-09-01' });
  });

  it('adds a version and updates current values when the price changes', async () => {
    await run('2026-09-01', [listing('a')]);
    const res = await run('2026-09-02', [listing('a', { price: 1_400_000 })]);
    expect(res.changed).toBe(1);
    expect(await state('a')).toMatchObject({ price: 1_400_000, versions: 2 });
  });

  it('delists after 2 complete runs without the listing, counting a day only once', async () => {
    await run('2026-09-01', [listing('a'), listing('b')]);
    await run('2026-09-02', [listing('a')]);
    expect(await state('b')).toMatchObject({ status: 'active', missed: 1 });
    await run('2026-09-02', [listing('a')]); // same-day re-run
    expect(await state('b')).toMatchObject({ status: 'active', missed: 1 });
    await run('2026-09-03', [listing('a')]);
    expect(await state('b')).toMatchObject({ status: 'delisted', missed: 2 });
  });

  it('never counts misses after an incomplete fetch', async () => {
    await run('2026-09-01', [listing('a'), listing('b')]);
    const res = await run('2026-09-02', [listing('a')], false);
    expect(res.complete).toBe(false);
    expect(await state('b')).toMatchObject({ status: 'active', missed: 0 });
  });

  it('reactivates a delisted listing that reappears', async () => {
    await run('2026-09-01', [listing('a'), listing('b')]);
    await run('2026-09-02', [listing('a')]);
    await run('2026-09-03', [listing('a')]);
    const res = await run('2026-09-04', [listing('a'), listing('b')]);
    expect(res).toMatchObject({ inserted: 0, changed: 0 });
    expect(await state('b')).toMatchObject({ status: 'active', missed: 0, versions: 1, last_seen: '2026-09-04' });
  });

  it('marks the run incomplete when rejects exceed 5%', async () => {
    await run('2026-09-01', [listing('a'), listing('b')]);
    const items = [...Array.from({ length: 9 }, (_, i) => listing(`n${i}`)), listing('bad', { price: -1 })];
    const res = await run('2026-09-02', items);
    expect(res).toMatchObject({ fetched: 10, rejected: 1, complete: false });
    expect(await state('a')).toMatchObject({ missed: 0 });
  });

  it('marks the run incomplete when size is missing on more than 5%', async () => {
    const items = Array.from({ length: 20 }, (_, i) => listing(`s${i}`, i < 2 ? { floor_area_sqft: null } : {}));
    expect((await run('2026-09-01', items)).complete).toBe(false);
  });

  it('marks the run incomplete when fewer than half the active listings are seen', async () => {
    await run('2026-09-01', Array.from({ length: 10 }, (_, i) => listing(`v${i}`)));
    const res = await run('2026-09-02', [listing('v0'), listing('v1'), listing('v2'), listing('v3')]);
    expect(res.complete).toBe(false);
    expect(await state('v9')).toMatchObject({ status: 'active', missed: 0 });
  });

  it('marks the run incomplete when a page cannot be parsed', async () => {
    const runId = await makeRun(sql, '99co');
    const res = (await sql.begin((tx) => ingestListings(
      tx, toAsync([{ key: 'p1', body: JSON.stringify([listing('a')]) }, { key: 'p2', body: '<html>captcha</html>' }]),
      ingestCtx(runId, { runDate: '2026-09-01' }),
      { source: '99co', parsePayload: (p) => JSON.parse(p.body) },
    ))) as IngestResult;
    expect(res).toMatchObject({ inserted: 1, complete: false });
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run test/unit/listings test/integration/listings.test.ts`
Expected: FAIL, because the modules aren't found.

- [ ] **Step 4: Implement**

`src/listings/schema.ts`:
```ts
import { z } from 'zod';

const opt = <T extends z.ZodType>(schema: T) => schema.nullish().transform((v) => v ?? null);

export const NormalizedListingSchema = z.object({
  source_listing_id: z.string().min(1),
  listing_type: z.enum(['sale', 'rent']),
  property_type: z.enum(['hdb', 'condo', 'apartment', 'ec', 'landed', 'other']),
  title: opt(z.string()),
  project_name: opt(z.string()),
  address: opt(z.string()),
  postal_code: opt(z.string()),
  district: opt(z.string()),
  bedrooms: opt(z.number().int().min(0)),
  bathrooms: opt(z.number().int().min(0)),
  floor_area_sqft: opt(z.number().positive()),
  price: z.number().positive(),
  tenure: opt(z.string()),
  built_year: opt(z.number().int()),
  lat: opt(z.number()),
  lng: opt(z.number()),
  url: z.string().min(1),
  extra: z.record(z.string(), z.unknown()).default({}),
});

export type NormalizedListing = z.output<typeof NormalizedListingSchema>;
```

`src/listings/upsert.ts`:
```ts
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { Sql } from '../db/client';
import type { NormalizedListing } from './schema';

export function fingerprint(l: NormalizedListing): string {
  const tracked = [l.price, l.floor_area_sqft, l.bedrooms, l.bathrooms, l.title, l.property_type, l.listing_type];
  return createHash('sha1').update(JSON.stringify(tracked)).digest('hex');
}

export async function upsertListing(
  tx: Sql, source: string, runId: number, runDate: string, l: NormalizedListing,
): Promise<'inserted' | 'changed' | 'unchanged'> {
  const fp = fingerprint(l);
  const psf = l.floor_area_sqft ? Math.round((l.price / l.floor_area_sqft) * 100) / 100 : null;
  const [row] = await tx<{ id: number; inserted: boolean }[]>`
    insert into listings (
      source, source_listing_id, listing_type, property_type, title, project_name, address, postal_code,
      district, bedrooms, bathrooms, floor_area_sqft, price, psf, tenure, built_year, lat, lng, url, extra,
      first_seen, last_seen, status, missed_complete_runs, last_missed_on, updated_run_id
    ) values (
      ${source}, ${l.source_listing_id}, ${l.listing_type}, ${l.property_type}, ${l.title}, ${l.project_name},
      ${l.address}, ${l.postal_code}, ${l.district}, ${l.bedrooms}, ${l.bathrooms}, ${l.floor_area_sqft},
      ${l.price}, ${psf}, ${l.tenure}, ${l.built_year}, ${l.lat}, ${l.lng}, ${l.url},
      ${tx.json(l.extra as postgres.JSONValue)}, ${runDate}, ${runDate}, 'active', 0, null, ${runId}
    )
    on conflict (source, source_listing_id) do update set
      listing_type = excluded.listing_type, property_type = excluded.property_type, title = excluded.title,
      project_name = excluded.project_name, address = excluded.address, postal_code = excluded.postal_code,
      district = excluded.district, bedrooms = excluded.bedrooms, bathrooms = excluded.bathrooms,
      floor_area_sqft = excluded.floor_area_sqft, price = excluded.price, psf = excluded.psf,
      tenure = excluded.tenure, built_year = excluded.built_year, lat = excluded.lat, lng = excluded.lng,
      url = excluded.url, extra = excluded.extra,
      first_seen = least(listings.first_seen, excluded.first_seen),
      last_seen = greatest(listings.last_seen, excluded.last_seen),
      status = 'active', missed_complete_runs = 0, last_missed_on = null,
      updated_run_id = excluded.updated_run_id
    returning id::int as id, (xmax = 0) as inserted`;

  const [latest] = await tx<{ fingerprint: string }[]>`
    select fingerprint from listing_versions where listing_id = ${row.id}
    order by observed_on desc, id desc limit 1`;
  if (latest?.fingerprint === fp) return 'unchanged';

  await tx`
    insert into listing_versions (listing_id, observed_on, price, psf, floor_area_sqft, fingerprint, run_id)
    values (${row.id}, ${runDate}, ${l.price}, ${psf}, ${l.floor_area_sqft}, ${fp}, ${runId})`;
  return row.inserted ? 'inserted' : 'changed';
}
```

`src/listings/ingest.ts`:
```ts
import type { Payload } from '../archive';
import type { IngestContext, IngestResult } from '../collectors/types';
import type { Sql } from '../db/client';
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
export async function markMissing(tx: Sql, source: string, runDate: string): Promise<{ missed: number; delisted: number }> {
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
  tx: Sql, payloads: AsyncIterable<Payload>, ctx: IngestContext, opts: ListingIngestOptions,
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
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/unit/listings test/integration/listings.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/listings test/unit/listings test/integration/listings.test.ts
git commit -m "feat: add listing upsert, versioning and delisting engine

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: Collector registry, lock, health check and CLI

**Files:**
- Create: `src/collectors/index.ts`, `src/lock.ts`, `src/health.ts`, `src/cli.ts`
- Test: `test/unit/lock.test.ts`, `test/unit/health.test.ts`, `test/unit/collectors-index.test.ts`

**Interfaces:**
- Consumes: every collector factory (Tasks 8–11), `runAll`, `reprocess` and `CollectorOutcome` (Task 5), `recentRuns`, `lastRuns` and `RunRow` (Task 5), `RawArchive` (Task 3), `HttpFetcher` (Task 4), `loadConfig` (Task 1), `createSql` and `migrate` (Task 2).
- Produces:
  - `buildCollectors(deps: { fetcher: Fetcher; config: Config }): Collector[]`
  - `selectCollectors(all: Collector[], names: string[], useAll: boolean): Collector[]`
  - `class LockHeldError`
  - `acquireLock(path: string, staleMs?: number, now?: () => number): Promise<() => Promise<void>>`
  - `interface HealthReport { ok: boolean; reasons: string[] }`
  - `evaluateHealth(outcomes: CollectorOutcome[], listingHistory: Record<string, Pick<RunRow, 'status'>[]>): HealthReport`
  - `pingHealthcheck(url: string, report: HealthReport, fetchImpl?: typeof fetch): Promise<void>`
  - CLI commands, run as `npm run collect -- <command>`:
    - `run [sources...] [--all] [--backfill] [--dry-run] [--limit <n>]`
    - `status`
    - `reprocess <source> --from <YYYY-MM-DD>`
    - `migrate`
- CLI rules:
  - `run` migrates first and takes the lock.
  - After a non-dry run, it prunes listing archives older than 60 days.
  - It pings the health check only for `--all` daily runs, when `HEALTHCHECK_URL` is set.
  - The exit code is 1 if any collector failed.

- [ ] **Step 1: Write the failing tests**

`test/unit/lock.test.ts`:
```ts
import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock, LockHeldError } from '../../src/lock';

describe('acquireLock', () => {
  it('is exclusive until released', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'lock-')), 'c.lock');
    const release = await acquireLock(file);
    await expect(acquireLock(file)).rejects.toBeInstanceOf(LockHeldError);
    await release();
    const again = await acquireLock(file);
    await again();
  });

  it('takes over a stale lock', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'lock-')), 'c.lock');
    await writeFile(file, '999999');
    const old = new Date(Date.now() - 7 * 3600_000);
    await utimes(file, old, old);
    const release = await acquireLock(file, 6 * 3600_000);
    await release();
  });
});
```

`test/unit/health.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { evaluateHealth, pingHealthcheck } from '../../src/health';
import type { CollectorOutcome } from '../../src/runner';

const outcome = (source: string, kind: 'official' | 'listing', status: CollectorOutcome['status'], error?: string): CollectorOutcome =>
  ({ source, kind, status, runId: 1, mode: 'daily', error });

describe('evaluateHealth', () => {
  it('is ok when official collectors succeed and listings are not failing for 3 runs', () => {
    const report = evaluateHealth(
      [outcome('hdb-resale', 'official', 'success'), outcome('propertyguru', 'listing', 'incomplete')],
      { propertyguru: [{ status: 'incomplete' }, { status: 'success' }, { status: 'failed' }] },
    );
    expect(report).toEqual({ ok: true, reasons: [] });
  });

  it('flags any failed official collector', () => {
    const report = evaluateHealth([outcome('ura-private-txn', 'official', 'failed', 'token')], {});
    expect(report.ok).toBe(false);
    expect(report.reasons[0]).toMatch(/ura-private-txn failed: token/);
  });

  it('flags a listing source with 3 non-successful runs in a row', () => {
    const report = evaluateHealth([], { srx: [{ status: 'incomplete' }, { status: 'failed' }, { status: 'incomplete' }] });
    expect(report.reasons).toEqual(['srx has not completed successfully in its last 3 runs']);
  });
});

describe('pingHealthcheck', () => {
  it('pings the base URL on success and /fail on failure, swallowing errors', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok'));
    await pingHealthcheck('https://hc.test/abc', { ok: true, reasons: [] }, fetchImpl as unknown as typeof fetch);
    await pingHealthcheck('https://hc.test/abc/', { ok: false, reasons: ['x'] }, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual(['https://hc.test/abc', 'https://hc.test/abc/fail']);
    const broken = vi.fn(async () => { throw new Error('offline'); });
    await expect(pingHealthcheck('https://hc.test/abc', { ok: true, reasons: [] }, broken as unknown as typeof fetch)).resolves.toBeUndefined();
  });
});
```

`test/unit/collectors-index.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildCollectors, selectCollectors } from '../../src/collectors';
import { loadConfig } from '../../src/config';
import { FakeFetcher } from '../support/fake-fetcher';

const all = buildCollectors({ fetcher: new FakeFetcher([]), config: loadConfig({ DATABASE_URL: 'postgres://x' }) });

describe('collector registry', () => {
  it('registers the four official collectors', () => {
    expect(all.map((c) => [c.name, c.kind])).toEqual([
      ['hdb-resale', 'official'], ['hdb-rental', 'official'],
      ['ura-private-txn', 'official'], ['ura-private-rental', 'official'],
    ]);
  });

  it('selects by name or --all and rejects unknown names', () => {
    expect(selectCollectors(all, [], true)).toHaveLength(4);
    expect(selectCollectors(all, ['hdb-rental'], false).map((c) => c.name)).toEqual(['hdb-rental']);
    expect(() => selectCollectors(all, ['nope'], false)).toThrow(/Unknown source "nope".*hdb-resale/);
    expect(() => selectCollectors(all, [], false)).toThrow(/--all/);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run --project unit test/unit/lock.test.ts test/unit/health.test.ts test/unit/collectors-index.test.ts`
Expected: FAIL, because the modules aren't found.

- [ ] **Step 3: Implement**

`src/collectors/index.ts`:
```ts
import type { Config } from '../config';
import type { Fetcher } from '../fetch/types';
import { createHdbRentalCollector } from '../official/hdb-rental';
import { createHdbResaleCollector } from '../official/hdb-resale';
import { createUraPrivateRentalCollector } from '../official/ura-private-rental';
import { createUraPrivateTxnCollector } from '../official/ura-private-txn';
import type { Collector } from './types';

export function buildCollectors(deps: { fetcher: Fetcher; config: Config }): Collector[] {
  const { fetcher, config } = deps;
  const dataGovSg = { apiKey: config.dataGovSgApiKey };
  return [
    createHdbResaleCollector({ fetcher, dataGovSg }),
    createHdbRentalCollector({ fetcher, dataGovSg }),
    createUraPrivateTxnCollector({ fetcher, uraAccessKey: config.uraAccessKey }),
    createUraPrivateRentalCollector({ fetcher, uraAccessKey: config.uraAccessKey }),
  ];
}

export function selectCollectors(all: Collector[], names: string[], useAll: boolean): Collector[] {
  if (useAll) return all;
  if (names.length === 0) throw new Error('Name one or more sources, or pass --all');
  return names.map((name) => {
    const found = all.find((c) => c.name === name);
    if (!found) throw new Error(`Unknown source "${name}". Valid sources: ${all.map((c) => c.name).join(', ')}`);
    return found;
  });
}
```

`src/lock.ts`:
```ts
import { open, rm, stat } from 'node:fs/promises';

export class LockHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockHeldError';
  }
}

const SIX_HOURS = 6 * 3600_000;

export async function acquireLock(
  path: string, staleMs = SIX_HOURS, now: () => number = Date.now,
): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => { await rm(path, { force: true }); };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const info = await stat(path);
      if (now() - info.mtimeMs > staleMs) {
        await rm(path, { force: true });
        continue;
      }
      throw new LockHeldError(`Another run holds ${path} (since ${info.mtime.toISOString()})`);
    }
  }
  throw new LockHeldError(`Could not acquire ${path}`);
}
```

`src/health.ts`:
```ts
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
```

`src/cli.ts`:
```ts
import { Command, InvalidArgumentError } from 'commander';
import pino from 'pino';
import { RawArchive } from './archive';
import { buildCollectors, selectCollectors } from './collectors';
import type { Collector } from './collectors/types';
import { loadConfig, type Config } from './config';
import { createSql, type Sql } from './db/client';
import { migrate } from './db/migrate';
import { HttpFetcher } from './fetch/http';
import { evaluateHealth, pingHealthcheck } from './health';
import { acquireLock } from './lock';
import { reprocess, runAll, type CollectorOutcome, type RunnerDeps } from './runner';
import { lastRuns, recentRuns } from './runs';
import { todaySgt } from './time';

const LISTING_ARCHIVE_KEEP_DAYS = 60;

interface App extends RunnerDeps {
  config: Config;
  sql: Sql;
  collectors: Collector[];
}

async function withApp(fn: (app: App) => Promise<void>): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });
  const sql = createSql(config.databaseUrl);
  try {
    await migrate(sql);
    const collectors = buildCollectors({ fetcher: new HttpFetcher(), config });
    await fn({ config, logger, sql, archive: new RawArchive(config.rawArchiveDir), collectors });
  } finally {
    await sql.end();
  }
}

async function withLock(app: App, fn: () => Promise<void>): Promise<void> {
  const release = await acquireLock(app.config.lockFile);
  try {
    await fn();
  } finally {
    await release();
  }
}

function printOutcomes(outcomes: CollectorOutcome[]): void {
  console.table(outcomes.map((o) => ({
    source: o.source, mode: o.mode, status: o.status,
    fetched: o.result?.fetched ?? 0, inserted: o.result?.inserted ?? 0,
    changed: o.result?.changed ?? 0, rejected: o.result?.rejected ?? 0, error: o.error ?? '',
  })));
  if (outcomes.some((o) => o.status === 'failed')) process.exitCode = 1;
}

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('must be a positive integer');
  return n;
}

function isoDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new InvalidArgumentError('must be YYYY-MM-DD');
  return value;
}

const program = new Command().name('collect').description('Singapore property price collector');

program.command('run')
  .description('fetch and ingest sources')
  .argument('[sources...]', 'source names')
  .option('--all', 'run every source')
  .option('--backfill', 'fetch full history')
  .option('--dry-run', 'fetch and parse but write nothing')
  .option('--limit <n>', 'max payloads per source', positiveInt)
  .action((sources: string[], opts: { all?: boolean; backfill?: boolean; dryRun?: boolean; limit?: number }) =>
    withApp(async (app) => {
      const selected = selectCollectors(app.collectors, sources, !!opts.all);
      const options = { backfill: !!opts.backfill, dryRun: !!opts.dryRun, limit: opts.limit };
      await withLock(app, async () => {
        const outcomes = await runAll(app, selected, options);
        printOutcomes(outcomes);
        if (options.dryRun) return;
        for (const c of app.collectors.filter((k) => k.kind === 'listing')) {
          await app.archive.prune(c.name, LISTING_ARCHIVE_KEEP_DAYS, todaySgt());
        }
        if (opts.all && !options.backfill && app.config.healthcheckUrl) {
          const history: Record<string, Awaited<ReturnType<typeof lastRuns>>> = {};
          for (const c of app.collectors.filter((k) => k.kind === 'listing')) history[c.name] = await lastRuns(app.sql, c.name, 3);
          const report = evaluateHealth(outcomes, history);
          if (!report.ok) app.logger.warn({ reasons: report.reasons }, 'health check failing');
          await pingHealthcheck(app.config.healthcheckUrl, report);
        }
      });
    }));

program.command('status')
  .description('show runs from the last 7 days')
  .action(() => withApp(async (app) => {
    const runs = await recentRuns(app.sql, 7);
    console.table(runs.map((r) => ({
      id: r.id, source: r.source, mode: r.mode, started: r.started_at.toISOString(), status: r.status,
      fetched: r.fetched, inserted: r.inserted, changed: r.changed, rejected: r.rejected,
      error: (r.error ?? '').slice(0, 80),
    })));
  }));

program.command('reprocess')
  .description('re-ingest archived payloads without fetching')
  .argument('<source>')
  .requiredOption('--from <date>', 'first archive date (YYYY-MM-DD)', isoDate)
  .action((source: string, opts: { from: string }) => withApp(async (app) => {
    const [collector] = selectCollectors(app.collectors, [source], false);
    await withLock(app, async () => printOutcomes(await reprocess(app, collector, opts.from)));
  }));

program.command('migrate')
  .description('apply database migrations')
  .action(() => withApp(async () => { console.log('migrations applied'); }));

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
```

- [ ] **Step 4: Run all tests and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all unit and integration tests PASS, and no type errors.

- [ ] **Step 5: Check the CLI by hand against a local Postgres and live data.gov.sg**

```bash
docker run -d --name sgp-dev -e POSTGRES_USER=collector -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=collector -p 5432:5432 postgres:17-alpine
cp .env.example .env   # then set DATABASE_URL=postgres://collector:devpass@localhost:5432/collector
npm run collect -- migrate
npm run collect -- run hdb-rental --dry-run
npm run collect -- run hdb-rental
npm run collect -- status
npm run collect -- run nope        # expect: Unknown source "nope". Valid sources: ...
```

Expected:
- The dry run prints `hdb-rental | dry-run | success` with `fetched` around 200 000, and writes nothing.
- The real run prints `success`, with `inserted` equal to the rows in the latest 3 months.
- `status` lists both runs.
- `raw/hdb-rental/<today>/` contains `00001.gz` and `manifest.json`.

Then run `npm run collect -- reprocess hdb-rental --from <today>`. Expected: one `reprocess | success` row.

If `URA_ACCESS_KEY` is already set, also run `npm run collect -- run ura-private-txn --dry-run --limit 1`. Expected: `success` (with `limit` below 4, the check that all 4 batches are present is relaxed only for dry runs). Save a trimmed copy of one real batch (about 5 projects) as `test/fixtures/ura-private-txn/batch-sample.json`, and add a unit test asserting that `parseUraTxnJson` parses it with `rejected: 0`.

- [ ] **Step 6: Commit**

```bash
git add src/collectors/index.ts src/lock.ts src/health.ts src/cli.ts test/unit/lock.test.ts test/unit/health.test.ts test/unit/collectors-index.test.ts
git add test/fixtures test/unit/official 2>/dev/null || true   # only if the URA fixture was captured
git commit -m "feat: add CLI with lock, health check and collector registry

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: Docker, cron, backups and README

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `ops/crontab.example`, `ops/backup.sh`
- Modify: `README.md` (replace the one-line stub)

**Interfaces:**
- Consumes: the CLI from Task 13 (`run --all`, `status`, `reprocess`, `migrate`).
- Produces: `docker compose run --rm collector <cli args>`, which is what cron calls.

- [ ] **Step 1: Write the container files**

`Dockerfile`:
```dockerfile
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
ENTRYPOINT ["node", "--import", "tsx", "src/cli.ts"]
CMD ["status"]
```

`.dockerignore`:
```
node_modules
data
raw
backups
logs
.env
.git
test
docs
```

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: collector
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: collector
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U collector -d collector"]
      interval: 10s
      timeout: 5s
      retries: 5

  collector:
    build: .
    profiles: ["job"]
    env_file: .env
    environment:
      DATABASE_URL: postgres://collector:${POSTGRES_PASSWORD}@postgres:5432/collector
      RAW_ARCHIVE_DIR: /data/raw
      LOCK_FILE: /data/collector.lock
    volumes:
      - ./data:/data
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  pgdata:
```

`env_file` loads `.env`. The `environment:` block then overrides `DATABASE_URL` and the paths so they point inside the container.

`ops/backup.sh`:
```bash
#!/usr/bin/env bash
# Nightly pg_dump; keeps 14 days of dumps in ./backups.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
docker compose exec -T postgres pg_dump -U collector -d collector | gzip > "backups/collector-$(date +%F).sql.gz"
find backups -name 'collector-*.sql.gz' -mtime +14 -delete
```

Run: `chmod +x ops/backup.sh`

`ops/crontab.example`:
```
# The VM's timezone must be Asia/Singapore:  sudo timedatectl set-timezone Asia/Singapore
# Install with:  crontab ops/crontab.example   (after editing the path)
SHELL=/bin/bash
APP=/opt/sg-property-price-tracker

30 2 * * * cd $APP && ./ops/backup.sh >> logs/backup.log 2>&1
0 3 * * *  cd $APP && docker compose run --rm collector run --all >> logs/collect.log 2>&1
```

- [ ] **Step 2: Write the README**

`README.md`:
````markdown
# Singapore Property Price Tracker

Collects Singapore residential property prices daily into Postgres:

| Source | Table | History |
|---|---|---|
| HDB resale (data.gov.sg) | `hdb_resale_txn` | 1990 onwards |
| HDB rental (data.gov.sg) | `hdb_rental_txn` | 2021 onwards |
| URA private transactions | `ura_private_txn` | rolling 5 years from URA, kept forever here |
| URA private rentals | `ura_private_rental` | rolling 5 years from URA, kept forever here |

Listing sites (99.co, PropertyGuru, SRX) come in Plan 2 and write to `listings` and `listing_versions`.
Design: `docs/superpowers/specs/2026-09-18-sg-property-collector-design.md`.

## Prerequisites

- Node 22+, Docker
- A free URA API access key: register at https://eservice.ura.gov.sg/maps/api/reg.html
- Optional: a data.gov.sg API key. Without one, downloads are rate-limited and simply run slower.

## Local development

```bash
npm install
cp .env.example .env          # fill in POSTGRES_PASSWORD, DATABASE_URL, URA_ACCESS_KEY
docker compose up -d postgres
npm run collect -- migrate
npm test                      # needs Docker running (Testcontainers)
```

## Commands

```bash
npm run collect -- run --all                      # daily run of every source
npm run collect -- run hdb-resale --backfill      # full history for one source
npm run collect -- run ura-private-txn --dry-run --limit 1   # fetch + parse, write nothing
npm run collect -- status                         # runs from the last 7 days
npm run collect -- reprocess hdb-resale --from 2026-09-01   # re-ingest archived raw data
```

## Deploying to a VM

1. Create a VM (2 vCPU, 4 GB RAM, 80 GB disk; Singapore region preferred) with Docker installed.
2. `sudo timedatectl set-timezone Asia/Singapore`
3. `git clone` this repo to `/opt/sg-property-price-tracker`, then `cp .env.example .env` and fill it in.
4. `mkdir -p data logs backups && docker compose up -d postgres && docker compose build collector`
5. Run the one-off backfill:
   `docker compose run --rm collector run hdb-resale hdb-rental ura-private-txn ura-private-rental --backfill`
6. `crontab ops/crontab.example` (edit `APP` first).
7. Optional: create a free check at https://healthchecks.io (daily period, a few hours' grace) and put its ping URL in `HEALTHCHECK_URL`.

To update: `git pull && docker compose build collector`.

## Where the data lives

- Postgres volume `pgdata`. Connect with `docker compose exec postgres psql -U collector`.
- Raw responses: `data/raw/<source>/<date>/`. Official sources are kept forever; listings for 60 days.
- Backups: `backups/collector-YYYY-MM-DD.sql.gz`, 14 days kept.

## Example queries

```sql
-- Median HDB resale price per month for 4-room flats in Tampines
select month, percentile_cont(0.5) within group (order by resale_price) as median
from hdb_resale_txn where town = 'TAMPINES' and flat_type = '4 ROOM'
group by month order by month;

-- Private resale price per sqm by market segment, last 12 months
select market_segment, round(avg(price / area_sqm)) as avg_psm
from ura_private_txn
where type_of_sale = 'resale' and contract_month >= date_trunc('month', now()) - interval '12 months'
group by 1;
```
````

- [ ] **Step 3: Verify the image and the compose job**

```bash
docker rm -f sgp-dev 2>/dev/null || true   # stop the Task 13 dev container, which also uses port 5432
docker compose up -d postgres
docker compose build collector
docker compose run --rm collector migrate
docker compose run --rm collector run hdb-rental --dry-run
docker compose run --rm collector status
./ops/backup.sh && ls backups/
```

Expected:
- `migrations applied`
- A `dry-run | success` row
- `status` shows it
- A `collector-<date>.sql.gz` file in `backups/`
- `data/raw/` stays empty after the dry run, because dry-run archives are removed

- [ ] **Step 4: Run the full suite one last time**

Run: `npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml ops README.md
git commit -m "chore: add Docker Compose deployment, cron, backups and README

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## After Plan 1

- Get a URA access key and run the backfill (README, deployment step 5).
- Plan 2 (listing sites) starts with a test of Playwright with stealth against 99.co, PropertyGuru and SRX. It will add `BrowserFetcher` and three collectors built on `ingestListings` (Task 12).
