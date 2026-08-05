-- Ending a Couple Space is an archive operation, not a destructive delete.
-- The original two members retain read-only access to their memories. They may
-- reconnect within 30 days; a reconnection creates a fresh active space so old
-- cards can never be exposed to a later partner.

alter table public.couple_spaces
  add column if not exists status text not null default 'active',
  add column if not exists ended_at timestamptz,
  add column if not exists ended_by uuid references public.profiles(id),
  add column if not exists recoverable_until timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'couple_spaces_status' and conrelid = 'public.couple_spaces'::regclass
  ) then
    alter table public.couple_spaces
      add constraint couple_spaces_status check (status in ('active', 'ended'));
  end if;
end $$;

alter table public.couple_members
  add column if not exists departed_at timestamptz;

alter table public.pairing_invites
  add column if not exists is_recovery boolean not null default false;

alter table public.couple_members
  drop constraint if exists one_couple_space_per_user;

create unique index if not exists couple_members_one_active_space_idx
  on public.couple_members (user_id)
  where departed_at is null;

create index if not exists couple_members_archive_idx
  on public.couple_members (user_id, departed_at desc)
  where departed_at is not null;
create index if not exists couple_spaces_ended_idx
  on public.couple_spaces (ended_at desc)
  where status = 'ended';

-- Historical membership permits read-only memory access; active membership is
-- required for all new cards, stamps, and undo operations.
create or replace function private.is_active_space_member(check_space_id uuid, check_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.couple_members cm
    join public.couple_spaces cs on cs.id = cm.space_id
    where cm.space_id = check_space_id
      and cm.user_id = check_user_id
      and cm.departed_at is null
      and cs.status = 'active'
  );
$$;

revoke all on function private.is_active_space_member(uuid, uuid) from public;
grant execute on function private.is_active_space_member(uuid, uuid) to authenticated;

drop policy if exists "cards_insert_by_member" on public.cards;
drop policy if exists "cards_insert_by_active_member" on public.cards;
create policy "cards_insert_by_active_member"
  on public.cards for insert to authenticated
  with check (
    created_by = (select auth.uid()) and
    (select private.is_active_space_member(space_id))
  );

drop policy if exists "cards_update_by_member" on public.cards;
drop policy if exists "cards_update_by_active_member" on public.cards;
create policy "cards_update_by_active_member"
  on public.cards for update to authenticated
  using ((select private.is_active_space_member(space_id)))
  with check ((select private.is_active_space_member(space_id)));

create or replace function public.create_pairing_invite()
returns table (invite_id uuid, invite_code text, invite_expires_at timestamptz, invite_space_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  target_space_id uuid;
  generated_code text;
  created_invite_id uuid;
  created_expiry timestamptz := now() + interval '24 hours';
  attempts integer := 0;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;

  select cm.space_id into target_space_id
  from public.couple_members cm
  join public.couple_spaces cs on cs.id = cm.space_id
  where cm.user_id = current_user_id
    and cm.departed_at is null
    and cs.status = 'active';

  if target_space_id is null then
    insert into public.couple_spaces (created_by)
    values (current_user_id)
    returning id into target_space_id;
    insert into public.couple_members (space_id, user_id)
    values (target_space_id, current_user_id);
  elsif (select count(*) from public.couple_members where space_id = target_space_id and departed_at is null) >= 2 then
    raise exception 'This Couple Space is already paired';
  end if;

  update public.pairing_invites
  set revoked_at = now()
  where space_id = target_space_id
    and used_at is null
    and revoked_at is null
    and is_recovery = false;

  loop
    attempts := attempts + 1;
    generated_code := lpad(floor(random() * 1000000)::integer::text, 6, '0');
    exit when not exists (
      select 1 from public.pairing_invites
      where code = generated_code and used_at is null and revoked_at is null
    );
    if attempts >= 20 then raise exception 'Unable to generate a pairing code'; end if;
  end loop;

  insert into public.pairing_invites (space_id, code, created_by, expires_at)
  values (target_space_id, generated_code, current_user_id, created_expiry)
  returning id into created_invite_id;

  return query select created_invite_id, generated_code, created_expiry, target_space_id;
end;
$$;

create or replace function public.create_recovery_invite(target_archived_space_id uuid)
returns table (invite_id uuid, invite_code text, invite_expires_at timestamptz, invite_space_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  archived_space public.couple_spaces%rowtype;
  generated_code text;
  created_invite_id uuid;
  created_expiry timestamptz;
  attempts integer := 0;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;

  select * into archived_space
  from public.couple_spaces
  where id = target_archived_space_id
  for update;
  if not found or archived_space.status <> 'ended' then
    raise exception 'This Couple Space is not archived';
  end if;
  if archived_space.recoverable_until is null or archived_space.recoverable_until <= now() then
    raise exception 'The recovery period has ended';
  end if;
  if not private.is_space_member(target_archived_space_id, current_user_id) then
    raise exception 'Access denied';
  end if;
  created_expiry := least(now() + interval '24 hours', archived_space.recoverable_until);
  if exists (
    select 1
    from public.couple_members active_members
    join public.couple_members archived_members on archived_members.user_id = active_members.user_id
    where archived_members.space_id = target_archived_space_id
      and active_members.departed_at is null
  ) then
    raise exception 'Both people must be unpaired before reconnecting';
  end if;

  update public.pairing_invites
  set revoked_at = now()
  where space_id = target_archived_space_id
    and is_recovery = true
    and used_at is null
    and revoked_at is null;

  loop
    attempts := attempts + 1;
    generated_code := lpad(floor(random() * 1000000)::integer::text, 6, '0');
    exit when not exists (
      select 1 from public.pairing_invites
      where code = generated_code and used_at is null and revoked_at is null
    );
    if attempts >= 20 then raise exception 'Unable to generate a pairing code'; end if;
  end loop;

  insert into public.pairing_invites (space_id, code, created_by, expires_at, is_recovery)
  values (target_archived_space_id, generated_code, current_user_id, created_expiry, true)
  returning id into created_invite_id;

  return query select created_invite_id, generated_code, created_expiry, target_archived_space_id;
end;
$$;

create or replace function public.accept_pairing_invite(submitted_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_invite public.pairing_invites%rowtype;
  selected_space public.couple_spaces%rowtype;
  existing_space_id uuid;
  new_space_id uuid;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;

  select cm.space_id into existing_space_id
  from public.couple_members cm
  join public.couple_spaces cs on cs.id = cm.space_id
  where cm.user_id = current_user_id
    and cm.departed_at is null
    and cs.status = 'active';
  if existing_space_id is not null then
    raise exception 'You already belong to a Couple Space';
  end if;

  select * into selected_invite
  from public.pairing_invites
  where code = trim(submitted_code)
    and used_at is null
    and revoked_at is null
    and expires_at > now()
  for update;
  if not found then raise exception 'Pairing code is invalid or expired'; end if;
  if selected_invite.created_by = current_user_id then
    raise exception 'You cannot accept your own pairing code';
  end if;

  select * into selected_space
  from public.couple_spaces
  where id = selected_invite.space_id
  for update;

  if selected_invite.is_recovery then
    if selected_space.status <> 'ended'
      or selected_space.recoverable_until is null
      or selected_space.recoverable_until <= now() then
      raise exception 'The recovery period has ended';
    end if;
    if not private.is_space_member(selected_invite.space_id, current_user_id) then
      raise exception 'Recovery is only available to the original two people';
    end if;
    if exists (
      select 1
      from public.couple_members active_members
      join public.couple_members archived_members on archived_members.user_id = active_members.user_id
      where archived_members.space_id = selected_invite.space_id
        and active_members.departed_at is null
    ) then
      raise exception 'Both people must be unpaired before reconnecting';
    end if;

    insert into public.couple_spaces (created_by)
    values (selected_invite.created_by)
    returning id into new_space_id;
    insert into public.couple_members (space_id, user_id)
    values (new_space_id, selected_invite.created_by), (new_space_id, current_user_id);

    update public.pairing_invites
    set used_at = now(), accepted_by = current_user_id
    where id = selected_invite.id;
    return new_space_id;
  end if;

  if selected_space.status <> 'active' then
    raise exception 'Pairing code is invalid or expired';
  end if;
  if (select count(*) from public.couple_members where space_id = selected_invite.space_id and departed_at is null) >= 2 then
    raise exception 'This Couple Space is already paired';
  end if;

  insert into public.couple_members (space_id, user_id)
  values (selected_invite.space_id, current_user_id);
  update public.pairing_invites
  set used_at = now(), accepted_by = current_user_id
  where id = selected_invite.id;

  return selected_invite.space_id;
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
  from public.couple_members cm
  join public.couple_spaces cs on cs.id = cm.space_id
  where cm.user_id = current_user_id
    and cm.departed_at is null
    and cs.status = 'active'
  for update of cm, cs;
  if target_space_id is null then raise exception 'No active Couple Space found'; end if;

  update public.pairing_invites
  set revoked_at = now()
  where space_id = target_space_id and used_at is null and revoked_at is null;
  update public.cards
  set status = 'archived'
  where space_id = target_space_id and status = 'active';
  update public.couple_spaces
  set status = 'ended',
      ended_at = now(),
      ended_by = current_user_id,
      recoverable_until = now() + interval '30 days'
  where id = target_space_id;
  update public.couple_members
  set departed_at = now()
  where space_id = target_space_id and departed_at is null;

  return target_space_id;
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
  if char_length(trim(event_note)) not between 1 and 280 then
    raise exception 'A note between 1 and 280 characters is required';
  end if;

  select * into selected_card from public.cards
  where id = target_card_id
  for update;
  if not found or selected_card.status <> 'active' then raise exception 'Card is not active'; end if;
  if not private.is_active_space_member(selected_card.space_id, current_user_id) then raise exception 'Access denied'; end if;

  select * into result from public.stamp_events where id = event_id;
  if found then
    if result.actor_id <> current_user_id or result.card_id <> target_card_id then
      raise exception 'Event ID already belongs to another action';
    end if;
    return result;
  end if;

  select count(*) into active_count
  from public.stamp_events
  where card_id = selected_card.id and undone_at is null;
  if active_count >= selected_card.target_count then raise exception 'Card is already complete'; end if;

  insert into public.stamp_events (id, card_id, space_id, actor_id, note, occurred_at)
  values (
    event_id,
    selected_card.id,
    selected_card.space_id,
    current_user_id,
    trim(event_note),
    least(coalesce(event_occurred_at, now()), now() + interval '1 minute')
  )
  returning * into result;
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
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select * into selected_event from public.stamp_events where id = target_event_id for update;
  if not found then raise exception 'Stamp event not found'; end if;
  if not private.is_active_space_member(selected_event.space_id, current_user_id) then raise exception 'Access denied'; end if;
  if selected_event.actor_id <> current_user_id then raise exception 'Only the actor can undo this stamp'; end if;
  if selected_event.undone_at is not null then return selected_event; end if;
  undo_requested_at := least(coalesce(undo_requested_at, now()), now() + interval '1 minute');
  if undo_requested_at > selected_event.occurred_at + interval '10 minutes' then
    raise exception 'The undo window has expired';
  end if;

  update public.stamp_events
  set undone_at = undo_requested_at, undone_by = current_user_id
  where id = target_event_id
  returning * into selected_event;
  return selected_event;
end;
$$;

revoke all on function public.create_pairing_invite() from public;
revoke all on function public.create_recovery_invite(uuid) from public;
revoke all on function public.accept_pairing_invite(text) from public;
revoke all on function public.end_couple_space() from public;
revoke all on function public.create_stamp_event(uuid, uuid, text, timestamptz) from public;
revoke all on function public.undo_stamp_event(uuid, timestamptz) from public;
grant execute on function public.create_pairing_invite() to authenticated;
grant execute on function public.create_recovery_invite(uuid) to authenticated;
grant execute on function public.accept_pairing_invite(text) to authenticated;
grant execute on function public.end_couple_space() to authenticated;
grant execute on function public.create_stamp_event(uuid, uuid, text, timestamptz) to authenticated;
grant execute on function public.undo_stamp_event(uuid, timestamptz) to authenticated;

alter table public.couple_members replica identity full;
