const PREFIX = "couple-stamp-card:outbox";

export function queueKey(userId) {
  return `${PREFIX}:${userId}`;
}

export function readQueue(userId, storage = globalThis.localStorage) {
  if (!storage || !userId) return [];
  try {
    const parsed = JSON.parse(storage.getItem(queueKey(userId)) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeQueue(userId, queue, storage = globalThis.localStorage) {
  if (!storage || !userId) return;
  storage.setItem(queueKey(userId), JSON.stringify(queue));
}

export function appendToQueue(userId, queue, action, storage = globalThis.localStorage) {
  const next = [...queue, action];
  writeQueue(userId, next, storage);
  return next;
}

// A reaction is a desired final state, not a sequence of events. Replacing a
// queued reaction for the same stamp prevents an offline tap sequence from
// creating stale reactions or extra notifications after reconnecting.
export function replaceQueuedReaction(userId, queue, action, storage = globalThis.localStorage) {
  const existing = queue.find((item) => item.type === "reaction" && item.eventId === action.eventId);
  const nextAction = { ...action, previousReaction: existing ? existing.previousReaction : (action.previousReaction ?? null) };
  const next = [...queue.filter((item) => !(item.type === "reaction" && item.eventId === action.eventId)), nextAction];
  writeQueue(userId, next, storage);
  return next;
}

export function removeQueuedAction(userId, queue, actionId, storage = globalThis.localStorage) {
  const next = queue.filter((action) => action.id !== actionId);
  writeQueue(userId, next, storage);
  return next;
}
