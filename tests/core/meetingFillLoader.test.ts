import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createTempDataFolder } from "../helpers/core";
import { checkStructuredMeetingLoader } from "../helpers/meetingFillLoader";

async function setup() {
  const picked = ["en", "zh"].flatMap((language) =>
    [1, 2, 3].map((index) => `reserved-${language}-structured-toy-${index}`),
  );
  const calls = picked.map((id) => ({ id, facts: [] as { kind: string; underLine?: string }[] }));
  const first = calls[0];
  if (!first) throw new Error("Missing toy call.");
  first.facts = Array.from({ length: 26 }, (_, index) => ({
    kind: index < 6 ? "decision" : "action",
    ...(index < 12 && { underLine: "Toy note text must not enter the receipt" }),
  }));
  const receipt = join(await createTempDataFolder(), "loader-receipt.json");
  const environment: Record<string, string | undefined> = {
    INCARNAMIND_STRUCTURED_LOADER_PREFLIGHT: "1",
    INCARNAMIND_STRUCTURED_CANDIDATE: "a".repeat(40),
    INCARNAMIND_STRUCTURED_SOURCE_FREEZE_SHA256: "b".repeat(64),
    INCARNAMIND_STRUCTURED_PREFLIGHT_RECEIPT: receipt,
    INCARNAMIND_LIVE_CALLS: picked.join(","),
  };
  const counts = { fetch: 0, provider: 0 };
  const load = vi.fn(async (_picked: readonly string[]) => calls);
  return { calls, receipt, environment, load, counts, attempts: () => counts, picked };
}

test("the preflight records actual returned inventory and source order, without fixture prose", async () => {
  const input = await setup();
  input.calls.reverse();
  const result = await checkStructuredMeetingLoader(input);
  expect(input.load).toHaveBeenCalledExactlyOnceWith(input.picked);
  expect(result.aggregate).toEqual({ calls: 6, decisions: 6, actions: 20, inPlaceFacts: 12 });
  expect(result.loaded_ids).toEqual(input.calls.map((call) => call.id));
  expect(result.requested_ids).toEqual(input.picked);
  expect(result.source_freeze_sha256).toBe(
    input.environment.INCARNAMIND_STRUCTURED_SOURCE_FREEZE_SHA256,
  );
  const written = await readFile(input.receipt, "utf8");
  expect(JSON.parse(written)).toEqual(result);
  expect(written).not.toContain("Toy note text");
  await expect(checkStructuredMeetingLoader(input)).rejects.toMatchObject({ code: "EEXIST" });
});

test.each([undefined, "", "b".repeat(63), "B".repeat(64)])(
  "an invalid source-freeze hash %s is refused before opening the fixture",
  async (hash) => {
    const input = await setup();
    input.environment.INCARNAMIND_STRUCTURED_SOURCE_FREEZE_SHA256 = hash;
    await expect(checkStructuredMeetingLoader(input)).rejects.toThrow("controls");
    expect(input.load).not.toHaveBeenCalled();
    await expect(readFile(input.receipt, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each([
  "INCARNAMIND_LIVE_ANTHROPIC_KEY",
  "INCARNAMIND_LIVE_ANTHROPIC_MODEL",
  "INCARNAMIND_LIVE_DEEPSEEK_KEY",
  "INCARNAMIND_LIVE_DEEPSEEK_MODEL",
  "INCARNAMIND_LIVE_OLLAMA_MODEL",
  "INCARNAMIND_STRUCTURED_RECEIPT",
])("the keyless preflight rejects %s before reading its input", async (name) => {
  const input = await setup();
  input.environment[name] = "supplied";
  await expect(checkStructuredMeetingLoader(input)).rejects.toThrow("controls");
  expect(input.load).not.toHaveBeenCalled();
});

test.each(["mixed", "duplicate", "missing", "disabled"])(
  "invalid %s controls cannot open the fixture",
  async (variant) => {
    const input = await setup();
    if (variant === "disabled") input.environment.INCARNAMIND_STRUCTURED_LOADER_PREFLIGHT = "0";
    else {
      const picked = [...input.picked];
      if (variant === "mixed") picked[0] = "reserved-en-historical";
      if (variant === "duplicate") picked[0] = picked[1] ?? "";
      if (variant === "missing") picked.pop();
      input.environment.INCARNAMIND_LIVE_CALLS = picked.join(",");
    }
    await expect(checkStructuredMeetingLoader(input)).rejects.toThrow("controls");
    expect(input.load).not.toHaveBeenCalled();
  },
);

test.each(["fetch", "provider"] as const)(
  "even a caught %s attempt makes the loader preflight fail",
  async (kind) => {
    const input = await setup();
    input.load.mockImplementation(async () => {
      input.counts[kind]++;
      return input.calls;
    });
    await expect(checkStructuredMeetingLoader(input)).rejects.toThrow("attempted");
    await expect(readFile(input.receipt, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("exit-zero style success cannot replace actual expected fixture inventory", async () => {
  const input = await setup();
  input.calls[0]?.facts.pop();
  await expect(checkStructuredMeetingLoader(input)).rejects.toThrow("inventory");
  await expect(readFile(input.receipt, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
