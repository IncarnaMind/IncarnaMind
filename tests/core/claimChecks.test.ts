import { writeFile } from "node:fs/promises";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import type { ClaimCheckAction, ClaimCheckAttributes, Core, Document } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown } from "../../src/shared/claimChecks";
import {
  checkGenerate,
  checkingModel as checkingModelOf,
  checkReply,
  isCheckRun,
  type Plan,
  sentenceOf,
} from "../helpers/checks";
import {
  answerEnded,
  type SourceFile,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { createTempDataFolder, manualClock, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, sha256, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient, typeInto } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import {
  type GeneratedReply,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { xlsxOf } from "../helpers/office";

const TIDES = {
  name: "Tides.md",
  contents: [
    "# Tides",
    "",
    "Spring tides happen at new moon and at full moon, when the Sun and the Moon pull together.",
    "",
    "Harbours publish the times of high water every year.",
  ].join("\n"),
};

const BREAD = {
  name: "Bread.md",
  contents: "# Bread\n\nSourdough bread needs a starter fed with flour and water every day.",
};

const SUPPORTED = "Spring tides come at new and full moon.";
const CONTRADICTED = "Harbours publish the times of high water every week.";
const UNSUPPORTED = "Penguins nest on the cliffs above the harbour.";

const PLANS: Record<string, Plan> = {
  [SUPPORTED]: {
    verdict: "supported",
    quote: "Spring tides happen at new moon and at full moon",
    says: "Tides says spring tides happen at new and full moon.",
  },
  [CONTRADICTED]: {
    verdict: "contradicted",
    quote: "Harbours publish the times of high water every year.",
    says: "Tides says harbours publish them every year, not every week.",
  },
  [UNSUPPORTED]: { verdict: "unsupported" },
};

/** A model that checks as `PLANS` say, unless told otherwise. */
const checkingModel = (
  plans: Record<string, Plan> = PLANS,
  calls: ModelCall[] = [],
  evidence?: string,
) => checkingModelOf(plans, calls, evidence);

let blocks = 0;
const paragraph = (...content: JSONContent[]): JSONContent & { attrs: { id: string } } => ({
  type: "paragraph",
  attrs: { id: `block-${++blocks}` },
  content,
});
const text = (value: string, check?: ClaimCheckAttributes): JSONContent => ({
  type: "text",
  text: value,
  ...(check && { marks: [{ type: "claimCheck", attrs: check }] }),
});

/** A check as a crash leaves it: "checking", with no request running. */
const LEFT_CHECKING: ClaimCheckAttributes = {
  id: "left-checking",
  request: "",
  action: "check-against-documents",
  state: "checking",
  reason: null,
  detail: null,
  providerId: null,
  modelId: null,
  text: SUPPORTED,
  evidence: null,
  says: null,
  unsupported: null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt: "2026-10-12T09:00:00.000Z",
};

/** Selects the whole of a paragraph's text. */
const whole = (block: { attrs: { id: string } }, length: number) => ({
  from: { blockId: block.attrs.id, offset: 0 },
  to: { blockId: block.attrs.id, offset: length },
});

/** Each check in the Mind, as the editor shows it now. */
async function shownChecks(core: Core, client: MindClient, folderId: string | null = null) {
  await client.settled();
  const versions = new Map((await core.listDocuments()).map((each) => [each.id, each.contentHash]));
  return claimSpans(readMind(client)).map((span) => ({
    check: span.check,
    sentence: span.sentence.text,
    shown: claimCheckShown(span.check, {
      text: span.sentence.text,
      versions,
      folderId,
      scope: null,
    }),
  }));
}

/** A Mind with one paragraph of these sentences and the Tides Document (and `others`), checked by `model`. */
async function mindWith(
  sentences: readonly string[],
  model = checkingModel(),
  others: readonly SourceFile[] = [],
) {
  const setup = await setUpWithDocuments(model, [TIDES, ...others]);
  const body = sentences.join(" ");
  const block = paragraph(text(body));
  writeMind(setup.client, [block]);
  await setup.client.settled();
  const check = (
    action: ClaimCheckAction = "check-against-documents",
    range = whole(block, body.length),
  ) =>
    setup.core.checkSentences({
      requestId: crypto.randomUUID(),
      mindId: setup.mind.id,
      action,
      ...range,
    });
  return { ...setup, block, body, check, tides: setup.documents[0] as Document };
}

describe("The language of a check's sentence", () => {
  test.each([
    ["en", "English", "Simplified Chinese"],
    ["zh-CN", "Simplified Chinese", "English"],
  ] as const)(
    "is the interface's, %s, whatever language the sentence is in, and the request says so",
    async (language, named, other) => {
      const calls: ModelCall[] = [];
      const { core, check } = await mindWith([CONTRADICTED], checkingModel(PLANS, calls));
      await core.updateSettings({ user: { language } });

      await check();

      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.system).toContain(`one plain sentence in ${named}`);
        expect(call.system).not.toContain(`sentence in ${other}`);
        expect(JSON.stringify(call.options.prompt)).toContain(`Write your sentence in ${named}.`);
      }
    },
  );

  test("follows a sentence in Chinese too only as far as the interface does", async () => {
    const calls: ModelCall[] = [];
    const sentence = "涨潮每天发生两次。";
    const { check } = await mindWith([sentence], checkingModel({}, calls));

    await check();

    expect(JSON.stringify(calls[0]?.options.prompt)).toContain("Write your sentence in English.");
  });
});

describe("Check against Documents", () => {
  test("marks each sentence the selection touches with what its check found", async () => {
    const { core, client, check, tides } = await mindWith([SUPPORTED, CONTRADICTED, UNSUPPORTED]);

    expect(await check()).toEqual({ kind: "checked", sentences: 3, checked: 3, smallModel: false });

    const checks = await shownChecks(core, client);
    expect(checks.map((each) => [each.sentence, each.shown])).toEqual([
      [SUPPORTED, { state: "supported" }],
      [CONTRADICTED, { state: "contradicted" }],
      [UNSUPPORTED, { state: "unsupported" }],
    ]);
    const [supported, contradicted, unsupported] = checks.map((each) => each.check);
    expect(supported).toMatchObject({
      action: "check-against-documents",
      text: SUPPORTED,
      evidence: {
        documentId: tides.id,
        contentHash: tides.contentHash,
        quote: "Spring tides happen at new moon and at full moon",
        check: "found",
      },
      scope: { folderId: null, widened: false },
      versions: [{ documentId: tides.id, contentHash: tides.contentHash }],
    });
    expect(contradicted).toMatchObject({
      says: "Tides says harbours publish them every year, not every week.",
      evidence: { quote: "Harbours publish the times of high water every year." },
    });
    expect(unsupported).toMatchObject({ evidence: null, says: null });
  });

  test("a sentence only part selected is checked whole, and the others aren't", async () => {
    const { core, client, block, check } = await mindWith([SUPPORTED, UNSUPPORTED]);
    const inSecond = SUPPORTED.length + 5;

    expect(
      await check("check-against-documents", {
        from: { blockId: block.attrs.id, offset: inSecond },
        to: { blockId: block.attrs.id, offset: inSecond + 3 },
      }),
    ).toEqual({ kind: "checked", sentences: 1, checked: 1, smallModel: false });
    expect((await shownChecks(core, client)).map((each) => each.sentence)).toEqual([UNSUPPORTED]);
  });

  test.each([
    "Verdict: unsupported",
    "**Verdict:** Unsupported",
    "P1 is about spring tides, not penguins.\n\nVerdict: unsupported",
    "Unsupported. No Passage mentions penguins.",
    '{"verdict": "unsupported"}',
    "Verdict: contradicted\nP1 is about another harbour, so it doesn't bear on this.\nVerdict: unsupported",
  ])("reads the verdict however the model words it: %j", async (reply) => {
    const plans = { [UNSUPPORTED]: { reply: { text: reply } } };
    const { core, client, check } = await mindWith([UNSUPPORTED], checkingModel(plans));
    await check();
    expect((await shownChecks(core, client))[0]?.shown).toEqual({ state: "unsupported" });
  });

  test("a sentence holding a change still waiting is left out and counted; with only such sentences, nothing is sent", async () => {
    const calls: ModelCall[] = [];
    const { core, client, mind } = await setUpWithDocuments(checkingModel(PLANS, calls), [TIDES]);
    const change = { id: "change-1", request: "request-1", target: "x" };
    const block = paragraph(text(`${SUPPORTED} Penguins nest `), {
      type: "text",
      text: "on the cliffs above the harbour.",
      marks: [{ type: "proposalInsert", attrs: change }],
    });
    writeMind(client, [block]);
    await client.settled();
    const length = SUPPORTED.length + 1 + UNSUPPORTED.length;
    const check = (from: number) =>
      core.checkSentences({
        requestId: crypto.randomUUID(),
        mindId: mind.id,
        action: "check-against-documents",
        from: { blockId: block.attrs.id, offset: from },
        to: { blockId: block.attrs.id, offset: length },
      });

    const leftOut = {
      sentences: [
        {
          from: { blockId: block.attrs.id, offset: SUPPORTED.length + 1 },
          to: { blockId: block.attrs.id, offset: length },
        },
      ],
      changeIds: ["change-1"],
    };
    expect(await check(0)).toEqual({
      kind: "checked",
      sentences: 1,
      checked: 1,
      smallModel: false,
      waiting: leftOut,
    });
    expect((await shownChecks(core, client)).map((each) => each.sentence)).toEqual([SUPPORTED]);

    calls.length = 0;
    expect(await check(SUPPORTED.length + 1)).toEqual({ kind: "waiting", waiting: leftOut });
    expect(calls).toEqual([]);
  });

  test("with nothing to check against, nothing is sent", async () => {
    const calls: ModelCall[] = [];
    const model = checkingModel(PLANS, calls);
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const mind = await core.createMind({ title: "Empty" });
    const client = await connectToMind(core, mind.id);
    const block = paragraph(text(SUPPORTED));
    writeMind(client, [block]);
    await client.settled();

    expect(
      await core.checkSentences({
        requestId: "r1",
        mindId: mind.id,
        action: "check-against-documents",
        ...whole(block, SUPPORTED.length),
      }),
    ).toEqual({ kind: "no-documents", folderId: null });
    expect(calls).toEqual([]);
  });
});

describe("One claim check", () => {
  test("a sentence with no Citations sends none and one with Citations sends them, in the same check Run offered only search and cite", async () => {
    const calls: ModelCall[] = [];
    const { core, client, check } = await mindWith([SUPPORTED], checkingModel(PLANS, calls));
    await check();
    const uncited = calls.splice(0);

    const cited = paragraph(
      text(`${SUPPORTED.slice(0, -1)} `),
      {
        type: "citation",
        attrs: {
          documentName: "Tides",
          quote: "Spring tides happen at new moon and at full moon",
          check: "found",
        },
      },
      text("."),
    );
    writeMind(client, [cited]);
    await client.settled();
    await check("check-against-documents", whole(cited, SUPPORTED.length + 1));
    const withCitations = calls.splice(0);

    for (const call of [...uncited, ...withCitations]) {
      expect(call.tools.sort()).toEqual(["cite", "search_documents"]);
    }
    expect(withCitations[0]?.system).toBe(uncited[0]?.system);
    const asked = (call: ModelCall | undefined) =>
      call?.options.prompt.find((message) => message.role === "user")?.content;
    expect(JSON.stringify(asked(withCitations[0]))).toContain(
      "Tides: “Spring tides happen at new moon and at full moon”",
    );
    expect(JSON.stringify(asked(uncited[0]))).not.toContain("The User cites this");
    expect((await shownChecks(core, client)).map((each) => each.check.action)).toEqual([
      "check-against-documents",
    ]);
  });

  test("a request that still says Find support, as an older version's mark does, sends the Citations too", async () => {
    const calls: ModelCall[] = [];
    const { client, check } = await mindWith([SUPPORTED], checkingModel(PLANS, calls));
    const cited = paragraph(
      text(`${SUPPORTED.slice(0, -1)} `),
      {
        type: "citation",
        attrs: {
          documentName: "Tides",
          quote: "Spring tides happen at new moon and at full moon",
          check: "found",
        },
      },
      text("."),
    );
    writeMind(client, [cited]);
    await client.settled();

    await check("find-support", whole(cited, SUPPORTED.length + 1));

    const asked = calls[0]?.options.prompt.find((message) => message.role === "user")?.content;
    expect(JSON.stringify(asked)).toContain("The User cites this");
  });

  test("a contradiction counts only once the sentence and its quote, judged alone, conflict", async () => {
    const near = { ...PLANS[CONTRADICTED], judgement: "neither" as const };
    const { core, client, check } = await mindWith(
      [CONTRADICTED],
      checkingModel({ [CONTRADICTED]: near }),
    );
    await check();
    expect((await shownChecks(core, client))[0]?.shown).toEqual({ state: "unsupported" });

    const same = {
      ...PLANS[CONTRADICTED],
      judgement: "same" as const,
      part: "Covered: the times of high water\nNot covered: every week",
    };
    const again = await mindWith([CONTRADICTED], checkingModel({ [CONTRADICTED]: same }));
    await again.check();
    expect((await shownChecks(again.core, again.client))[0]).toMatchObject({
      shown: { state: "unsupported" },
      check: {
        unsupported: {
          covered: "the times of high water",
          uncovered: "every week",
          quoted: { quote: "Harbours publish the times of high water every year." },
        },
      },
    });
  });

  // protects=a request after the model's verdict that the provider rate-limits leaves the sentence not checked on the limit's reason, so the run tries it again: a contradiction is never shown unconfirmed, nor a verdict without its evidence, nor a wider Supported the parts ask would settle (#1618); fails_when=the sentence is Contradicted or Supported without the request that confirms it; no_claim=the run's pauses, which runItems' tests cover.
  test.each<[string, string, string, Plan]>([
    [
      "the contradiction's confirmation",
      CONTRADICTED,
      "Compare a sentence",
      PLANS[CONTRADICTED] as Plan,
    ],
    ["the evidence asked for again", SUPPORTED, "You checked a sentence", { verdict: "supported" }],
    [
      "the parts of a wider-supported sentence",
      SUPPORTED,
      "A sentence the User wrote says more",
      {
        verdict: "supported",
        quote: "Spring tides happen at new moon and at full moon",
        says: "Scope: wider\nTides says spring tides happen at new and full moon.",
      },
    ],
  ])(
    "%s rate-limited leaves the sentence not checked, on the rate limit",
    async (_, claim, asked, plan) => {
      const plans: Record<string, Plan> = { ...PLANS, [claim]: plan };
      const model = scriptedModel((call) => checkReply(call, plans), {
        generate: (call) =>
          call.system.startsWith(asked)
            ? { error: { status: 429, message: "Too many requests." } }
            : checkGenerate(plans)(call),
      });
      const { core } = await setUpWithDocuments(model, [TIDES]);

      expect(await core.checkClaim({ claim })).toMatchObject({
        verdict: "not-checked",
        reason: "rate-limit",
      });
    },
  );

  test("a supported reply whose roles differ from the Passage's shows the partly-supported card", async () => {
    const MUST = "Harbours must publish the times of high water every year.";
    const YEARLY = "Harbours publish the times of high water every year.";
    const calls: ModelCall[] = [];
    const supported = (roles: string, lines = ""): Plan => ({
      verdict: "supported",
      quote: YEARLY,
      says: `Roles: ${roles}\nTides says harbours publish them every year.${lines}`,
      judgement: "neither",
    });
    const { core, client, check } = await mindWith(
      [MUST, SUPPORTED],
      checkingModel(
        {
          [MUST]: supported(
            "Harbours must publish / Harbours publish, differs",
            "\nCovered: the yearly times of high water\nNot covered: a duty to publish them",
          ),
          [SUPPORTED]: { ...(PLANS[SUPPORTED] as Plan), says: "Roles: none, same\nTides says so." },
        },
        calls,
      ),
    );

    await check();

    const [must, plain] = await shownChecks(core, client);
    expect(calls[0]?.system).toContain("Roles: who does it, for or to whom");
    expect(must).toMatchObject({
      shown: { state: "unsupported" },
      check: {
        unsupported: {
          covered: "the yearly times of high water",
          uncovered: "a duty to publish them",
          quoted: { quote: YEARLY, check: "found" },
        },
      },
    });
    expect(plain?.shown).toEqual({ state: "supported" });

    const none = await mindWith(
      [MUST],
      checkingModel({ [MUST]: supported("Harbours must publish / Harbours publish, differs") }),
    );
    await none.check();
    expect((await shownChecks(none.core, none.client))[0]?.shown).toEqual({ state: "unsupported" });
  });

  describe("a contradiction the strict judgement doesn't uphold", () => {
    const YEARLY = "Harbours publish the times of high water every year.";
    const JANUARY = "Harbours publish the times of high water every year in January.";
    const nearMiss = (strict: GeneratedReply, says?: string): Plan => ({
      verdict: "contradicted",
      quote: YEARLY,
      says:
        says ??
        "Tides says they are published every year, not in which month.\nCovered: the yearly times of high water\nNot covered: January",
      judgement: "conflict",
      strict,
    });
    const strictAsked = (model: ReturnType<typeof checkingModel>) =>
      model.doGenerateCalls.filter((call) => JSON.stringify(call.prompt).includes("Judgement:"))
        .length;

    test("shows the partly-supported card, quoting the Passage the check cited", async () => {
      const model = checkingModel({
        [JANUARY]: nearMiss({
          text: "Sentence: in January\nQuote: not stated\nJudgement: neither",
        }),
      });
      const { core, client, check } = await mindWith([JANUARY], model);

      await check();

      expect((await shownChecks(core, client))[0]).toMatchObject({
        shown: { state: "unsupported" },
        check: {
          evidence: null,
          unsupported: {
            covered: "the yearly times of high water",
            uncovered: "January",
            quoted: { documentName: "Tides", quote: YEARLY, check: "found" },
          },
        },
      });
      expect(strictAsked(model)).toBe(1);
    });

    test("asks once for the parts when the check named none", async () => {
      const model = checkingModel({
        [JANUARY]: {
          ...nearMiss(
            { text: "Sentence: in January\nQuote: not stated\nJudgement: neither" },
            "Tides says they are published every year.",
          ),
          part: "Covered: the yearly times of high water\nNot covered: the month",
        },
      });
      const { core, client, check } = await mindWith([JANUARY], model);

      await check();

      expect((await shownChecks(core, client))[0]?.check.unsupported).toMatchObject({
        covered: "the yearly times of high water",
        uncovered: "the month",
        quoted: { quote: YEARLY, check: "found" },
      });
      const asked = model.doGenerateCalls.filter((call) =>
        JSON.stringify(call.prompt).includes("says more than words quoted"),
      );
      expect(asked).toHaveLength(1);
    });

    test("in Chinese, the card keeps the check's own phrases", async () => {
      const contract = { name: "合同.md", contents: "乙方每周可在家工作两天，须事先与主管商定。" };
      const days = "员工可以在每周一和周五居家办公。";
      const model = checkingModel({
        [days]: {
          ...nearMiss(
            {
              text: "Sentence: on Mondays and Fridays (2 named days)\nQuote: not stated\nJudgement: neither",
            },
            "合同写的是每周可在家工作两天，没有写是哪两天。\nCovered: 每周居家办公两天\nNot covered: 每周一和周五",
          ),
          quote: "乙方每周可在家工作两天，须事先与主管商定。",
        },
      });
      const { core, client, check } = await mindWith([days], model, [contract]);
      await core.updateSettings({ user: { language: "zh-CN" } });

      await check();

      expect((await shownChecks(core, client))[0]).toMatchObject({
        shown: { state: "unsupported" },
        check: {
          unsupported: {
            covered: "每周居家办公两天",
            uncovered: "每周一和周五",
            quoted: { quote: "乙方每周可在家工作两天，须事先与主管商定。", check: "found" },
          },
        },
      });
    });

    test.each(["conflict", "same"])(
      "stays Contradicted when the strict judgement says %s: only a quote silent on the detail downgrades it",
      async (word) => {
        const { core, client, check } = await mindWith(
          [JANUARY],
          checkingModel({
            [JANUARY]: nearMiss({
              text: `Sentence: in January\nQuote: every year\nJudgement: ${word}`,
            }),
          }),
        );

        await check();

        expect((await shownChecks(core, client))[0]).toMatchObject({
          shown: { state: "contradicted" },
          check: { evidence: { quote: YEARLY, check: "found" } },
        });
      },
    );

    test.each<{ reason: ClaimCheckAttributes["reason"]; strict: GeneratedReply }>([
      { reason: "failed", strict: { error: { status: 500, message: "Overloaded" } } },
      { reason: "malformed", strict: { text: "It depends on the month." } },
    ])(
      "$reason: a judgement that fails leaves the sentence not checked, with why",
      async ({ reason, strict }) => {
        const { core, client, check } = await mindWith(
          [JANUARY],
          checkingModel({ [JANUARY]: nearMiss(strict) }),
        );

        await check();

        const [checked] = await shownChecks(core, client);
        expect(checked?.shown).toEqual({ state: "not-checked", reason });
        expect(checked?.check.evidence).toBeNull();
      },
    );
  });

  // protects=a sentence found unsupported keeps the nearest line the Run read when that line states another value for the same thing, and the verdict stays unsupported; fails_when=the line is lost, the verdict says contradicted, or an unrelated sentence gets a line; no_claim=how a real model words its judgement.
  test("an unsupported sentence keeps the nearest line that says something different (#770)", async () => {
    const different = { verdict: "unsupported" as const };
    const { core, client, check } = await mindWith(
      [CONTRADICTED, UNSUPPORTED],
      checkingModel({ [CONTRADICTED]: different, [UNSUPPORTED]: different }),
    );

    await check();

    const [near, unrelated] = await shownChecks(core, client);
    expect(near).toMatchObject({
      shown: { state: "unsupported" },
      check: {
        evidence: {
          documentName: "Tides",
          quote: "Harbours publish the times of high water every year.",
          check: "found",
        },
      },
    });
    expect(unrelated).toMatchObject({ shown: { state: "unsupported" }, check: { evidence: null } });
  });

  // protects=a sentence about something else that shares a common word or two with a line asks the model nothing more, in English and Chinese; a near one still does; fails_when=every unsupported sentence pays an extra request; no_claim=none beyond protects.
  test.each([
    {
      name: "English",
      report: {
        name: "Report.md",
        contents: "The company reported its results for the year 2025 in March.",
      },
      unrelated: "Our company will open three new offices in Singapore during 2025.",
      near: "The company reported its results for the year 2026 in March.",
    },
    {
      name: "Chinese",
      report: { name: "Report.md", contents: "公司发布了年度报告，营收增长明显。" },
      unrelated: "这家公司的年度旅行计划包括去云南和四川的长途徒步。",
      near: "公司发布了年度报告，营收下降明显。",
    },
  ])(
    "$name: an unrelated sentence makes no extra request (#770)",
    async ({ report, unrelated, near }) => {
      const plans = {
        [unrelated]: { verdict: "unsupported" as const },
        [near]: { verdict: "unsupported" as const },
      };
      const asked = (model: ReturnType<typeof checkingModel>) =>
        model.doGenerateCalls.filter((call) =>
          JSON.stringify(call.prompt).includes("Compare a sentence"),
        ).length;

      const model = checkingModel(plans);
      const { check } = await mindWith([unrelated], model, [report]);
      await check();
      expect(asked(model)).toBe(0);

      const nearModel = checkingModel(plans);
      const nearby = await mindWith([near], nearModel, [report]);
      await nearby.check();
      expect(asked(nearModel)).toBe(1);
    },
  );

  test("the nearest line is shown only when, judged alone, it differs", async () => {
    const same = { verdict: "unsupported" as const, judgement: "neither" as const };
    const { core, client, check } = await mindWith(
      [CONTRADICTED],
      checkingModel({ [CONTRADICTED]: same }),
    );

    await check();

    expect((await shownChecks(core, client))[0]).toMatchObject({
      shown: { state: "unsupported" },
      check: { evidence: null },
    });
  });

  test("checkClaim is the same check, for a claim outside a Mind", async () => {
    const { core, documents } = await setUpWithDocuments(checkingModel(), [TIDES]);
    const tides = documents[0] as Document;

    expect(await core.checkClaim({ claim: SUPPORTED })).toMatchObject({
      verdict: "supported",
      evidence: { documentId: tides.id, check: "found" },
      versions: [{ documentId: tides.id, contentHash: tides.contentHash }],
    });
    // The document being checked is never its own evidence (#80).
    expect(
      await core.checkClaim({ claim: SUPPORTED, checked: { documentIds: [tides.id] } }),
    ).toMatchObject({ verdict: "unsupported", versions: [] });
  });

  test("a check Run whose quote was refused gives its verdict after the fix, though its model writes Answers before citing (#489)", async () => {
    const quote = "Spring tides happen at new moon and at full moon";
    const model = scriptedModel(
      (call) => {
        const searched = call.results.find((result) => result.tool === "search_documents");
        const cites = call.results.filter((result) => result.tool === "cite").length;
        if (!searched) return checkReply(call, PLANS);
        const passage = shownPassages(searched.text)[0]?.id;
        const cite = (quoted: string) => ({
          tool: "cite",
          input: { citations: [{ marker: 1, passage, quote: quoted }] },
        });
        if (cites === 0) {
          return {
            text: "Tides says spring tides happen at new and full moon [^1].",
            calls: [cite("Spring tides happen every week")],
          };
        }
        return cites === 1 ? { calls: [cite(quote)] } : { text: "Verdict: supported" };
      },
      { generate: checkGenerate(PLANS) },
    );
    const { core } = await setUpWithDocuments(model, [TIDES], {
      answerPaths: { writesThenCites: () => true },
    });

    expect(await core.checkClaim({ claim: SUPPORTED })).toMatchObject({
      verdict: "supported",
      evidence: { check: "found" },
    });
    expect(model.doStreamCalls).toHaveLength(4);
  });

  test("the quotes a sentence cites name their Document as it is now, and as cited once it is gone", async () => {
    const calls: ModelCall[] = [];
    const { core, client, check, tides } = await mindWith(
      [SUPPORTED],
      checkingModel(PLANS, calls),
      [BREAD],
    );
    const quote = "Spring tides happen at new moon and at full moon";
    const cited = paragraph(
      text(`${SUPPORTED.slice(0, -1)} `),
      {
        type: "citation",
        attrs: {
          documentId: tides.id,
          documentName: "Tides",
          contentHash: tides.contentHash,
          quote,
          check: "found",
        },
      },
      text("."),
    );
    writeMind(client, [cited]);
    await client.settled();
    const citedToTheModel = async () => {
      calls.length = 0;
      await check("check-against-documents", whole(cited, SUPPORTED.length + 1));
      const asked = calls[0]?.options.prompt.find((message) => message.role === "user")?.content;
      return JSON.stringify(asked);
    };
    expect(await citedToTheModel()).toContain(`Tides: “${quote}”`);

    await core.renameDocument(tides.id, "Tides of the coast");
    expect(await citedToTheModel()).toContain(`Tides of the coast: “${quote}”`);

    await core.deleteDocument(tides.id);
    const gone = await citedToTheModel();
    expect(gone).toContain(`Tides: “${quote}”`);
    expect(gone).not.toContain("Tides of the coast");
  });

  test("checkClaim names the quotes it is given by their Document's name now", async () => {
    const calls: ModelCall[] = [];
    const { core, documents } = await setUpWithDocuments(checkingModel(PLANS, calls), [TIDES]);
    const tides = documents[0] as Document;
    await core.renameDocument(tides.id, "Tides of the coast");
    const quote = "Spring tides happen at new moon and at full moon";

    await core.checkClaim({
      claim: SUPPORTED,
      cited: [
        { documentName: "Tides", documentId: tides.id, quote },
        { documentName: "Notes from the harbour", quote: "High water is at six." },
      ],
    });

    const asked = JSON.stringify(calls[0]?.options.prompt.find((each) => each.role === "user"));
    expect(asked).toContain(`Tides of the coast: “${quote}”`);
    expect(asked).toContain("Notes from the harbour: “High water is at six.”");
  });
});

describe("A figure the Documents don't state, worked out (#707)", () => {
  const BOARD = {
    name: "Board update.md",
    contents: [
      "# Board update",
      "",
      "Net debt was £1,234m at the end of 2025.",
      "",
      "EBITDA was £942m in 2025.",
      "",
      "Revenue was £131.9m in 2025, compared with £118.2m in 2024.",
      "",
      "Costs were £86.5m in 2025, and staff cost £40.1m of that.",
    ].join("\n"),
  };
  const NET_DEBT = {
    name: "nd",
    label: "Net debt 2025",
    quote: "Net debt was £1,234m",
    number: "£1,234m",
  };
  const EBITDA = { name: "e", label: "EBITDA 2025", quote: "EBITDA was £942m", number: "£942m" };
  const REVENUE = (number: string, label: string, name: string) => ({
    name,
    label,
    quote: "Revenue was £131.9m in 2025, compared with £118.2m in 2024.",
    number,
  });
  const COSTS = { name: "c", label: "Costs 2025", quote: "Costs were £86.5m", number: "£86.5m" };
  const STAFF = {
    name: "s",
    label: "Staff costs 2025",
    quote: "staff cost £40.1m",
    number: "£40.1m",
  };
  const RATIO = { inputs: [NET_DEBT, EBITDA], formula: "nd / e", as: "times" };
  const GROWTH = {
    inputs: [REVENUE("£131.9m", "Revenue 2025", "r25"), REVENUE("£118.2m", "Revenue 2024", "r24")],
    formula: "r25 / r24 - 1",
    as: "percent",
  };
  const SUM = { inputs: [NET_DEBT, EBITDA], formula: "nd + e" };
  const DIFFERENCE = { inputs: [COSTS, STAFF], formula: "c - s" };

  /** A check whose model is Claude Haiku 5.5, scripted: one measured to use calculate (ADR-0021). */
  async function calculatingCheck(model: ReturnType<typeof checkingModel>) {
    const setup = await setUpWithDocuments(model, [BOARD]);
    const saved = await setup.core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await setup.core.allowDataFlow("checks", saved.service.id);
    return { ...setup, board: setup.documents[0] as Document };
  }

  test.each([
    ["ratio", "Net debt to EBITDA fell to 1.3x.", RATIO, "1.3x", "supported", "1.31x"],
    ["ratio", "Net debt to EBITDA fell to 1.1x.", RATIO, "1.1x", "contradicted", "1.31x"],
    ["growth", "Revenue grew 11.6% in 2025.", GROWTH, "11.6%", "supported", "11.6%"],
    ["growth", "Revenue grew 15% in 2025.", GROWTH, "15%", "contradicted", "11.6%"],
    ["sum", "Net debt and EBITDA come to £2,176m.", SUM, "£2,176m", "supported", "£2,176m"],
    ["sum", "Net debt and EBITDA come to £2,276m.", SUM, "£2,276m", "contradicted", "£2,176m"],
    [
      "difference",
      "Costs other than staff were £46.4m.",
      DIFFERENCE,
      "£46.4m",
      "supported",
      "£46.4m",
    ],
    [
      "difference",
      "Costs other than staff were £56.4m.",
      DIFFERENCE,
      "£56.4m",
      "contradicted",
      "£46.4m",
    ],
  ])(
    "a %s: “%s” is checked by calculation",
    async (_kind, claim, figure, stated, verdict, shown) => {
      // The model's own verdict is the other one: the calculation decides, not the model.
      const said = verdict === "supported" ? "contradicted" : "supported";
      const plans = { [claim]: { verdict: said, calculation: { ...figure, stated } } } as const;
      const { core, board } = await calculatingCheck(checkingModel(plans));

      const result = await core.checkClaim({ claim });
      expect(result).toMatchObject({
        verdict,
        says: null,
        evidence: { documentId: board.id, check: "found" },
        calculation: { stated, figure: { shown } },
      });
      if (result.verdict === "not-checked") throw new Error("Not checked.");
      for (const input of result.calculation?.figure.inputs ?? []) {
        expect(input.citation).toMatchObject({ documentId: board.id, check: "found" });
      }
    },
  );

  test.each([
    ["en", "Revenue was 7,509,964.", ["Customer", "Revenue"], "7509964", "North", "Ledger.xlsx"],
    ["zh-CN", "收入为 7,509,964。", ["客户", "收入"], "7509964", "北方", "台账.xlsx"],
  ] as const)(
    "a grouped figure in %s matches its source cell with no Difference",
    async (language, claim, headings, cell, customer, name) => {
      const book = {
        name,
        contents: xlsxOf([
          {
            name: "Sheet1",
            rows: [[...headings], [customer, 7_509_964]],
          },
        ]),
      };
      const calculation = {
        inputs: [{ name: "v", label: headings[1], quote: cell, number: cell }],
        formula: "v",
        stated: "7,509,964",
      };
      const plans = { [claim]: { verdict: "supported", calculation } } as const;
      const setup = await setUpWithDocuments(checkingModel(plans), [book]);
      const saved = await setup.core.saveChatProvider({
        kind: "anthropic",
        apiKey: "sk-test",
        modelId: "claude-haiku-5-5",
      });
      if (saved.service) await setup.core.allowDataFlow("checks", saved.service.id);
      await setup.core.updateSettings({ user: { language } });

      const result = await setup.core.checkClaim({ claim });

      expect(result).toMatchObject({
        verdict: "supported",
        calculation: { stated: "7,509,964", agrees: true, figure: { value: 7_509_964 } },
      });
    },
  );

  test("a model that calculates is offered calculate, with the sentence's number to name, and told when to use it; one that doesn't isn't", async () => {
    const calls: ModelCall[] = [];
    const claim = "Net debt to EBITDA fell to 1.1x.";
    const plans = {
      [claim]: { verdict: "unsupported", calculation: { ...RATIO, stated: "1.1x" } },
    } as const;
    const { core } = await calculatingCheck(checkingModel(plans, calls));
    await core.checkClaim({ claim });

    expect(calls[0]?.tools.sort()).toEqual(["calculate", "cite", "search_documents"]);
    expect(calls[0]?.system).toContain("isn't judged in your head");
    const offered = calls[0]?.options.tools?.find(
      (tool) => tool.type === "function" && tool.name === "calculate",
    );
    expect(offered).toMatchObject({
      inputSchema: {
        properties: {
          figures: {
            items: {
              properties: {
                stated: {
                  type: "string",
                  description: expect.stringContaining("original language"),
                },
              },
            },
          },
        },
      },
    });

    const localCalls: ModelCall[] = [];
    const local = await setUpWithDocuments(checkingModel(plans, localCalls), [BOARD]);
    await local.core.checkClaim({ claim });
    expect(localCalls[0]?.tools.sort()).toEqual(["cite", "search_documents"]);
    expect(localCalls[0]?.system).not.toContain("isn't judged in your head");
  });

  test("the sentence's mark keeps the working: the figure, its inputs' Citations and the sentence's number, and their Documents' versions are kept", async () => {
    const claim = "Net debt to EBITDA fell to 1.1x.";
    const plans = {
      [claim]: { verdict: "supported", calculation: { ...RATIO, stated: "1.1x" } },
    } as const;
    const { core, client, mind, board, dataDir } = await calculatingCheck(checkingModel(plans));
    const block = paragraph(text(claim));
    writeMind(client, [block]);
    await client.settled();

    await core.checkSentences({
      requestId: "r1",
      mindId: mind.id,
      action: "check-against-documents",
      ...whole(block, claim.length),
    });

    const [checked] = await shownChecks(core, client);
    expect(checked?.shown).toEqual({ state: "contradicted" });
    expect(checked?.check.calculation).toMatchObject({
      stated: "1.1x",
      figure: {
        formula: "nd / e",
        shown: "1.31x",
        inputs: [
          {
            label: "Net debt 2025",
            number: { chars: "£1,234m" },
            citation: { quote: "Net debt was £1,234m", check: "found" },
          },
          {
            label: "EBITDA 2025",
            number: { chars: "£942m" },
            citation: { quote: "EBITDA was £942m", check: "found" },
          },
        ],
      },
    });
    expect(
      queryDatabase(
        dataDir,
        "SELECT DISTINCT content_hash FROM retained_versions WHERE kind = 'check-result' AND deleted_at IS NULL",
      ),
    ).toEqual([{ content_hash: board.contentHash }]);
  });

  test("in Chinese: a multiple worked out from amounts in 万元 contradicts the sentence's", async () => {
    const report = {
      name: "董事会报告.md",
      contents: "# 董事会报告\n\n截至2026年9月30日，净负债为12,340万元。全年EBITDA为9,420万元。\n",
    };
    const claim = "净负债与 EBITDA 之比降至 1.1 倍。";
    const calculation = {
      inputs: [
        { name: "nd", label: "净负债", quote: "净负债为12,340万元", number: "12,340万元" },
        { name: "e", label: "EBITDA", quote: "全年EBITDA为9,420万元", number: "9,420万元" },
      ],
      formula: "nd / e",
      as: "times",
      stated: "1.1 倍",
    };
    const model = checkingModel({ [claim]: { verdict: "supported", calculation } });
    const setup = await setUpWithDocuments(model, [report]);
    const saved = await setup.core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await setup.core.allowDataFlow("checks", saved.service.id);

    expect(await setup.core.checkClaim({ claim })).toMatchObject({
      verdict: "contradicted",
      calculation: { stated: "1.1 倍", figure: { shown: "1.31倍" } },
    });
  });

  test("a figure that agrees settles only its number: a Passage that contradicts the rest of the sentence still does", async () => {
    const claim = "Revenue grew 11.6% in 2025, to £141.9m.";
    const plans = {
      [claim]: {
        verdict: "contradicted",
        quote: "Revenue was £131.9m in 2025",
        says: "The update says revenue was £131.9m in 2025, not £141.9m.",
        calculation: { ...GROWTH, stated: "11.6%" },
      },
    } as const;
    const { core } = await calculatingCheck(checkingModel(plans));

    expect(await core.checkClaim({ claim })).toMatchObject({
      verdict: "contradicted",
      evidence: { quote: "Revenue was £131.9m in 2025", check: "found" },
      says: "The update says revenue was £131.9m in 2025, not £141.9m.",
      calculation: { stated: "11.6%", agrees: true, figure: { shown: "11.6%" } },
    });
  });

  test.each([
    ["Net debt to EBITDA was about 1.4x.", "about 1.4x", "supported"],
    ["Net debt to EBITDA was 1.4x.", "1.4x", "contradicted"],
  ])(
    "an approximate number is a place looser: “%s” against 1.31x",
    async (claim, stated, verdict) => {
      const plans = {
        [claim]: { verdict: "unsupported", calculation: { ...RATIO, stated } },
      } as const;
      const { core } = await calculatingCheck(checkingModel(plans));
      expect(await core.checkClaim({ claim })).toMatchObject({ verdict });
    },
  );

  test("a bare number isn't compared with a ratio: “1.31” could be a share or a multiple", async () => {
    const claim = "Net debt to EBITDA was 1.31.";
    const plans = {
      [claim]: { verdict: "unsupported", calculation: { ...RATIO, stated: "1.31" } },
    } as const;
    const { core } = await calculatingCheck(checkingModel(plans));
    expect(await core.checkClaim({ claim })).toMatchObject({
      verdict: "not-checked",
      reason: "no-evidence",
    });
  });

  test("a figure for a number the sentence doesn't have leaves the arithmetic Not checked", async () => {
    const claim = "Net debt to EBITDA fell to 1.1x.";
    const plans = {
      [claim]: { verdict: "unsupported", calculation: { ...RATIO, stated: "2.5x" } },
    } as const;
    const { core } = await calculatingCheck(checkingModel(plans));

    expect(await core.checkClaim({ claim })).toMatchObject({
      verdict: "not-checked",
      reason: "no-evidence",
    });
  });
});

describe("A memo's figure worked out from amounts in brackets (#978)", () => {
  const STATEMENT = {
    name: "Completion statement.md",
    contents: [
      "# Completion statement: 14 Mill Lane",
      "",
      "Sale price £385,000.00",
      "",
      "Less: estate agent's fee (£4,620.00)",
      "",
      "Less: legal fees (£1,500.00)",
      "",
      "Less: search and other costs (£804.00)",
    ].join("\n"),
  };
  const input = (name: string, label: string, line: string, number: string) => ({
    name,
    label,
    quote: line,
    number,
  });
  const NET = {
    inputs: [
      input("price", "Sale price", "Sale price £385,000.00", "£385,000.00"),
      input("agent", "Agent's fee", "estate agent's fee (£4,620.00)", "(£4,620.00)"),
      input("legal", "Legal fees", "legal fees (£1,500.00)", "(£1,500.00)"),
      input("other", "Other costs", "search and other costs (£804.00)", "(£804.00)"),
    ],
    formula: "price + agent + legal + other",
  };

  // protects=#978; fails_when=a correct net figure is Contradicted because a deduction in brackets was read as positive, or the card's inputs don't carry their sign; no_claim=a model that subtracts the brackets, which the line it is told and a hand check with Claude Haiku 5.5 cover.
  test.each([
    ["Net sale proceeds £378,076.", "£378,076", "supported"],
    ["Net sale proceeds £391,924.", "£391,924", "contradicted"],
  ])("“%s” is %s, by taking the deductions off", async (claim, stated, verdict) => {
    const said = verdict === "supported" ? "contradicted" : "supported";
    const plans = { [claim]: { verdict: said, calculation: { ...NET, stated } } } as const;
    const setup = await setUpWithDocuments(checkingModel(plans), [STATEMENT]);
    const saved = await setup.core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await setup.core.allowDataFlow("checks", saved.service.id);

    const result = await setup.core.checkClaim({ claim });

    expect(result).toMatchObject({
      verdict,
      calculation: { stated, figure: { shown: "£378,076.00" } },
    });
    if (result.verdict === "not-checked") throw new Error("Not checked.");
    expect(result.calculation?.figure.inputs.map((each) => each.number.value)).toEqual([
      385_000, -4_620, -1_500, -804,
    ]);
  });
});

describe("A limit the figure stays within, and a cost printed in brackets (#1908)", () => {
  const RESULTS = {
    name: "Cedar results.md",
    contents: [
      "# Cedar results",
      "",
      "Adjusted EBITDA 187.3 (FY2025), 88.0 and 91.5 (H1 2025, H1 2026)",
      "",
      "Finance costs (41.2)",
      "",
      "Net debt at 30 June 2026 528.9",
      "",
      "Net debt to Adjusted EBITDA must not exceed 3.25 to 1",
    ].join("\n"),
  };
  const EBITDA_LINE = "Adjusted EBITDA 187.3 (FY2025), 88.0 and 91.5 (H1 2025, H1 2026)";
  const ebitda = (name: string, number: string) => ({
    name,
    label: `Adjusted EBITDA ${number}`,
    quote: EBITDA_LINE,
    number,
  });
  const LEVERAGE = {
    inputs: [
      { name: "nd", label: "Net debt", quote: "Net debt at 30 June 2026 528.9", number: "528.9" },
      ebitda("fy", "187.3"),
      ebitda("h1a", "88.0"),
      ebitda("h1b", "91.5"),
    ],
    formula: "nd / (fy - h1a + h1b)",
    as: "times",
  };
  const COVER = {
    inputs: [
      ebitda("fy", "187.3"),
      {
        name: "fc",
        label: "Finance costs",
        quote: "Finance costs (41.2)",
        number: "(41.2)",
        bracketedCost: true,
      },
    ],
    formula: "fy / fc",
    as: "times",
  };
  async function checked(
    document: { name: string; contents: string },
    claim: string,
    calculation: NonNullable<Plan["calculation"]>,
    said: "supported" | "contradicted" | "unsupported",
    says?: string,
    language?: "en" | "zh-CN",
  ) {
    const plans = {
      [claim]: { verdict: said, calculation, strict: { text: "same" }, ...(says && { says }) },
    } as const;
    const calls: ModelCall[] = [];
    const setup = await setUpWithDocuments(checkingModel(plans, calls), [document]);
    const saved = await setup.core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await setup.core.allowDataFlow("checks", saved.service.id);
    if (language) await setup.core.updateSettings({ user: { language } });
    const result = await setup.core.checkClaim({ claim });
    // Each case's figures are worked out: a verdict never stands because calculate refused one.
    const replies = calls
      .flatMap((call) => call.results)
      .filter((each) => each.tool === "calculate");
    expect(replies.at(-1)?.text).toMatch(/^Recorded/);
    return result;
  }
  const INSIDE = (limit: string, amount = "528.9") =>
    `Net debt at 30 June 2026 was ${amount}, so leverage should still be inside the ${limit} covenant.`;
  const COVERED = (times: string) =>
    `Using finance costs of (41.2) as a stand-in, cover would be ${times}.`;

  // protects=a sentence naming a limit is judged on the comparison the model says it makes, exactly against the limit, while only a figure the sentence states rounds to its precision; a cost in brackets is judged on its size; a figure that breaks its limit or a wrong cover is still Contradicted, and a limit given with no relation is still compared as the figure (today's behaviour); fails_when=2.77x "inside a 3.25x covenant" or 4.55x cover from "(41.2)" is Contradicted, a breach passes, or 4.546x passes "at least 4.55x" or 2.772x "inside a 2.77x covenant" by rounding; no_claim=that a real model gives relation, which the real-model counts measure.
  test.each([
    [INSIDE("3.25x"), { ...LEVERAGE, stated: "3.25x", relation: "at most" }, "supported"],
    [INSIDE("2.5x"), { ...LEVERAGE, stated: "2.5x", relation: "at most" }, "contradicted"],
    [INSIDE("3.25x"), { ...LEVERAGE, stated: "3.25x" }, "contradicted"],
    [
      "Adjusted EBITDA covers finance costs at least 4x.",
      { ...COVER, stated: "4x", relation: "at least" },
      "supported",
    ],
    [
      "Adjusted EBITDA covers finance costs at least 5x.",
      { ...COVER, stated: "5x", relation: "at least" },
      "contradicted",
    ],
    [
      "Adjusted EBITDA covers finance costs at least 4.55x.",
      { ...COVER, stated: "4.55x", relation: "at least" },
      "contradicted",
    ],
    [INSIDE("2.77x"), { ...LEVERAGE, stated: "2.77x", relation: "at most" }, "contradicted"],
    [COVERED("4.55x"), { ...COVER, stated: "4.55x" }, "supported"],
    [COVERED("5.55x"), { ...COVER, stated: "5.55x" }, "contradicted"],
  ] as const)("“%s” is %s", async (claim, calculation, verdict) => {
    const said = verdict === "supported" ? "contradicted" : "supported";
    const result = await checked(RESULTS, claim, calculation, said);
    expect(result).toMatchObject({ verdict, calculation: { stated: calculation.stated } });
  });

  test("an agreeing limit does not settle an unstated monetary unit or scale", async () => {
    const result = await checked(
      RESULTS,
      INSIDE("3.25x", "£528.9m"),
      { ...LEVERAGE, stated: "3.25x", relation: "at most" },
      "supported",
    );
    expect(result).toMatchObject({
      verdict: "unsupported",
      unsupported: {
        covered: "the amount, 528.9",
        uncovered: "the currency, unit or scale in £528.9m",
      },
      calculation: { agrees: true },
    });
    if (result.verdict === "unsupported") expect(result.unsupported?.quoted).toBeUndefined();
  });

  test("an unstated scale is named in Chinese", async () => {
    const claim = "2026年6月30日净负债为£528.9m，因此杠杆率仍应在3.25倍的契约上限之内。";
    const result = await checked(
      RESULTS,
      claim,
      { ...LEVERAGE, stated: "3.25倍", relation: "at most" },
      "supported",
      undefined,
      "zh-CN",
    );
    expect(result).toMatchObject({
      verdict: "unsupported",
      unsupported: {
        reason: "文档写的是 528.9，不是 £528.9m。",
        covered: "金额 528.9",
        uncovered: "£528.9m 的币种、单位或量级",
      },
    });
  });

  test("an empty reply after an agreeing calculation is not whole-sentence support", async () => {
    const claim = INSIDE("3.25x", "£528.9m");
    const calculation = { ...LEVERAGE, stated: "3.25x", relation: "at most" as const };
    const plans = { [claim]: { verdict: "supported" as const, calculation } };
    const model = scriptedModel(
      (call) => {
        if (isCheckRun(call) && call.results.some((each) => each.tool === "calculate")) {
          return { text: "" };
        }
        return checkReply(call, plans);
      },
      { generate: checkGenerate(plans) },
    );
    const setup = await setUpWithDocuments(model, [RESULTS]);
    const saved = await setup.core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await setup.core.allowDataFlow("checks", saved.service.id);

    expect(await setup.core.checkClaim({ claim })).toMatchObject({
      verdict: "not-checked",
      reason: "empty",
    });
  });

  test("a stated monetary unit and scale can support the same calculated claim", async () => {
    const stated = {
      ...RESULTS,
      contents: `All amounts are in GBP millions.\n\n${RESULTS.contents}`,
    };
    const calculation = { ...LEVERAGE, stated: "3.25x", relation: "at most" as const };
    const result = await checked(stated, INSIDE("3.25x", "£528.9m"), calculation, "supported");
    expect(result).toMatchObject({ verdict: "supported", calculation: { agrees: true } });
  });

  test("a reasoned contradiction with no Citation is not erased by an agreeing calculation", async () => {
    const result = await checked(
      RESULTS,
      INSIDE("3.25x"),
      { ...LEVERAGE, stated: "3.25x", relation: "at most" },
      "contradicted",
      "The Documents give a different leverage ratio.",
    );
    expect(result).toMatchObject({ verdict: "contradicted", calculation: { agrees: true } });
  });

  test("a reasoned unsupported clause with no Citation or Topic is not erased by an agreeing calculation", async () => {
    const claim = `${INSIDE("3.25x")} and the borrower is based in Scotland.`;
    const calculation = { ...LEVERAGE, stated: "3.25x", relation: "at most" as const };
    const plans = { [claim]: { verdict: "unsupported" as const, calculation } };
    const model = scriptedModel(
      (call) => {
        if (isCheckRun(call) && call.results.some((each) => each.tool === "calculate")) {
          return {
            text: "Verdict: unsupported\nThe Documents do not support the borrower's location.",
          };
        }
        return checkReply(call, plans);
      },
      { generate: checkGenerate(plans) },
    );
    const setup = await setUpWithDocuments(model, [RESULTS]);
    const saved = await setup.core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await setup.core.allowDataFlow("checks", saved.service.id);

    expect(await setup.core.checkClaim({ claim })).toMatchObject({
      verdict: "unsupported",
      unsupported: { reason: "The Documents do not support the borrower's location." },
      calculation: { agrees: true },
    });
  });

  test.each([
    {
      label: "coordinated reason",
      reply:
        "The calculated 3.25x ratio agrees, but the Documents do not support the borrower's location.",
      unsupported: {
        reason:
          "The calculated 3.25x ratio agrees, but the Documents do not support the borrower's location.",
      },
    },
    {
      label: "coordinated parts",
      reply: "Covered: the amount 528.9\nNot covered: the 3.25x ratio and the borrower's location",
      unsupported: { uncovered: "the 3.25x ratio and the borrower's location" },
    },
    {
      label: "separate reason sentence",
      reply:
        "The calculated 3.25x ratio agrees. The Documents do not support the borrower's location.",
      unsupported: {
        reason:
          "The calculated 3.25x ratio agrees. The Documents do not support the borrower's location.",
      },
    },
    {
      label: "separate part sentence",
      reply:
        "Covered: the amount 528.9\nNot covered: the 3.25x ratio. The borrower's location is not stated",
      unsupported: { uncovered: "the 3.25x ratio. The borrower's location is not stated" },
    },
    {
      label: "adjoined reason clause",
      reply:
        "The calculated 3.25x ratio agrees: the Documents do not support the borrower's location.",
      unsupported: {
        reason:
          "The calculated 3.25x ratio agrees: the Documents do not support the borrower's location.",
      },
    },
    {
      label: "adjoined part clause",
      reply:
        "Covered: the amount 528.9\nNot covered: the 3.25x ratio — the borrower's location is not stated",
      unsupported: { uncovered: "the 3.25x ratio — the borrower's location is not stated" },
    },
  ])(
    "a derived figure beside an independent unsupported clause stays unsupported ($label)",
    async ({ reply, unsupported }) => {
      const claim = `${INSIDE("3.25x")} and the borrower is based in Scotland.`;
      const calculation = { ...LEVERAGE, stated: "3.25x", relation: "at most" as const };
      const plans = { [claim]: { verdict: "unsupported" as const, calculation } };
      const model = scriptedModel(
        (call) => {
          if (isCheckRun(call) && call.results.some((each) => each.tool === "calculate")) {
            return { text: `Verdict: unsupported\n${reply}` };
          }
          return checkReply(call, plans);
        },
        { generate: checkGenerate(plans) },
      );
      const setup = await setUpWithDocuments(model, [RESULTS]);
      const saved = await setup.core.saveChatProvider({
        kind: "anthropic",
        apiKey: "sk-test",
        modelId: "claude-haiku-5-5",
      });
      if (saved.service) await setup.core.allowDataFlow("checks", saved.service.id);

      expect(await setup.core.checkClaim({ claim })).toMatchObject({
        verdict: "unsupported",
        unsupported,
        calculation: { agrees: true },
      });
    },
  );

  test.each(["reason", "parts"])(
    "an uncovered derived figure is settled by its calculation (%s)",
    async (kind) => {
      const claim = COVERED("4.55x");
      const calculation = { ...COVER, stated: "4.55x" };
      const plans = {
        [claim]: { verdict: "unsupported" as const, calculation, strict: { text: "same" } },
      };
      const model = scriptedModel(
        (call) => {
          if (isCheckRun(call) && call.results.some((each) => each.tool === "calculate")) {
            return {
              text:
                kind === "reason"
                  ? "Verdict: unsupported\nThe Documents do not state the 4.55x coverage multiple itself"
                  : "Verdict: unsupported\nCovered: finance costs of (41.2)\nNot covered: the 4.55x coverage multiple itself",
            };
          }
          return checkReply(call, plans);
        },
        { generate: checkGenerate(plans) },
      );
      const setup = await setUpWithDocuments(model, [RESULTS]);
      const saved = await setup.core.saveChatProvider({
        kind: "anthropic",
        apiKey: "sk-test",
        modelId: "claude-haiku-5-5",
      });
      if (saved.service) await setup.core.allowDataFlow("checks", saved.service.id);

      expect(await setup.core.checkClaim({ claim })).toMatchObject({
        verdict: "supported",
        calculation: { agrees: true },
      });
    },
  );

  const LEDGER = {
    name: "Ledger.md",
    contents: [
      "# Ledger",
      "",
      "Operating profit (12.0)",
      "",
      "Revenue 400.0",
      "",
      "Loss before tax (6.5)",
      "",
      "Tax rate 30%",
      "",
      "Receipts 10.0",
      "",
      "Payments (15.0)",
      "",
      "Other income 1.0",
      "",
      "Underlying EBITDA -50.0",
      "",
      "Net debt 528.9",
    ].join("\n"),
  };
  const LEDGER_ZH = {
    name: "台账.md",
    contents: [
      "# 台账",
      "",
      "营业利润 （12.0）",
      "",
      "营业收入 400.0",
      "",
      "税前亏损 （6.5）",
      "",
      "税率 30%",
      "",
      "收款 10.0",
      "",
      "付款 （15.0）",
      "",
      "其他收入 1.0",
      "",
      "基础EBITDA -50.0",
      "",
      "净负债 528.9",
    ].join("\n"),
  };
  const RESULTS_ZH = {
    name: "雪松业绩.md",
    contents: [
      "# 雪松业绩",
      "",
      "调整后EBITDA 187.3（2025财年），88.0 和 91.5（2025年上半年、2026年上半年）",
      "",
      "2026年6月30日净负债 528.9",
    ].join("\n"),
  };
  const line = (name: string, quote: string, number: string, bracketedCost?: boolean) => ({
    name,
    label: quote,
    quote,
    number,
    ...(bracketedCost && { bracketedCost }),
  });
  const LEDGER_LINES = {
    en: {
      op: line("op", "Operating profit (12.0)", "(12.0)"),
      rev: line("rev", "Revenue 400.0", "400.0"),
      pbt: line("pbt", "Loss before tax (6.5)", "(6.5)"),
      t: line("t", "Tax rate 30%", "30%"),
      r: line("r", "Receipts 10.0", "10.0"),
      p: line("p", "Payments (15.0)", "(15.0)", true),
      oi: line("oi", "Other income 1.0", "1.0"),
      ue: line("ue", "Underlying EBITDA -50.0", "-50.0"),
      nd: line("nd", "Net debt 528.9", "528.9"),
    },
    zh: {
      op: line("op", "营业利润 （12.0）", "（12.0）"),
      rev: line("rev", "营业收入 400.0", "400.0"),
      pbt: line("pbt", "税前亏损 （6.5）", "（6.5）"),
      t: line("t", "税率 30%", "30%"),
      r: line("r", "收款 10.0", "10.0"),
      p: line("p", "付款 （15.0）", "（15.0）", true),
      oi: line("oi", "其他收入 1.0", "1.0"),
      ue: line("ue", "基础EBITDA -50.0", "-50.0"),
      nd: line("nd", "净负债 528.9", "528.9"),
    },
  };
  const zhEbitda = (name: string, number: string) =>
    line(
      name,
      "调整后EBITDA 187.3（2025财年），88.0 和 91.5（2025年上半年、2026年上半年）",
      number,
    );
  const ZH_LEVERAGE = {
    inputs: [
      line("nd", "2026年6月30日净负债 528.9", "528.9"),
      zhEbitda("fy", "187.3"),
      zhEbitda("h1a", "88.0"),
      zhEbitda("h1b", "91.5"),
    ],
    formula: "nd / (fy - h1a + h1b)",
    as: "times",
  };
  const cases = (language: "en" | "zh") => {
    const { op, rev, pbt, t, r, p, oi, ue, nd } = LEDGER_LINES[language];
    const zh = language === "zh";
    const ledger = zh ? LEDGER_ZH : LEDGER;
    const results = zh ? RESULTS_ZH : RESULTS;
    const leverage = zh ? ZH_LEVERAGE : LEVERAGE;
    const both = zh
      ? "2026年6月30日净负债为528.9，杠杆率为2.5倍，在3.25倍的契约上限之内。"
      : "Net debt at 30 June 2026 was £528.9m: leverage of 2.5x is inside the 3.25x covenant.";
    const limit = { ...leverage, stated: zh ? "3.25倍" : "3.25x", relation: "at most" as const };
    const figure = { ...leverage, stated: zh ? "2.5倍" : "2.5x" };
    return [
      [
        ledger,
        zh ? "营业利润率为3%。" : "Operating margin was 3%.",
        { inputs: [op, rev], formula: "op / rev", as: "percent", stated: "3%" },
        "contradicted",
      ],
      [
        ledger,
        zh ? "税后利润为4.55。" : "Profit after tax was 4.55.",
        { inputs: [pbt, t], formula: "pbt * (1 - t)", stated: "4.55" },
        "contradicted",
      ],
      [
        ledger,
        zh ? "净现金流为5.0。" : "Net cash flow was 5.0.",
        { inputs: [r, p], formula: "SUM(r, p)", stated: "5.0" },
        "contradicted",
      ],
      [
        ledger,
        zh
          ? "付款按税率计算再加其他收入，合计为3.5。"
          : "Payments at the tax rate plus other income give a total of 3.5.",
        { inputs: [p, t, oi], formula: "(p * t) + oi", stated: "3.5" },
        "contradicted",
      ],
      [results, both, [limit, figure], "contradicted"],
      [results, both, [figure, limit], "contradicted"],
      [
        ledger,
        zh
          ? "净负债528.9，基础EBITDA为-50.0，杠杆率仍在3.25倍的契约上限之内。"
          : "With net debt of 528.9 and underlying EBITDA of -50.0, leverage stays inside the 3.25x covenant.",
        {
          inputs: [nd, ue],
          formula: "nd / ue",
          as: "times",
          stated: zh ? "3.25倍" : "3.25x",
          relation: "at most" as const,
        },
        "not-checked",
      ],
    ] as const;
  };

  // protects=brackets on a loss keep its sign, a sum in any form (SUM, a product added) keeps the sign of a cost in it, every number the model names must hold whatever their order, and a negative figure is never inside a positive limit, in English and Chinese (review of #1908); fails_when="Operating margin was 3%" against an operating loss "(12.0)", "Net cash flow was 5.0" against SUM(10.0, (15.0)), or "Leverage of 2.5x is inside the 3.25x covenant" at 2.77x is Supported, or a loss-making EBITDA's negative leverage is inside a covenant; no_claim=the meaning of a covenant against loss-making EBITDA; an incomparable result leaves its arithmetic Not checked.
  test.each(
    [...cases("en"), ...cases("zh")].map(
      ([document, claim, calculation, verdict]) => [claim, verdict, document, calculation] as const,
    ),
  )("%#: “%s” is %s", async (claim, verdict, document, calculation) => {
    const said = verdict === "contradicted" ? "supported" : "unsupported";
    const result = await checked(document, claim, calculation, said);
    expect(result.verdict).toBe(verdict);
  });

  // protects=a cost in brackets is read by its size only when the model marks it so; fails_when=187.3 ÷ (41.2) agrees with "4.55x" though no input was marked; no_claim=none beyond protects.
  test("a cost in brackets keeps its sign unless the model marks it a cost", async () => {
    const [fy, fc] = COVER.inputs;
    if (!fy || !fc) throw new Error("No cover inputs.");
    const unmarked = { ...COVER, inputs: [fy, { ...fc, bracketedCost: false }], stated: "4.55x" };
    const result = await checked(RESULTS, COVERED("4.55x"), unmarked, "unsupported");
    expect(result.verdict).toBe("contradicted");
  });

  // protects=a check is offered relation, which it must give, saying when it is a limit; fails_when=the model is never told a limit can be named, or may leave relation out; no_claim=none beyond protects.
  test("the check's calculate takes relation for a limit", async () => {
    const calls: ModelCall[] = [];
    const claim = INSIDE("3.25x");
    const plans = {
      [claim]: { verdict: "supported", calculation: { ...LEVERAGE, stated: "3.25x" } },
    } as const;
    const setup = await setUpWithDocuments(checkingModel(plans, calls), [RESULTS]);
    await setup.core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    await setup.core.checkClaim({ claim });
    const offered = JSON.stringify(calls[0]?.options.tools);
    expect(offered).toContain('"at most"');
    expect(offered).toContain("give relation");
    expect(offered).toContain("bracketedCost");
    expect(offered).toMatch(/"required":\[[^\]]*"stated","relation"\]/);
  });
});

describe("A count of people in brackets is a count (#1023)", () => {
  const ACCOUNTS = {
    name: "Statement of accounts.md",
    contents: [
      "# Statement of accounts",
      "",
      "£'000",
      "",
      "Revenue 45,300",
      "",
      "Administrative expenses (12,500)",
      "",
      "Headcount (250)",
      "",
      "Employees (1,250)",
      "",
      "Staff 人数（250）",
      "",
      "Impairment (£1.2m)",
    ].join("\n"),
  };
  const HEADCOUNT = "Headcount (250)";
  const IMPAIRMENT = "Impairment (£1.2m)";
  const CLAIM = "We had 250 employees.";
  const DEDUCTION = "Impairment was £1.2m, a deduction.";
  const input = { name: "headcount", label: "Headcount", number: "(250)" };

  // protects=#1023; fails_when=a headcount in brackets is read as minus 250, so a figure worked out from it is -250 and counted as negative, or an impairment in brackets with a currency and a scale is read as plus, so a correct sentence about either is Contradicted; no_claim=the wording of the Answer, which the scripted model writes.
  test("the Answer to “What was the headcount?” says 250, “We had 250 employees.” is Supported, and an impairment in brackets is a deduction", async () => {
    const plans: Record<string, Plan> = {
      [CLAIM]: {
        verdict: "contradicted",
        calculation: {
          inputs: [{ ...input, quote: HEADCOUNT }],
          formula: "headcount",
          stated: "250",
        },
      },
      [DEDUCTION]: {
        verdict: "contradicted",
        calculation: {
          inputs: [
            { name: "impairment", label: "Impairment", quote: IMPAIRMENT, number: "(£1.2m)" },
          ],
          formula: "-impairment",
          stated: "£1.2m",
        },
      },
    };
    const model = scriptedModel(
      (call) => {
        if (isCheckRun(call)) return checkReply(call, plans);
        const searches = call.results.filter((result) => result.tool === "search_documents");
        if (searches.length === 0) {
          return { calls: [{ tool: "search_documents", input: { query: "headcount" } }] };
        }
        if (call.results.some((result) => result.tool === "calculate")) {
          return { text: "We had [=1] employees[^1]." };
        }
        const passage = shownPassages(searches.at(-1)?.text ?? "").find((each) =>
          each.text.includes(HEADCOUNT),
        );
        const figure = {
          marker: 1,
          label: "Headcount",
          formula: "headcount",
          inputs: [{ ...input, citation: 1 }],
        };
        return {
          calls: [
            {
              tool: "cite",
              input: {
                citations: [{ marker: 1, passage: passage?.id, quote: HEADCOUNT }],
              },
            },
            { tool: "calculate", input: { figures: [figure] } },
          ],
        };
      },
      { generate: checkGenerate(plans) },
    );
    const { core } = await setUpWithDocuments(model, [ACCOUNTS]);
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) {
      await core.allowDataFlow("chat", saved.service.id);
      await core.allowDataFlow("checks", saved.service.id);
    }

    const asked = await core.askInConversation({ text: "What was the headcount?" });
    if (!asked.asked) throw new Error("The Question wasn't asked.");
    await answerEnded(core, asked.answerId);
    const content = await core.getConversation(asked.conversation.id);
    const answer = content.messages.find((message) => message.id === asked.answerId);
    if (answer?.kind !== "answer") throw new Error("No Answer.");
    expect(answer.figures[0]).toMatchObject({ shown: "250" });
    expect(answer.figures[0]?.inputs.map((each) => each.number.value)).toEqual([250]);

    const result = await core.checkClaim({ claim: CLAIM });
    expect(result).toMatchObject({
      verdict: "supported",
      calculation: { stated: "250 employees" },
    });
    if (result.verdict === "not-checked") throw new Error("Not checked.");
    expect(result.calculation?.figure.inputs.map((each) => each.number.value)).toEqual([250]);

    const deduction = await core.checkClaim({ claim: DEDUCTION });
    expect(deduction).toMatchObject({ verdict: "supported", calculation: { stated: "£1.2m" } });
    if (deduction.verdict === "not-checked") throw new Error("Not checked.");
    expect(deduction.calculation?.figure.inputs.map((each) => each.number.value)).toEqual([
      -1_200_000,
    ]);
  });
});

describe("A sentence the Documents state only part of, with no Citation", () => {
  const STAFF = "Staff watch spring tides at new moon and at full moon from the harbour wall.";
  const MOON = "Spring tides happen at new moon and at full moon";
  const PARTLY =
    "\nCovered: spring tides at new and full moon\nNot covered: the staff and the harbour wall";
  const asked = (model: ReturnType<typeof checkingModel>, instructions: string) =>
    model.doGenerateCalls.filter((call) => JSON.stringify(call.prompt).includes(instructions))
      .length;

  test("keeps the Passage the model quoted for the part it covers, found, beside what it covers and what not", async () => {
    const model = checkingModel({
      [STAFF]: {
        verdict: "unsupported",
        quote: MOON,
        says: `Tides says when spring tides happen, not who watches them.${PARTLY}`,
        judgement: "same",
      },
    });
    const { core, client, check } = await mindWith([STAFF], model);

    await check();

    const [shown] = await shownChecks(core, client);
    expect(shown).toMatchObject({
      shown: { state: "unsupported" },
      check: {
        evidence: null,
        unsupported: {
          covered: "spring tides at new and full moon",
          uncovered: "the staff and the harbour wall",
          quoted: { documentName: "Tides", quote: MOON, check: "found" },
        },
      },
    });
    expect(asked(model, "named the part of it that a Passage does state")).toBe(0);
  });

  test("asks once for that Passage when the model named the part but quoted none, and keeps it once its quote is found", async () => {
    const model = checkingModel(
      { [STAFF]: { reply: { text: `Verdict: unsupported${PARTLY}` }, judgement: "same" } },
      [],
      JSON.stringify({ passage: "P1", location: null, quote: MOON }),
    );
    const { core, client, check } = await mindWith([STAFF], model);

    await check();

    expect(asked(model, "named the part of it that a Passage does state")).toBe(1);
    expect((await shownChecks(core, client))[0]?.check.unsupported?.quoted).toMatchObject({
      quote: MOON,
      check: "found",
    });
  });

  test("keeps none when the quote it gives isn't found, nor for a sentence nothing in the Documents states", async () => {
    const model = checkingModel(
      {
        [STAFF]: { reply: { text: `Verdict: unsupported${PARTLY}` }, judgement: "same" },
        [UNSUPPORTED]: { verdict: "unsupported" },
      },
      [],
      JSON.stringify({ passage: "P1", location: null, quote: "Spring tides happen every Tuesday" }),
    );
    const { core, client, check } = await mindWith([STAFF, UNSUPPORTED], model);

    await check();

    const [staff, penguins] = await shownChecks(core, client);
    expect(staff?.check.unsupported).toEqual({
      reason: null,
      covered: "spring tides at new and full moon",
      uncovered: "the staff and the harbour wall",
      found: true,
    });
    expect(penguins?.check.unsupported).toEqual({ reason: null, covered: null, uncovered: null });
    expect(asked(model, "named the part of it that a Passage does state")).toBe(1);
  });

  test("a supported sentence that names the Passage's party in general words shows the part the Passage states", async () => {
    const wider = (lines: string): Plan => ({
      verdict: "supported",
      quote: MOON,
      says: `Scope: wider\nTides says when spring tides happen.${lines}`,
      judgement: "same",
    });
    const calls: ModelCall[] = [];
    const { core, client, check } = await mindWith(
      [STAFF, SUPPORTED],
      checkingModel({ [STAFF]: wider(PARTLY), [SUPPORTED]: PLANS[SUPPORTED] as Plan }, calls),
    );

    await check();

    const [staff, plain] = await shownChecks(core, client);
    expect(calls[0]?.system).toContain("Scope: the sentence's own word for the Passage's party");
    expect(staff).toMatchObject({
      shown: { state: "unsupported" },
      check: {
        evidence: null,
        unsupported: {
          covered: "spring tides at new and full moon",
          uncovered: "the staff and the harbour wall",
          quoted: { quote: MOON, check: "found" },
        },
      },
    });
    expect(plain?.shown).toEqual({ state: "supported" });
  });

  // protects=a Supported reply with a wider scope keeps the partly-supported card quoting the Passage it cited, and no nearest line is judged, in English and Chinese; fails_when=a nearest line judged different replaces that card, or the request is still made; no_claim=how a real model judges the line (eval/repeats README, #1708).
  test.each([
    {
      name: "English",
      language: "en" as const,
      sentence: STAFF,
      quote: MOON,
      covered: "spring tides at new and full moon",
      uncovered: "the staff and the harbour wall",
      document: undefined,
    },
    {
      name: "Chinese",
      language: "zh-CN" as const,
      sentence: "职工每周可在家工作两天。",
      quote: "乙方每周可在家工作两天，须事先与主管商定。",
      covered: "乙方每周可在家工作两天",
      uncovered: "所有职工",
      document: { name: "劳动合同.md", contents: "乙方每周可在家工作两天，须事先与主管商定。" },
    },
  ])(
    "$name: a supported reply with a wider scope keeps its part card, with no nearest line asked about",
    async ({ language, sentence, quote, covered, uncovered, document }) => {
      const model = checkingModel({
        [sentence]: {
          verdict: "supported",
          quote,
          says: `Scope: wider\nSays so for one party.\nCovered: ${covered}\nNot covered: ${uncovered}`,
          judgement: "conflict",
        },
      });
      const { core, client, check } = await mindWith([sentence], model, document ? [document] : []);
      await core.updateSettings({ user: { language } });

      await check();

      expect((await shownChecks(core, client))[0]).toMatchObject({
        shown: { state: "unsupported" },
        check: { evidence: null, unsupported: { covered, uncovered, quoted: { quote } } },
      });
      expect(asked(model, "- conflict: both state a figure")).toBe(0);
    },
  );

  test("names no part covered when the reply says no Passage is about the sentence's topic", async () => {
    const { core, client, check } = await mindWith(
      [STAFF],
      checkingModel({
        [STAFF]: {
          verdict: "unsupported",
          quote: MOON,
          says: `Topic: not found\nNothing is said of who watches.${PARTLY}`,
          judgement: "neither",
        },
      }),
    );

    await check();

    expect((await shownChecks(core, client))[0]?.check.unsupported).toEqual({
      reason: "Nothing is said of who watches.",
      covered: null,
      uncovered: null,
    });
  });

  test("asks once for the parts when the reply names a wider group but none it can show", async () => {
    const wider = (part: string) =>
      checkingModel({
        [STAFF]: {
          verdict: "supported",
          quote: MOON,
          says: "Scope: Staff, wider\nTides says so.",
          judgement: "same",
          part,
        },
      });
    const asked = (model: ReturnType<typeof checkingModel>) =>
      model.doGenerateCalls.filter((call) =>
        JSON.stringify(call.prompt).includes("says more than words quoted"),
      ).length;

    const model = wider("Covered: spring tides at new and full moon\nNot covered: the staff");
    const { core, client, check } = await mindWith([STAFF], model);
    await check();
    expect((await shownChecks(core, client))[0]?.check.unsupported).toMatchObject({
      covered: "spring tides at new and full moon",
      uncovered: "the staff",
      quoted: { quote: MOON, check: "found" },
    });
    expect(asked(model)).toBe(1);

    const none = wider("I can't say.");
    const again = await mindWith([STAFF], none);
    await again.check();
    expect((await shownChecks(again.core, again.client))[0]?.shown).toEqual({
      state: "supported",
    });
    expect(asked(none)).toBe(1);
  });

  test("a sentence with its own Citations asks for no quote: its card shows them", async () => {
    const model = checkingModel(
      { [STAFF]: { reply: { text: `Verdict: unsupported${PARTLY}` }, judgement: "neither" } },
      [],
      JSON.stringify({ passage: "P1", location: null, quote: MOON }),
    );
    const { core } = await setUpWithDocuments(model, [TIDES]);

    const result = await core.checkClaim({
      claim: STAFF,
      cited: [{ documentName: "Tides", quote: MOON }],
    });

    expect(result).toMatchObject({
      verdict: "unsupported",
      unsupported: { covered: "spring tides at new and full moon" },
    });
    expect(result.verdict === "unsupported" && result.unsupported?.quoted).toBeFalsy();
    expect(asked(model, "named the part of it that a Passage does state")).toBe(0);
  });

  test("a nearest line that says something different still comes first", async () => {
    const { core, client, check } = await mindWith(
      [CONTRADICTED],
      checkingModel({
        [CONTRADICTED]: {
          reply: {
            text: "Verdict: unsupported\nCovered: the times of high water\nNot covered: every week",
          },
        },
      }),
    );

    await check();

    const [near] = await shownChecks(core, client);
    expect(near?.check.evidence?.quote).toBe(
      "Harbours publish the times of high water every year.",
    );
    expect(near?.check.unsupported?.quoted).toBeUndefined();
  });
});

describe("When the model can't check a sentence", () => {
  const failing = (reply: ScriptedReply): Plan => ({ reply });
  test.each<{ reason: ClaimCheckAttributes["reason"]; plan: Plan }>([
    { reason: "refused", plan: failing({ text: "I'm sorry, I can't help with that." }) },
    { reason: "malformed", plan: failing({ text: "It reads well to me." }) },
    { reason: "empty", plan: failing({ text: "" }) },
    {
      reason: "rate-limit",
      plan: failing({ error: { status: 429, message: "Rate limit reached." } }),
    },
    // A verdict whose quote isn't in the Passage it names.
    {
      reason: "no-evidence",
      plan: {
        verdict: "supported",
        quote: "Spring tides happen twice a year",
        says: "It says so.",
      },
    },
  ])(
    "$reason: the sentence says “not checked” with why, never supported",
    async ({ reason, plan }) => {
      const { core, client, check } = await mindWith(
        [SUPPORTED],
        checkingModel({ [SUPPORTED]: plan }),
      );

      expect(await check()).toEqual({
        kind: "checked",
        sentences: 1,
        checked: 0,
        smallModel: false,
      });

      const [checked] = await shownChecks(core, client);
      expect(checked?.shown).toEqual({ state: "not-checked", reason });
      expect(checked?.check.evidence).toBeNull();
    },
  );

  test("a verdict given without its Passage is asked for once more, and counts once its quote is found", async () => {
    const plans: Record<string, Plan> = {
      [SUPPORTED]: { verdict: "supported", says: "Tides says so." },
    };
    const model = checkingModel(
      plans,
      [],
      JSON.stringify({ passage: "P1", quote: "Spring tides happen at new moon and at full moon" }),
    );
    const { core, client, check } = await mindWith([SUPPORTED], model);

    expect(await check()).toEqual({ kind: "checked", sentences: 1, checked: 1, smallModel: false });

    const [checked] = await shownChecks(core, client);
    expect(checked?.shown).toEqual({ state: "supported" });
    expect(checked?.check.evidence).toMatchObject({
      quote: "Spring tides happen at new moon and at full moon",
      check: "found",
    });
    const asked = model.doGenerateCalls.filter((call) =>
      JSON.stringify(call.prompt).includes("without recording the Passage"),
    );
    expect(asked).toHaveLength(1);
  });

  test("cost cap: nothing is sent, and the sentence says “not checked” with why", async () => {
    const calls: ModelCall[] = [];
    const model = checkingModel(PLANS, calls);
    const folder = await createTempDataFolder();
    const sources = await createTempDataFolder();
    const core = startCore(folder, {
      createChatModel: () => model,
      now: manualClock("2026-10-12T09:00:00.000Z").now,
    });
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    await core.saveChatProvider({
      kind: "anthropic",
      modelId: "claude-haiku-5-5",
      apiKey: "sk-test",
    });
    await core.updateSettings({ user: { monthlyCap: { amount: 0, currency: "USD" } } });
    await addAndProcess(core, [await writeSourceFile(sources, TIDES.name, TIDES.contents)]);
    const mind = await core.createMind({ title: "Capped" });
    const client = await connectToMind(core, mind.id);
    const block = paragraph(text(SUPPORTED));
    writeMind(client, [block]);
    await client.settled();

    await core.checkSentences({
      requestId: "capped",
      mindId: mind.id,
      action: "check-against-documents",
      ...whole(block, SUPPORTED.length),
    });

    expect((await shownChecks(core, client)).map((each) => each.shown)).toEqual([
      { state: "not-checked", reason: "cost-cap" },
    ]);
    expect(calls).toEqual([]);
  });
});

describe("A reply whose verdict is written in the turn that calls cite (#1673)", () => {
  const SPRING_QUOTE = "Spring tides happen at new moon and at full moon";
  const SAYS = "Tides says spring tides happen at new and full moon.";
  const LINES = "Verdict: supported\nScope: none, same\nTopic: found\nRoles: none, same";
  const CONTRACT = {
    name: "劳动合同书.md",
    contents:
      "# 劳动合同书\n\n乙方自2027年1月11日起入职。\n\n乙方每年享有带薪年休假10天，法定节假日另计。",
  };

  const citesBeside = (step: { search?: string; quote: string; beside: string; after: string }) =>
    scriptedModel(
      (call) => {
        const searches = call.results.filter((result) => result.tool === "search_documents");
        if (searches.length === 0) {
          return {
            ...(step.search && { text: step.search }),
            calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }],
          };
        }
        if (call.results.some((result) => result.tool === "cite")) return { text: step.after };
        const shown = shownPassages(searches.at(-1)?.text ?? "");
        const passage = shown.find((each) => each.text.includes(step.quote));
        const citations = [{ marker: 1, passage: passage?.id, quote: step.quote }];
        return { text: step.beside, calls: [{ tool: "cite", input: { citations } }] };
      },
      { generate: checkGenerate({}) },
    );

  // protects=verdict lines written beside cite with no marker, the marked sentence or the last lines after it, give the sentence its verdict and Citation in the model's own three requests; fails_when=the lines are dropped as a preamble and the check reads "not checked"; no_claim=how often a real model writes it so.
  test.each([
    { shape: "the verdict lines, then the marked sentence", beside: LINES, after: `${SAYS} [^1]` },
    {
      shape: "the whole reply, then only its last lines",
      beside: `${LINES}\n\n${SAYS}`,
      after: "Covered: spring tides at new and full moon\nNot covered: none",
    },
  ])("$shape: the sentence is Supported, with its Citation", async ({ beside, after }) => {
    const model = citesBeside({ quote: SPRING_QUOTE, beside, after });
    const { core, client, check } = await mindWith([SUPPORTED], model);

    expect(await check()).toEqual({ kind: "checked", sentences: 1, checked: 1, smallModel: false });

    const [checked] = await shownChecks(core, client);
    expect(checked?.shown).toEqual({ state: "supported" });
    expect(checked?.check.says).toBe(SAYS);
    expect(checked?.check.evidence).toMatchObject({ quote: SPRING_QUOTE, check: "found" });
    expect(model.doStreamCalls).toHaveLength(3);
    const askedForEvidence = model.doGenerateCalls.filter((call) =>
      JSON.stringify(call.prompt).includes("without recording the Passage"),
    );
    expect(askedForEvidence).toEqual([]);
  });

  // protects=a Chinese check whose verdict lines come beside cite and whose sentence or last lines come after it, as Claude Haiku 5.5 wrote them, is Contradicted with its Citation and the Chinese sentence; fails_when=it reads "not checked"; no_claim=the verdict a real model gives.
  test.each([
    {
      shape: "the verdict lines, then the marked sentence",
      sentence: "乙方自2027年2月11日起入职。",
      quote: "乙方自2027年1月11日起入职",
      beside:
        "The labour contract states the start date as 2027年1月11日, not 2027年2月11日.\n\nVerdict: contradicted\nScope: 乙方, same\nTopic: found",
      after: "劳动合同书写明乙方自2027年1月11日起入职，不是2027年2月11日。[^1]",
      says: "劳动合同书写明乙方自2027年1月11日起入职，不是2027年2月11日。",
    },
    {
      shape: "the whole reply, then only its last lines",
      sentence: "乙方每年有15天带薪年休假。",
      quote: "乙方每年享有带薪年休假10天",
      beside:
        "Verdict: contradicted\nScope: 乙方, same\nTopic: found\nRoles: none, same\n\n劳动合同书写明乙方每年享有带薪年休假10天，不是15天。",
      after: "Covered: 乙方的年休假天数\nNot covered: 无",
      says: "劳动合同书写明乙方每年享有带薪年休假10天，不是15天。",
    },
  ])("in Chinese, $shape: the sentence is Contradicted, with its Citation", async (each) => {
    const model = citesBeside(each);
    const { core, client, check } = await mindWith([each.sentence], model, [CONTRACT]);
    await core.updateSettings({ user: { language: "zh-CN" } });

    await check();

    const [checked] = await shownChecks(core, client);
    expect(checked?.shown).toEqual({ state: "contradicted" });
    expect(checked?.check.says).toBe(each.says);
    expect(checked?.check.evidence).toMatchObject({ quote: each.quote, check: "found" });
  });

  // protects=text before a search and text beside cite that holds no verdict stay a preamble: the verdict and sentence come from the reply after them; fails_when=a preamble's words become what the Document says; no_claim=none beyond protects.
  test("a real preamble, before the search and beside cite, is still only a preamble", async () => {
    const model = citesBeside({
      search: "Let me search the Documents for spring tides.",
      quote: SPRING_QUOTE,
      beside: "I'll record the Passage that decides it.",
      after: `${LINES}\n${SAYS} [^1]`,
    });
    const { core, client, check } = await mindWith([SUPPORTED], model);

    await check();

    const [checked] = await shownChecks(core, client);
    expect(checked?.shown).toEqual({ state: "supported" });
    expect(checked?.check.says).toBe(SAYS);
  });

  // protects=a reply with no verdict line in any turn still reads "not checked" with its reason, though it cited; fails_when=it gets a verdict, or its Citation shows; no_claim=none beyond protects.
  test("a reply with no verdict lines in any turn is “not checked”, malformed", async () => {
    const model = citesBeside({
      quote: SPRING_QUOTE,
      beside: "I'll record the Passage that decides it.",
      after: "It reads well to me.",
    });
    const { core, client, check } = await mindWith([SUPPORTED], model);

    await check();

    const [checked] = await shownChecks(core, client);
    expect(checked?.shown).toEqual({ state: "not-checked", reason: "malformed" });
    expect(checked?.check.evidence).toBeNull();
  });

  // protects=a refusal written after verdict lines beside cite is the reply's last word: the sentence is "not checked", refused; fails_when=the earlier verdict is taken; no_claim=none beyond protects.
  test("verdict lines beside cite, then a refusal: “not checked”, refused", async () => {
    const model = citesBeside({
      quote: SPRING_QUOTE,
      beside: LINES,
      after: "I'm sorry, I can't check this sentence.",
    });
    const { core, client, check } = await mindWith([SUPPORTED], model);

    await check();

    const [checked] = await shownChecks(core, client);
    expect(checked?.shown).toEqual({ state: "not-checked", reason: "refused" });
  });

  const inSteps = (
    ...steps: ("search" | ((passage: (quote: string) => string) => ScriptedReply))[]
  ) =>
    scriptedModel(
      (call) => {
        const found = call.results.find((result) => result.tool === "search_documents");
        const passage = (quote: string) =>
          shownPassages(found?.text ?? "").find((each) => each.text.includes(quote))?.id ?? "P1";
        const step = steps[Math.min(call.results.length, steps.length - 1)];
        if (step === "search") {
          return { calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }] };
        }
        return step ? step(passage) : { text: "" };
      },
      { generate: checkGenerate({}) },
    );
  const cites = (passage: string, quote: string) => ({
    tool: "cite",
    input: { citations: [{ marker: 1, passage, quote }] },
  });
  const HARBOUR_QUOTE = "Harbours publish the times of high water every year.";
  const HARBOUR_SAYS = "Tides says harbours publish them every year, not every week.";
  const LEAVE_QUOTE = "乙方每年享有带薪年休假10天";
  const LEAVE_SAYS = "劳动合同书写明乙方每年享有带薪年休假10天，不是15天。";

  // protects=a verdict written beside cite before any search stays a preamble, though the model searches after it: the sentence is "not checked", as on main; fails_when=the earlier verdict decides the sentence; no_claim=none beyond protects.
  test.each([
    {
      language: "en" as const,
      sentence: SUPPORTED,
      quote: SPRING_QUOTE,
      first: "Verdict: unsupported\nTopic: not found",
      last: "Covered: none\nNot covered: spring tides at new and full moon",
    },
    {
      language: "zh-CN" as const,
      sentence: "乙方每年享有带薪年休假10天。",
      quote: LEAVE_QUOTE,
      first: "Verdict: contradicted\nScope: 乙方, same\nTopic: found",
      last: "劳动合同书写明乙方每年享有带薪年休假10天。[^1]",
    },
  ])(
    "$language: a verdict beside cite before the search is “not checked”, malformed",
    async (each) => {
      const model = inSteps(
        () => ({ text: each.first, calls: [cites("P1", each.quote)] }),
        "search",
        (passage) => ({ calls: [cites(passage(each.quote), each.quote)] }),
        () => ({ text: each.last }),
      );
      const { core, client, check } = await mindWith([each.sentence], model, [CONTRACT]);
      if (each.language === "zh-CN") await core.updateSettings({ user: { language: "zh-CN" } });

      await check();

      const [checked] = await shownChecks(core, client);
      expect(checked?.shown).toEqual({ state: "not-checked", reason: "malformed" });
    },
  );

  // protects=text beside a later cite with no verdict in it, after the verdict lines, never becomes what the Document says: the card's sentence is the reply's; fails_when=the card says "Let me correct the quote."; no_claim=none beyond protects.
  test.each([
    {
      language: "en" as const,
      sentence: CONTRADICTED,
      quote: HARBOUR_QUOTE,
      lines: "Verdict: contradicted\nScope: none, same\nTopic: found\nRoles: none, same",
      between: "Let me correct the quote.",
      says: HARBOUR_SAYS,
    },
    {
      language: "zh-CN" as const,
      sentence: "乙方每年有15天带薪年休假。",
      quote: LEAVE_QUOTE,
      lines: "Verdict: contradicted\nScope: 乙方, same\nTopic: found\nRoles: none, same",
      between: "我来更正引文。",
      says: LEAVE_SAYS,
    },
  ])(
    "$language: a preamble set aside after the verdict lines isn't what the Document says",
    async (each) => {
      const model = inSteps(
        "search",
        (passage) => ({
          text: each.lines,
          calls: [cites(passage(each.quote), `${each.quote}，每周`)],
        }),
        (passage) => ({ text: each.between, calls: [cites(passage(each.quote), each.quote)] }),
        () => ({ text: `${each.says} [^1]` }),
      );
      const { core, client, check } = await mindWith([each.sentence], model, [CONTRACT]);
      if (each.language === "zh-CN") await core.updateSettings({ user: { language: "zh-CN" } });

      await check();

      const [checked] = await shownChecks(core, client);
      expect(checked?.shown).toEqual({ state: "contradicted" });
      expect(checked?.check.says).toBe(each.says);
      expect(checked?.check.evidence).toMatchObject({ quote: each.quote, check: "found" });
    },
  );

  // protects=of two verdicts written beside cite after the search, the later one decides the sentence, in either order and in Chinese; fails_when=the earlier verdict decides it; no_claim=none beyond protects.
  test.each([
    {
      language: "en" as const,
      sentence: SUPPORTED,
      quote: SPRING_QUOTE,
      earlier: "Verdict: contradicted\nScope: none, same\nTopic: found\nRoles: none, same",
      later: LINES,
      says: SAYS,
      state: "supported",
    },
    {
      language: "en" as const,
      sentence: CONTRADICTED,
      quote: HARBOUR_QUOTE,
      earlier: LINES,
      later: "Verdict: contradicted\nScope: none, same\nTopic: found\nRoles: none, same",
      says: HARBOUR_SAYS,
      state: "contradicted",
    },
    {
      language: "zh-CN" as const,
      sentence: "乙方每年有15天带薪年休假。",
      quote: LEAVE_QUOTE,
      earlier: "Verdict: supported\nScope: 乙方, same\nTopic: found\nRoles: none, same",
      later: "Verdict: contradicted\nScope: 乙方, same\nTopic: found\nRoles: none, same",
      says: LEAVE_SAYS,
      state: "contradicted",
    },
  ])(
    "$language: of two verdicts beside cite, the later is the sentence's: $state",
    async (each) => {
      const model = inSteps(
        "search",
        (passage) => ({
          text: each.earlier,
          calls: [cites(passage(each.quote), `${each.quote}，每周`)],
        }),
        (passage) => ({ text: each.later, calls: [cites(passage(each.quote), each.quote)] }),
        () => ({ text: `${each.says} [^1]` }),
      );
      const { core, client, check } = await mindWith([each.sentence], model, [CONTRACT]);
      if (each.language === "zh-CN") await core.updateSettings({ user: { language: "zh-CN" } });

      await check();

      const [checked] = await shownChecks(core, client);
      expect(checked?.shown).toEqual({ state: each.state });
      expect(checked?.check.says).toBe(each.says);
    },
  );
});

describe("Needs re-check", () => {
  test("editing a checked sentence, inside or at its start, makes its check need a re-check", async () => {
    const { core, client, check } = await mindWith([SUPPORTED, UNSUPPORTED]);
    await check();
    const before = await shownChecks(core, client);
    expect(before.map((each) => each.shown.state)).toEqual(["supported", "unsupported"]);

    typeInto(client, 0, SUPPORTED.indexOf("moon"), "blue ");
    typeInto(client, 0, 0, "Not all ");

    const shown = (await shownChecks(core, client)).map((each) => [each.sentence, each.shown]);
    expect(shown).toEqual([
      [
        `Not all ${SUPPORTED.replace("moon", "blue moon")}`,
        { state: "needs-recheck", why: "edited" },
      ],
      [UNSUPPORTED, { state: "unsupported" }],
    ]);
  });

  test("a new version of its evidence Document makes its check need a re-check", async () => {
    const { core, client, check, tides, dataDir } = await mindWith([SUPPORTED]);
    await check();
    expect((await shownChecks(core, client))[0]?.shown).toEqual({ state: "supported" });

    const changed = `${TIDES.contents}\n\nNeap tides come in between.`;
    await writeFile(tides.path, changed);
    await core.reconcileDocuments();
    const [processed] = await waitForProcessing(core, [tides.id]);
    expect(processed?.contentHash).toBe(sha256(changed));

    expect((await shownChecks(core, client))[0]?.shown).toEqual({
      state: "needs-recheck",
      why: "new-version",
    });
    // Its evidence's text is kept for its card and Add as Citation (#79).
    expect(
      queryDatabase(
        dataDir,
        "SELECT content_hash FROM retained_versions WHERE kind = 'check-result' AND deleted_at IS NULL",
      ),
    ).toEqual([{ content_hash: tides.contentHash }]);
  });

  // protects=a result stays when a Document it only read goes, as an example's do when the interface language changes (#962), and needs a re-check when the one it rests on goes; fails_when=any Document read, deleted, makes a result need a re-check, or the evidence's own deletion doesn't; no_claim=new versions, tested above.
  test("a Document the check only read, deleted, leaves its result as it was; its evidence Document, deleted, makes it need a re-check", async () => {
    const moons = {
      name: "Moons.md",
      contents: "# Moons\n\nSpring tides and neap tides follow the moon around the harbour.",
    };
    const { core, client, check, tides, documents } = await mindWith([SUPPORTED], checkingModel(), [
      moons,
    ]);
    const read = documents[1] as Document;
    await check();
    const [checked] = await shownChecks(core, client);
    expect(checked?.shown).toEqual({ state: "supported" });
    expect(checked?.check.evidence?.documentId).toBe(tides.id);
    expect(checked?.check.versions.map((each) => each.documentId)).toContain(read.id);

    await core.deleteDocument(read.id);
    expect((await shownChecks(core, client))[0]?.shown).toEqual({ state: "supported" });

    await core.deleteDocument(tides.id);
    expect((await shownChecks(core, client))[0]?.shown).toEqual({
      state: "needs-recheck",
      why: "document-removed",
    });
  });

  test("a Mind deleted permanently lets go of its checks' evidence", async () => {
    const { core, check, mind, dataDir } = await mindWith([SUPPORTED]);
    await check();
    const retained = () =>
      queryDatabase<{ deleted: number }>(
        dataDir,
        "SELECT deleted_at IS NOT NULL AS deleted FROM retained_versions WHERE kind = 'check-result'",
      );
    expect(retained()).toEqual([{ deleted: 0 }]);

    await core.deleteMind(mind.id);
    await core.deletePermanently([{ kind: "mind", id: mind.id }]);

    expect(retained()).toEqual([{ deleted: 1 }]);
  });

  test("moving the Mind to another Folder makes its checks need a re-check", async () => {
    const { core, client, check, mind } = await mindWith([SUPPORTED]);
    await check();
    const folder = await core.createLibraryGroup({ name: "Coasts", description: "" });
    await core.moveToFolder({ mindIds: [mind.id], folderId: folder.id });

    expect((await shownChecks(core, client, folder.id))[0]?.shown).toEqual({
      state: "needs-recheck",
      why: "scope",
    });
  });
});

describe("Stopping", () => {
  test("a check left “checking” by a crash says “stopped” once its Mind opens", async () => {
    const { core, client, mind } = await mindWith([SUPPORTED]);
    const left = { ...LEFT_CHECKING, request: "a run that no longer exists" };
    writeMind(client, [paragraph(text(SUPPORTED, left))]);
    await client.settled();

    await core.openMind(mind.id);

    expect((await shownChecks(core, client)).map((each) => each.shown)).toEqual([
      { state: "not-checked", reason: "stopped" },
    ]);
  });

  test("a check stopped halfway leaves the sentences not checked yet “stopped”", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = scriptedModel((call) => {
      if (!call.results.some((result) => result.tool === "search_documents")) {
        return { calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }] };
      }
      if (sentenceOf(call) === UNSUPPORTED)
        return { text: "Verdict: unsupported", pause: { after: 0, until: held } };
      return { text: "Verdict: unsupported" };
    });
    const { core, client, mind, block, body } = await mindWith([SUPPORTED, UNSUPPORTED], model);
    const running = core.checkSentences({
      requestId: "stop-me",
      mindId: mind.id,
      action: "check-against-documents",
      ...whole(block, body.length),
    });
    await vi.waitFor(async () =>
      expect((await shownChecks(core, client)).map((each) => each.check.state)).toEqual([
        "unsupported",
        "checking",
      ]),
    );

    await core.cancelCheck("stop-me");
    release();

    expect(await running).toEqual({ kind: "cancelled" });
    expect((await shownChecks(core, client)).map((each) => each.shown)).toEqual([
      { state: "unsupported" },
      { state: "not-checked", reason: "stopped" },
    ]);
  });
});

describe("What the check is told about dates and its own workings (#821)", () => {
  test("its instructions keep a metadata date and the words index, passages and metadata out of the explanation", async () => {
    const calls: ModelCall[] = [];
    const { check } = await mindWith([CONTRADICTED], checkingModel(PLANS, calls));
    await check();
    const system = calls[0]?.system ?? "";
    expect(system).toContain("file's own metadata");
    expect(system).toContain("never mention it unless the sentence itself is about a date");
    expect(system).toContain("Never mention the index, the search, the passages");
  });
});

describe("Why a sentence is unsupported", () => {
  const HALF = "Spring tides happen at new moon and at full moon, creating very high waters.";
  const OWNER =
    "教程讨论了训练速度、鲁棒性和内存需求之间的权衡：已有实验通常显示，拟牛顿方法比梯度下降更快；一阶优化方法通常更加稳健，但速度较慢。";

  const reasonOf = async (reply: string, sentence = HALF) => {
    const { core, client, check } = await mindWith(
      [sentence],
      checkingModel({ [sentence]: { reply: { text: reply } } }),
    );
    await check();
    const [shown] = await shownChecks(core, client);
    return shown?.check.unsupported;
  };

  test("asks for the reason, and for what the Passages cover and don't when part of the sentence is supported", async () => {
    const calls: ModelCall[] = [];
    const { check } = await mindWith([UNSUPPORTED], checkingModel(PLANS, calls));
    await check();
    expect(calls[0]?.system).toContain("For unsupported, one plain sentence in English");
    expect(calls[0]?.system).toContain('"Covered: "');
    expect(calls[0]?.system).toContain('"Not covered: "');
  });

  test("is kept with the check: the reason and the phrases", async () => {
    expect(
      await reasonOf(
        "Verdict: unsupported\nTides gives the moon phases, not what they cause.\nCovered: the moon phases\nNot covered: the high waters",
      ),
    ).toEqual({
      reason: "Tides gives the moon phases, not what they cause.",
      covered: "the moon phases",
      uncovered: "the high waters",
      found: true,
    });
  });

  test("keeps the owner's sentence in Chinese, with its phrases in Chinese", async () => {
    expect(
      await reasonOf(
        "Verdict: unsupported\n引用只比较了速度。\nCovered: 速度比较\nNot covered: 内存和鲁棒性",
        OWNER,
      ),
    ).toEqual({
      reason: "引用只比较了速度。",
      covered: "速度比较",
      uncovered: "内存和鲁棒性",
      found: true,
    });
  });

  test("keeps the reason alone when the reply names only one side", async () => {
    expect(await reasonOf("Verdict: unsupported\nNot stated.\nNot covered: high waters")).toEqual({
      reason: "Not stated.",
      covered: null,
      uncovered: "high waters",
    });
  });

  test("is empty when the reply gives nothing", async () => {
    expect(await reasonOf("Verdict: unsupported")).toEqual({
      reason: null,
      covered: null,
      uncovered: null,
    });
  });

  test("is none for a sentence that is supported or contradicted", async () => {
    const { core, client, check } = await mindWith([SUPPORTED, CONTRADICTED]);
    await check();
    expect((await shownChecks(core, client)).map((each) => each.check.unsupported)).toEqual([
      null,
      null,
    ]);
  });

  test("is replaced when the sentence is checked again", async () => {
    const plans: Record<string, Plan> = { [HALF]: { reply: { text: "Verdict: unsupported" } } };
    const { core, client, check } = await mindWith([HALF], checkingModel(plans));
    await check();
    expect((await shownChecks(core, client))[0]?.check.unsupported).toEqual({
      reason: null,
      covered: null,
      uncovered: null,
    });
    plans[HALF] = {
      reply: {
        text: "Verdict: unsupported\nNot stated.\nCovered: the moon phases\nNot covered: the high waters",
      },
    };
    await check();
    expect((await shownChecks(core, client))[0]?.check.unsupported).toEqual({
      reason: "Not stated.",
      covered: "the moon phases",
      uncovered: "the high waters",
      found: true,
    });
  });
});

describe("A quote that starts with a figure (#1969)", () => {
  const RESULTS_ZH = {
    name: "雪松业绩.md",
    contents: [
      "# 雪松业绩",
      "",
      "调整后EBITDA 187.3（2025财年），88.0 和 91.5（2025年上半年、2026年上半年）",
      "",
      "2026年6月30日净负债 528.9",
    ].join("\n"),
  };
  const H1 = "88.0 和 91.5（2025年上半年、2026年上半年）";
  const WINDOW = "近十二个月指截至2026年6月30日的十二个月。";

  // protects=a check whose input quotes "88.0 和 91.5（…）" from the middle of a line reads 88.0 as a figure, so a right Chinese ratio sentence is Supported by calculate; fails_when=calculate says the quote has no 88.0 and the model's own Unsupported stands; no_claim=none beyond protects.
  test.each([
    { name: "is Supported by calculate when the sentence is right", scopeQuote: true },
    { name: "keeps an unquoted duration Not checked despite the valid ratio", scopeQuote: false },
  ])("$name", async ({ scopeQuote }) => {
    const claim = "2026年6月30日净负债为528.9，是近十二个月调整后EBITDA的2.77倍。";
    const calculation = {
      inputs: [
        { name: "nd", label: "净负债", quote: "2026年6月30日净负债 528.9", number: "528.9" },
        { name: "fy", label: "2025财年", quote: "调整后EBITDA 187.3（2025财年）", number: "187.3" },
        { name: "h1a", label: "2025年上半年", quote: H1, number: "88.0" },
        { name: "h1b", label: "2026年上半年", quote: H1, number: "91.5" },
      ],
      formula: "nd / (fy - h1a + h1b)",
      as: "times",
      stated: "2.77倍",
    };
    const calls: ModelCall[] = [];
    const plans = {
      [claim]: {
        verdict: "unsupported",
        calculation,
        strict: { text: "same" },
        ...(scopeQuote && { quote: WINDOW }),
      },
    } as const;
    const setup = await setUpWithDocuments(checkingModel(plans, calls), [
      {
        ...RESULTS_ZH,
        contents: scopeQuote ? `${RESULTS_ZH.contents}\n\n${WINDOW}` : RESULTS_ZH.contents,
      },
    ]);
    const saved = await setup.core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await setup.core.allowDataFlow("checks", saved.service.id);

    const result = await setup.core.checkClaim({ claim });
    const replies = calls
      .flatMap((call) => call.results)
      .filter((each) => each.tool === "calculate");
    expect(replies.at(-1)?.text).toMatch(/^Recorded \[=1\] = 2\.77倍/);
    if (scopeQuote) {
      expect(result).toMatchObject({ verdict: "supported", calculation: { agrees: true } });
    } else {
      expect(result).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
    }
  });

  // protects=a quote that is a list's line reads 5% as its figure, not the list's "1.", so a right sentence is Supported by calculate; fails_when=the list's number is read as the figure and 5% is refused; no_claim=none beyond protects.
  test("reads a list's line's figure, not its number", async () => {
    const list = {
      name: "Revenue.md",
      contents: ["# Revenue", "", "1. Revenue rose 5% in 2025."].join("\n"),
    };
    const claim = "Revenue rose 5% in 2025.";
    const calculation = {
      inputs: [{ name: "rose", label: "增长", quote: "1. Revenue rose 5% in 2025.", number: "5%" }],
      formula: "rose",
      as: "percent",
      stated: "5%",
    };
    const calls: ModelCall[] = [];
    const plans = { [claim]: { verdict: "unsupported", calculation } } as const;
    const setup = await setUpWithDocuments(checkingModel(plans, calls), [list]);
    const saved = await setup.core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await setup.core.allowDataFlow("checks", saved.service.id);

    const result = await setup.core.checkClaim({ claim });
    const replies = calls
      .flatMap((call) => call.results)
      .filter((each) => each.tool === "calculate");
    expect(replies.at(-1)?.text).toMatch(/^Recorded \[=1\] = 5\.0%/);
    expect(result).toMatchObject({ verdict: "supported", calculation: { agrees: true } });
  });
});

describe("A quote whose page mentions it before its Passage (#1981)", () => {
  const HEADING = "3.1 收入";
  const CLAIM = "2026年收入为1240.0。";
  const FILLER = Array.from(
    { length: 20 },
    (_, index) =>
      `第${index + 1}项说明：本期经营活动产生的现金流量净额与净利润的差异，主要来自折旧摊销、利息费用以及营运资本变动。`,
  ).join("\n\n");
  const REPORT = ["# 雪松业绩", "", `详见 ${HEADING}。`, "", FILLER, "", HEADING, "收入为400.0"];

  const check = async (
    contents: string,
    quote = HEADING,
    problem = /the quote occurs more than once/,
  ) => {
    const calculation = {
      inputs: [
        { name: "base", label: "2026年收入", quote: "收入为400.0", number: "400.0" },
        { name: "section", label: "章节号", quote, number: "3.1" },
      ],
      formula: "base * section",
      as: "number",
      stated: "1240.0",
    };
    const plans = { [CLAIM]: { verdict: "unsupported", calculation } } as const;
    const calls: ModelCall[] = [];
    const model = scriptedModel(
      (call) => {
        calls.push(call);
        const search = call.results.filter((each) => each.tool === "search_documents").at(-1);
        if (!search) return { calls: [{ tool: "search_documents", input: { query: CLAIM } }] };
        const heading = shownPassages(search.text).find((passage) =>
          passage.text.split("\n").some((line) => line.trim() === HEADING),
        );
        if (!call.results.some((each) => each.tool === "calculate")) {
          return {
            calls: [
              {
                tool: "calculate",
                input: {
                  figures: [
                    {
                      marker: 1,
                      label: "句子里的数字",
                      relation: "equals",
                      ...calculation,
                      inputs: calculation.inputs.map((input) => ({
                        ...input,
                        passage: heading?.id,
                      })),
                    },
                  ],
                },
              },
            ],
          };
        }
        return { text: "Verdict: unsupported" };
      },
      { generate: checkGenerate(plans) },
    );
    const setup = await setUpWithDocuments(model, [{ name: "雪松业绩半年报.md", contents }]);
    const saved = await setup.core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await setup.core.allowDataFlow("checks", saved.service.id);

    const result = await setup.core.checkClaim({ claim: CLAIM });
    const replies = calls
      .flatMap((call) => call.results)
      .filter((each) => each.tool === "calculate");
    expect(replies.at(-1)?.text).toMatch(problem);
    expect(result).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
  };

  test("a unique quote of the heading still refuses its section number", async () => {
    await check(REPORT.join("\n"), `${HEADING}\n收入为400.0`, /the quote has no number "3\.1"/);
  });

  // protects=a quote of the real heading is read where its own Passage has it, so 3.1 stays a heading's number and calculate refuses it; fails_when=the earlier mention on the page places the quote after "详见 ", 3.1 reads as a figure, and the check is Supported on 3.1 × 400.0; no_claim=none beyond protects.
  test("reads the heading as a heading, not as a figure from the earlier mention", async () => {
    await check(REPORT.join("\n"));
  });

  // protects=a Passage that holds the heading and an earlier mention of those words keeps the heading's reading, so calculate refuses 3.1; fails_when=the first place in the Passage decides mid-line and the check is Supported on 3.1 × 400.0; no_claim=none beyond protects.
  test("reads the heading as a heading when its Passage holds both mentions", async () => {
    await check(["# 雪松业绩", "", `详见 ${HEADING}。`, "", HEADING, "收入为400.0"].join("\n"));
  });

  // protects=a Passage that runs past the cited page keeps the heading's reading from the page's own places, so calculate refuses 3.1; fails_when=the Passage's text isn't found on the cited page and the first place there decides mid-line; no_claim=none beyond protects.
  test("reads the heading as a heading when its Passage runs past the cited page", async () => {
    await check([...REPORT, "", "# 附注", "", "附注内容：本节说明会计政策。"].join("\n"));
  });
});
