import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { Tx } from '../db/client';
import type { NormalizedListing } from './schema';

export function fingerprint(l: NormalizedListing): string {
  const tracked = [l.price, l.floor_area_sqft, l.bedrooms, l.bathrooms, l.title, l.property_type, l.listing_type];
  return createHash('sha1').update(JSON.stringify(tracked)).digest('hex');
}

export async function upsertListing(
  tx: Tx, source: string, runId: number, runDate: string, l: NormalizedListing,
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
