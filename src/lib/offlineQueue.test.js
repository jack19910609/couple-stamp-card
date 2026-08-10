import { describe, expect, it } from "vitest";
import { appendToQueue, isQueuedActionForInactiveCard, queuedActionCardId, readQueue, removeQueuedAction, replaceQueuedReaction } from "./offlineQueue.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe("offline queue", () => {
  it("persists ordered, idempotent actions per user", () => {
    const storage = memoryStorage();
    let queue = appendToQueue("user-1", [], { id: "q1", type: "stamp", eventId: "event-1" }, storage);
    queue = appendToQueue("user-1", queue, { id: "q2", type: "undo", eventId: "event-1" }, storage);
    expect(readQueue("user-1", storage).map((item) => item.id)).toEqual(["q1", "q2"]);
    queue = removeQueuedAction("user-1", queue, "q1", storage);
    expect(queue.map((item) => item.id)).toEqual(["q2"]);
  });

  it("keeps only the final offline reaction for each stamp", () => {
    const storage = memoryStorage();
    let queue = replaceQueuedReaction("user-1", [], { id: "r1", type: "reaction", eventId: "event-1", emoji: "❤️", previousReaction: null }, storage);
    queue = replaceQueuedReaction("user-1", queue, { id: "r2", type: "reaction", eventId: "event-1", emoji: "👏", previousReaction: { id: "old" } }, storage);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ id: "r2", emoji: "👏", previousReaction: null });
  });

  it("identifies queued operations targeting a card that is no longer active", () => {
    const events = [{ id: "event-1", card_id: "archived-card" }];
    const activeCardIds = new Set(["active-card"]);
    const actions = [
      { type: "stamp", event: { card_id: "archived-card" } },
      { type: "undo", eventId: "event-1" },
      { type: "comment", comment: { card_id: "archived-card" } },
      { type: "reaction", eventId: "event-1" },
    ];

    expect(actions.map((action) => queuedActionCardId(action, events))).toEqual([
      "archived-card", "archived-card", "archived-card", "archived-card",
    ]);
    expect(actions.every((action) => isQueuedActionForInactiveCard(action, activeCardIds, events))).toBe(true);
  });

  it("keeps actions when the target card cannot yet be resolved", () => {
    expect(isQueuedActionForInactiveCard({ type: "undo", eventId: "unknown" }, new Set(), [])).toBe(false);
  });
});
