/**
 * Paired runs of eval:speed (eval/speed/README.md): an arm's requests go as that arm has them,
 * and the guards hold or fail item by item.
 */
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { openLibrary } from "../../eval/lib/library";
import { type Arm, armNamed, armSwitch } from "../../eval/speed/arms";
import {
  type ArmRun,
  type GroupOptions,
  openForArms,
  type RequestTiming,
} from "../../eval/speed/paired";
import {
  guards,
  newFalseSupported,
  type PairedRow,
  pairedSection,
  timeTable,
} from "../../eval/speed/pairedReport";
import { createFakeEmbedder } from "../../src/core/embedding/fake";
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
  searches: 1,
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

  test("counted over the set, a false Supported only the candidate gives holds against one only the baseline gives, and two against one don't", () => {
    const fresh = row({}, { falseSupported: 1 }, "en-01");
    const gone = row({ falseSupported: 1 }, {}, "en-02");
    const another = row({}, { falseSupported: 2 }, "en-03");
    const counted = (rows: PairedRow[]) =>
      guards(rows, 0, true).find((each) => each.name === "False Supported");

    expect(counted([fresh, gone])).toMatchObject({ lost: 1, gained: 1, holds: true });
    expect(counted([fresh, gone, another])).toMatchObject({ lost: 2, gained: 1, holds: false });
    expect(named([fresh, gone], "False Supported")?.holds).toBe(false);
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

describe("the arms' cores", () => {
  test("two arms writing a Note of the same title each see only their own", async () => {
    const group = {
      async open(options: GroupOptions) {
        const library = await openLibrary({ ...options, name: "paired-notes", documents: [] });
        return { library, close: () => library.close() };
      },
    };
    const opened = await openForArms(group, () => ({
      embedder: createFakeEmbedder(),
      keep: false,
      log: () => undefined,
      embeddings: false,
    }));
    try {
      for (const { library } of opened) {
        await library.core.createMind({ title: "Library summary" });
      }
      for (const { library } of opened) {
        const titled = (await library.core.listMinds()).filter(
          (mind) => mind.title === "Library summary",
        );
        expect(titled).toHaveLength(1);
      }
      expect(opened[0].library.dataDir).not.toBe(opened[1].library.dataDir);
    } finally {
      await Promise.all(opened.map((each) => each.close()));
    }
  });

  test("when the second arm's library fails to open, the first is closed", async () => {
    const closed: string[] = [];
    let opens = 0;
    const group = {
      async open(options: GroupOptions) {
        opens += 1;
        if (opens === 2) throw new Error("The second library didn't open.");
        const library = await openLibrary({ ...options, name: "paired-notes", documents: [] });
        return {
          library,
          async close() {
            closed.push(library.dataDir);
            await library.close();
          },
        };
      },
    };

    await expect(
      openForArms(group, () => ({
        embedder: createFakeEmbedder(),
        keep: false,
        log: () => undefined,
        embeddings: false,
      })),
    ).rejects.toThrow("The second library didn't open.");
    expect(closed).toHaveLength(1);
  });
});

describe("the report", () => {
  test("counts the Answers that searched more than once", () => {
    const section = pairedSection(
      [row({ searches: 1 }, { searches: 2 }), row({ searches: 1 }, { searches: 1 }, "en-02")],
      ["loop", "retrieve-first"],
    );
    expect(section).toContain("| Searched more than once | 0 of 2 | 1 of 2 | |");
  });

  test("a language's table judges no guard: the set's own table does", () => {
    const section = pairedSection(
      [row({}, { grade: "wrong" })],
      ["loop", "retrieve-first"],
      1,
      false,
    );
    expect(section).toContain("| Judged right | 1 | 0 | 1 / 0 | – |");
    expect(section).not.toContain("**no**");
  });

  test("leaves the row out where no search was counted", () => {
    const section = pairedSection(
      [row({ searches: null }, { searches: null })],
      ["loop", "retrieve-first"],
    );
    expect(section).not.toContain("Searched more than once");
    expect(section).toContain("| Answered in one call | 0 of 1 | 0 of 1 | |");
  });
});

describe("where a help reply's time went", () => {
  const request = (model: string, startMs: number, step: string | null = null): RequestTiming => ({
    kind: "model",
    step,
    model,
    reasoning: null,
    startMs,
    firstByteMs: 500,
    firstReasoningMs: null,
    firstTextMs: 700,
    firstToolMs: null,
    endMs: 1500,
    inputTokens: 4000,
    outputTokens: 200,
  });

  test("times each of the reply's own requests from the User's action, apart from the other steps' requests, and counts a reply written again by another model", () => {
    const table = timeTable(
      [
        row(
          { requests: [request("sonnet", 100), request("haiku", 1700, "change-claim-check")] },
          { requests: [request("haiku", 100), request("sonnet", 1700)], firstOptionMs: 900 },
        ),
      ],
      ["today", "quick-help"],
    );

    expect(table).toContain("| Request 1: first byte | 0.6 s | 0.6 s |");
    expect(table).toContain("| Request 2: end | – | 3.2 s |");
    expect(table).toContain("| Written again by another model (share) | 0.00 | 1.00 |");
    expect(table).toContain("| Requests for change-claim-check, how many | 1.00 | 0.00 |");
    expect(table).toContain("| First whole option | – | 0.9 s |");
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
  // In the question flow, the one the arms' sets ask in.
  const pathOf = (model: { catalogId: string; modelId: string }, paths: AnswerPathsOverride) => ({
    searchesFirst: retrievesFirst(model, "question", paths),
    writesFirst: writesThenCites(model, "question", paths),
  });

  test.each([
    ["A model on no list", false, { searchesFirst: false, writesFirst: false }],
    ["A model on the write-then-cite list only", true, { searchesFirst: false, writesFirst: true }],
  ])(
    "%s: each arm decides the path it compares, the citation arms in the loop from its first call; today keeps the lists'",
    (_, onList, listed) => {
      const switcher = armSwitch();
      const model = { catalogId: "anthropic", modelId: "claude-haiku-5-5" };
      // The lists name no model since #2720, so a list naming this one stands in wherever an
      // arm leaves the path to the lists.
      const paths: AnswerPathsOverride = {
        writesThenCites: (each) =>
          switcher.answerPaths.writesThenCites?.(each) ?? (onList || undefined),
        retrievesFirst: (each) => switcher.answerPaths.retrievesFirst?.(each),
      };
      const seen = Object.fromEntries(
        ["cite-first", "write-then-cite", "loop", "retrieve-first", "today"].map((id) => {
          switcher.use(armNamed(id));
          return [id, pathOf(model, paths)];
        }),
      );
      expect(seen).toEqual({
        "cite-first": { searchesFirst: false, writesFirst: false },
        "write-then-cite": { searchesFirst: false, writesFirst: true },
        loop: { searchesFirst: false, writesFirst: listed.writesFirst },
        "retrieve-first": { searchesFirst: true, writesFirst: listed.writesFirst },
        today: listed,
      });
    },
  );
});
