/**
 * Paired runs of eval:speed (eval/speed/README.md): an arm's requests go as that arm has them,
 * and the guards hold or fail item by item.
 */
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { type Arm, armNamed, armSwitch } from "../../eval/speed/arms";
import type { ArmRun } from "../../eval/speed/paired";
import { guards, newFalseSupported, type PairedRow } from "../../eval/speed/pairedReport";
import {
  type AnswerPathsOverride,
  retrievesFirst,
  writesThenCites,
} from "../../src/core/providers/catalog/answerPaths";

const RUN: ArmRun = {
  status: "done",
  error: null,
  firstSignMs: 10,
  firstWordsMs: 3000,
  doneMs: 5000,
  modelCalls: 3,
  answerCalls: 3,
  inputTokens: 30_000,
  outputTokens: 900,
  citations: 2,
  found: 2,
  cited: true,
  grade: "right",
  falseSupported: 0,
  duplicate: false,
  failures: [],
  text: "The tide turns twice a day.[^1]",
};

const row = (baseline: Partial<ArmRun>, candidate: Partial<ArmRun>, id = "en-01"): PairedRow => ({
  set: "gating",
  id,
  kind: "en",
  language: "en",
  model: "anthropic/claude-haiku-5-5",
  run: 1,
  baseline: { ...RUN, ...baseline },
  candidate: { ...RUN, ...candidate },
});

const named = (rows: PairedRow[], name: string) => guards(rows).find((each) => each.name === name);

describe("the guards", () => {
  test("an item the candidate no longer cites is lost, and the rate is lower", () => {
    const cited = named(
      [row({}, { cited: false }), row({}, {}, "en-02")],
      "Expected Passages cited",
    );
    expect(cited).toMatchObject({ baseline: 2, candidate: 1, lost: 1, gained: 0, holds: false });
  });

  test("a margin of one in 30 lets 30 items lose one", () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      row({}, index === 0 ? { cited: false } : {}, `en-${index}`),
    );
    expect(guards(rows).find((each) => each.name === "Expected Passages cited")?.holds).toBe(false);
    expect(guards(rows, 1).find((each) => each.name === "Expected Passages cited")).toMatchObject({
      lost: 1,
      allowed: 1,
      holds: true,
    });
  });

  test("one lost and one gained hold the rate", () => {
    const right = named(
      [row({}, { grade: "partly" }), row({ grade: "wrong" }, {}, "en-02")],
      "Judged right",
    );
    expect(right).toMatchObject({ baseline: 1, candidate: 1, lost: 1, gained: 1, holds: true });
  });

  test("a false Supported both arms give isn't new; one only the candidate gives is", () => {
    const both = row({ falseSupported: 1 }, { falseSupported: 1 });
    const fresh = row({}, { falseSupported: 1 }, "en-02");
    expect(newFalseSupported(both)).toBe(false);
    expect(newFalseSupported(fresh)).toBe(true);
    expect(named([both], "False Supported")?.holds).toBe(true);
    expect(named([both, fresh], "False Supported")).toMatchObject({ lost: 1, holds: false });
  });

  test("a duplicate Answer or an unmade change only the candidate gives fails", () => {
    const rows = [row({}, { duplicate: true, failures: ["unbacked"] })];
    expect(named(rows, "Duplicate Answer")?.holds).toBe(false);
    expect(named(rows, "Change claimed, none made")?.holds).toBe(false);
  });

  test("items an arm failed to run are left out of the other guards and counted apart", () => {
    const rows = [row({}, { status: "failed", error: "overloaded", cited: null })];
    expect(named(rows, "Expected Passages cited")).toBeUndefined();
    expect(named(rows, "Failed to run")).toMatchObject({ baseline: 0, candidate: 1, holds: false });
  });
});

describe("the arm switch", () => {
  test("each request goes as the arm in use has it", async () => {
    const systems: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const system = prompt.find((message) => message.role === "system");
        systems.push(system?.role === "system" ? system.content : "");
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const today: Arm = { id: "today", label: "today" };
    const shorter: Arm = {
      id: "shorter",
      label: "shorter",
      request: (params) => ({
        ...params,
        prompt: params.prompt.map((message) =>
          message.role === "system" ? { ...message, content: "Be brief." } : message,
        ),
      }),
    };
    const switcher = armSwitch();
    const wrapped = switcher.chatModels(() => model)({
      kind: "anthropic",
      modelId: "claude-haiku-5-5",
      apiKey: null,
      baseUrl: null,
    });
    for (const arm of [today, shorter, today]) {
      switcher.use(arm);
      await generateText({ model: wrapped, instructions: "Answer.", prompt: "Hi" });
    }
    expect(systems).toEqual(["Answer.", "Be brief.", "Answer."]);
  });
});

describe("the arms' Answer paths", () => {
  // An Answer writes first when it retrieves first or writes then cites (src/core/answers/index.ts).
  const pathOf = (model: { catalogId: string; modelId: string }, paths: AnswerPathsOverride) => {
    const searchesFirst = retrievesFirst(model, paths);
    return { searchesFirst, writesFirst: searchesFirst || writesThenCites(model, paths) };
  };

  test.each([
    [
      "Claude Sonnet 5.5, on no list",
      "claude-sonnet-5-5",
      { searchesFirst: false, writesFirst: false },
    ],
    [
      "Claude Haiku 5.5, on both lists",
      "claude-haiku-5-5",
      { searchesFirst: true, writesFirst: true },
    ],
  ])(
    "%s: each arm decides the path it compares, the citation arms in the loop from its first call; today keeps the lists'",
    (_, modelId, listed) => {
      const switcher = armSwitch();
      const model = { catalogId: "anthropic", modelId };
      const seen = Object.fromEntries(
        ["cite-first", "write-then-cite", "loop", "retrieve-first", "today"].map((id) => {
          switcher.use(armNamed(id));
          return [id, pathOf(model, switcher.answerPaths)];
        }),
      );
      expect(seen).toEqual({
        "cite-first": { searchesFirst: false, writesFirst: false },
        "write-then-cite": { searchesFirst: false, writesFirst: true },
        loop: { searchesFirst: false, writesFirst: listed.writesFirst },
        "retrieve-first": { searchesFirst: true, writesFirst: true },
        today: listed,
      });
    },
  );
});
