import { describe, expect, test } from "vitest";
import type { AnswerToolCall, MindChange } from "../../src/core";
import { unbackedClaims } from "../../src/core/answers/claimedChanges";
import { toolRecordLines } from "../../src/core/answers/toolRecord";
import { scriptedModel } from "../helpers/models";

const MINDS = [
  { id: "q3", name: "Q3 review" },
  { id: "weekly", name: "周报" },
  { id: "tides", name: "Tide notes" },
  { id: "papers", name: "Paper summaries" },
];
const names = (id: string) => MINDS.find((mind) => mind.id === id)?.name ?? null;

const mindCall = (tool: string, change: Partial<MindChange> | null): AnswerToolCall => ({
  id: `${tool}-1`,
  tool,
  source: "minds",
  input: {},
  status: change ? "done" : "failed",
  resultCount: null,
  ...(change && {
    mindChange: { mindId: "q3", created: false, request: "r1", proposals: 2, ...change },
  }),
});

function judge(verdict: unknown) {
  return scriptedModel(() => ({ text: "" }), {
    generate: () => ({ text: typeof verdict === "string" ? verdict : JSON.stringify(verdict) }),
  });
}

async function check(
  model: ReturnType<typeof judge>,
  reply: string,
  calls: AnswerToolCall[] = [],
  focused: string | null = null,
) {
  return unbackedClaims(reply, calls, MINDS, focused, {
    model,
    names,
    signal: new AbortController().signal,
  });
}

describe("The quick model's verdict", () => {
  test.each([
    "Done — the summary is now on the page.",
    "Your summary is in “Q3 review” now.",
    "Here it is in a new Note, “Library summary”.",
    "I've renamed the page to “Q3 summary”.",
    "总结已经放在页面里了。",
    "好了，第二段现在更清楚了。",
    "已在新的笔记中整理好总结。",
  ])("an unmade claim is returned unbacked: %s", async (reply) => {
    const result = await check(
      judge({ claims: [{ sentence: reply, kind: "changed", about: "mind", backed: false }] }),
      reply,
    );

    expect(result.claims).toEqual(["changed"]);
    expect(result.usage?.inputTokens).toBe(5);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("a verdict's straight quotes match the reply's curly quotes", async () => {
    const reply = "I've renamed the page to “Q3 summary”.";
    const sentence = 'I\'ve renamed the page to "Q3 summary".';
    const result = await check(
      judge({ claims: [{ sentence, kind: "changed", about: "mind", backed: false }] }),
      reply,
    );
    expect(result.claims).toEqual(["changed"]);
  });

  test.each([
    "The page was created on 3 March 2021 to track the project.",
    "The new page replaces the version published in 2019.",
    "第二版中，已经修改了摘要部分的实验结论。",
    "这份总结已经完成于2023年。",
    "The authors updated the report in 2024.",
  ])("a Document description is not a change claim: %s", async (reply) => {
    const result = await check(judge({ claims: [] }), reply);
    expect(result.claims).toEqual([]);
  });

  test("the record, not the old wording patterns, decides", async () => {
    const reply = "I added a risks section to “Q3 review”.";
    const backed = judge({
      claims: [{ sentence: reply, kind: "added", about: "mind", backed: true }],
    });
    const unbacked = judge({
      claims: [{ sentence: reply, kind: "added", about: "mind", backed: false }],
    });

    expect((await check(backed, reply, [mindCall("add_to_mind", {})])).claims).toEqual([]);
    expect((await check(unbacked, reply, [mindCall("add_to_mind", null)])).claims).toEqual([
      "added",
    ]);
  });

  test("a chart the record says wasn't drawn is in the judge's record, so a reply claiming it is asked again (#2378)", async () => {
    const reply = "I added the bar chart of total order amount by region to the Note.";
    const call = mindCall("add_to_mind", { tables: 1, chartNotDrawn: "noTable" });
    const model = judge({
      claims: [{ sentence: reply, kind: "added", about: "mind", backed: false }],
    });
    const result = await check(model, reply, [call]);
    expect(result.claims).toEqual(["added"]);
    const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain('\\"chartNotDrawn\\": \\"noTable\\"');
  });

  test("the turn's record names a chart drawn, and one asked for but not drawn (#2378)", () => {
    expect(toolRecordLines([mindCall("add_to_mind", { tables: 1, charts: 1 })], names)).toEqual([
      "- add_to_mind “Q3 review”: proposed 2 new Blocks, waiting for the User, 1 table among them, 1 chart among them",
    ]);
    expect(
      toolRecordLines([mindCall("add_to_mind", { tables: 1, chartNotDrawn: "noTable" })], names),
    ).toEqual([
      "- add_to_mind “Q3 review”: proposed 2 new Blocks, waiting for the User, 1 table among them; the chart asked for was not drawn: nothing was written as a table",
    ]);
  });

  test("a chart the record says was drawn is named in it", async () => {
    const reply = "I added the bar chart to the Note.";
    const model = judge({
      claims: [{ sentence: reply, kind: "added", about: "mind", backed: true }],
    });
    await check(model, reply, [mindCall("add_to_mind", { charts: 1 })]);
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('\\"charts\\": 1');
  });

  test("a claim about the focused Mind is checked with its name", async () => {
    const reply = "我已把摘要写进你的笔记里。";
    const model = judge({ claims: [] });
    await check(model, reply, [mindCall("add_to_mind", {})], "q3");
    const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain('\\"id\\": \\"q3\\"');
    expect(prompt).toContain('\\"name\\": \\"Q3 review\\"');
  });

  // Value: protects=the judge can distinguish completed and unmade Mind commands; fails_when=run_command loses its input, affected items or renamed target; why_new=review found generic command records; seam=the exact structured judge prompt; no_claim=model wording beyond the supplied record
  test("run_command records carry the command, input and affected Mind items", async () => {
    const model = judge({ claims: [] });
    const calls: AnswerToolCall[] = [
      {
        id: "rename",
        tool: "run_command",
        source: "commands",
        input: { command: "mind.rename", ids: ["q3"], name: "Q3 summary" },
        status: "done",
        resultCount: null,
        command: {
          command: "mind.rename",
          run: "r1",
          items: [{ kind: "mind", id: "q3", name: "Q3 review", renamed: "Q3 summary" }],
        },
      },
      {
        id: "delete",
        tool: "run_command",
        source: "commands",
        input: { command: "mind.delete", ids: ["weekly"] },
        status: "done",
        resultCount: null,
        command: {
          command: "mind.delete",
          run: "r2",
          items: [{ kind: "mind", id: "weekly", name: "周报" }],
        },
      },
    ];

    await check(model, "I renamed and deleted the pages.", calls);

    const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain("mind.rename");
    expect(prompt).toContain("mind.delete");
    expect(prompt).toContain("Q3 summary");
    expect(prompt).toContain("周报");
    expect(prompt).toContain('\\"ids\\"');
  });

  test.each(["typo", undefined])(
    "a verdict with an invalid change kind finds nothing: %s",
    async (kind) => {
      const result = await check(
        judge({ claims: [{ sentence: "An honest Answer.", kind, backed: false }] }),
        "An honest Answer.",
      );
      expect(result.claims).toEqual([]);
    },
  );

  test("a blank reply costs no judge call", async () => {
    const model = judge({ claims: [] });
    expect((await check(model, "  ")).claims).toEqual([]);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  test("a failed check finds nothing rather than flagging an honest reply", async () => {
    const model = scriptedModel(() => ({ text: "" }), {
      generate: () => ({ error: { status: 503, message: "offline" } }),
    });
    expect((await check(model, "An honest Answer.")).claims).toEqual([]);
  });

  test("an unreadable verdict finds nothing", async () => {
    expect((await check(judge("not JSON"), "An honest Answer.")).claims).toEqual([]);
  });
});

describe("What the judge says the sentence is about (#2194)", () => {
  const english = "I've sorted out what the Volunteer Handbook says.";
  const chinese = "我整理了手册的要点。";

  // protects=the four values the judge uses for what a claim is not about each drop it, in English and Chinese; fails_when=a claim it calls the reply's, a Document's, an offer or a negation is flagged; no_claim=what a real judge answers (the pull request's runs).
  test.each(["reply", "document", "offer_or_question", "negation"] as const)(
    "about %s finds nothing",
    async (about) => {
      for (const reply of [english, chinese]) {
        const result = await check(
          judge({ claims: [{ sentence: reply, kind: "added", about, backed: false }] }),
          reply,
        );
        expect(result.claims).toEqual([]);
      }
    },
  );

  // protects=a claim the judge calls a change to a Mind flags, backed false; fails_when=the line goes missing for a real claim; no_claim=none beyond protects.
  test("about mind flags", async () => {
    for (const reply of [english, chinese]) {
      const result = await check(
        judge({ claims: [{ sentence: reply, kind: "added", about: "mind", backed: false }] }),
        reply,
      );
      expect(result.claims).toEqual(["added"]);
    }
  });

  // protects=a provider that ignores the schema, and a judge that omits or invents about, cannot silently drop a real claim: no about, and an unknown one, flag as they did before the field, in English and Chinese; fails_when=a claim is lost because the field is missing or unknown; no_claim=how a provider ignores the schema.
  test.each(["omitted", "unknown"] as const)("about %s flags", async (how) => {
    for (const reply of [english, chinese]) {
      const claim =
        how === "omitted"
          ? { sentence: reply, kind: "added", backed: false }
          : { sentence: reply, kind: "added", about: "Mind", backed: false };
      const result = await check(judge({ claims: [claim] }), reply);
      expect(result.claims).toEqual(["added"]);
    }
  });
});
