import { describe, expect, it } from "vitest";
import { cardProgress, isTerminalOutboxError, isUndoable, upsertById } from "./domain.js";

describe("cardProgress", () => {
  const card = { id: "card-1", target_count: 2 };

  it("counts independent active events and contributions", () => {
    const result = cardProgress(card, [
      { id: "a", card_id: "card-1", actor_id: "u1", undone_at: null },
      { id: "b", card_id: "card-1", actor_id: "u2", undone_at: null },
      { id: "c", card_id: "card-1", actor_id: "u1", undone_at: "2026-01-01" },
    ]);
    expect(result.count).toBe(2);
    expect(result.complete).toBe(true);
    expect(result.contributions).toEqual({ u1: 1, u2: 1 });
  });

  it("counts only the assigned person on a personal card", () => {
    const result = cardProgress({ ...card, mode: "personal", participant_id: "u1" }, [
      { id: "a", card_id: "card-1", actor_id: "u1", undone_at: null },
      { id: "b", card_id: "card-1", actor_id: "u2", undone_at: null },
    ]);
    expect(result.count).toBe(1);
    expect(result.complete).toBe(false);
  });

  it("keeps competition progress separate and finds the leader", () => {
    const result = cardProgress({ ...card, mode: "competition" }, [
      { id: "a", card_id: "card-1", actor_id: "u1", undone_at: null },
      { id: "b", card_id: "card-1", actor_id: "u2", undone_at: null },
      { id: "c", card_id: "card-1", actor_id: "u1", undone_at: null },
    ]);
    expect(result.count).toBe(2);
    expect(result.complete).toBe(true);
    expect(result.contributions).toEqual({ u1: 2, u2: 1 });
  });
});

describe("event helpers", () => {
  it("upserts a realtime payload without duplicating an optimistic event", () => {
    expect(upsertById([{ id: "same", pending: true }], { id: "same", pending: false })).toEqual([
      { id: "same", pending: false },
    ]);
  });

  it("only permits the actor to undo within ten minutes", () => {
    const now = new Date("2026-08-05T10:10:00Z").getTime();
    const event = { actor_id: "u1", occurred_at: "2026-08-05T10:01:00Z", undone_at: null };
    expect(isUndoable(event, "u1", now)).toBe(true);
    expect(isUndoable(event, "u2", now)).toBe(false);
    expect(isUndoable(event, "u1", now + 2 * 60 * 1000)).toBe(false);
  });

  it("distinguishes rejected business actions from retryable network failures", () => {
    expect(isTerminalOutboxError({ message: "Card is already complete" })).toBe(true);
    expect(isTerminalOutboxError({ message: "The undo window has expired" })).toBe(true);
    expect(isTerminalOutboxError({ message: "Failed to fetch" })).toBe(false);
  });
});
