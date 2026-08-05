-- Third milestone: reactions, comments, and recipient-private in-app notifications.
-- Writes remain RPC-only so archived memories are always read-only.

create table if not exists public.stamp_comments (
  id uuid primary key,
  event_id uuid not null references public.stamp_events(id) on delete cascade,
  card_id uuid not null references public.cards(id) on delete cascade,
  space_id uuid not null references public.couple_spaces(id) on delete cascade,
  author_id uuid not null references public.profiles(id),
  body text not null,
  created_at timestamptz not null default now(),
  constraint stamp_comments_body_length check (char_length(body) between 1 and 300)
);

create table if not exists public.stamp_reactions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.stamp_events(id) on delete cascade,
  card_id uuid not null references public.cards(id) on delete cascade,
  space_id uuid not null references public.couple_spaces(id) on delete cascade,
  actor_id uuid not null references public.profiles(id),
  emoji text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stamp_reactions_one_per_person unique (event_id, actor_id),
  constraint stamp_reactions_emoji_valid check (emoji in ('❤️', '👏', '🥰', '💪'))
);

create table if not exists public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id),
  actor_id uuid not null references public.profiles(id),
  space_id uuid not null references public.couple_spaces(id) on delete cascade,
  card_id uuid references public.cards(id) on delete set null,
  stamp_event_id uuid references public.stamp_events(id) on delete set null,
  kind text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint user_notifications_kind_valid check (kind in (
    'card_created', 'stamp_created', 'card_completed',
    'comment_created', 'reaction_created',
    'reward_requested', 'reward_redeemed'
  )),
  constraint user_notifications_data_object check (jsonb_typeof(data) = 'object')
);

create index if not exists stamp_comments_event_idx on public.stamp_comments (event_id, created_at);
create index if not exists stamp_comments_space_idx on public.stamp_comments (space_id, created_at desc);
create index if not exists stamp_reactions_event_idx on public.stamp_reactions (event_id, updated_at);
create index if not exists stamp_reactions_space_idx on public.stamp_reactions (space_id, updated_at desc);
create index if not exists user_notifications_recipient_idx on public.user_notifications (recipient_id, read_at, created_at desc);
create index if not exists user_notifications_space_idx on public.user_notifications (space_id, created_at desc);

alter table public.stamp_comments enable row level security;
alter table public.stamp_reactions enable row level security;
alter table public.user_notifications enable row level security;

drop policy if exists "stamp_comments_read_by_member" on public.stamp_comments;
create policy "stamp_comments_read_by_member"
  on public.stamp_comments for select to authenticated
  using ((select private.is_space_member(space_id)));

drop policy if exists "stamp_reactions_read_by_member" on public.stamp_reactions;
create policy "stamp_reactions_read_by_member"
  on public.stamp_reactions for select to authenticated
  using ((select private.is_space_member(space_id)));

drop policy if exists "notifications_read_by_recipient" on public.user_notifications;
create policy "notifications_read_by_recipient"
  on public.user_notifications for select to authenticated
  using (recipient_id = (select auth.uid()));

revoke all on public.stamp_comments, public.stamp_reactions, public.user_notifications from anon, authenticated;
grant select on public.stamp_comments, public.stamp_reactions, public.user_notifications to authenticated;
grant all privileges on public.stamp_comments, public.stamp_reactions, public.user_notifications to service_role;

create or replace function private.notify_other_active_member(
  target_space_id uuid,
  action_actor_id uuid,
  notification_kind text,
  target_card_id uuid default null,
  target_stamp_event_id uuid default null,
  notification_data jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.user_notifications (recipient_id, actor_id, space_id, card_id, stamp_event_id, kind, data)
  select cm.user_id, action_actor_id, target_space_id, target_card_id, target_stamp_event_id,
    notification_kind, coalesce(notification_data, '{}'::jsonb)
  from public.couple_members cm
  join public.couple_spaces cs on cs.id = cm.space_id
  where cm.space_id = target_space_id
    and cm.departed_at is null
    and cs.status = 'active'
    and cm.user_id <> action_actor_id;
$$;

revoke all on function private.notify_other_active_member(uuid, uuid, text, uuid, uuid, jsonb) from public;

create or replace function public.create_stamp_comment(
  comment_id uuid,
  target_event_id uuid,
  comment_body text
)
returns public.stamp_comments
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_event public.stamp_events%rowtype;
  selected_card public.cards%rowtype;
  result public.stamp_comments%rowtype;
  normalized_body text := trim(comment_body);
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if char_length(normalized_body) not between 1 and 300 then raise exception 'A comment between 1 and 300 characters is required'; end if;
  select * into result from public.stamp_comments where id = comment_id;
  if found then
    if result.author_id <> current_user_id or result.event_id <> target_event_id or result.body <> normalized_body then
      raise exception 'Comment ID already belongs to another action';
    end if;
    return result;
  end if;
  select * into selected_event from public.stamp_events where id = target_event_id for update;
  if not found then raise exception 'Stamp event not found'; end if;
  select * into selected_card from public.cards where id = selected_event.card_id for update;
  if selected_card.status <> 'active' or not private.is_active_space_member(selected_card.space_id, current_user_id) then
    raise exception 'Card is not active';
  end if;
  insert into public.stamp_comments (id, event_id, card_id, space_id, author_id, body)
  values (comment_id, selected_event.id, selected_card.id, selected_card.space_id, current_user_id, normalized_body)
  returning * into result;
  perform private.notify_other_active_member(
    selected_card.space_id, current_user_id, 'comment_created', selected_card.id, selected_event.id,
    jsonb_build_object('comment_id', result.id, 'body', result.body)
  );
  return result;
end;
$$;

create or replace function public.set_stamp_reaction(
  target_event_id uuid,
  next_emoji text default null
)
returns public.stamp_reactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_event public.stamp_events%rowtype;
  selected_card public.cards%rowtype;
  result public.stamp_reactions%rowtype;
  normalized_emoji text := nullif(trim(next_emoji), '');
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if normalized_emoji is not null and normalized_emoji not in ('❤️', '👏', '🥰', '💪') then
    raise exception 'Reaction is not supported';
  end if;
  select * into selected_event from public.stamp_events where id = target_event_id for update;
  if not found then raise exception 'Stamp event not found'; end if;
  select * into selected_card from public.cards where id = selected_event.card_id for update;
  if selected_card.status <> 'active' or not private.is_active_space_member(selected_card.space_id, current_user_id) then
    raise exception 'Card is not active';
  end if;
  select * into result from public.stamp_reactions
  where event_id = selected_event.id and actor_id = current_user_id for update;
  if normalized_emoji is null then
    if found then delete from public.stamp_reactions where id = result.id; end if;
    return null;
  end if;
  if found and result.emoji = normalized_emoji then return result; end if;
  if found then
    update public.stamp_reactions set emoji = normalized_emoji, updated_at = now()
    where id = result.id returning * into result;
  else
    insert into public.stamp_reactions (event_id, card_id, space_id, actor_id, emoji)
    values (selected_event.id, selected_card.id, selected_card.space_id, current_user_id, normalized_emoji)
    returning * into result;
  end if;
  perform private.notify_other_active_member(
    selected_card.space_id, current_user_id, 'reaction_created', selected_card.id, selected_event.id,
    jsonb_build_object('reaction_id', result.id, 'emoji', result.emoji)
  );
  return result;
end;
$$;

create or replace function public.mark_notification_read(target_notification_id uuid)
returns public.user_notifications
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  result public.user_notifications%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  update public.user_notifications set read_at = coalesce(read_at, now())
  where id = target_notification_id and recipient_id = current_user_id
  returning * into result;
  if not found then raise exception 'Notification not found'; end if;
  return result;
end;
$$;

create or replace function public.mark_all_notifications_read(target_space_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  updated_count integer;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  update public.user_notifications set read_at = now()
  where recipient_id = current_user_id and space_id = target_space_id and read_at is null;
  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

-- Existing card and stamp RPCs are redefined only to emit recipient-private
-- notifications. Their validations and lifecycle semantics remain unchanged.
create or replace function public.create_card(
  target_space_id uuid, card_mode text, card_participant_id uuid, card_title text,
  card_action_label text, card_target_count integer, card_reward text
)
returns public.cards
language plpgsql security definer set search_path = ''
as $$
declare current_user_id uuid := auth.uid(); result public.cards%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if not private.is_active_space_member(target_space_id, current_user_id) then raise exception 'Access denied'; end if;
  if card_mode not in ('personal', 'shared', 'competition') then raise exception 'Card mode is invalid'; end if;
  if char_length(trim(card_title)) not between 1 and 80 then raise exception 'Card title is required'; end if;
  if char_length(trim(card_action_label)) not between 1 and 100 then raise exception 'Card action is required'; end if;
  if char_length(trim(card_reward)) not between 1 and 120 then raise exception 'Card reward is required'; end if;
  if card_target_count not between 2 and 100 then raise exception 'Card target must be between 2 and 100'; end if;
  if card_mode = 'personal' then
    if card_participant_id is null or not private.is_active_space_member(target_space_id, card_participant_id) then raise exception 'Personal card participant must belong to this Couple Space'; end if;
  elsif card_participant_id is not null then raise exception 'Only personal cards can have one participant'; end if;
  insert into public.cards (space_id, created_by, mode, participant_id, title, action_label, target_count, reward)
  values (target_space_id, current_user_id, card_mode, card_participant_id, trim(card_title), trim(card_action_label), card_target_count, trim(card_reward)) returning * into result;
  insert into public.card_activity_events (card_id, space_id, actor_id, kind, details)
  values (result.id, result.space_id, current_user_id, 'created', jsonb_build_object('mode', result.mode, 'participant_id', result.participant_id, 'target_count', result.target_count));
  perform private.notify_other_active_member(result.space_id, current_user_id, 'card_created', result.id, null, jsonb_build_object('title', result.title, 'mode', result.mode));
  return result;
end;
$$;

create or replace function public.copy_card(target_card_id uuid)
returns public.cards
language plpgsql security definer set search_path = ''
as $$
declare current_user_id uuid := auth.uid(); source_card public.cards%rowtype; result public.cards%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select * into source_card from public.cards where id = target_card_id for update;
  if not found then raise exception 'Card not found'; end if;
  if not private.is_active_space_member(source_card.space_id, current_user_id) then raise exception 'Access denied'; end if;
  insert into public.cards (space_id, created_by, mode, participant_id, title, action_label, target_count, reward)
  values (source_card.space_id, current_user_id, source_card.mode, source_card.participant_id, source_card.title, source_card.action_label, source_card.target_count, source_card.reward) returning * into result;
  insert into public.card_activity_events (card_id, space_id, actor_id, kind, details) values (result.id, result.space_id, current_user_id, 'created', jsonb_build_object('copied_from', source_card.id));
  insert into public.card_activity_events (card_id, space_id, actor_id, kind, details) values (source_card.id, source_card.space_id, current_user_id, 'copied', jsonb_build_object('new_card_id', result.id));
  perform private.notify_other_active_member(result.space_id, current_user_id, 'card_created', result.id, null, jsonb_build_object('title', result.title, 'copied', true));
  return result;
end;
$$;

create or replace function public.request_reward_redemption(target_card_id uuid)
returns public.cards
language plpgsql security definer set search_path = ''
as $$
declare current_user_id uuid := auth.uid(); result public.cards%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select * into result from public.cards where id = target_card_id for update;
  if not found or result.status <> 'active' then raise exception 'Card is not active'; end if;
  if not private.is_active_space_member(result.space_id, current_user_id) then raise exception 'Access denied'; end if;
  if result.completed_at is null or result.reward_state <> 'ready' then raise exception 'Card reward is not ready'; end if;
  update public.cards set reward_state = 'requested', reward_requested_at = now(), reward_requested_by = current_user_id where id = result.id returning * into result;
  insert into public.card_activity_events (card_id, space_id, actor_id, kind) values (result.id, result.space_id, current_user_id, 'reward_requested');
  perform private.notify_other_active_member(result.space_id, current_user_id, 'reward_requested', result.id, null, jsonb_build_object('title', result.title));
  return result;
end;
$$;

create or replace function public.confirm_reward_redemption(target_card_id uuid)
returns public.cards
language plpgsql security definer set search_path = ''
as $$
declare current_user_id uuid := auth.uid(); result public.cards%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select * into result from public.cards where id = target_card_id for update;
  if not found or result.status <> 'active' then raise exception 'Card is not active'; end if;
  if not private.is_active_space_member(result.space_id, current_user_id) then raise exception 'Access denied'; end if;
  if result.reward_state <> 'requested' then raise exception 'Reward redemption is not awaiting confirmation'; end if;
  if result.reward_requested_by = current_user_id then raise exception 'The other partner must confirm reward redemption'; end if;
  update public.cards set reward_state = 'redeemed', reward_redeemed_at = now(), reward_redeemed_by = current_user_id where id = result.id returning * into result;
  insert into public.card_activity_events (card_id, space_id, actor_id, kind) values (result.id, result.space_id, current_user_id, 'reward_redeemed');
  perform private.notify_other_active_member(result.space_id, current_user_id, 'reward_redeemed', result.id, null, jsonb_build_object('title', result.title));
  return result;
end;
$$;

create or replace function public.create_stamp_event(event_id uuid, target_card_id uuid, event_note text, event_occurred_at timestamptz)
returns public.stamp_events
language plpgsql security definer set search_path = ''
as $$
declare current_user_id uuid := auth.uid(); selected_card public.cards%rowtype; result public.stamp_events%rowtype; active_count integer; completed_now boolean := false;
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
  if selected_card.mode = 'personal' and selected_card.participant_id <> current_user_id then raise exception 'Only the assigned partner can stamp this personal card'; end if;
  if selected_card.mode = 'competition' then
    select count(*) into active_count from public.stamp_events where card_id = selected_card.id and actor_id = current_user_id and undone_at is null;
  elsif selected_card.mode = 'personal' then
    select count(*) into active_count from public.stamp_events where card_id = selected_card.id and actor_id = selected_card.participant_id and undone_at is null;
  else
    select count(*) into active_count from public.stamp_events where card_id = selected_card.id and undone_at is null;
  end if;
  if active_count >= selected_card.target_count then raise exception 'Card is already complete'; end if;
  insert into public.stamp_events (id, card_id, space_id, actor_id, note, occurred_at)
  values (event_id, selected_card.id, selected_card.space_id, current_user_id, trim(event_note), least(coalesce(event_occurred_at, now()), now() + interval '1 minute')) returning * into result;
  perform private.notify_other_active_member(selected_card.space_id, current_user_id, 'stamp_created', selected_card.id, result.id, jsonb_build_object('title', selected_card.title, 'note', result.note));
  if active_count + 1 >= selected_card.target_count then
    completed_now := true;
    if selected_card.mode = 'competition' then
      update public.cards set completed_at = now(), winner_id = current_user_id, reward_state = 'ready' where id = selected_card.id;
      insert into public.card_activity_events (card_id, space_id, actor_id, kind, details) values (selected_card.id, selected_card.space_id, current_user_id, 'competition_won', jsonb_build_object('winner_id', current_user_id));
    else
      update public.cards set completed_at = now(), reward_state = 'ready' where id = selected_card.id;
      insert into public.card_activity_events (card_id, space_id, actor_id, kind) values (selected_card.id, selected_card.space_id, current_user_id, 'completed');
    end if;
  end if;
  if completed_now then perform private.notify_other_active_member(selected_card.space_id, current_user_id, 'card_completed', selected_card.id, result.id, jsonb_build_object('title', selected_card.title)); end if;
  return result;
end;
$$;

revoke all on function public.create_stamp_comment(uuid, uuid, text) from public;
revoke all on function public.set_stamp_reaction(uuid, text) from public;
revoke all on function public.mark_notification_read(uuid) from public;
revoke all on function public.mark_all_notifications_read(uuid) from public;
grant execute on function public.create_stamp_comment(uuid, uuid, text) to authenticated;
grant execute on function public.set_stamp_reaction(uuid, text) to authenticated;
grant execute on function public.mark_notification_read(uuid) to authenticated;
grant execute on function public.mark_all_notifications_read(uuid) to authenticated;

alter table public.stamp_comments replica identity full;
alter table public.stamp_reactions replica identity full;
alter table public.user_notifications replica identity full;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stamp_comments') then alter publication supabase_realtime add table public.stamp_comments; end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stamp_reactions') then alter publication supabase_realtime add table public.stamp_reactions; end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'user_notifications') then alter publication supabase_realtime add table public.user_notifications; end if;
end $$;
