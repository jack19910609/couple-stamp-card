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

function singleData(result, label) {
  const data = resultData(result, label);
  return Array.isArray(data) ? data[0] : data;
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
  console.log("1/14 Creating isolated users…");
  const [a, b, outsider, expiryOwner] = await Promise.all([
    createTestUser("a"),
    createTestUser("b"),
    createTestUser("outsider"),
    createTestUser("expiry"),
  ]);

  console.log("2/14 Verifying pairing completion and one-time six-digit codes…");
  const inviteRows = resultData(await a.client.rpc("create_pairing_invite"), "create pairing invite");
  const invite = inviteRows?.[0];
  assert(invite && /^\d{6}$/.test(invite.invite_code), "RPC did not return a six-digit pairing code");
  assert(new Date(invite.invite_expires_at).getTime() > Date.now(), "Pairing code is not future-dated");
  createdSpaces.add(invite.invite_space_id);

  const acceptedSpaceId = resultData(await b.client.rpc("accept_pairing_invite", { submitted_code: invite.invite_code }), "accept pairing invite");
  assert(acceptedSpaceId === invite.invite_space_id, "Partner joined a different Couple Space");
  const pairedMembers = resultData(await a.client.from("couple_members").select("user_id").eq("space_id", invite.invite_space_id), "creator reads paired membership");
  assert(pairedMembers.some((member) => member.user_id === b.user.id), "Creator cannot read the partner membership after pairing");
  const reused = await outsider.client.rpc("accept_pairing_invite", { submitted_code: invite.invite_code });
  assert(reused.error, "A used pairing code was accepted twice");

  console.log("3/14 Verifying expired pairing rejection…");
  const expiryRows = resultData(await expiryOwner.client.rpc("create_pairing_invite"), "create expiry invite");
  const expiryInvite = expiryRows[0];
  createdSpaces.add(expiryInvite.invite_space_id);
  resultData(await admin.from("pairing_invites").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", expiryInvite.invite_id), "expire invite");
  const expired = await outsider.client.rpc("accept_pairing_invite", { submitted_code: expiryInvite.invite_code });
  assert(expired.error, "An expired pairing code was accepted");

  const createCard = async (client, values, label) => singleData(await client.rpc("create_card", {
    target_space_id: invite.invite_space_id,
    card_mode: values.mode,
    card_participant_id: values.participantId || null,
    card_title: values.title,
    card_action_label: values.action,
    card_target_count: values.target,
    card_reward: values.reward,
  }), label);

  console.log("4/14 Creating a shared card and reading lifecycle audit…");
  const sharedCard = await createCard(a.client, {
    mode: "shared", title: "整合測試共同卡", action: "完成一次共同測試", target: 2, reward: "共享獎勵",
  }, "create shared card");
  assert(sharedCard.mode === "shared" && sharedCard.reward_state === "locked", "Shared card was not initialized correctly");
  const partnerCards = resultData(await b.client.from("cards").select("id").eq("id", sharedCard.id), "partner reads card");
  assert(partnerCards.length === 1, "Partner cannot read the shared card");
  const createdActivity = resultData(await b.client.from("card_activity_events").select("kind").eq("card_id", sharedCard.id), "partner reads creation audit");
  assert(createdActivity.some((item) => item.kind === "created"), "Card creation audit was not saved");

  console.log("5/14 Verifying shared completion, Realtime, and idempotent stamps…");
  const firstSharedEventId = randomUUID();
  const finalSharedEventId = randomUUID();
  let cardReceiver;
  const cardCompletePromise = waitForEvent((resolve) => { cardReceiver = resolve; }, "shared card completion UPDATE");
  const cardChannel = a.client.channel(`verify-shared-card-${randomUUID()}`).on(
    "postgres_changes",
    { event: "UPDATE", schema: "public", table: "cards", filter: `space_id=eq.${invite.invite_space_id}` },
    (payload) => payload.new.id === sharedCard.id && payload.new.completed_at && cardReceiver?.(payload),
  );
  channels.push([a.client, cardChannel]);
  await waitForChannel(cardChannel);
  let insertReceiver;
  const insertPromise = waitForEvent((resolve) => { insertReceiver = resolve; }, "stamp INSERT");
  const insertChannel = b.client.channel(`verify-insert-${randomUUID()}`).on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "stamp_events", filter: `space_id=eq.${invite.invite_space_id}` },
    (payload) => payload.new.id === firstSharedEventId && insertReceiver?.(payload),
  );
  channels.push([b.client, insertChannel]);
  await waitForChannel(insertChannel);
  const occurredAt = new Date().toISOString();
  const stamp = singleData(await a.client.rpc("create_stamp_event", {
    event_id: firstSharedEventId,
    target_card_id: sharedCard.id,
    event_note: "A 留下的整合測試留言",
    event_occurred_at: occurredAt,
  }), "create first shared stamp");
  const insertPayload = await insertPromise;
  assert(insertPayload.new.id === firstSharedEventId && insertPayload.new.actor_id === a.user.id, "Realtime INSERT has incorrect event data");
  assert(stamp.note === "A 留下的整合測試留言", "Stamp note was not preserved");
  singleData(await a.client.rpc("create_stamp_event", {
    event_id: firstSharedEventId,
    target_card_id: sharedCard.id,
    event_note: "A 留下的整合測試留言",
    event_occurred_at: occurredAt,
  }), "replay shared stamp");
  const duplicateCheck = resultData(await b.client.from("stamp_events").select("id", { count: "exact" }).eq("id", firstSharedEventId), "count replayed event");
  assert(duplicateCheck.length === 1, "Replaying an event created a duplicate stamp");
  singleData(await b.client.rpc("create_stamp_event", {
    event_id: finalSharedEventId,
    target_card_id: sharedCard.id,
    event_note: "B 完成共同目標",
    event_occurred_at: new Date().toISOString(),
  }), "complete shared card");
  const sharedCompletion = await cardCompletePromise;
  assert(sharedCompletion.new.reward_state === "ready", "Shared completion did not unlock the reward");

  console.log("6/14 Verifying two-person reward request and confirmation…");
  let rewardActivityReceiver;
  const rewardActivityPromise = waitForEvent((resolve) => { rewardActivityReceiver = resolve; }, "reward request activity INSERT");
  const rewardChannel = b.client.channel(`verify-reward-${randomUUID()}`).on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "card_activity_events", filter: `space_id=eq.${invite.invite_space_id}` },
    (payload) => payload.new.card_id === sharedCard.id && payload.new.kind === "reward_requested" && rewardActivityReceiver?.(payload),
  );
  channels.push([b.client, rewardChannel]);
  await waitForChannel(rewardChannel);
  const rewardRequested = singleData(await a.client.rpc("request_reward_redemption", { target_card_id: sharedCard.id }), "request reward redemption");
  assert(rewardRequested.reward_state === "requested" && rewardRequested.reward_requested_by === a.user.id, "Reward request state is incorrect");
  await rewardActivityPromise;
  const selfConfirm = await a.client.rpc("confirm_reward_redemption", { target_card_id: sharedCard.id });
  assert(selfConfirm.error, "Requester could confirm their own reward redemption");
  const rewardRedeemed = singleData(await b.client.rpc("confirm_reward_redemption", { target_card_id: sharedCard.id }), "confirm reward redemption");
  assert(rewardRedeemed.reward_state === "redeemed" && rewardRedeemed.reward_redeemed_by === b.user.id, "Partner reward confirmation failed");

  console.log("7/14 Verifying personal card participant restrictions…");
  const personalCard = await createCard(a.client, {
    mode: "personal", participantId: a.user.id, title: "A 的個人卡", action: "完成一次個人練習", target: 2, reward: "個人卡獎勵",
  }, "create personal card");
  const personalPartnerStamp = await b.client.rpc("create_stamp_event", {
    event_id: randomUUID(), target_card_id: personalCard.id, event_note: "B 不該能蓋章", event_occurred_at: new Date().toISOString(),
  });
  assert(personalPartnerStamp.error, "Non-participant could stamp a personal card");
  for (const note of ["A 個人進度 1", "A 個人進度 2"]) {
    singleData(await a.client.rpc("create_stamp_event", {
      event_id: randomUUID(), target_card_id: personalCard.id, event_note: note, event_occurred_at: new Date().toISOString(),
    }), "stamp personal card");
  }
  const completedPersonal = singleData(await a.client.from("cards").select("completed_at, reward_state").eq("id", personalCard.id).single(), "read completed personal card");
  assert(completedPersonal.completed_at && completedPersonal.reward_state === "ready", "Personal card did not complete");

  console.log("8/14 Verifying atomic competition winner and undo reopening…");
  const competitionCard = await createCard(a.client, {
    mode: "competition", title: "同步競賽卡", action: "完成一次競賽測試", target: 2, reward: "競賽獎勵",
  }, "create competition card");
  for (const [actor, note] of [[a, "A 第一章"], [b, "B 第一章"]]) {
    singleData(await actor.client.rpc("create_stamp_event", {
      event_id: randomUUID(), target_card_id: competitionCard.id, event_note: note, event_occurred_at: new Date().toISOString(),
    }), "create first competition stamp");
  }
  const aFinishId = randomUUID();
  const bFinishId = randomUUID();
  const [aFinish, bFinish] = await Promise.all([
    a.client.rpc("create_stamp_event", { event_id: aFinishId, target_card_id: competitionCard.id, event_note: "A 衝線", event_occurred_at: new Date().toISOString() }),
    b.client.rpc("create_stamp_event", { event_id: bFinishId, target_card_id: competitionCard.id, event_note: "B 衝線", event_occurred_at: new Date().toISOString() }),
  ]);
  const successfulFinish = [
    { actor: a, eventId: aFinishId, result: aFinish },
    { actor: b, eventId: bFinishId, result: bFinish },
  ].filter((item) => !item.result.error);
  assert(successfulFinish.length === 1, "Simultaneous competition finish produced more than one winner");
  const completedCompetition = singleData(await a.client.from("cards").select("winner_id, completed_at, reward_state").eq("id", competitionCard.id).single(), "read competition winner");
  assert(completedCompetition.winner_id === successfulFinish[0].actor.user.id && completedCompetition.completed_at, "Competition winner was not atomically locked");
  singleData(await successfulFinish[0].actor.client.rpc("undo_stamp_event", { target_event_id: successfulFinish[0].eventId, undo_requested_at: new Date().toISOString() }), "undo winning competition stamp");
  const reopenedCompetition = singleData(await a.client.from("cards").select("winner_id, completed_at, reward_state").eq("id", competitionCard.id).single(), "read reopened competition");
  assert(!reopenedCompetition.winner_id && !reopenedCompetition.completed_at && reopenedCompetition.reward_state === "locked", "Undo did not reopen the competition card");

  console.log("9/14 Verifying explicit rule-change confirmation and lifecycle audit…");
  const unconfirmedEdit = await a.client.rpc("update_card_rules", {
    target_card_id: personalCard.id, next_mode: "personal", next_participant_id: a.user.id,
    next_title: "更新後的個人卡", next_action_label: "更新後的條件", next_target_count: 3,
    next_reward: "更新後獎勵", acknowledge_existing_progress: false,
  });
  assert(unconfirmedEdit.error, "Existing progress could be changed without confirmation");
  const editedPersonal = singleData(await a.client.rpc("update_card_rules", {
    target_card_id: personalCard.id, next_mode: "personal", next_participant_id: a.user.id,
    next_title: "更新後的個人卡", next_action_label: "更新後的條件", next_target_count: 3,
    next_reward: "更新後獎勵", acknowledge_existing_progress: true,
  }), "confirm personal card rule change");
  assert(editedPersonal.target_count === 3 && !editedPersonal.completed_at, "Confirmed rule change did not reopen card progress");
  const ruleActivities = resultData(await b.client.from("card_activity_events").select("kind, details").eq("card_id", personalCard.id), "read rules audit");
  assert(ruleActivities.some((item) => item.kind === "rules_changed" && item.details?.acknowledged_existing_progress), "Rule change audit is missing");

  console.log("10/14 Verifying individual archive and copy into a new round…");
  const archivedPersonal = singleData(await a.client.rpc("archive_card", { target_card_id: personalCard.id }), "archive personal card");
  assert(archivedPersonal.status === "archived" && archivedPersonal.archived_at, "Individual card archive failed");
  const copiedPersonal = singleData(await b.client.rpc("copy_card", { target_card_id: personalCard.id }), "copy archived card");
  assert(copiedPersonal.status === "active" && copiedPersonal.id !== personalCard.id && copiedPersonal.mode === "personal", "Copy did not create a fresh active round");

  console.log("11/14 Verifying outsider RLS isolation and RPC-only mutations…");
  const outsiderRead = resultData(await outsider.client.from("cards").select("id").eq("id", sharedCard.id), "outsider card query");
  assert(outsiderRead.length === 0, "Outsider could read a Couple Space card");
  const outsiderWrite = await outsider.client.from("cards").insert({
    space_id: invite.invite_space_id, created_by: outsider.user.id, mode: "shared", title: "不該成功", action_label: "越權寫入", target_count: 2, reward: "無",
  });
  assert(outsiderWrite.error, "Outsider could write to a Couple Space card");

  console.log("12/14 Verifying end, read-only archive, and blocked writes…");
  const endedSpaceId = resultData(await a.client.rpc("end_couple_space"), "end Couple Space");
  assert(endedSpaceId === invite.invite_space_id, "Ended an unexpected Couple Space");
  const departedMembership = singleData(await b.client.from("couple_members").select("departed_at").eq("space_id", invite.invite_space_id).eq("user_id", b.user.id).single(), "partner reads departed membership");
  assert(departedMembership.departed_at, "Partner cannot read their archive status after ending the space");
  const archivedCard = singleData(await b.client.from("cards").select("id, status, archived_at").eq("id", sharedCard.id).single(), "partner reads archived card");
  assert(archivedCard.status === "archived" && archivedCard.archived_at, "Ending a space did not archive its cards");
  const archiveMemberships = resultData(await b.client.from("couple_members")
    .select("space_id, departed_at, space:couple_spaces!couple_members_space_id_fkey(id, status, recoverable_until)")
    .eq("user_id", b.user.id)
    .not("departed_at", "is", null), "read archive metadata");
  assert(archiveMemberships.some((item) => item.space_id === invite.invite_space_id && item.space?.status === "ended" && item.space?.recoverable_until), "Archive metadata is unavailable to an original member");
  const archivedWrite = await a.client.from("cards").insert({
    space_id: invite.invite_space_id,
    created_by: a.user.id,
    mode: "shared", title: "不該寫入封存空間", action_label: "越權寫入", target_count: 2, reward: "無",
  });
  assert(archivedWrite.error, "A former member could create a card in an archived space");
  const archivedStamp = await b.client.rpc("create_stamp_event", {
    event_id: randomUUID(),
    target_card_id: sharedCard.id,
    event_note: "不該蓋章",
    event_occurred_at: new Date().toISOString(),
  });
  assert(archivedStamp.error, "A former member could stamp an archived card");

  console.log("13/14 Verifying original-partner-only recovery creates a fresh active space…");
  const recoveryRows = resultData(await a.client.rpc("create_recovery_invite", { target_archived_space_id: invite.invite_space_id }), "create recovery invite");
  const recoveryInvite = recoveryRows?.[0];
  assert(recoveryInvite && /^\d{6}$/.test(recoveryInvite.invite_code), "Recovery RPC did not return a six-digit code");
  const outsiderRecovery = await outsider.client.rpc("create_recovery_invite", { target_archived_space_id: invite.invite_space_id });
  assert(outsiderRecovery.error, "A non-member could create a recovery code");
  const recoveredSpaceId = resultData(await b.client.rpc("accept_pairing_invite", { submitted_code: recoveryInvite.invite_code }), "accept recovery invite");
  createdSpaces.add(recoveredSpaceId);
  assert(recoveredSpaceId !== invite.invite_space_id, "Recovery reused the archived space instead of creating a clean one");
  const recoveredMembership = singleData(await a.client.from("couple_members").select("space_id").eq("space_id", recoveredSpaceId).eq("user_id", a.user.id).single(), "creator reads recovery membership");
  assert(recoveredMembership.space_id === recoveredSpaceId, "Creator cannot read their recovered membership");
  const recoveredCard = singleData(await a.client.rpc("create_card", {
    target_space_id: recoveredSpaceId, card_mode: "shared", card_participant_id: null,
    card_title: "重新開始的共同卡", card_action_label: "完成一次重新開始測試", card_target_count: 2, card_reward: "新的回憶",
  }), "create card after recovery");
  assert(recoveredCard.status === "active", "Recovered partners could not create a fresh active card");

  console.log("14/14 Verifying card archive history remains private…");
  const formerCards = resultData(await a.client.from("cards").select("id, status").eq("space_id", invite.invite_space_id).eq("status", "archived"), "former member reads archived cards");
  assert(formerCards.length >= 3, "Archived card history was not retained after ending the space");
  const outsiderActivities = resultData(await outsider.client.from("card_activity_events").select("id").eq("space_id", invite.invite_space_id), "outsider activity query");
  assert(outsiderActivities.length === 0, "Outsider could read lifecycle history");

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
