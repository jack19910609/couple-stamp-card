import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.VITE_SUPABASE_URL;
const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const adminKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !publishableKey || !adminKey) {
  console.error([
    "Missing Supabase verification credentials.",
    "Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local,",
    "plus SUPABASE_SECRET_KEY (preferred) or SUPABASE_SERVICE_ROLE_KEY for temporary test-user administration.",
  ].join("\n"));
  process.exit(1);
}

const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const admin = createClient(url, adminKey, options);
const createdUsers = [];
const createdSpaces = new Set();
const channels = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function resultData(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function createTestUser(label) {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const email = `couple-stamp-${label}-${suffix}@example.com`;
  const password = `Mvp-${randomUUID()}!`;
  const user = resultData(await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: `驗收${label}` },
  }), `create test user ${label}`).user;
  createdUsers.push(user.id);
  const client = createClient(url, publishableKey, options);
  const session = resultData(await client.auth.signInWithPassword({ email, password }), `sign in ${label}`).session;
  await client.realtime.setAuth(session.access_token);
  return { client, user };
}

function waitForChannel(channel) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Realtime subscription timed out")), 12_000);
    channel.subscribe((status, error) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timeout);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timeout);
        reject(error || new Error(`Realtime channel failed: ${status}`));
      }
    });
  });
}

function waitForEvent(register, description) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 12_000);
    register((payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

async function main() {
  console.log("1/8 Creating isolated users…");
  const [a, b, outsider, expiryOwner] = await Promise.all([
    createTestUser("a"),
    createTestUser("b"),
    createTestUser("outsider"),
    createTestUser("expiry"),
  ]);

  console.log("2/8 Verifying one-time six-digit pairing…");
  const inviteRows = resultData(await a.client.rpc("create_pairing_invite"), "create pairing invite");
  const invite = inviteRows?.[0];
  assert(invite && /^\d{6}$/.test(invite.invite_code), "RPC did not return a six-digit pairing code");
  assert(new Date(invite.invite_expires_at).getTime() > Date.now(), "Pairing code is not future-dated");
  createdSpaces.add(invite.invite_space_id);
  const acceptedSpaceId = resultData(await b.client.rpc("accept_pairing_invite", { submitted_code: invite.invite_code }), "accept pairing invite");
  assert(acceptedSpaceId === invite.invite_space_id, "Partner joined a different Couple Space");
  const reused = await outsider.client.rpc("accept_pairing_invite", { submitted_code: invite.invite_code });
  assert(reused.error, "A used pairing code was accepted twice");

  console.log("3/8 Verifying expired pairing rejection…");
  const expiryRows = resultData(await expiryOwner.client.rpc("create_pairing_invite"), "create expiry invite");
  const expiryInvite = expiryRows[0];
  createdSpaces.add(expiryInvite.invite_space_id);
  resultData(await admin.from("pairing_invites").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", expiryInvite.invite_id), "expire invite");
  const expired = await outsider.client.rpc("accept_pairing_invite", { submitted_code: expiryInvite.invite_code });
  assert(expired.error, "An expired pairing code was accepted");

  console.log("4/8 Creating and reading a shared card from both accounts…");
  const card = resultData(await a.client.from("cards").insert({
    space_id: invite.invite_space_id,
    created_by: a.user.id,
    title: "整合測試共同卡",
    action_label: "完成一次共同測試",
    target_count: 3,
    reward: "測試完成",
  }).select().single(), "create shared card");
  const partnerCards = resultData(await b.client.from("cards").select("id").eq("id", card.id), "partner reads card");
  assert(partnerCards.length === 1, "Partner cannot read the shared card");

  console.log("5/8 Verifying Realtime stamp insert…");
  const eventId = randomUUID();
  let insertReceiver;
  const insertPromise = waitForEvent((resolve) => { insertReceiver = resolve; }, "stamp INSERT");
  const insertChannel = b.client.channel(`verify-insert-${randomUUID()}`).on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "stamp_events", filter: `space_id=eq.${invite.invite_space_id}` },
    (payload) => insertReceiver?.(payload),
  );
  channels.push([b.client, insertChannel]);
  await waitForChannel(insertChannel);
  const occurredAt = new Date().toISOString();
  const stamp = resultData(await a.client.rpc("create_stamp_event", {
    event_id: eventId,
    target_card_id: card.id,
    event_note: "A 留下的整合測試留言",
    event_occurred_at: occurredAt,
  }).single(), "create stamp");
  const insertPayload = await insertPromise;
  assert(insertPayload.new.id === eventId && insertPayload.new.actor_id === a.user.id, "Realtime INSERT has incorrect event data");
  assert(stamp.note === "A 留下的整合測試留言", "Stamp note was not preserved");

  console.log("6/8 Verifying idempotent replay…");
  resultData(await a.client.rpc("create_stamp_event", {
    event_id: eventId,
    target_card_id: card.id,
    event_note: "A 留下的整合測試留言",
    event_occurred_at: occurredAt,
  }).single(), "replay stamp");
  const duplicateCheck = resultData(await b.client.from("stamp_events").select("id", { count: "exact" }).eq("id", eventId), "count replayed event");
  assert(duplicateCheck.length === 1, "Replaying an event created a duplicate stamp");

  console.log("7/8 Verifying Realtime undo and audit history…");
  let updateReceiver;
  const updatePromise = waitForEvent((resolve) => { updateReceiver = resolve; }, "stamp UPDATE");
  const updateChannel = b.client.channel(`verify-update-${randomUUID()}`).on(
    "postgres_changes",
    { event: "UPDATE", schema: "public", table: "stamp_events", filter: `space_id=eq.${invite.invite_space_id}` },
    (payload) => payload.new.id === eventId && updateReceiver?.(payload),
  );
  channels.push([b.client, updateChannel]);
  await waitForChannel(updateChannel);
  resultData(await a.client.rpc("undo_stamp_event", { target_event_id: eventId, undo_requested_at: new Date().toISOString() }).single(), "undo stamp");
  const updatePayload = await updatePromise;
  assert(updatePayload.new.undone_at && updatePayload.new.undone_by === a.user.id, "Realtime UPDATE did not preserve undo audit data");

  console.log("8/8 Verifying outsider RLS isolation…");
  const outsiderRead = resultData(await outsider.client.from("cards").select("id").eq("id", card.id), "outsider card query");
  assert(outsiderRead.length === 0, "Outsider could read a Couple Space card");
  const outsiderWrite = await outsider.client.from("cards").insert({
    space_id: invite.invite_space_id,
    created_by: outsider.user.id,
    title: "不該成功",
    action_label: "越權寫入",
    target_count: 2,
    reward: "無",
  });
  assert(outsiderWrite.error, "Outsider could write to a Couple Space card");

  console.log("Supabase integration verification passed.");
}

async function cleanup() {
  for (const [client, channel] of channels) await client.removeChannel(channel).catch(() => {});
  if (createdSpaces.size) await admin.from("couple_spaces").delete().in("id", [...createdSpaces]);
  for (const userId of createdUsers) await admin.auth.admin.deleteUser(userId).catch(() => {});
}

try {
  await main();
} catch (error) {
  console.error(`Verification failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
