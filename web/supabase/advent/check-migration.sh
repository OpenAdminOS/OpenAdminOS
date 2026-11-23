#!/usr/bin/env bash
set -euo pipefail

migration_dir=$(cd "$(dirname "$0")" && pwd)
pg_bin=${ADVENT_POSTGRES_BIN:-}
if [[ -z "$pg_bin" ]] && command -v pg_config >/dev/null; then
  pg_bin=$(pg_config --bindir)
fi
if [[ -z "$pg_bin" ]] && command -v initdb >/dev/null; then
  pg_bin=$(dirname "$(command -v initdb)")
fi
if [[ -z "$pg_bin" || ! -x "$pg_bin/initdb" || ! -x "$pg_bin/pg_ctl" || ! -x "$pg_bin/psql" ]]; then
  echo "SKIP: PostgreSQL server and client binaries are unavailable. Set ADVENT_POSTGRES_BIN to their bin directory."
  exit 0
fi

cluster=$(mktemp -d /tmp/advent-migration.XXXXXXXX)
cleanup() {
  "$pg_bin/pg_ctl" -D "$cluster/data" -m immediate stop >/dev/null 2>&1 || true
  rm -r -- "$cluster"
}
trap cleanup EXIT
"$pg_bin/initdb" -D "$cluster/data" -U postgres -A trust --no-locale -E UTF8 >/dev/null
"$pg_bin/pg_ctl" -D "$cluster/data" -o "-c listen_addresses= -k $cluster" -l "$cluster/server.log" -w start >/dev/null
psql=(env -u PGHOSTADDR -u PGSERVICE -u PGSERVICEFILE -u PGOPTIONS "$pg_bin/psql" -X -q -v ON_ERROR_STOP=1 -h "$cluster" -p 5432 -U postgres -d postgres)

if [[ $("${psql[@]}" -Atc "select exists (select 1 from pg_available_extensions where name = 'citext')") != t ]]; then
  echo "SKIP: This PostgreSQL installation does not include the citext extension."
  exit 0
fi

"${psql[@]}" -c "create role anon; create role authenticated; create role service_role bypassrls;"
"${psql[@]}" -f "$migration_dir/0001_init.sql"
"${psql[@]}" <<'SQL'
set role anon;
do $$
begin
  if has_table_privilege(current_user, 'public.advent_participants', 'select')
    or has_function_privilege(current_user, 'public.advent_preview_token(text,timestamptz)', 'execute') then
    raise exception 'anon can access Advent data';
  end if;
end;
$$;

set role service_role;
set search_path = public, extensions;
do $$
declare
  start_at timestamptz := '2026-12-01 06:00:00+01';
  request_at timestamptz := clock_timestamp() - interval '2 minutes';
  real_confirm_at timestamptz := request_at + interval '1 minute';
  grand_at timestamptz := '2027-01-01 08:00:00+01';
  runner_email text := 'operator@example.test';
  referrer uuid;
  signup uuid;
  earlier_winner uuid;
  replacement uuid;
  grand_draw uuid;
  token jsonb;
  confirmation jsonb := '{
    "handle":"confirmed-handle","discard_referral":false,"marketing":false,"reminders":true,
    "rules_version":"rules-confirmed","marketing_version":"marketing-confirmed","reminders_version":"reminders-confirmed"
  }';
  pending jsonb := '{
    "email":"guest@example.test","handle":"draft-handle","ref":"AB234567","marketing":true,"reminders":false
  }';
  preview jsonb;
  outcome jsonb;
  snapshot jsonb;
  replacement_record jsonb;
  attempt int;
  status text;
  removed int;
begin
  insert into advent_participants (email, handle, created_at, rules_version, rules_accepted_at, age_confirmed, ref_code)
    values ('referrer@example.test', 'referrer', start_at, 'fixture', start_at, true, 'AB234567') returning id into referrer;
  begin
    insert into advent_participants (email, handle, rules_version, rules_accepted_at, age_confirmed, ref_code)
      values ('REFERRER@EXAMPLE.TEST', 'second-handle', 'fixture', start_at, true, 'CD234567');
    raise exception 'citext accepted a duplicate';
  exception when unique_violation then
    null;
  end;

  if advent_issue_signup_token(repeat('a', 64), request_at + interval '15 minutes', request_at, pending) is not true then
    raise exception 'initial pending signup was not stored';
  end if;
  if advent_issue_signup_token(repeat('b', 64), request_at + interval '15 minutes', request_at + interval '1 second', pending) is not true then
    raise exception 'newer pending signup did not replace the old one';
  end if;
  if advent_issue_signup_token(repeat('c', 64), request_at + interval '15 minutes', request_at, pending) is not false then
    raise exception 'an older deferred signup replaced a newer one';
  end if;
  if advent_preview_token(repeat('a', 64), request_at) is not null then
    raise exception 'the old signup token can still be used';
  end if;

  preview := advent_preview_token(repeat('b', 64), real_confirm_at);
  if preview is distinct from '{
    "kind":"signup","email":"guest@example.test","handle":"draft-handle",
    "referral":"AB234567","marketing":true,"reminders":false
  }'::jsonb or exists (select 1 from advent_participants where email = 'guest@example.test') then
    raise exception 'signup preview wrote an account or returned the wrong details';
  end if;
  token := advent_consume_token(repeat('b', 64), real_confirm_at, start_at, 'CD234567', true, null, true);
  if token->>'status' is distinct from 'confirmation_required' then raise exception 'signup bypassed confirmation'; end if;
  token := advent_consume_token(repeat('b', 64), real_confirm_at, start_at, 'CD234567', true, confirmation, false);
  if token->>'status' is distinct from 'ok' or token->>'version' is distinct from '0' then
    raise exception 'signup confirmation failed';
  end if;
  signup := (token->>'id')::uuid;

  if not exists (select 1 from advent_participants where id = signup and handle = 'confirmed-handle'
    and not marketing_opt_in and marketing_consent_at is null and reminders_opt_in
    and reminders_consent_text_version = 'reminders-confirmed' and reminders_consent_at = real_confirm_at
    and rules_accepted_at = real_confirm_at and referred_by = referrer) then
    raise exception 'signup used initial values or rejected a same-time referral';
  end if;
  if (advent_consume_token(repeat('b', 64), real_confirm_at, start_at, 'CD234567', true, confirmation, false)->>'status')
    is distinct from 'invalid' then raise exception 'consumed link could be reused'; end if;

  insert into advent_login_tokens (token_hash, participant_id, expires_at)
    values (repeat('d', 64), signup, request_at + interval '15 minutes');
  preview := advent_preview_token(repeat('d', 64), real_confirm_at);
  if preview is distinct from '{"kind":"signin","handle":"confirmed-handle","maskedEmail":"g•••@example.test"}'::jsonb then
    raise exception 'sign-in preview omitted or exposed the wrong account details';
  end if;
  perform advent_sign_out(signup, 0);
  perform advent_sign_out(signup, 0);
  token := advent_consume_token(repeat('d', 64), real_confirm_at, start_at, 'CD234567', true, null, true);
  if token->>'version' is distinct from '1' then raise exception 'session version was not revoked exactly once'; end if;

  if advent_update_settings(signup, 'confirmed-handle', true, true, 'm1', null, 'r1') is not true then
    raise exception 'opt-in failed';
  end if;
  if advent_update_settings(signup, 'confirmed-handle', true, false, 'm2', false, 'r2') is not true then
    raise exception 'opt-out failed';
  end if;
  if not exists (select 1 from advent_participants where id = signup
      and not marketing_opt_in and marketing_consent_text_version = 'm1' and marketing_withdrawn_at >= marketing_consent_at
      and not reminders_opt_in and reminders_consent_text_version = 'reminders-confirmed'
      and reminders_consent_at = real_confirm_at and reminders_withdrawn_at >= reminders_consent_at) then
    raise exception 'withdrawal did not retain the last consent';
  end if;
  perform advent_update_settings(signup, 'confirmed-handle', true, true, 'm3', true, 'r3');
  perform advent_unsubscribe_reminders((select reminder_unsubscribe_id from advent_participants where id = signup));
  if not exists (select 1 from advent_participants where id = signup and marketing_withdrawn_at is null
    and marketing_consent_text_version = 'm3' and reminders_consent_text_version = 'r3'
    and not reminders_opt_in and reminders_withdrawn_at >= reminders_consent_at) then
    raise exception 'renewal or one-click unsubscribe failed';
  end if;

  insert into advent_answers (day, accepted_hashes) values (1, array[repeat('1',64)]), (2, array[repeat('2',64)]);
  if (advent_complete_door(signup, 1, start_at, true, repeat('1',64), null, false)->>'status') is distinct from 'done'
    or (advent_complete_door(signup, 2, start_at, false, null, null, false)->>'status') is distinct from 'ip_limited' then
    raise exception 'completion rejected a correct answer or ignored the IP budget';
  end if;
  for attempt in 1..10 loop
    outcome := advent_complete_door(signup, 2, start_at, false, null, null, true);
    if outcome->>'status' is distinct from 'wrong' or (outcome->>'remaining')::int is distinct from 10 - attempt then
      raise exception 'wrong-answer attempt % did not use the ten-attempt budget', attempt;
    end if;
  end loop;
  if (advent_complete_door(signup, 2, start_at, false, repeat('2',64), null, true)->>'status') is distinct from 'limited' then
    raise exception 'per-account limit did not block the eleventh attempt';
  end if;
  if (advent_complete_door(signup, 2, start_at + interval '1 hour', false, repeat('2',64), null, false)->>'status') is distinct from 'done' then
    raise exception 'rolling hour did not clear the per-account limit';
  end if;
  if not exists (select 1 from advent_completions c where c.participant_id = signup and c.day = 1 and c.on_time)
    or not exists (select 1 from advent_completions c where c.participant_id = signup and c.day = 2 and not c.on_time)
    or advent_referral_count(referrer) <> 1 then
    raise exception 'rolling attempt limit, on-time flags or referral count failed';
  end if;
  perform advent_complete_door(signup, 22, start_at, false, null, 'Fixture feedback.', false);
  insert into advent_reminder_sends (day, participant_id) values (7, signup);
  perform advent_issue_signup_token(repeat('f',64), request_at + interval '15 minutes', request_at,
    pending || '{"email":"expired-pending@example.test"}'::jsonb);
  if advent_daily_cleanup(greatest(start_at + interval '7 days', request_at + interval '15 minutes')) is distinct from '{"expiredTokens":3,"staleAttempts":10}'::jsonb then
    raise exception 'daily cleanup did not remove expired tokens and stale attempts';
  end if;
  insert into advent_login_tokens (token_hash, participant_id, expires_at)
    values (repeat('e',64), signup, grand_at);
  insert into advent_attempts (participant_id, day, at) values (signup, 3, start_at);
  delete from advent_participants where id = signup;
  if exists (select 1 from advent_login_tokens where participant_id = signup)
    or exists (select 1 from advent_attempts where participant_id = signup)
    or exists (select 1 from advent_completions where participant_id = signup)
    or exists (select 1 from advent_feedback where participant_id = signup)
    or exists (select 1 from advent_reminder_sends where participant_id = signup) then
    raise exception 'service-role account deletion did not cascade';
  end if;

  insert into advent_participants (email, handle, rules_version, rules_accepted_at, age_confirmed, ref_code)
    values ('earlier@example.test', 'earlier-winner', 'fixture', start_at, true, 'EF234567') returning id into earlier_winner;
  insert into advent_participants (email, handle, rules_version, rules_accepted_at, age_confirmed, ref_code)
    values ('replacement@example.test', 'replacement', 'fixture', start_at, true, 'GH234567') returning id into replacement;
  snapshot := jsonb_build_array(jsonb_build_object('id', earlier_winner, 'entries', 1));
  if advent_record_draw(jsonb_build_object(
    'kind', 'daily', 'day', 1, 'created_at', start_at, 'eligible_count', 1, 'eligible_list', snapshot,
    'eligible_list_sha256', repeat('a',64), 'random_bytes_hex', repeat('b',64),
    'winner_participant_ids', array[earlier_winner], 'created_by_email', runner_email
  )) is distinct from 'ok' then raise exception 'daily audit write failed'; end if;
  select jsonb_agg(jsonb_build_object('id', p.id, 'entries', 2) order by p.id) into snapshot
    from advent_participants p where p.id in (referrer, earlier_winner, replacement);
  if advent_record_draw(jsonb_build_object(
    'kind', 'grand', 'created_at', grand_at, 'eligible_count', 3, 'eligible_list', snapshot,
    'eligible_list_sha256', repeat('c',64), 'random_bytes_hex', repeat('d',64),
    'winner_participant_ids', array[referrer], 'created_by_email', runner_email
  )) is distinct from 'ok' then raise exception 'grand audit write failed'; end if;
  select id into grand_draw from advent_draws where kind = 'grand';
  if (advent_replacement_offer(grand_draw, 1, grand_at)->>'status') is distinct from 'occupied' then
    raise exception 'a current winner could be replaced';
  end if;
  delete from advent_participants where id = referrer;
  outcome := advent_replacement_offer(grand_draw, 1, grand_at);
  if outcome->>'status' is distinct from 'ok'
    or outcome->'eligible' is distinct from jsonb_build_array(jsonb_build_object('id', replacement, 'entries', 2)) then
    raise exception 'replacement included earlier winners or excluded a valid entrant';
  end if;
  replacement_record := jsonb_build_object(
    'kind', 'replacement', 'created_at', grand_at, 'eligible_count', 1, 'eligible_list', outcome->'eligible',
    'eligible_list_sha256', repeat('e',64), 'random_bytes_hex', repeat('f',64),
    'winner_participant_ids', array[replacement], 'created_by_email', runner_email,
    'original_draw_id', grand_draw, 'replaces_draw_id', grand_draw, 'prize_slot', 1
  );
  if advent_record_draw(replacement_record) is distinct from 'ok' then
    raise exception 'replacement write failed';
  end if;
  status := advent_record_draw(replacement_record);
  if status is distinct from 'occupied' or not exists (select 1 from advent_draws d where d.original_draw_id = grand_draw and d.prize_slot = 1) then
    raise exception 'replacement was not linked or could be repeated';
  end if;

  insert into advent_participants (email, handle, rules_version, rules_accepted_at, age_confirmed, ref_code)
    values ('non-winner@example.test', 'non-winner', 'fixture', start_at, true, 'JK234567');
  if advent_purge(grand_at) is not null then raise exception 'non-winner purge ran early'; end if;
  removed := advent_purge(grand_at + interval '2160 hours');
  if removed is distinct from 1 or (select count(*) from advent_participants) <> 2 then
    raise exception 'non-winner purge timing or winner protection failed';
  end if;
  if advent_purge_winners(grand_at + interval '2160 hours') is not null then
    raise exception 'winner purge ran without a fulfilment date';
  end if;
  if advent_set_prizes_fulfilled('2027-04-02') is not true then raise exception 'fulfilment date failed'; end if;
  if advent_purge_winners('2027-04-01 23:59:59+02') is not null then raise exception 'winner purge ran early'; end if;
  removed := advent_purge_winners('2027-04-02 00:00:00+02');
  if removed is distinct from 2 or exists (select 1 from advent_participants)
    or (select count(*) from advent_draws) <> 3 then
    raise exception 'winner purge timing, record deletion or audit preservation failed';
  end if;
end;
$$;
SQL
printf 'PASS: Advent migration and service-role assertions on %s\n' "$("${psql[@]}" -Atc 'show server_version')"
