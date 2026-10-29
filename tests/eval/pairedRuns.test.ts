/**
 * Paired runs of eval:speed (eval/speed/README.md): an arm's requests go as that arm has them,
 * and the guards hold or fail item by item.
 */
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { Library } from "../../eval/lib/library";
import { createTimingRecorder } from "../../eval/lib/timing";
import { type Arm, armNamed, armSwitch } from "../../eval/speed/arms";
import { type ArmRun, runOnArm, writesSet } from "../../eval/speed/paired";
import {
  byFlowTable,
  guards,
  newFalseSupported,
  type PairedRow,
} from "../../eval/speed/pairedReport";
import {
  type AnswerPathsOverride,
  retrievesFirst,
  writesThenCites,
} from "../../src/core/providers/catalog/answerPaths";
import { checkReply, isCheckRun } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { type ScriptedReply, scriptedModel, scriptedModels } from "../helpers/models";

const RUN: ArmRun = {
  status: "done",
  error: null,
  firstSignMs: 10,
  firstWordsMs: 3000,
  firstChangeMs: null,
  doneMs: 5000,
  modelCalls: 3,
  answerCalls: 3,
  inputTokens: 30_000,
  outputTokens: 900,
  checkCalls: 0,
  claimChecks: 0,
  toolInputMs: null,
  endedAtWrite: null,
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

describe("the write-replies arm (#1635)", () => {
  // protects=the arm that runs writes as before #1635 offers the write Tools without done and leaves every other Tool and field as it was; fails_when=a write Tool keeps done, or another Tool or field changes; no_claim=how a model reads either schema.
  test("the write Tools offer no done; every other Tool and field is as sent", () => {
    const schema = (properties: Record<string, { type: string }>) => ({
      type: "object" as const,
      properties,
    });
    const tools = [
      {
        type: "function" as const,
        name: "add_to_mind",
        inputSchema: schema({ content: { type: "string" }, done: { type: "boolean" } }),
      },
      {
        type: "function" as const,
        name: "edit_mind",
        inputSchema: schema({ part: { type: "string" }, done: { type: "boolean" } }),
      },
      {
        type: "function" as const,
        name: "lookup_tide",
        inputSchema: schema({ done: { type: "boolean" } }),
      },
    ];
    const sent = armNamed("write-replies").request?.({ prompt: [], tools, temperature: 0 });
    expect(sent?.temperature).toBe(0);
    expect(
      sent?.tools?.map((tool) =>
        tool.type === "function" ? [tool.name, Object.keys(tool.inputSchema.properties ?? {})] : [],
      ),
    ).toEqual([
      ["add_to_mind", ["content"]],
      ["edit_mind", ["part"]],
      ["lookup_tide", ["done"]],
    ]);
  });
});

describe("the arms' Answer paths", () => {
  // An Answer in the question flow, the one the arms' sets ask in, writes first when it retrieves
  // first or writes then cites (src/core/answers/index.ts).
  const pathOf = (model: { catalogId: string; modelId: string }, paths: AnswerPathsOverride) => {
    const searchesFirst = retrievesFirst(model, "question", paths);
    return {
      searchesFirst,
      writesFirst: searchesFirst || writesThenCites(model, "question", paths),
    };
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

describe("the writes set, end to end on a scripted model (#1635)", { timeout: 60_000 }, () => {
  const ESG = "The bank will cut its financed emissions by 45% by 2032";
  const MODEL = "scripted/local-model";

  // protects=the paired run's writes set runs the eight-paragraph flow on both arms in one core, write-replies sending no done and today ending at the write, and its by-flow table reads both; fails_when=an arm, the flow, a column or the table is wired wrong, which a $40 real-model run would find first; no_claim=any real model's times or choices.
  test("eight paragraphs into the page: write-replies replies, today ends at the write", async () => {
    const model = scriptedModel((call): ScriptedReply => {
      if (isCheckRun(call)) return checkReply(call, {});
      const made = (name: string) => call.results.some((each) => each.tool === name);
      if (!made("search_documents")) {
        return { calls: [{ tool: "search_documents", input: { query: "emissions targets" } }] };
      }
      if (!made("cite")) {
        const [shown] = call.results
          .filter((each) => each.tool === "search_documents")
          .flatMap((each) => shownPassages(each.text));
        const record = { marker: 1, passage: shown?.id ?? "", quote: ESG };
        return { calls: [{ tool: "cite", input: { citations: [record] } }] };
      }
      if (!made("add_to_mind")) {
        // As a real model, it can give done only when the Tool offers it.
        const offered = call.options.tools?.find(
          (each) => each.type === "function" && each.name === "add_to_mind",
        );
        const done =
          offered?.type === "function" && "done" in (offered.inputSchema.properties ?? {});
        const content = Array.from(
          { length: 8 },
          (_, index) => `Target ${index + 1}: ${ESG} [^1].`,
        ).join("\n\n");
        return {
          calls: [{ tool: "add_to_mind", input: { content, ...(done && { done: true }) } }],
        };
      }
      return { text: "Wrote the summary into your notes." };
    });
    const switcher = armSwitch();
    const { core, dataDir, documents } = await setUpWithDocuments(
      model,
      [{ name: "ESG report.md", contents: `# ESG report\n\n${ESG}.\n` }],
      { createChatModel: switcher.chatModels(scriptedModels(model).createChatModel) },
    );
    const recorder = createTimingRecorder();
    const library: Library = {
      core,
      timings: recorder,
      dataDir,
      documents: new Map(documents.map((document) => [document.name, document])),
      processingSeconds: 0,
      passageCount: 0,
      pageTexts: () => [],
      passagePages: () => null,
      passages: () => [],
      close: async () => {},
    };
    const [group] = writesSet();
    expect(group?.items.map((item) => `${item.id} ${item.language}`)).toEqual([
      "assistant-write en",
      "assistant-write zh-CN",
      "assistant-write-long en",
      "assistant-write-long zh-CN",
      "assistant-longer en",
      "assistant-longer zh-CN",
    ]);
    const item = group?.items.find(
      (each) => each.id === "assistant-write-long" && each.language === "en",
    );
    if (!item) throw new Error("No eight-paragraph item.");

    const runs: ArmRun[] = [];
    for (const arm of ["write-replies", "today"]) {
      switcher.use(armNamed(arm));
      runs.push(
        await runOnArm(item, {
          library,
          recorder,
          choice: { providerId: "", modelId: "local-model" },
          model: MODEL,
          arm,
          grade: async () => "right",
          claimsJudge: model,
        }),
      );
    }

    const [before, after] = runs;
    expect(before).toMatchObject({ status: "done", endedAtWrite: false, claimChecks: 1 });
    expect(after).toMatchObject({ status: "done", endedAtWrite: true, claimChecks: 0 });
    expect(after?.answerCalls).toBe((before?.answerCalls ?? 0) - 1);
    for (const run of runs) {
      expect(run.firstChangeMs).not.toBeNull();
      expect(run.toolInputMs).not.toBeNull();
      expect(run.checkCalls).toBeGreaterThan(0);
    }
    const table = byFlowTable(
      [
        {
          set: "writes",
          id: item.id,
          kind: item.kind,
          language: "en",
          model: MODEL,
          run: 1,
          baseline: before ?? RUN,
          candidate: after ?? RUN,
        },
      ],
      ["write-replies", "today"],
    );
    expect(table).toContain("| assistant-write-long | en | 1 |");
    expect(table).toContain("| 0 / 1 |");
  });
});
