import { describe, expect, it } from "vitest";
import { base64UrlToUint8Array } from "./push.js";

describe("Push helpers", () => {
  it("converts a URL-safe VAPID key into browser subscription bytes", () => {
    expect([...base64UrlToUint8Array("AQID-_8")]).toEqual([1, 2, 3, 251, 255]);
  });
});
