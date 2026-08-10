-- An archived card is a preserved memory. Report that business rule separately
-- from membership authorization so clients can safely retire stale outbox work.
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
  if selected_card.status <> 'active' then raise exception 'Card is archived and cannot be changed'; end if;
  if not private.is_active_space_member(selected_card.space_id, current_user_id) then raise exception 'Access denied'; end if;
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
