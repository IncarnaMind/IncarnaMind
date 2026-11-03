/**
 * The evaluation's watcher for the app's own asks (#1226, #894): it counts the
 * change-claim ask and the ask for a capped summary's left-out Documents
 * apart, including the write-only ask the engine's last-step note follows.
 */
import { describe, expect, test } from "vitest";
import { ASKED_AGAIN, watchReasks } from "../../eval/everyday/reasks";
import { coverageNudge } from "../../src/core/answers/coverage";
import { streamingModel } from "../helpers/models";

const LAST_STEP =
  "You can make no more calls, and none can record a Citation now. Write the Answer now from what has been read, without Citation markers, and say plainly what you didn't check.";
const LEFT_OUT = { id: "d8", name: "Report 9", size: 1 };
const NUDGE = coverageNudge(
  { kind: "largest", used: [], rest: [LEFT_OUT.id] },
  [LEFT_OUT],
  "Done.",
);

const said = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});

const chatOf = (watch: ReturnType<typeof watchReasks>) =>
  watch.chatModels(() => streamingModel("ok"))({
    kind: "anthropic",
    modelId: "claude-haiku-5-5",
    apiKey: null,
    baseUrl: null,
  });

describe("The evaluation's watcher for the app's asks", () => {
  // protects=a write-only ask is counted once, though the engine's last-step note follows it; fails_when=it is missed or counted twice; no_claim=what the model writes.
  test("a write-only ask is counted once", async () => {
    const watch = watchReasks();
    const chat = chatOf(watch);
    watch.begin(null);
    await chat.doStream({
      prompt: [said("Summarise these documents"), said(NUDGE ?? ""), said(LAST_STEP)],
    });
    await chat.doStream({
      prompt: [said("Summarise these documents"), said(NUDGE ?? ""), said(LAST_STEP)],
    });

    expect(watch.end().coverage).toBe(1);
    expect(watch.end().again).toBe(0);
  });

  // protects=the change-claim ask still counts as `again`, not as the coverage ask; fails_when=it is read as coverage; no_claim=what the model writes.
  test("the change-claim ask counts as again", async () => {
    const watch = watchReasks();
    const chat = chatOf(watch);
    watch.begin(null);
    await chat.doStream({ prompt: [said("Summarise these documents"), said(ASKED_AGAIN)] });

    expect(watch.end().again).toBe(1);
    expect(watch.end().coverage).toBe(0);
  });
});
