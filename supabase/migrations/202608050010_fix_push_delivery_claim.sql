-- `return query` appends rows but does not exit a PL/pgSQL function. Exit the
-- successful insert path so PostgREST receives exactly one claim result.

create or replace function public.claim_push_delivery(
  target_notification_id uuid,
  target_subscription_id uuid
)
returns table (delivery_id uuid, claimed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  result_id uuid;
begin
  insert into public.push_delivery_log (notification_id, subscription_id)
  values (target_notification_id, target_subscription_id)
  on conflict (notification_id, subscription_id) do nothing
  returning id into result_id;

  if result_id is not null then
    return query select result_id, true;
    return;
  end if;

  select id into result_id
  from public.push_delivery_log
  where notification_id = target_notification_id
    and subscription_id = target_subscription_id;
  return query select result_id, false;
end;
$$;

revoke all on function public.claim_push_delivery(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_push_delivery(uuid, uuid) to service_role;
