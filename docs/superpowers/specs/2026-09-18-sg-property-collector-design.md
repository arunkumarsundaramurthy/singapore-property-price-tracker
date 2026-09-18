# Singapore Property Price Collector — Design

**Date:** 2026-09-18
**Status:** Approved in brainstorming, pending spec review

## Goal

Collect Singapore residential property prices every day into a queryable database:

- **Historic transacted prices** (sales and rentals, HDB and private) from official sources.
- **Current asking prices** (sales and rentals) from online listing portals, tracked over time.

The deliverable is the data only. No UI, API, alerts, or forecasting. Price forecasting and new-launch pricing are explicitly out of scope.

## Scope

| Segment | Transactions (official) | Listings (asking) |
|---|---|---|
| HDB resale | data.gov.sg — HDB resale flat prices (1990–present) | 99.co, PropertyGuru, SRX |
| HDB rental | data.gov.sg — Renting out of flats (2021–present) | 99.co, PropertyGuru, SRX |
| Private sale | URA Data Service — private residential transactions (rolling ~5 years) | 99.co, PropertyGuru, SRX |
| Private rental | URA Data Service — private residential rental contracts (by quarter) | 99.co, PropertyGuru, SRX |

**Constraints**

- Language: Node.js + TypeScript.
- Runs daily on a cloud VM.
- $0 budget for anti-bot measures: Playwright with stealth only, no paid proxies or scraping APIs. PropertyGuru may be blocked often, and the system must tolerate that. The fetch layer must be swappable so a paid proxy can be added later with a config change only.
- Listing portals prohibit scraping in their terms of service. This is personal data collection, and the owner has accepted that risk.

## Architecture

A single TypeScript application with pluggable collectors, a Postgres database, and a raw-response archive on disk. The whole thing runs once a day via cron on the VM.

```
cron (03:00 SGT)
  └─ docker compose run --rm collector run --all
       ├─ official collectors (sequential): hdb-resale, hdb-rental, ura-private-txn, ura-private-rental
       └─ listing collectors (sequential):  99co, propertyguru, srx
            each: fetch → archive raw → read archive back → parse → validate → write (one DB transaction) → record run
```

Every collector writes what it fetches to the raw archive, and ingestion always reads it back from there. A daily run, a reprocess, and a dry run therefore share the same ingest path. Ingestion for one source runs inside a single database transaction.

### Collector interface

```ts
interface Collector {
  name: string;                                   // e.g. "hdb-resale", "99co"
  kind: 'official' | 'listing';
  fetch(ctx: FetchContext, emit: (p: Payload) => Promise<void>): Promise<{ complete: boolean }>;
  ingest(tx: Sql, payloads: AsyncIterable<Payload>, ctx: IngestContext): Promise<IngestResult>;
}

interface Payload { key: string; body: string }  // one raw response (CSV or JSON text)
interface RunOptions { backfill: boolean; dryRun: boolean; limit?: number }   // limit = max payloads fetched
interface FetchContext { runDate: string; logger: Logger; options: RunOptions }
interface IngestContext { runId: number; runDate: string; logger: Logger; backfill: boolean; dryRun: boolean; fetchComplete: boolean }
interface IngestResult { fetched: number; inserted: number; changed: number; rejected: number; complete: boolean }
```

`Fetcher` is an interface. `HttpFetcher` (built on Node's fetch) is used by the official collectors. A Playwright-backed `BrowserFetcher` is added together with the listing collectors, and a future `ProxyFetcher` plugs in without changing collectors.

### Project layout

```
src/
  cli.ts                 # run [sources...] [--all] [--backfill] [--dry-run] [--limit N] | status | reprocess <source> --from <date> | migrate
  runner.ts              # runs collectors in order, isolates failures, dry-run rollback, reprocess
  config.ts, time.ts, archive.ts, runs.ts, lock.ts, health.ts
  fetch/                 # Fetcher interface, HttpFetcher (BrowserFetcher added with the listing collectors)
  db/                    # client, migrator, migrations/*.sql
  collectors/            # Collector types and the registry of all collectors
  official/              # data.gov.sg and URA clients, the four official collectors, replace-by-period
  listings/              # NormalizedListing schema, upsert and delisting engine (site collectors added later)
test/
  unit/, integration/, support/
```

### Delivery in two plans

1. **Plan 1:** the foundation, the four official collectors, the listing change-tracking engine (tested without any site), the command line, and the operational setup.
2. **Plan 2:** the three listing site collectors and `BrowserFetcher`. A plain request to each of the three sites returned a Cloudflare challenge (HTTP 403) on 2026-09-18, so Plan 2 starts with a test of Playwright with stealth against each site and saves real pages as fixtures.

## Data model (Postgres)

### Official data: one table per source

Each table keeps the source's own fields. Column names are normalized to snake_case, and months are stored as `date` (first of the month).

- **`hdb_resale_txn`**: month, town, flat_type, block, street_name, storey_range, floor_area_sqm, flat_model, lease_commence_year, remaining_lease, resale_price.
- **`hdb_rental_txn`**: rent_approval_month, town, block, street_name, flat_type, monthly_rent.
- **`ura_private_txn`**: project, street, district, market_segment, property_type, tenure, type_of_sale (new / sub-sale / resale), floor_range, area_sqm, type_of_area, no_of_units, contract_month, price, x, y (SVY21 coordinates as supplied).
- **`ura_private_rental`**: project, street, district, property_type, lease_month, area_sqm_range, area_sqft_range, no_of_bedroom, rent, ref_quarter.

Every row also carries `ingested_run_id`.

**Deduplication: replace by period.** These datasets have no row IDs, and legitimately identical rows exist. Each ingest therefore deletes and re-inserts whole periods, in one transaction:

| Source | Daily refresh window | Period key |
|---|---|---|
| hdb-resale | latest 3 months | month |
| hdb-rental | latest 3 months | rent_approval_month |
| ura-private-txn | every contract month present in the response | contract_month |
| ura-private-rental | latest 2 quarters | ref_quarter |

Backfill uses the same mechanism over all available periods. URA only serves about 5 years, so private history accumulates in our database from the first backfill onward.

### Listings

**`listings`**: one row per listing, holding its current state.

| column | notes |
|---|---|
| id | bigserial PK |
| source | `99co` / `propertyguru` / `srx` |
| source_listing_id | unique with `source` |
| listing_type | `sale` / `rent` |
| property_type | `hdb` / `condo` / `apartment` / `ec` / `landed` / `other` |
| title, project_name, address, postal_code, district | |
| bedrooms, bathrooms, floor_area_sqft | |
| price, psf | psf = price / floor_area_sqft when both are present |
| tenure, built_year | |
| lat, lng, url | |
| extra | jsonb for site-specific fields |
| first_seen, last_seen | dates |
| status | `active` / `delisted` |
| missed_complete_runs | int; the delisting counter |
| last_missed_on | date; stops a same-day re-run from counting a miss twice |
| updated_run_id | run that last wrote the row |

**`listing_versions`**: a new row only when a tracked field changes.

| column | notes |
|---|---|
| listing_id | FK |
| observed_on | date |
| price, psf, floor_area_sqft | |
| fingerprint | hash of the tracked fields (price, floor_area_sqft, bedrooms, bathrooms, title, property_type, listing_type) |
| run_id | |

**Upsert rules** (`listings/upsert.ts`), for each listing parsed in a run:

1. New `(source, source_listing_id)`: insert the listing (`first_seen = last_seen = today`, `status = active`) and a first version.
2. Existing listing: set `last_seen = today`, `status = active` and `missed_complete_runs = 0`, and update the current fields. If the fingerprint differs from the latest version, insert a new version.
3. After a run with `complete = true` only: for each active listing of that source not seen in this run, increment `missed_complete_runs`. When it reaches **2**, set `status = delisted`.
4. After an incomplete run, no listing's missed counter or status is touched.

Re-running on the same day with unchanged data produces no new versions.

### `runs`

id, source, started_at, finished_at, status (`success` / `incomplete` / `failed`), fetched, inserted, changed, rejected, error (text), mode (`daily` / `backfill` / `reprocess` / `dry-run`).

## Collectors

### Official

- **hdb-resale**:
  - Backfill: download all HDB resale datasets from data.gov.sg (split by period: 1990–1999, 2000–Feb 2012, Mar 2012–2014, 2015–2016, 2017–present).
  - Daily: download the current (2017–present) dataset and replace the latest 3 months.
- **hdb-rental**: the "renting out of flats" dataset (2021–present), same pattern.
- **ura-private-txn**: each run exchanges the AccessKey for a daily token, then fetches `PMI_Resi_Transaction` for batches 1–4 (split by postal district). It replaces every contract month in the response **except the earliest**: URA serves a rolling 5-year window, so the earliest month may be only partly included. Ingestion requires all 4 batches, because a replaced month spans every district. `typeOfSale` codes are mapped as 1 = new sale, 2 = sub sale, 3 = resale. URA publishes transactions every Tuesday and Friday.
- **ura-private-rental**: fetches `PMI_Resi_Rental` by `refPeriod`. URA publishes rentals monthly, on the 15th; a daily pull is still safe because replacing a quarter is idempotent.
  - Daily: fetch the rental contracts service for the latest 2 quarters, e.g. `refPeriod=26q3`, and replace them.
  - Backfill: all quarters URA serves.

The URA AccessKey is supplied through the environment (`URA_ACCESS_KEY`).

### Listings (99co, propertyguru, srx)

- **Slicing:** listing_type × property_type × district, split further by price band when a slice would exceed the portal's page limit. The slice definitions live in each collector.
- **Search pages only:** no detail pages.
- **Parsing, in order of preference:**
  1. Embedded JSON (e.g. Next.js `__NEXT_DATA__`).
  2. The site's own API responses captured through Playwright network interception.
  3. DOM parsing, as a last resort.
- **Pacing:** one browser context per site, sites run sequentially, a random 2–6 s delay between page loads, and a per-run page cap per site (configurable).
- **Block detection:** a Cloudflare challenge page, an HTTP 403/429, or an empty result where results are expected counts as blocked. The page is retried twice with backoff. If it is still blocked, the slice fails and the collector moves on. `complete = false` if any slice failed or the page cap was hit.

### Verification before building

Several details above come from prior knowledge and have not been checked against the live sources:

- data.gov.sg dataset IDs and download API
- URA service names and batch/refPeriod parameters
- portal page limits and whether each portal serves embedded JSON

**The first implementation task** is a short investigation against each live source. It records the real endpoints and response shapes and saves sample responses as test fixtures. Any difference from this spec is fixed in the spec before collectors are built.

## Error handling

- **Isolation:** each collector runs in its own try/catch and database transaction. A crash rolls back only that source, records `failed` in `runs`, and the runner continues.
- **Idempotency:** re-running any collector on the same day yields the same database state.
- **Validation:** every parsed record goes through a zod schema. Invalid records are skipped, counted in `rejected`, and a sample is logged. For listings, if rejects are above **5%** or size is missing on more than 5% of records, the run is marked `incomplete` (price is required by the schema). For official data, a reject rate above 5% fails the run before anything is written.
- **Volume guards:**
  - Official: if a download returns fewer than **95%** of the rows already stored for the periods being replaced, nothing is replaced and the run is marked `failed`. The 5% tolerance allows for transactions the source withdraws.
  - Listings: if a site returns fewer than 50% of the previous day's active count for that source, the run is marked `incomplete`.
- **Retries:**
  - HTTP errors and timeouts: 3 attempts, exponential backoff.
  - Blocked pages: 2 retries.
  - URA token expiry: refresh once.
- **Reprocessing:** `npm run collect -- reprocess <source> --from <date>` re-parses archived raw responses into the database without fetching anything.

## Deployment and operations

- **VM:** any provider, Singapore region preferred. 2 vCPU, 4 GB RAM, about 80 GB disk.
- **Docker Compose:**
  - `postgres` runs continuously, with data on a named volume.
  - `collector` is built on the official Playwright Node image and runs on demand.
- **Deployment:** `git pull && docker compose build` on the VM.
- **Schedule:** host crontab, daily at 03:00 SGT: `docker compose run --rm collector run --all`. A lock file prevents overlapping runs. Official collectors run first, then listings; expect about 1–3 hours total.
- **Monitoring:**
  - `status` prints the last 7 days of `runs`.
  - Optional healthchecks.io ping, enabled when `HEALTHCHECK_URL` is set. The runner signals success at the end of a run and failure when any official collector failed or any listing source has been incomplete for 3 consecutive days.
- **Backups:** nightly `pg_dump` (gzipped), keeping 14 days on the VM. Copying off the VM is a later addition.
- **Raw archive retention:** official responses are kept forever. Listing responses are kept for 60 days and pruned by the runner.

Configuration comes from environment variables: `DATABASE_URL`, `URA_ACCESS_KEY`, `DATA_GOV_SG_API_KEY` (optional; without it data.gov.sg rate-limits to about one request per 10 seconds, which the client handles by waiting), `HEALTHCHECK_URL` (optional), `RAW_ARCHIVE_DIR`, `LOCK_FILE`, `LOG_LEVEL`. The listing collectors add `LISTING_PAGE_CAP` and `LISTING_DELAY_MS_MIN/MAX`.

## Testing

- **Parser unit tests (Vitest):** each collector's parser is tested against saved real responses in `test/fixtures/<source>/`, captured during the verification task, and asserts the normalized output.
- **Change-tracking tests** for `listings/upsert.ts`:
  - a new listing gets a first version
  - an unchanged same-day re-run adds no version
  - a price change adds a version
  - a listing missing across 2 complete runs is delisted
  - a listing missing after an incomplete run is untouched
  - a delisted listing that reappears becomes active again
- **Database integration tests** against real Postgres via Testcontainers: replace-by-period (including genuine duplicate rows), volume guards, and idempotent re-runs. The database is not mocked.
- **Collector tests:** each collector runs end to end against a fixture-backed fake `Fetcher`, and the test checks the `runs` row and table contents.
- **No live-site tests in CI.** `npm run collect -- run <source> --dry-run --limit 2` is used by hand to check real fetch and parse after deployment.
- **When a portal changes:** capture a new fixture, fix the parser until the tests pass, then run `reprocess` over the affected days.

## Out of scope (for now)

Price forecasting, new-launch and BTO pricing, a UI or dashboard, a query API, alerts on listings, matching the same unit across portals, geocoding or enrichment, paid proxies, and off-VM backups.
