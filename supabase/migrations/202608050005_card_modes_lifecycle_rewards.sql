-- Second milestone: mode-aware cards, immutable lifecycle audit, and a
-- two-person reward confirmation flow. Card mutations remain RPC-only.

alter table public.cards
  add column if not exists mode text not null default 'shared',
  add column if not exists participant_id uuid references public.profiles(id),
  add column if not exists winner_id uuid references public.profiles(id),
  add column if not exists completed_at timestamptz,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references public.profiles(id),
  add column if not exists reward_state text not null default 'locked',
  add column if not exists reward_requested_at timestamptz,
  add column if not exists reward_requested_by uuid references public.profiles(id),
  add column if not exists reward_redeemed_at timestamptz,
  add column if not exists reward_redeemed_by uuid references public.profiles(id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cards_mode_valid' and conrelid = 'public.cards'::regclass) then
    alter table public.cards add constraint cards_mode_valid check (mode in ('personal', 'shared', 'competition'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cards_mode_participant_valid' and conrelid = 'public.cards'::regclass) then
    alter table public.cards add constraint cards_mode_participant_valid check (
      (mode = 'personal' and participant_id is not null) or
      (mode in ('shared', 'competition') and participant_id is null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cards_reward_state_valid' and conrelid = 'public.cards'::regclass) then
    alter table public.cards add constraint cards_reward_state_valid check (reward_state in ('locked', 'ready', 'requested', 'redeemed'));
  end if;
end $$;

create index if not exists cards_active_space_idx on public.cards (space_id, created_at desc) where status = 'active';
create index if not exists cards_archived_space_idx on public.cards (space_id, archived_at desc) where status = 'archived';

create table if not exists public.card_activity_events (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards(id) on delete cascade,
  space_id uuid not null references public.couple_spaces(id) on delete cascade,
  actor_id uuid not null references public.profiles(id),
  kind text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint card_activity_kind_valid check (kind in (
    'created', 'rules_changed', 'completed', 'competition_won', 'reopened',
    'archived', 'copied', 'reward_requested', 'reward_redeemed'
  )),
  constraint card_activity_details_object check (jsonb_typeof(details) = 'object')
);

create index if not exists card_activity_card_idx on public.card_activity_events (card_id, created_at desc);
create index if not exists card_activity_space_idx on public.card_activity_events (space_id, created_at desc);
alter table public.card_activity_events enable row level security;

drop policy if exists "card_activity_read_by_member" on public.card_activity_events;
create policy "card_activity_read_by_member"
  on public.card_activity_events for select to authenticated
  using ((select private.is_space_member(space_id)));

revoke insert, update, delete on public.cards from authenticated;
revoke all on public.card_activity_events from anon, authenticated;
grant select on public.card_activity_events to authenticated;
grant all privileges on public.card_activity_events to service_role;

-- Existing MVP cards are shared cards. Preserve their history and expose
-- already-completed cards as ready for reward confirmation.
update public.cards c
set completed_at = coalesce((
      select max(se.occurred_at)
      from public.stamp_events se
      where se.card_id = c.id and se.undone_at is null
    ), c.updated_at),
    reward_state = 'ready'
where c.status = 'active'
  and c.completed_at is null
  and c.mode = 'shared'
  and (select count(*) from public.stamp_events se where se.card_id = c.id and se.undone_at is null) >= c.target_count;

create or replace function public.create_card(
  target_space_id uuid,
  card_mode text,
  card_participant_id uuid,
  card_title text,
  card_action_label text,
  card_target_count integer,
  card_reward text
)
returns public.cards
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  result public.cards%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if not private.is_active_space_member(target_space_id, current_user_id) then raise exception 'Access denied'; end if;
  if card_mode not in ('personal', 'shared', 'competition') then raise exception 'Card mode is invalid'; end if;
  if char_length(trim(card_title)) not between 1 and 80 then raise exception 'Card title is required'; end if;
  if char_length(trim(card_action_label)) not between 1 and 100 then raise exception 'Card action is required'; end if;
  if char_length(trim(card_reward)) not between 1 and 120 then raise exception 'Card reward is required'; end if;
  if card_target_count not between 2 and 100 then raise exception 'Card target must be between 2 and 100'; end if;

  if card_mode = 'personal' then
    if card_participant_id is null or not private.is_active_space_member(target_space_id, card_participant_id) then
      raise exception 'Personal card participant must belong to this Couple Space';
    end if;
  elsif card_participant_id is not null then
    raise exception 'Only personal cards can have one participant';
  end if;

  insert into public.cards (space_id, created_by, mode, participant_id, title, action_label, target_count, reward)
  values (target_space_id, current_user_id, card_mode, card_participant_id, trim(card_title), trim(card_action_label), card_target_count, trim(card_reward))
  returning * into result;

  insert into public.card_activity_events (card_id, space_id, actor_id, kind, details)
  values (result.id, result.space_id, current_user_id, 'created', jsonb_build_object(
    'mode', result.mode, 'participant_id', result.participant_id, 'target_count', result.target_count
  ));
  return result;
end;
$$;

create or replace function public.update_card_rules(
  target_card_id uuid,
  next_mode text,
  next_participant_id uuid,
  next_title text,
  next_action_label text,
  next_target_count integer,
  next_reward text,
  acknowledge_existing_progress boolean default false
)
returns public.cards
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_card public.cards%rowtype;
  result public.cards%rowtype;
  existing_progress boolean;
  achieved_count integer;
  completion_winner uuid;
  old_rules jsonb;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select * into selected_card from public.cards where id = target_card_id for update;
  if not found or selected_card.status <> 'active' then raise exception 'Card is not active'; end if;
  if not private.is_active_space_member(selected_card.space_id, current_user_id) then raise exception 'Access denied'; end if;
  if selected_card.reward_state in ('requested', 'redeemed') then raise exception 'Reward redemption is already in progress'; end if;
  if next_mode not in ('personal', 'shared', 'competition') then raise exception 'Card mode is invalid'; end if;
  if char_length(trim(next_title)) not between 1 and 80 then raise exception 'Card title is required'; end if;
  if char_length(trim(next_action_label)) not between 1 and 100 then raise exception 'Card action is required'; end if;
  if char_length(trim(next_reward)) not between 1 and 120 then raise exception 'Card reward is required'; end if;
  if next_target_count not between 2 and 100 then raise exception 'Card target must be between 2 and 100'; end if;
  if next_mode = 'personal' then
    if next_participant_id is null or not private.is_active_space_member(selected_card.space_id, next_participant_id) then
      raise exception 'Personal card participant must belong to this Couple Space';
    end if;
  elsif next_participant_id is not null then
    raise exception 'Only personal cards can have one participant';
  end if;

  select exists(select 1 from public.stamp_events where card_id = selected_card.id) into existing_progress;
  if existing_progress and not acknowledge_existing_progress then
    raise exception 'Existing progress requires confirmation';
  end if;

  old_rules := jsonb_build_object(
    'mode', selected_card.mode, 'participant_id', selected_card.participant_id,
    'title', selected_card.title, 'action_label', selected_card.action_label,
    'target_count', selected_card.target_count, 'reward', selected_card.reward
  );

  update public.cards
  set mode = next_mode,
      participant_id = next_participant_id,
      title = trim(next_title),
      action_label = trim(next_action_label),
      target_count = next_target_count,
      reward = trim(next_reward),
      completed_at = null,
      winner_id = null,
      reward_state = 'locked'
  where id = selected_card.id
  returning * into result;

  if result.mode = 'competition' then
    select ranked.actor_id into completion_winner
    from (
      select se.actor_id, se.occurred_at, se.id,
        row_number() over (partition by se.actor_id order by se.occurred_at, se.id) as actor_position
      from public.stamp_events se
      where se.card_id = result.id and se.undone_at is null
    ) ranked
    where ranked.actor_position = result.target_count
    order by ranked.occurred_at, ranked.id
    limit 1;
    if completion_winner is not null then
      update public.cards
      set completed_at = now(), winner_id = completion_winner, reward_state = 'ready'
      where id = result.id
      returning * into result;
    end if;
  else
    select count(*) into achieved_count
    from public.stamp_events se
    where se.card_id = result.id
      and se.undone_at is null
      and (result.mode = 'shared' or se.actor_id = result.participant_id);
    if achieved_count >= result.target_count then
      update public.cards
      set completed_at = now(), reward_state = 'ready'
      where id = result.id
      returning * into result;
    end if;
  end if;

  insert into public.card_activity_events (card_id, space_id, actor_id, kind, details)
  values (result.id, result.space_id, current_user_id, 'rules_changed', jsonb_build_object(
    'before', old_rules,
    'after', jsonb_build_object('mode', result.mode, 'participant_id', result.participant_id, 'title', result.title, 'action_label', result.action_label, 'target_count', result.target_count, 'reward', result.reward),
    'acknowledged_existing_progress', acknowledge_existing_progress
  ));
  if result.completed_at is not null then
    insert into public.card_activity_events (card_id, space_id, actor_id, kind, details)
    values (result.id, result.space_id, current_user_id,
      case when result.mode = 'competition' then 'competition_won' else 'completed' end,
      jsonb_build_object('winner_id', result.winner_id, 'reason', 'rules_changed'));
  end if;
  return result;
end;
$$;

create or replace function public.archive_card(target_card_id uuid)
returns public.cards
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  result public.cards%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select * into result from public.cards where id = target_card_id for update;
  if not found or result.status <> 'active' then raise exception 'Card is not active'; end if;
  if not private.is_active_space_member(result.space_id, current_user_id) then raise exception 'Access denied'; end if;
  update public.cards
  set status = 'archived', archived_at = now(), archived_by = current_user_id
  where id = result.id
  returning * into result;
  insert into public.card_activity_events (card_id, space_id, actor_id, kind)
  values (result.id, result.space_id, current_user_id, 'archived');
  return result;
end;
$$;

create or replace function public.copy_card(target_card_id uuid)
returns public.cards
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  source_card public.cards%rowtype;
  result public.cards%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select * into source_card from public.cards where id = target_card_id for update;
  if not found then raise exception 'Card not found'; end if;
  if not private.is_active_space_member(source_card.space_id, current_user_id) then raise exception 'Access denied'; end if;
  insert into public.cards (space_id, created_by, mode, participant_id, title, action_label, target_count, reward)
  values (source_card.space_id, current_user_id, source_card.mode, source_card.participant_id, source_card.title, source_card.action_label, source_card.target_count, source_card.reward)
  returning * into result;
  insert into public.card_activity_events (card_id, space_id, actor_id, kind, details)
  values (result.id, result.space_id, current_user_id, 'created', jsonb_build_object('copied_from', source_card.id));
  insert into public.card_activity_events (card_id, space_id, actor_id, kind, details)
  values (source_card.id, source_card.space_id, current_user_id, 'copied', jsonb_build_object('new_card_id', result.id));
  return result;
end;
$$;

create or replace function public.request_reward_redemption(target_card_id uuid)
returns public.cards
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  result public.cards%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select * into result from public.cards where id = target_card_id for update;
  if not found or result.status <> 'active' then raise exception 'Card is not active'; end if;
  if not private.is_active_space_member(result.space_id, current_user_id) then raise exception 'Access denied'; end if;
  if result.completed_at is null or result.reward_state <> 'ready' then raise exception 'Card reward is not ready'; end if;
  update public.cards
  set reward_state = 'requested', reward_requested_at = now(), reward_requested_by = current_user_id
  where id = result.id
  returning * into result;
  insert into public.card_activity_events (card_id, space_id, actor_id, kind)
  values (result.id, result.space_id, current_user_id, 'reward_requested');
  return result;
end;
$$;

create or replace function public.confirm_reward_redemption(target_card_id uuid)
returns public.cards
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  result public.cards%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select * into result from public.cards where id = target_card_id for update;
  if not found or result.status <> 'active' then raise exception 'Card is not active'; end if;
  if not private.is_active_space_member(result.space_id, current_user_id) then raise exception 'Access denied'; end if;
  if result.reward_state <> 'requested' then raise exception 'Reward redemption is not awaiting confirmation'; end if;
  if result.reward_requested_by = current_user_id then raise exception 'The other partner must confirm reward redemption'; end if;
  update public.cards
  set reward_state = 'redeemed', reward_redeemed_at = now(), reward_redeemed_by = current_user_id
  where id = result.id
  returning * into result;
  insert into public.card_activity_events (card_id, space_id, actor_id, kind)
  values (result.id, result.space_id, current_user_id, 'reward_redeemed');
  return result;
end;
$$;

create or replace function public.create_stamp_event(
  event_id uuid,
  target_card_id uuid,
  event_note text,
  event_occurred_at timestamptz
)
returns public.stamp_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_card public.cards%rowtype;
  result public.stamp_events%rowtype;
  active_count integer;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if char_length(trim(event_note)) not between 1 and 280 then raise exception 'A note between 1 and 280 characters is required'; end if;
  select * into selected_card from public.cards where id = target_card_id for update;
  if not found or selected_card.status <> 'active' then raise exception 'Card is not active'; end if;
  if not private.is_active_space_member(selected_card.space_id, current_user_id) then raise exception 'Access denied'; end if;
  select * into result from public.stamp_events where id = event_id;
  if found then
    if result.actor_id <> current_user_id or result.card_id <> target_card_id then raise exception 'Event ID already belongs to another action'; end if;
    return result;
  end if;
  if selected_card.completed_at is not null then raise exception 'Card is already complete'; end if;
  if selected_card.mode = 'personal' and selected_card.participant_id <> current_user_id then
    raise exception 'Only the assigned partner can stamp this personal card';
  end if;

  if selected_card.mode = 'competition' then
    select count(*) into active_count from public.stamp_events
    where card_id = selected_card.id and actor_id = current_user_id and undone_at is null;
  elsif selected_card.mode = 'personal' then
    select count(*) into active_count from public.stamp_events
    where card_id = selected_card.id and actor_id = selected_card.participant_id and undone_at is null;
  else
    select count(*) into active_count from public.stamp_events where card_id = selected_card.id and undone_at is null;
  end if;
  if active_count >= selected_card.target_count then raise exception 'Card is already complete'; end if;

  insert into public.stamp_events (id, card_id, space_id, actor_id, note, occurred_at)
  values (event_id, selected_card.id, selected_card.space_id, current_user_id, trim(event_note), least(coalesce(event_occurred_at, now()), now() + interval '1 minute'))
  returning * into result;

  if active_count + 1 >= selected_card.target_count then
    if selected_card.mode = 'competition' then
      update public.cards set completed_at = now(), winner_id = current_user_id, reward_state = 'ready' where id = selected_card.id;
      insert into public.card_activity_events (card_id, space_id, actor_id, kind, details)
      values (selected_card.id, selected_card.space_id, current_user_id, 'competition_won', jsonb_build_object('winner_id', current_user_id));
    else
      update public.cards set completed_at = now(), reward_state = 'ready' where id = selected_card.id;
      insert into public.card_activity_events (card_id, space_id, actor_id, kind)
      values (selected_card.id, selected_card.space_id, current_user_id, 'completed');
    end if;
  end if;
  return result;
end;
$$;

create or replace function public.undo_stamp_event(
  target_event_id uuid,
  undo_requested_at timestamptz default now()
)
returns public.stamp_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_event public.stamp_events%rowtype;
  selected_card public.cards%rowtype;
  active_count integer;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select * into selected_event from public.stamp_events where id = target_event_id for update;
  if not found then raise exception 'Stamp event not found'; end if;
  select * into selected_card from public.cards where id = selected_event.card_id for update;
  if selected_card.status <> 'active' or not private.is_active_space_member(selected_card.space_id, current_user_id) then raise exception 'Access denied'; end if;
  if selected_event.actor_id <> current_user_id then raise exception 'Only the actor can undo this stamp'; end if;
  if selected_event.undone_at is not null then return selected_event; end if;
  if selected_card.reward_state in ('requested', 'redeemed') then raise exception 'Cannot undo after reward redemption has been requested'; end if;
  undo_requested_at := least(coalesce(undo_requested_at, now()), now() + interval '1 minute');
  if undo_requested_at > selected_event.occurred_at + interval '10 minutes' then raise exception 'The undo window has expired'; end if;

  update public.stamp_events set undone_at = undo_requested_at, undone_by = current_user_id
  where id = target_event_id returning * into selected_event;

  if selected_card.mode = 'competition' then
    select count(*) into active_count from public.stamp_events
    where card_id = selected_card.id and actor_id = selected_card.winner_id and undone_at is null;
  elsif selected_card.mode = 'personal' then
    select count(*) into active_count from public.stamp_events
    where card_id = selected_card.id and actor_id = selected_card.participant_id and undone_at is null;
  else
    select count(*) into active_count from public.stamp_events where card_id = selected_card.id and undone_at is null;
  end if;
  if selected_card.completed_at is not null and active_count < selected_card.target_count then
    update public.cards set completed_at = null, winner_id = null, reward_state = 'locked' where id = selected_card.id;
    insert into public.card_activity_events (card_id, space_id, actor_id, kind)
    values (selected_card.id, selected_card.space_id, current_user_id, 'reopened');
  end if;
  return selected_event;
end;
$$;

create or replace function public.end_couple_space()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  target_space_id uuid;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select cm.space_id into target_space_id
  from public.couple_members cm join public.couple_spaces cs on cs.id = cm.space_id
  where cm.user_id = current_user_id and cm.departed_at is null and cs.status = 'active'
  for update of cm, cs;
  if target_space_id is null then raise exception 'No active Couple Space found'; end if;
  update public.pairing_invites set revoked_at = now()
  where space_id = target_space_id and used_at is null and revoked_at is null;
  with archived_cards as (
    update public.cards set status = 'archived', archived_at = now(), archived_by = current_user_id
    where space_id = target_space_id and status = 'active'
    returning id, space_id
  )
  insert into public.card_activity_events (card_id, space_id, actor_id, kind, details)
  select id, space_id, current_user_id, 'archived', jsonb_build_object('reason', 'couple_space_ended')
  from archived_cards;
  update public.couple_spaces set status = 'ended', ended_at = now(), ended_by = current_user_id, recoverable_until = now() + interval '30 days' where id = target_space_id;
  update public.couple_members set departed_at = now() where space_id = target_space_id and departed_at is null;
  return target_space_id;
end;
$$;

revoke all on function public.create_card(uuid, text, uuid, text, text, integer, text) from public;
revoke all on function public.update_card_rules(uuid, text, uuid, text, text, integer, text, boolean) from public;
revoke all on function public.archive_card(uuid) from public;
revoke all on function public.copy_card(uuid) from public;
revoke all on function public.request_reward_redemption(uuid) from public;
revoke all on function public.confirm_reward_redemption(uuid) from public;
revoke all on function public.create_stamp_event(uuid, uuid, text, timestamptz) from public;
revoke all on function public.undo_stamp_event(uuid, timestamptz) from public;
revoke all on function public.end_couple_space() from public;
grant execute on function public.create_card(uuid, text, uuid, text, text, integer, text) to authenticated;
grant execute on function public.update_card_rules(uuid, text, uuid, text, text, integer, text, boolean) to authenticated;
grant execute on function public.archive_card(uuid) to authenticated;
grant execute on function public.copy_card(uuid) to authenticated;
grant execute on function public.request_reward_redemption(uuid) to authenticated;
grant execute on function public.confirm_reward_redemption(uuid) to authenticated;
grant execute on function public.create_stamp_event(uuid, uuid, text, timestamptz) to authenticated;
grant execute on function public.undo_stamp_event(uuid, timestamptz) to authenticated;
grant execute on function public.end_couple_space() to authenticated;

alter table public.cards replica identity full;
alter table public.card_activity_events replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'card_activity_events'
  ) then
    alter publication supabase_realtime add table public.card_activity_events;
  end if;
end $$;
