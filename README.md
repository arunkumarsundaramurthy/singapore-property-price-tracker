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
