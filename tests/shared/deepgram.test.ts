import { describe, expect, test } from "vitest";
import { typedServerChecksKey } from "../../src/shared/deepgram";

describe("A server typed for Deepgram", () => {
  test("left empty or Deepgram's own, in any region, gets the key to check", () => {
    expect(typedServerChecksKey("")).toBe(true);
    expect(typedServerChecksKey("  ")).toBe(true);
    expect(typedServerChecksKey("wss://api.deepgram.com/v1/listen")).toBe(true);
    expect(typedServerChecksKey("https://api.eu.deepgram.com")).toBe(true);
  });

  test("Cloudflare's or the User's own is never sent the key to check", () => {
    expect(
      typedServerChecksKey(
        "https://api.cloudflare.com/client/v4/accounts/0f0e0d/ai/run/@cf/deepgram/nova-3",
      ),
    ).toBe(false);
    expect(typedServerChecksKey("ws://localhost:8080")).toBe(false);
    expect(typedServerChecksKey("wss://notdeepgram.com/v1/listen")).toBe(false);
  });

  test("one that can't be read says the key is checked, never less than is sent", () => {
    expect(typedServerChecksKey("api.cloudflare.com")).toBe(true);
  });
});
