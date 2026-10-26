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
import { documentInstructions, WRITE_THEN_CITE } from "../../src/core/answers/prompt";

const RUN: ArmRun = {
  status: "done",
  error: null,
  firstSignMs: 10,
  firstWordsMs: 3000,
  doneMs: 5000,
  modelCalls: 3,
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

describe("the cite-first arm", () => {
  test("gives cite's replies their words of before #489", () => {
    const sent = armNamed("cite-first").request?.({
      prompt: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "cite",
              output: {
                type: "text",
                value:
                  "Recorded [^1]. Write the Answer now if your reply's text hasn't given it yet (your thinking isn't shown); don't repeat it.",
              },
            },
          ],
        },
      ],
    });
    const part = sent?.prompt[0]?.role === "tool" ? sent.prompt[0].content[0] : undefined;
    expect(part?.type === "tool-result" && part.output).toEqual({
      type: "text",
      value: "Recorded [^1]. Write the Answer now if you haven't yet; don't repeat it.",
    });
  });

  test("gives a request the Tool loop's citing lines of before #489, in their order", () => {
    const today = documentInstructions(
      "tools",
      { total: 1, names: ["Tides"] },
      "",
      false,
      false,
      true,
      true,
    );
    const arm = armNamed("cite-first");
    const sent = arm.request?.({ prompt: [{ role: "system", content: today }] });
    const system = sent?.prompt[0]?.role === "system" ? sent.prompt[0].content : "";
    const lines = system.split("\n");
    const at = (start: string) => lines.findIndex((line) => line.startsWith(start));

    for (const line of WRITE_THEN_CITE) expect(lines).not.toContain(line);
    expect(system).not.toContain("Text you write into a Mind is the exception");
    expect(at("- Before writing the Answer, call cite once")).toBe(at("Cite every claim") + 1);
    expect(at("- Copy each quote as one unbroken")).toBeGreaterThan(at("- Before writing"));
    expect(lines).toContain(
      "- Use quotation marks only around a Document's exact words, in its own language, the same as the record's quote, never a translation of them: that goes after the closing mark, as “…”（译：…）.",
    );
    expect(at("- In the Answer, put the marker")).toBeGreaterThan(at("- Use quotation marks"));
    expect(at("- A Citation shown with an id")).toBeGreaterThan(at("- In the Answer"));
    expect(at("- Write nothing before your Tool calls")).toBe(
      at("- A Citation shown with an id") + 1,
    );
    expect(system.slice(system.indexOf("- Write nothing before your Tool calls"))).toBe(
      today
        .slice(today.indexOf("- Write nothing before a search"))
        .replace(
          "- Write nothing before a search: only the Answer, once you have what it needs.",
          "- Write nothing before your Tool calls: only the Answer, after them.",
        ),
    );
  });
});
