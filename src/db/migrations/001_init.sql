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
