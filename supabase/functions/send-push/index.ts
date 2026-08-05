import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.55.0";

type NotificationKind =
  | "card_created"
  | "stamp_created"
  | "card_completed"
  | "comment_created"
  | "reaction_created"
  | "reward_requested"
  | "reward_redeemed";

type NotificationRecord = {
  id: string;
  recipient_id: string;
  actor_id: string;
  space_id: string;
  card_id: string | null;
  stamp_event_id: string | null;
  kind: NotificationKind;
  data: Record<string, unknown> | null;
};

type PushSubscriptionRecord = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

type PushSendFailure = {
  cause: unknown;
  attempts: number;
};

function requiredSecret(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function serviceRoleKey() {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY");
  if (legacy) return legacy;
  const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
  const key = Object.values(keys)[0];
  if (typeof key !== "string" || !key) throw new Error("Missing Supabase service key");
  return key;
}

function categoryEnabled(kind: NotificationKind, preference: Record<string, unknown>) {
  if (!preference.push_enabled) return false;
  if (kind === "card_created" || kind === "card_completed") return preference.card_updates !== false;
  if (kind === "stamp_created") return preference.stamp_updates !== false;
  if (kind === "comment_created" || kind === "reaction_created") return preference.interaction_updates !== false;
  return preference.reward_updates !== false;
}

function appUrl(notification: NotificationRecord) {
  const url = new URL(requiredSecret("PUSH_APP_URL"));
  url.searchParams.set("space", notification.space_id);
  url.searchParams.set("notification", notification.id);
  if (notification.card_id) url.searchParams.set("card", notification.card_id);
  if (notification.stamp_event_id) url.searchParams.set("event", notification.stamp_event_id);
  return url.toString();
}

function isInvalidSubscription(error: unknown) {
  const status = Number((error as { statusCode?: number })?.statusCode);
  return status === 404 || status === 410;
}

function responseStatus(error: unknown) {
  const status = Number((error as { statusCode?: number })?.statusCode);
  return Number.isInteger(status) && status > 0 ? status : null;
}

function compactError(error: unknown) {
  if (error && typeof error === "object" && !(error instanceof Error)) {
    const record = error as Record<string, unknown>;
    const message = [record.code, record.message, record.details, record.hint]
      .filter((value) => typeof value === "string" && value)
      .join(" · ");
    if (message) return message.slice(0, 240);
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 240);
}

function pushFailureCause(error: unknown) {
  return error && typeof error === "object" && "cause" in error
    ? (error as PushSendFailure).cause
    : error;
}

function pushAttempts(error: unknown) {
  const attempts = error && typeof error === "object"
    ? Number((error as PushSendFailure).attempts)
    : 3;
  return Number.isInteger(attempts) && attempts >= 1 && attempts <= 3 ? attempts : 3;
}

async function pause(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sendWithRetries(subscription: PushSubscriptionRecord, payload: string) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      }, payload, { TTL: 120, urgency: "normal" });
      return { response, attempts: attempt };
    } catch (error) {
      if (isInvalidSubscription(error) || attempt === 3) throw { cause: error, attempts: attempt } satisfies PushSendFailure;
      await pause(300 * attempt * attempt);
    }
  }
  throw new Error("Push delivery unexpectedly exhausted without an error");
}

export default {
  async fetch(request: Request) {
    if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
    if (request.headers.get("x-push-hook-secret") !== requiredSecret("PUSH_WEBHOOK_SECRET")) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => null) as { notification_id?: string } | null;
    if (!body?.notification_id) return Response.json({ error: "notification_id is required" }, { status: 400 });

    const admin = createClient(requiredSecret("SUPABASE_URL"), serviceRoleKey(), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: notification, error: notificationError } = await admin
      .from("user_notifications")
      .select("id, recipient_id, actor_id, space_id, card_id, stamp_event_id, kind, data")
      .eq("id", body.notification_id)
      .maybeSingle<NotificationRecord>();
    if (notificationError) throw notificationError;
    if (!notification) return Response.json({ skipped: "notification_missing" });

    const { data: activeMembers, error: membersError } = await admin
      .from("couple_members")
      .select("user_id, departed_at, space:couple_spaces!couple_members_space_id_fkey(status)")
      .eq("space_id", notification.space_id)
      .in("user_id", [notification.recipient_id, notification.actor_id])
      .is("departed_at", null);
    if (membersError) throw membersError;
    const activeMemberIds = new Set((activeMembers || [])
      .filter((member) => (member.space as { status?: string } | null)?.status === "active")
      .map((member) => member.user_id));
    if (notification.recipient_id === notification.actor_id || activeMemberIds.size !== 2) {
      return Response.json({ skipped: "relationship_inactive" });
    }

    const { data: preference, error: preferenceError } = await admin
      .from("notification_preferences")
      .select("push_enabled, card_updates, stamp_updates, interaction_updates, reward_updates")
      .eq("user_id", notification.recipient_id)
      .maybeSingle<Record<string, unknown>>();
    if (preferenceError) throw preferenceError;
    if (!preference || !categoryEnabled(notification.kind, preference)) {
      return Response.json({ skipped: "preference_disabled" });
    }

    const { data: subscriptions, error: subscriptionsError } = await admin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("user_id", notification.recipient_id)
      .eq("enabled", true)
      .is("invalidated_at", null);
    if (subscriptionsError) throw subscriptionsError;
    if (!subscriptions?.length) return Response.json({ skipped: "no_subscriptions" });

    const title = typeof notification.data?.title === "string" ? notification.data.title : null;
    const payload = JSON.stringify({
      title: "愛的集點卡",
      // Do not expose comment text, stamps notes, or emojis on a lock screen.
      body: title ? `「${title}」有新的雙人互動` : "你的伴侶有新的互動",
      tag: `couple-notification-${notification.id}`,
      notificationId: notification.id,
      url: appUrl(notification),
    });

    const results = await Promise.all((subscriptions as PushSubscriptionRecord[]).map(async (subscription) => {
      const { data: claim, error: claimError } = await admin.rpc("claim_push_delivery", {
        target_notification_id: notification.id,
        target_subscription_id: subscription.id,
      }).single<{ delivery_id: string; claimed: boolean }>();
      if (claimError) {
        return { subscriptionId: subscription.id, status: "claim_failed", error: compactError(claimError) };
      }
      if (!claim?.claimed) return { subscriptionId: subscription.id, status: "duplicate" };
      try {
        webpush.setVapidDetails(
          requiredSecret("VAPID_SUBJECT"),
          requiredSecret("VAPID_PUBLIC_KEY"),
          requiredSecret("VAPID_PRIVATE_KEY"),
        );
        const delivery = await sendWithRetries(subscription, payload);
        await admin.from("push_delivery_log").update({
          status: "sent", attempts: delivery.attempts, response_status: delivery.response.statusCode || 201, sent_at: new Date().toISOString(), error_code: null,
        }).eq("id", claim.delivery_id);
        return { subscriptionId: subscription.id, status: "sent" };
      } catch (error) {
        const cause = pushFailureCause(error);
        const invalid = isInvalidSubscription(cause);
        await admin.from("push_delivery_log").update({
          status: invalid ? "invalid" : "failed", attempts: pushAttempts(error), response_status: responseStatus(cause), error_code: compactError(cause),
        }).eq("id", claim.delivery_id);
        if (invalid) {
          await admin.from("push_subscriptions").update({
            enabled: false, invalidated_at: new Date().toISOString(), disabled_at: new Date().toISOString(),
          }).eq("id", subscription.id);
        }
        return { subscriptionId: subscription.id, status: invalid ? "invalid" : "failed" };
      }
    }));
    return Response.json({ notification_id: notification.id, results });
  },
};
