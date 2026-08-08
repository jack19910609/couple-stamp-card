-- Re-check the lifecycle state after locking the space. Migration 011 already
-- protects the normal path; this closes the narrow race with any lifecycle
-- change made between its initial membership lookup and the row lock.

create or replace function public.cancel_pending_pairing()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  target_space_id uuid;
  space_owner_id uuid;
  space_status text;
  active_member_count integer;
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  select cm.space_id into target_space_id
  from public.couple_members cm
  join public.couple_spaces cs on cs.id = cm.space_id
  where cm.user_id = current_user_id
    and cm.departed_at is null
    and cs.status = 'active';

  if target_space_id is null then
    raise exception 'No pending pairing invite found';
  end if;

  -- Match the lock order in accept_pairing_invite: invitation, then space.
  perform 1
  from public.pairing_invites
  where space_id = target_space_id
    and used_at is null
    and revoked_at is null
    and is_recovery = false
  for update;

  select cs.created_by, cs.status into space_owner_id, space_status
  from public.couple_spaces cs
  where cs.id = target_space_id
  for update;

  if not found or space_status <> 'active' or space_owner_id <> current_user_id then
    raise exception 'Pending pairing invite cannot be cancelled';
  end if;

  select count(*) into active_member_count
  from public.couple_members cm
  where cm.space_id = target_space_id
    and cm.departed_at is null;

  if active_member_count <> 1 then
    raise exception 'Pending Couple Space is already paired';
  end if;

  if exists (select 1 from public.cards where space_id = target_space_id)
    or exists (select 1 from public.stamp_events where space_id = target_space_id)
    or exists (select 1 from public.stamp_comments where space_id = target_space_id)
    or exists (select 1 from public.stamp_reactions where space_id = target_space_id)
    or exists (select 1 from public.card_activity_events where space_id = target_space_id)
    or exists (select 1 from public.user_notifications where space_id = target_space_id) then
    raise exception 'Pending Couple Space contains records and cannot be cancelled';
  end if;

  update public.pairing_invites
  set revoked_at = now()
  where space_id = target_space_id
    and used_at is null
    and revoked_at is null
    and is_recovery = false;

  delete from public.couple_spaces where id = target_space_id;
  return target_space_id;
end;
$$;

revoke all on function public.cancel_pending_pairing() from public;
grant execute on function public.cancel_pending_pairing() to authenticated;
