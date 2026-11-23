begin;

create schema if not exists extensions;
create extension if not exists citext with schema extensions;
set local search_path = public, extensions;

create table public.advent_participants (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  handle text not null unique check (
    handle ~ '^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$'
    and handle not in (
      'about', 'administrator', 'admin', 'advent', 'api', 'help', 'microsoft',
      'mod', 'moderator', 'official', 'open-admin-os', 'open-adminos', 'openadmin',
      'openadminos', 'privacy', 'root', 'rules', 'security', 'staff', 'support',
      'system', 'team', 'ugurlabs'
    )
  ),
  created_at timestamptz not null default now(),
  rules_version text not null,
  rules_accepted_at timestamptz not null,
  age_confirmed boolean not null check (age_confirmed),
  marketing_opt_in boolean not null default false,
  marketing_consent_text_version text,
  marketing_consent_at timestamptz,
  marketing_withdrawn_at timestamptz,
  reminders_opt_in boolean not null default false,
  reminders_consent_text_version text,
  reminders_consent_at timestamptz,
  reminders_withdrawn_at timestamptz,
  reminder_unsubscribe_id uuid not null unique default gen_random_uuid(),
  session_version int not null default 0 check (session_version >= 0),
  ref_code text not null unique check (ref_code ~ '^[2-9A-HJ-NP-Z]{8}$'),
  referred_by uuid references public.advent_participants on delete set null,
  badge_public boolean not null default false,
  check (referred_by is distinct from id),
  check (
    (marketing_opt_in and marketing_consent_text_version is not null and marketing_consent_at is not null and marketing_withdrawn_at is null)
    or (not marketing_opt_in and (
      num_nonnulls(marketing_consent_text_version, marketing_consent_at, marketing_withdrawn_at) = 0
      or (num_nonnulls(marketing_consent_text_version, marketing_consent_at, marketing_withdrawn_at) = 3 and marketing_withdrawn_at >= marketing_consent_at)
    ))
  ),
  check (
    (reminders_opt_in and reminders_consent_text_version is not null and reminders_consent_at is not null and reminders_withdrawn_at is null)
    or (not reminders_opt_in and (
      num_nonnulls(reminders_consent_text_version, reminders_consent_at, reminders_withdrawn_at) = 0
      or (num_nonnulls(reminders_consent_text_version, reminders_consent_at, reminders_withdrawn_at) = 3 and reminders_withdrawn_at >= reminders_consent_at)
    ))
  )
);
create index advent_reminders_opt_in_idx on public.advent_participants (id) where reminders_opt_in;
create index advent_referrer_idx on public.advent_participants (referred_by) where referred_by is not null;

create table public.advent_login_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  participant_id uuid references public.advent_participants on delete cascade,
  pending_signup jsonb,
  pending_email citext generated always as ((pending_signup->>'email')::citext) stored unique,
  requested_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  used_at timestamptz,
  check (num_nonnulls(participant_id, pending_signup) = 1)
);
create index advent_login_expiry_idx on public.advent_login_tokens (expires_at);
create index advent_login_participant_idx on public.advent_login_tokens (participant_id);

create table public.advent_answers (
  day int primary key check (day between 1 and 24),
  accepted_hashes text[] not null check (
    cardinality(accepted_hashes) <= 50 and (
      cardinality(accepted_hashes) = 0
      or array_to_string(accepted_hashes, ',', '!') ~ '^[0-9a-f]{64}(,[0-9a-f]{64})*$'
    )
  )
);

create table public.advent_completions (
  participant_id uuid not null references public.advent_participants on delete cascade,
  day int not null check (day between 1 and 24),
  completed_at timestamptz not null,
  on_time boolean not null,
  primary key (participant_id, day)
);
create index advent_completion_day_idx on public.advent_completions (day, on_time);

create table public.advent_attempts (
  participant_id uuid not null references public.advent_participants on delete cascade,
  day int not null check (day between 1 and 24),
  at timestamptz not null
);
create index advent_attempt_participant_idx on public.advent_attempts (participant_id, day, at);
create index advent_attempt_expiry_idx on public.advent_attempts (at);

create table public.advent_feedback (
  participant_id uuid primary key references public.advent_participants on delete cascade,
  day int not null default 22 check (day = 22),
  text text not null check (char_length(text) between 1 and 2000)
);

create table public.advent_draws (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  day int,
  created_at timestamptz not null,
  eligible_count int not null check (eligible_count >= 0),
  eligible_list_sha256 text not null check (eligible_list_sha256 ~ '^[0-9a-f]{64}$'),
  eligible_list jsonb not null check (jsonb_array_length(eligible_list) = eligible_count),
  random_bytes_hex text not null check (random_bytes_hex ~ '^[0-9a-f]{64}$'),
  winner_participant_ids uuid[] not null,
  created_by_email citext not null,
  check ((kind = 'daily' and day is not null and day between 1 and 24)
    or (kind = 'grand' and day is null)),
  check (cardinality(winner_participant_ids) <= case when kind = 'daily' then 1 else 3 end)
);
create unique index advent_daily_draw_once on public.advent_draws (day) where kind = 'daily';
create unique index advent_grand_draw_once on public.advent_draws (kind) where kind = 'grand';

create table public.advent_reminder_sends (
  day int not null check (day between 1 and 24),
  participant_id uuid not null references public.advent_participants on delete cascade,
  claimed_at timestamptz not null default now(),
  sent_at timestamptz,
  resend_message_id text,
  status text not null default 'claimed' check (status in ('claimed', 'sent', 'failed', 'unconfirmed')),
  failure_code text,
  primary key (day, participant_id),
  check (
    (status = 'sent' and sent_at is not null and resend_message_id is not null and failure_code is null)
    or (status = 'claimed' and sent_at is null and resend_message_id is null and failure_code is null)
    or (status in ('failed', 'unconfirmed') and sent_at is null and resend_message_id is null and failure_code is not null)
  )
);
create index advent_reminder_participant_idx on public.advent_reminder_sends (participant_id);

alter table public.advent_participants enable row level security;
alter table public.advent_login_tokens enable row level security;
alter table public.advent_answers enable row level security;
alter table public.advent_completions enable row level security;
alter table public.advent_attempts enable row level security;
alter table public.advent_feedback enable row level security;
alter table public.advent_draws enable row level security;
alter table public.advent_reminder_sends enable row level security;

revoke all on table public.advent_participants, public.advent_login_tokens, public.advent_answers,
  public.advent_completions, public.advent_attempts, public.advent_feedback, public.advent_draws,
  public.advent_reminder_sends
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.advent_participants, public.advent_login_tokens
  to service_role;
grant select, insert, update on table public.advent_answers to service_role;
grant select, insert on table public.advent_completions, public.advent_feedback, public.advent_draws
  to service_role;
grant select, insert, delete on table public.advent_attempts to service_role;
grant select, insert, update on table public.advent_reminder_sends to service_role;

create function public.advent_issue_signup_token(
  p_hash text, p_expires_at timestamptz, p_requested_at timestamptz, p_pending jsonb
) returns boolean language plpgsql security invoker set search_path = public, extensions, pg_temp as $$
begin
  insert into public.advent_login_tokens (token_hash, pending_signup, requested_at, expires_at)
  values (p_hash, p_pending, p_requested_at, p_expires_at)
  on conflict (pending_email) do update set
    token_hash = excluded.token_hash, pending_signup = excluded.pending_signup,
    requested_at = excluded.requested_at, expires_at = excluded.expires_at
  where advent_login_tokens.requested_at <= excluded.requested_at;
  return found;
end;
$$;

create function public.advent_preview_token(p_hash text, p_now timestamptz)
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select case when login.pending_signup is not null then
    jsonb_build_object(
      'kind', 'signup', 'email', login.pending_signup->>'email', 'handle', login.pending_signup->>'handle',
      'referral', (select ref_code from public.advent_participants where ref_code = login.pending_signup->>'ref'),
      'marketing', (login.pending_signup->>'marketing')::boolean,
      'reminders', (login.pending_signup->>'reminders')::boolean
    )
  else
    jsonb_build_object(
      'kind', 'signin', 'handle', account.handle,
      'maskedEmail', left(account.email::text, 1) || '•••@' || split_part(account.email::text, '@', 2)
    )
  end
  from public.advent_login_tokens as login
  left join public.advent_participants as account on account.id = login.participant_id
  where login.token_hash = p_hash and login.used_at is null and login.expires_at > p_now;
$$;

create function public.advent_consume_token(
  p_hash text, p_now timestamptz, p_created_at timestamptz, p_ref_code text,
  p_allow_signup boolean, p_confirmation jsonb, p_signin boolean
) returns jsonb language plpgsql security invoker set search_path = public, extensions, pg_temp as $$
declare
  login public.advent_login_tokens;
  account_id uuid;
  account_version int;
  referrer uuid;
  conflict_constraint text;
  marketing boolean;
  reminders boolean;
begin
  select * into login from public.advent_login_tokens where token_hash = p_hash for update;
  if not found or login.used_at is not null or login.expires_at <= p_now then
    return jsonb_build_object('status', 'invalid');
  end if;

  if login.pending_signup is not null then
    if not p_allow_signup then
      return jsonb_build_object('status', 'signup_closed');
    end if;
    if p_confirmation is null or p_signin then
      return jsonb_build_object('status', 'confirmation_required');
    end if;

    account_id := gen_random_uuid();
    if not (p_confirmation->>'discard_referral')::boolean then
      select id into referrer from public.advent_participants
        where ref_code = login.pending_signup->>'ref' and created_at <= p_created_at and id <> account_id;
    end if;
    marketing := (p_confirmation->>'marketing')::boolean;
    reminders := (p_confirmation->>'reminders')::boolean;
    begin
      insert into public.advent_participants (
        id, email, handle, created_at, rules_version, rules_accepted_at, age_confirmed,
        marketing_opt_in, marketing_consent_text_version, marketing_consent_at,
        reminders_opt_in, reminders_consent_text_version, reminders_consent_at, ref_code, referred_by
      ) values (
        account_id, login.pending_signup->>'email', p_confirmation->>'handle', p_created_at,
        p_confirmation->>'rules_version', p_now, true,
        marketing, case when marketing then p_confirmation->>'marketing_version' end,
        case when marketing then p_now end,
        reminders, case when reminders then p_confirmation->>'reminders_version' end,
        case when reminders then p_now end,
        p_ref_code, referrer
      ) returning session_version into account_version;
    exception when unique_violation then
      get stacked diagnostics conflict_constraint = constraint_name;
      if conflict_constraint = 'advent_participants_handle_key' then
        return jsonb_build_object('status', 'handle_taken');
      end if;
      if conflict_constraint = 'advent_participants_ref_code_key' then
        return jsonb_build_object('status', 'ref_collision');
      end if;
      if conflict_constraint = 'advent_participants_email_key' then
        return jsonb_build_object('status', 'invalid');
      end if;
      raise;
    end;
  else
    if not p_signin then
      return jsonb_build_object('status', 'confirmation_required');
    end if;
    account_id := login.participant_id;
    select session_version into account_version from public.advent_participants where id = account_id;
    if not found then
      return jsonb_build_object('status', 'invalid');
    end if;
  end if;

  update public.advent_login_tokens
    set used_at = p_now, participant_id = account_id, pending_signup = null
    where token_hash = p_hash;
  return jsonb_build_object('status', 'ok', 'id', account_id, 'version', account_version);
end;
$$;

create function public.advent_unsubscribe_reminders(p_unsubscribe_id uuid)
returns void language sql security invoker set search_path = public, pg_temp as $$
  update public.advent_participants set reminders_opt_in = false, reminders_withdrawn_at = clock_timestamp()
  where reminder_unsubscribe_id = p_unsubscribe_id and reminders_opt_in;
$$;

create function public.advent_sign_out(p_id uuid, p_version int)
returns void language sql security invoker set search_path = public, pg_temp as $$
  update public.advent_participants set session_version = session_version + 1
    where id = p_id and session_version = p_version;
$$;

create function public.advent_complete_door(
  p_id uuid, p_day int, p_now timestamptz, p_on_time boolean, p_hash text, p_feedback text, p_can_record_wrong boolean
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  account public.advent_participants;
  previous public.advent_completions;
  hashes text[];
  attempts int;
begin
  select * into account from public.advent_participants where id = p_id for update;
  if not found then
    return jsonb_build_object('status', 'signed_out');
  end if;

  select * into previous from public.advent_completions where participant_id = p_id and day = p_day;
  if found then
    return jsonb_build_object('status', 'done');
  end if;

  if p_day = 22 then
    insert into public.advent_feedback (participant_id, text) values (p_id, p_feedback);
  elsif p_day = 24 then
    if not account.badge_public then
      return jsonb_build_object('status', 'private_badge');
    end if;
  else
    select accepted_hashes into hashes from public.advent_answers where day = p_day;
    if coalesce(cardinality(hashes), 0) = 0 then
      return jsonb_build_object('status', 'no_answers');
    end if;
    select count(*) into attempts from public.advent_attempts
      where participant_id = p_id and day = p_day and at > p_now - interval '1 hour';
    if attempts >= 10 then
      return jsonb_build_object('status', 'limited');
    end if;
    if not coalesce(p_hash = any(hashes), false) then
      if p_can_record_wrong is not true then
        return jsonb_build_object('status', 'ip_limited');
      end if;
      insert into public.advent_attempts (participant_id, day, at) values (p_id, p_day, p_now);
      return jsonb_build_object('status', 'wrong', 'remaining', 9 - attempts);
    end if;
  end if;

  insert into public.advent_completions (participant_id, day, completed_at, on_time)
    values (p_id, p_day, p_now, p_on_time);
  return jsonb_build_object('status', 'done');
end;
$$;

create function public.advent_update_settings(
  p_id uuid, p_handle text, p_badge boolean, p_marketing boolean, p_consent_version text,
  p_reminders boolean, p_reminders_consent_version text
) returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  changed_at timestamptz := clock_timestamp();
begin
  update public.advent_participants
    set handle = p_handle, badge_public = p_badge,
      marketing_opt_in = coalesce(p_marketing, marketing_opt_in),
      marketing_consent_text_version = case when p_marketing and not marketing_opt_in
        then p_consent_version else marketing_consent_text_version end,
      marketing_consent_at = case when p_marketing and not marketing_opt_in
        then changed_at else marketing_consent_at end,
      marketing_withdrawn_at = case when p_marketing then null
        when not p_marketing and marketing_opt_in then changed_at else marketing_withdrawn_at end,
      reminders_opt_in = coalesce(p_reminders, reminders_opt_in),
      reminders_consent_text_version = case when p_reminders and not reminders_opt_in
        then p_reminders_consent_version else reminders_consent_text_version end,
      reminders_consent_at = case when p_reminders and not reminders_opt_in
        then changed_at else reminders_consent_at end,
      reminders_withdrawn_at = case when p_reminders then null
        when not p_reminders and reminders_opt_in then changed_at else reminders_withdrawn_at end
    where id = p_id;
  return found;
end;
$$;

create function public.advent_door_stats()
returns table(day int, completed int, on_time int, answer_count int)
language sql stable security invoker set search_path = public, pg_temp as $$
  select d.day, coalesce(c.completed, 0), coalesce(c.on_time, 0),
    coalesce(cardinality(a.accepted_hashes), 0)
  from generate_series(1, 24) as d(day)
  left join (
    select day, count(*)::int as completed, count(*) filter (where on_time)::int as on_time
    from public.advent_completions group by day
  ) as c on c.day = d.day
  left join public.advent_answers as a on a.day = d.day
  order by d.day;
$$;

create function public.advent_referral_count(p_id uuid)
returns int language sql stable security invoker set search_path = public, pg_temp as $$
  select count(*)::int
  from public.advent_participants as referrer
  join public.advent_participants as referred on referred.referred_by = referrer.id
  join public.advent_completions as first_door on first_door.participant_id = referred.id and first_door.day = 1
  where referrer.id = p_id and referred.id <> referrer.id and referred.created_at >= referrer.created_at;
$$;

create function public.advent_draw_candidates(p_day int)
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', eligible.participant_id,
    'completed', eligible.completed,
    'referrals', case when p_day is null then public.advent_referral_count(eligible.participant_id) else 0 end
  ) order by eligible.participant_id), '[]'::jsonb)
  from (
    select participant_id, count(*)::int as completed from public.advent_completions
    where p_day is null or (day = p_day and on_time)
    group by participant_id
    having count(*) >= case when p_day is null then 18 else 1 end
  ) as eligible;
$$;

create function public.advent_purge(p_now timestamptz)
returns int language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  removed int;
begin
  if not exists (
    select 1 from public.advent_draws where kind = 'grand' and created_at + interval '2160 hours' <= p_now
  ) then
    return null;
  end if;

  delete from public.advent_participants as p
  where not exists (
    select 1 from public.advent_draws as draw where p.id = any(draw.winner_participant_ids)
  );
  get diagnostics removed = row_count;
  return removed;
end;
$$;

create function public.advent_daily_cleanup(p_now timestamptz)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  expired_tokens int;
  stale_attempts int;
begin
  delete from public.advent_login_tokens where expires_at <= p_now;
  get diagnostics expired_tokens = row_count;
  delete from public.advent_attempts where at <= p_now - interval '7 days';
  get diagnostics stale_attempts = row_count;
  return jsonb_build_object('expiredTokens', expired_tokens, 'staleAttempts', stale_attempts);
end;
$$;

create function public.advent_reminder_eligible(p_day int)
returns setof uuid language sql stable security invoker set search_path = public, pg_temp as $$
  select p.id from public.advent_participants as p
  where p.reminders_opt_in
    and not exists (
      select 1 from public.advent_completions as c where c.participant_id = p.id and c.day = p_day
    )
    and not exists (
      select 1 from public.advent_reminder_sends as s where s.participant_id = p.id and s.day = p_day
    );
$$;

create function public.advent_reminder_count(p_day int)
returns int language sql stable security invoker set search_path = public, pg_temp as $$
  select count(*)::int from public.advent_reminder_eligible(p_day);
$$;

create function public.advent_reminder_claim(p_day int, p_limit int)
returns jsonb language sql security invoker set search_path = public, extensions, pg_temp as $$
  with recipients as (
    select p.id, p.email, p.reminder_unsubscribe_id from public.advent_participants as p
    where p.reminders_opt_in and p.id in (select * from public.advent_reminder_eligible(p_day))
    order by p.id
    limit greatest(0, least(p_limit, 100))
    for update of p skip locked
  ), claimed as (
    insert into public.advent_reminder_sends (day, participant_id)
    select p_day, id from recipients
    on conflict (day, participant_id) do nothing
    returning participant_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'email', r.email, 'unsubscribeId', r.reminder_unsubscribe_id) order by r.id), '[]'::jsonb)
  from recipients as r
  join claimed as c on c.participant_id = r.id;
$$;

create function public.advent_reminder_record(p_day int, p_outcomes jsonb)
returns void language sql security invoker set search_path = public, pg_temp as $$
  update public.advent_reminder_sends as s
  set status = outcome.status,
    sent_at = case when outcome.status = 'sent' then clock_timestamp() end,
    resend_message_id = outcome.message_id, failure_code = outcome.code
  from jsonb_to_recordset(p_outcomes) as outcome(id uuid, status text, message_id text, code text)
  where s.day = p_day and s.participant_id = outcome.id and s.status = 'claimed'
    and outcome.status in ('sent', 'failed', 'unconfirmed');
$$;

create function public.advent_reminder_stats()
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'optedIn', (select count(*) from public.advent_participants where reminders_opt_in),
    'days', coalesce(jsonb_agg(jsonb_build_object(
      'day', day, 'sent', sent, 'failed', failed, 'unconfirmed', unconfirmed
    ) order by day), '[]'::jsonb)
  )
  from (
    select day, count(*) filter (where status = 'sent') as sent,
      count(*) filter (where status = 'failed') as failed,
      count(*) filter (where status in ('claimed', 'unconfirmed')) as unconfirmed
    from public.advent_reminder_sends group by day
  ) as counts;
$$;

revoke execute on function public.advent_issue_signup_token(text, timestamptz, timestamptz, jsonb),
  public.advent_preview_token(text, timestamptz),
  public.advent_consume_token(text, timestamptz, timestamptz, text, boolean, jsonb, boolean),
  public.advent_sign_out(uuid, int), public.advent_unsubscribe_reminders(uuid),
  public.advent_complete_door(uuid, int, timestamptz, boolean, text, text, boolean),
  public.advent_daily_cleanup(timestamptz),
  public.advent_update_settings(uuid, text, boolean, boolean, text, boolean, text),
  public.advent_door_stats(), public.advent_referral_count(uuid),
  public.advent_draw_candidates(int), public.advent_purge(timestamptz),
  public.advent_reminder_eligible(int), public.advent_reminder_count(int),
  public.advent_reminder_claim(int, int), public.advent_reminder_record(int, jsonb),
  public.advent_reminder_stats()
  from public, anon, authenticated;
grant execute on function public.advent_issue_signup_token(text, timestamptz, timestamptz, jsonb),
  public.advent_preview_token(text, timestamptz),
  public.advent_consume_token(text, timestamptz, timestamptz, text, boolean, jsonb, boolean),
  public.advent_sign_out(uuid, int), public.advent_unsubscribe_reminders(uuid),
  public.advent_complete_door(uuid, int, timestamptz, boolean, text, text, boolean),
  public.advent_daily_cleanup(timestamptz),
  public.advent_update_settings(uuid, text, boolean, boolean, text, boolean, text),
  public.advent_door_stats(), public.advent_referral_count(uuid),
  public.advent_draw_candidates(int), public.advent_purge(timestamptz),
  public.advent_reminder_eligible(int), public.advent_reminder_count(int),
  public.advent_reminder_claim(int, int), public.advent_reminder_record(int, jsonb),
  public.advent_reminder_stats()
  to service_role;

commit;
