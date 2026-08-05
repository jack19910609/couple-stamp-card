-- Card completion can happen through a stamp or an acknowledged rule edit.
-- Centralize its notification so the recipient receives it exactly once.

create or replace function private.notify_card_completed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if old.completed_at is null and new.completed_at is not null and current_user_id is not null then
    perform private.notify_other_active_member(new.space_id, current_user_id, 'card_completed', new.id, null, jsonb_build_object('title', new.title));
  end if;
  return new;
end;
$$;

drop trigger if exists cards_notify_completed on public.cards;
create trigger cards_notify_completed
  after update of completed_at on public.cards
  for each row execute function private.notify_card_completed();

create or replace function public.create_stamp_event(event_id uuid, target_card_id uuid, event_note text, event_occurred_at timestamptz)
returns public.stamp_events
language plpgsql security definer set search_path = ''
as $$
declare current_user_id uuid := auth.uid(); selected_card public.cards%rowtype; result public.stamp_events%rowtype; active_count integer;
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
    if selected_card.mode = 'competition' then
      update public.cards set completed_at = now(), winner_id = current_user_id, reward_state = 'ready' where id = selected_card.id;
      insert into public.card_activity_events (card_id, space_id, actor_id, kind, details) values (selected_card.id, selected_card.space_id, current_user_id, 'competition_won', jsonb_build_object('winner_id', current_user_id));
    else
      update public.cards set completed_at = now(), reward_state = 'ready' where id = selected_card.id;
      insert into public.card_activity_events (card_id, space_id, actor_id, kind) values (selected_card.id, selected_card.space_id, current_user_id, 'completed');
    end if;
  end if;
  return result;
end;
$$;
