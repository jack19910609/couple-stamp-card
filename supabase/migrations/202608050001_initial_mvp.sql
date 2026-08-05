-- Couple Stamp Card MVP
-- Auth, one-time pairing, shared cards, idempotent stamp events, RLS and Realtime.

create extension if not exists pgcrypto;
create schema if not exists private;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_length check (char_length(display_name) <= 40)
);

create table public.couple_spaces (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.couple_members (
  space_id uuid not null references public.couple_spaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (space_id, user_id),
  constraint one_couple_space_per_user unique (user_id)
);

create table public.pairing_invites (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.couple_spaces(id) on delete cascade,
  code text not null,
  created_by uuid not null references public.profiles(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  accepted_by uuid references public.profiles(id),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint pairing_code_format check (code ~ '^[0-9]{6}$')
);

create unique index pairing_invites_open_code_idx
  on public.pairing_invites (code)
  where used_at is null and revoked_at is null;
create index couple_members_user_idx on public.couple_members (user_id, space_id);
create index pairing_invites_space_idx on public.pairing_invites (space_id, created_at desc);

create table public.cards (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.couple_spaces(id) on delete cascade,
  created_by uuid not null references public.profiles(id),
  title text not null,
  action_label text not null,
  target_count integer not null,
  reward text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cards_title_length check (char_length(title) between 1 and 80),
  constraint cards_action_length check (char_length(action_label) between 1 and 100),
  constraint cards_reward_length check (char_length(reward) between 1 and 120),
  constraint cards_target_range check (target_count between 2 and 100),
  constraint cards_status check (status in ('active', 'archived'))
);

create table public.stamp_events (
  id uuid primary key,
  card_id uuid not null references public.cards(id) on delete cascade,
  space_id uuid not null references public.couple_spaces(id) on delete cascade,
  actor_id uuid not null references public.profiles(id),
  note text not null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references public.profiles(id),
  constraint stamp_note_length check (char_length(note) between 1 and 280),
  constraint stamp_undo_pair check (
    (undone_at is null and undone_by is null) or
    (undone_at is not null and undone_by is not null)
  )
);

create index cards_space_idx on public.cards (space_id, created_at desc);
create index stamp_events_card_idx on public.stamp_events (card_id, occurred_at desc);
create index stamp_events_space_idx on public.stamp_events (space_id, occurred_at desc);

create or replace function private.is_space_member(check_space_id uuid, check_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.couple_members
    where space_id = check_space_id and user_id = check_user_id
  );
$$;

create or replace function private.shares_space(other_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.couple_members mine
    join public.couple_members theirs on theirs.space_id = mine.space_id
    where mine.user_id = auth.uid() and theirs.user_id = other_user_id
  );
$$;

revoke all on function private.is_space_member(uuid, uuid) from public;
revoke all on function private.shares_space(uuid) from public;
grant execute on function private.is_space_member(uuid, uuid) to authenticated;
grant execute on function private.shares_space(uuid) to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Also cover projects that already had Auth users before this migration ran.
insert into public.profiles (id, display_name)
select id, coalesce(raw_user_meta_data ->> 'display_name', '')
from auth.users
on conflict (id) do nothing;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute procedure public.touch_updated_at();
create trigger cards_touch_updated_at
  before update on public.cards
  for each row execute procedure public.touch_updated_at();

alter table public.profiles enable row level security;
alter table public.couple_spaces enable row level security;
alter table public.couple_members enable row level security;
alter table public.pairing_invites enable row level security;
alter table public.cards enable row level security;
alter table public.stamp_events enable row level security;

create policy "profiles_read_self_or_partner"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select private.shares_space(id)));
create policy "profiles_update_self"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
create policy "profiles_insert_self"
  on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));

create policy "spaces_read_by_member"
  on public.couple_spaces for select to authenticated
  using ((select private.is_space_member(id)));

create policy "members_read_by_member"
  on public.couple_members for select to authenticated
  using ((select private.is_space_member(space_id)));

create policy "invites_read_by_member"
  on public.pairing_invites for select to authenticated
  using ((select private.is_space_member(space_id)));

create policy "cards_read_by_member"
  on public.cards for select to authenticated
  using ((select private.is_space_member(space_id)));
create policy "cards_insert_by_member"
  on public.cards for insert to authenticated
  with check (
    created_by = (select auth.uid()) and
    (select private.is_space_member(space_id))
  );
create policy "cards_update_by_member"
  on public.cards for update to authenticated
  using ((select private.is_space_member(space_id)))
  with check ((select private.is_space_member(space_id)));

create policy "stamps_read_by_member"
  on public.stamp_events for select to authenticated
  using ((select private.is_space_member(space_id)));

-- Pairing mutations are RPC-only so accepting a code cannot bypass expiry,
-- one-time use, the two-member limit, or the one-space-per-user invariant.
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
  where cm.user_id = current_user_id;

  if target_space_id is null then
    insert into public.couple_spaces (created_by)
    values (current_user_id)
    returning id into target_space_id;
    insert into public.couple_members (space_id, user_id)
    values (target_space_id, current_user_id);
  elsif (select count(*) from public.couple_members where space_id = target_space_id) >= 2 then
    raise exception 'This Couple Space is already paired';
  end if;

  update public.pairing_invites
  set revoked_at = now()
  where space_id = target_space_id and used_at is null and revoked_at is null;

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

create or replace function public.accept_pairing_invite(submitted_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_invite public.pairing_invites%rowtype;
  existing_space_id uuid;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;

  select cm.space_id into existing_space_id
  from public.couple_members cm
  where cm.user_id = current_user_id;
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
  if (select count(*) from public.couple_members where space_id = selected_invite.space_id) >= 2 then
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

-- The event UUID is generated on the client before queueing. Replaying the same
-- offline request returns the existing row instead of adding another stamp.
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
  if not private.is_space_member(selected_card.space_id, current_user_id) then raise exception 'Access denied'; end if;

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
revoke all on function public.accept_pairing_invite(text) from public;
revoke all on function public.create_stamp_event(uuid, uuid, text, timestamptz) from public;
revoke all on function public.undo_stamp_event(uuid, timestamptz) from public;
grant execute on function public.create_pairing_invite() to authenticated;
grant execute on function public.accept_pairing_invite(text) to authenticated;
grant execute on function public.create_stamp_event(uuid, uuid, text, timestamptz) to authenticated;
grant execute on function public.undo_stamp_event(uuid, timestamptz) to authenticated;

revoke all on public.profiles, public.couple_spaces, public.couple_members,
  public.pairing_invites, public.cards, public.stamp_events from anon;
grant select, insert, update on public.profiles to authenticated;
grant select on public.couple_spaces, public.couple_members, public.pairing_invites to authenticated;
grant select, insert, update on public.cards to authenticated;
grant select on public.stamp_events to authenticated;
grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter table public.stamp_events replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cards'
  ) then
    alter publication supabase_realtime add table public.cards;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stamp_events'
  ) then
    alter publication supabase_realtime add table public.stamp_events;
  end if;
end $$;
