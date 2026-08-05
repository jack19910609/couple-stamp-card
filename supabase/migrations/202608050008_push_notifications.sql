-- Fourth milestone: browser-native Push notifications.
-- The browser only receives the public VAPID key. The signing key lives in
-- Supabase Edge Function secrets, while this trigger reads only a webhook
-- secret stored in Supabase Vault.

create extension if not exists pg_net;
create extension if not exists supabase_vault with schema vault;

create table if not exists public.notification_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  push_enabled boolean not null default false,
  card_updates boolean not null default true,
  stamp_updates boolean not null default true,
  interaction_updates boolean not null default true,
  reward_updates boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  device_label text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,
  invalidated_at timestamptz,
  constraint push_subscriptions_endpoint_https check (endpoint ~ '^https://'),
  constraint push_subscriptions_p256dh_length check (char_length(p256dh) between 16 and 512),
  constraint push_subscriptions_auth_length check (char_length(auth) between 8 and 512),
  constraint push_subscriptions_device_label_length check (device_label is null or char_length(device_label) <= 120)
);

create table if not exists public.push_delivery_log (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.user_notifications(id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  status text not null default 'sending',
  attempts integer not null default 1,
  response_status integer,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint push_delivery_log_status check (status in ('sending', 'sent', 'failed', 'invalid')),
  constraint push_delivery_log_attempts check (attempts between 1 and 3),
  constraint push_delivery_log_once_per_subscription unique (notification_id, subscription_id)
);

create index if not exists push_subscriptions_user_enabled_idx
  on public.push_subscriptions (user_id, enabled)
  where enabled = true and invalidated_at is null;
create index if not exists push_delivery_log_notification_idx on public.push_delivery_log (notification_id, created_at desc);

drop trigger if exists notification_preferences_touch_updated_at on public.notification_preferences;
create trigger notification_preferences_touch_updated_at
  before update on public.notification_preferences
  for each row execute procedure public.touch_updated_at();

drop trigger if exists push_subscriptions_touch_updated_at on public.push_subscriptions;
create trigger push_subscriptions_touch_updated_at
  before update on public.push_subscriptions
  for each row execute procedure public.touch_updated_at();

drop trigger if exists push_delivery_log_touch_updated_at on public.push_delivery_log;
create trigger push_delivery_log_touch_updated_at
  before update on public.push_delivery_log
  for each row execute procedure public.touch_updated_at();

alter table public.notification_preferences enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_delivery_log enable row level security;

drop policy if exists "notification_preferences_read_self" on public.notification_preferences;
create policy "notification_preferences_read_self"
  on public.notification_preferences for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "push_subscriptions_read_self" on public.push_subscriptions;
create policy "push_subscriptions_read_self"
  on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));

-- Client writes are RPC-only: endpoints and browser encryption keys must
-- always be bound to the authenticated account server-side.
revoke all on public.notification_preferences, public.push_subscriptions, public.push_delivery_log from anon, authenticated;
grant select on public.notification_preferences, public.push_subscriptions to authenticated;
grant all privileges on public.notification_preferences, public.push_subscriptions, public.push_delivery_log to service_role;

create or replace function public.enable_push_notifications(
  subscription_endpoint text,
  subscription_p256dh text,
  subscription_auth text,
  subscription_device_label text default null
)
returns public.push_subscriptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  result public.push_subscriptions%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if subscription_endpoint !~ '^https://' then raise exception 'Push subscription endpoint must use HTTPS'; end if;
  if char_length(subscription_endpoint) > 4096 then raise exception 'Push subscription endpoint is too long'; end if;
  if char_length(subscription_p256dh) not between 16 and 512 then raise exception 'Push subscription key is invalid'; end if;
  if char_length(subscription_auth) not between 8 and 512 then raise exception 'Push subscription auth key is invalid'; end if;
  if subscription_device_label is not null and char_length(trim(subscription_device_label)) > 120 then raise exception 'Device label is too long'; end if;

  insert into public.notification_preferences (user_id, push_enabled)
  values (current_user_id, true)
  on conflict (user_id) do update set push_enabled = true, updated_at = now();

  -- Browser endpoints are opaque, high-entropy capabilities. If the same
  -- physical browser is signed into another account, move that endpoint to
  -- the current account rather than leaking notifications across accounts.
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, device_label, enabled, disabled_at, invalidated_at)
  values (current_user_id, subscription_endpoint, subscription_p256dh, subscription_auth, nullif(trim(subscription_device_label), ''), true, null, null)
  on conflict (endpoint) do update
    set user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        device_label = excluded.device_label,
        enabled = true,
        disabled_at = null,
        invalidated_at = null,
        updated_at = now()
  returning * into result;
  return result;
end;
$$;

create or replace function public.disable_push_notifications(subscription_endpoint text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  update public.notification_preferences
  set push_enabled = false, updated_at = now()
  where user_id = current_user_id;
  if not found then
    insert into public.notification_preferences (user_id, push_enabled)
    values (current_user_id, false);
  end if;
  update public.push_subscriptions
  set enabled = false, disabled_at = now(), updated_at = now()
  where user_id = current_user_id
    and (subscription_endpoint is null or endpoint = subscription_endpoint);
end;
$$;

create or replace function public.update_push_notification_preferences(
  next_card_updates boolean,
  next_stamp_updates boolean,
  next_interaction_updates boolean,
  next_reward_updates boolean
)
returns public.notification_preferences
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  result public.notification_preferences%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  insert into public.notification_preferences (
    user_id, card_updates, stamp_updates, interaction_updates, reward_updates
  ) values (
    current_user_id, next_card_updates, next_stamp_updates, next_interaction_updates, next_reward_updates
  )
  on conflict (user_id) do update set
    card_updates = excluded.card_updates,
    stamp_updates = excluded.stamp_updates,
    interaction_updates = excluded.interaction_updates,
    reward_updates = excluded.reward_updates,
    updated_at = now()
  returning * into result;
  return result;
end;
$$;

-- Only the trusted Edge Function (service_role) can claim a delivery. The
-- unique constraint makes retries/webhook redelivery idempotent.
create or replace function private.claim_push_delivery(
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
  end if;
  select id into result_id
  from public.push_delivery_log
  where notification_id = target_notification_id
    and subscription_id = target_subscription_id;
  return query select result_id, false;
end;
$$;

-- Database writes never wait for a network request. The trigger exits quietly
-- until the project owner has placed the matching secret in Vault, allowing
-- this migration to be deployed safely before the Edge Function is configured.
create or replace function private.enqueue_push_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  hook_secret text;
begin
  select decrypted_secret into hook_secret
  from vault.decrypted_secrets
  where name = 'couple_stamp_push_hook_secret'
  limit 1;
  if hook_secret is null or char_length(hook_secret) < 24 then
    return new;
  end if;
  perform net.http_post(
    url := 'https://ruqghhdoatziepvbifnb.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-hook-secret', hook_secret
    ),
    body := jsonb_build_object('notification_id', new.id)::jsonb,
    timeout_milliseconds := 5000
  );
  return new;
exception when others then
  -- Push delivery is best-effort and must never roll back the original card,
  -- stamp, comment, reaction, or in-app notification transaction.
  return new;
end;
$$;

drop trigger if exists user_notifications_enqueue_push on public.user_notifications;
create trigger user_notifications_enqueue_push
  after insert on public.user_notifications
  for each row execute function private.enqueue_push_notification();

revoke all on function public.enable_push_notifications(text, text, text, text) from public;
revoke all on function public.disable_push_notifications(text) from public;
revoke all on function public.update_push_notification_preferences(boolean, boolean, boolean, boolean) from public;
revoke all on function private.claim_push_delivery(uuid, uuid) from public;
grant execute on function public.enable_push_notifications(text, text, text, text) to authenticated;
grant execute on function public.disable_push_notifications(text) to authenticated;
grant execute on function public.update_push_notification_preferences(boolean, boolean, boolean, boolean) to authenticated;
grant execute on function private.claim_push_delivery(uuid, uuid) to service_role;
