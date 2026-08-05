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

export function removeQueuedAction(userId, queue, actionId, storage = globalThis.localStorage) {
  const next = queue.filter((action) => action.id !== actionId);
  writeQueue(userId, next, storage);
  return next;
}
