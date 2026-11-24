begin;

create schema if not exists openadminos;

create table if not exists openadminos.install_counts_daily (
  slug text,
  day date,
  installs integer not null default 0,
  flushed integer not null default 0,
  primary key (slug, day),
  check (flushed >= 0 and installs >= flushed)
);

create table if not exists openadminos.rate_limits (
  scope text,
  key_hash text,
  window_start timestamptz,
  hits integer not null,
  expires_at timestamptz not null,
  primary key (scope, key_hash, window_start)
);

create table if not exists openadminos.support_issue_dedup (
  hash text primary key,
  expires_at timestamptz not null
);

create index if not exists rate_limits_expires_at_idx on openadminos.rate_limits (expires_at);
create index if not exists support_issue_dedup_expires_at_idx on openadminos.support_issue_dedup (expires_at);

alter table openadminos.install_counts_daily enable row level security;
alter table openadminos.rate_limits enable row level security;
alter table openadminos.support_issue_dedup enable row level security;

-- The Data API role can call these functions without direct table privileges.
create or replace function openadminos.record_install(p_slug text, p_day date)
returns void
language sql security definer set search_path = ''
as $$
  insert into openadminos.install_counts_daily as daily (slug, day, installs)
  values (p_slug, p_day, 1)
  on conflict (slug, day) do update set installs = daily.installs + 1;
$$;

create or replace function openadminos.rate_limit_hit(
  p_scope text, p_key_hash text, p_window_seconds integer, p_max integer
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  checked_at timestamptz := pg_catalog.statement_timestamp();
  bucket_start timestamptz;
begin
  if p_window_seconds <= 0 or p_max <= 0 then
    return false;
  end if;

  bucket_start := pg_catalog.to_timestamp(
    pg_catalog.floor(extract(epoch from checked_at) / p_window_seconds) * p_window_seconds
  );

  delete from openadminos.rate_limits as expired
  using (
    select scope, key_hash, window_start
    from openadminos.rate_limits
    where expires_at <= checked_at
    order by expires_at
    limit 100
    for update skip locked
  ) as batch
  where (expired.scope, expired.key_hash, expired.window_start) =
    (batch.scope, batch.key_hash, batch.window_start);

  insert into openadminos.rate_limits as rates (scope, key_hash, window_start, hits, expires_at)
  values (p_scope, p_key_hash, bucket_start, 1, bucket_start + pg_catalog.make_interval(secs => p_window_seconds))
  on conflict (scope, key_hash, window_start) do update set hits = rates.hits + 1
  where rates.hits < p_max;
  return found;
end;
$$;

create or replace function openadminos.claim_support_dedup(p_hash text, p_ttl_seconds integer)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  checked_at timestamptz := pg_catalog.statement_timestamp();
begin
  insert into openadminos.support_issue_dedup as dedup (hash, expires_at)
  values (p_hash, checked_at + pg_catalog.make_interval(secs => p_ttl_seconds))
  on conflict (hash) do update set expires_at = excluded.expires_at
  where dedup.expires_at <= checked_at;
  return found;
end;
$$;

-- Called from the claiming request only if GitHub definitely rejected the issue.
create or replace function openadminos.release_support_dedup(p_hash text)
returns void
language sql security definer set search_path = ''
as $$
  delete from openadminos.support_issue_dedup where hash = p_hash;
$$;

create or replace function openadminos.pending_install_snapshot()
returns table (slug text, delta bigint, days jsonb)
language sql stable security definer set search_path = ''
as $$
  select daily.slug, pg_catalog.sum(daily.installs - daily.flushed),
    pg_catalog.jsonb_object_agg(daily.day, daily.installs)
  from openadminos.install_counts_daily as daily
  where daily.installs > daily.flushed
  group by daily.slug
  order by daily.slug;
$$;

create or replace function openadminos.pending_installs()
returns table (slug text, delta bigint)
language sql stable security invoker set search_path = ''
as $$
  select snapshot.slug, snapshot.delta from openadminos.pending_install_snapshot() as snapshot;
$$;

-- Absolute daily totals make the acknowledgement retryable and preserve newer installs.
create or replace function openadminos.mark_installs_flushed(p_snapshot jsonb)
returns void
language sql security definer set search_path = ''
as $$
  update openadminos.install_counts_daily as daily
  set flushed = counts.value::integer
  from pg_catalog.jsonb_to_recordset(p_snapshot) as snapshot(slug text, days jsonb)
  cross join lateral pg_catalog.jsonb_each_text(snapshot.days) as counts
  where daily.slug = snapshot.slug
    and daily.day = counts.key::date
    and counts.value::integer > daily.flushed
    and counts.value::integer <= daily.installs;
$$;

create or replace function openadminos.installs_7d()
returns table (slug text, installs bigint)
language sql stable security definer set search_path = ''
as $$
  select daily.slug, pg_catalog.sum(daily.installs)
  from openadminos.install_counts_daily as daily
  where daily.day between pg_catalog.timezone('UTC', pg_catalog.statement_timestamp())::date - 6
    and pg_catalog.timezone('UTC', pg_catalog.statement_timestamp())::date
  group by daily.slug
  order by daily.slug;
$$;

create or replace function openadminos.purge_expired()
returns void
language sql security definer set search_path = ''
as $$
  delete from openadminos.rate_limits where expires_at <= pg_catalog.statement_timestamp();
  delete from openadminos.support_issue_dedup where expires_at <= pg_catalog.statement_timestamp();
  delete from openadminos.install_counts_daily
    where day < pg_catalog.timezone('UTC', pg_catalog.statement_timestamp())::date - 8
      and installs = flushed;
$$;

create or replace function openadminos.health()
returns boolean
language sql stable security invoker set search_path = ''
as $$
  select true;
$$;

revoke all on schema openadminos from public, anon, authenticated, service_role;
revoke all on all tables in schema openadminos from public, anon, authenticated, service_role;
revoke all on all functions in schema openadminos from public, anon, authenticated, service_role;

grant usage on schema openadminos to service_role;
grant execute on function
  openadminos.record_install(text, date),
  openadminos.rate_limit_hit(text, text, integer, integer),
  openadminos.claim_support_dedup(text, integer),
  openadminos.release_support_dedup(text),
  openadminos.pending_install_snapshot(),
  openadminos.pending_installs(),
  openadminos.mark_installs_flushed(jsonb),
  openadminos.installs_7d(),
  openadminos.purge_expired(),
  openadminos.health()
to service_role;

commit;
