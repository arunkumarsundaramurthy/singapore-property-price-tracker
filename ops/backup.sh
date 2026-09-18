#!/usr/bin/env bash
# Nightly pg_dump; keeps 14 days of dumps in ./backups.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
docker compose exec -T postgres pg_dump -U collector -d collector | gzip > "backups/collector-$(date +%F).sql.gz"
find backups -name 'collector-*.sql.gz' -mtime +14 -delete
