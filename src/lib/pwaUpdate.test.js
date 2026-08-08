import { describe, expect, it } from "vitest";
import { canApplyPwaUpdate, updateBlockReason } from "./pwaUpdate.js";

describe("PWA update safety", () => {
  it("allows an update only when online and the outbox is empty", () => {
    expect(canApplyPwaUpdate({ online: true, queueLength: 0, syncing: false })).toBe(true);
    expect(updateBlockReason({ online: true, queueLength: 0, syncing: false })).toBeNull();
  });

  it("keeps the update waiting while offline or while interactions are syncing", () => {
    expect(canApplyPwaUpdate({ online: false, queueLength: 0, syncing: false })).toBe(false);
    expect(updateBlockReason({ online: false, queueLength: 2, syncing: false })).toContain("離線");
    expect(canApplyPwaUpdate({ online: true, queueLength: 1, syncing: false })).toBe(false);
    expect(updateBlockReason({ online: true, queueLength: 1, syncing: false })).toContain("1 筆");
    expect(canApplyPwaUpdate({ online: true, queueLength: 0, syncing: true })).toBe(false);
  });
});
