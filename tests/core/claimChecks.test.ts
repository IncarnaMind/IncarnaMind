import { writeFile } from "node:fs/promises";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import type {
  ClaimCheckAction,
  ClaimCheckAttributes,
  Core,
  CoreAdapters,
  Document,
} from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { noteStateParts, readNoteState } from "../../src/renderer/src/noteState";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { translate } from "../../src/shared/i18n";
import { folderScope } from "../../src/shared/searchScope";
import {
  checkGenerate,
  checkingModel as checkingModelOf,
  checkReply,
  type Plan,
  sentenceOf,
} from "../helpers/checks";
import { type SourceFile, setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, sha256, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { checkClock } from "../helpers/heldClock";
import { connectToMind, type MindClient, typeInto } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import {
  judgesNothing,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

const fail = (): never => {
  throw new Error("The Note's state is null.");
};

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
const checkingModel = (plans: Record<string, Plan> = PLANS, calls: ModelCall[] = []) =>
  checkingModelOf(plans, calls);

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
      footing: "not-yet-known",
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
  overrides: Partial<CoreAdapters> = {},
) {
  const setup = await setUpWithDocuments(model, [TIDES, ...others], overrides);
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
  ])("reads the verdict however the model words it: %j", async (reply) => {
    const plans = { [UNSUPPORTED]: { reply: { text: reply } } };
    const { core, client, check } = await mindWith([UNSUPPORTED], checkingModel(plans));
    await check();
    expect((await shownChecks(core, client))[0]?.shown).toEqual({ state: "unsupported" });
  });

  // protects=a reply that gives a second Verdict line whose word isn't one of the three can't be read: Not checked, never Supported; the same reply without that line is Supported (#2817); fails_when=its first verdict is taken.
  test.each(["Verdict: not supported", "结论：不支持"])(
    "a Supported reply that goes on to say %j is Not checked",
    async (more) => {
      const said = PLANS[SUPPORTED]?.says ?? "";
      const shown = async (says: string) => {
        const plans = { [SUPPORTED]: { ...PLANS[SUPPORTED], says } };
        const { core, client, check } = await mindWith([SUPPORTED], checkingModel(plans));
        await check();
        return (await shownChecks(core, client))[0]?.shown;
      };

      expect(await shown(said)).toEqual({ state: "supported" });
      expect(await shown(`${said}\n${more}`)).toMatchObject({ state: "not-checked" });
    },
  );

  // protects=a reply that lowers its verdict is read by its later Verdict line, in English and Chinese labels (#3029, #3019); fails_when=the earlier verdict is taken, or the later lowering is lost; no_claim=none beyond protects.
  test.each([
    ["Verdict: contradicted", "Verdict: unsupported", "unsupported"],
    ["结论：contradicted", "结论：unsupported", "unsupported"],
  ])("a reply that changes %s to %s reads as %s", async (earlier, later, state) => {
    const reply = `${earlier}\nP1 is about another harbour, so it doesn't bear on this.\n${later}`;
    const plans = { [UNSUPPORTED]: { reply: { text: reply } } };
    const { core, client, check } = await mindWith([UNSUPPORTED], checkingModel(plans));
    await check();
    expect((await shownChecks(core, client))[0]?.shown).toMatchObject({ state });
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
        return cites === 1
          ? { calls: [cite(quote)] }
          : { text: "Verdict: supported\nEvidence: [1]" };
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
    // Its first search is made for it (#3512): the cite that is refused, the one that holds, the verdict.
    expect(model.doStreamCalls).toHaveLength(3);
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
      // A rate limit is waited out and sent again (#2897): its pauses end at once here.
      const { core, client, check } = await mindWith(
        [SUPPORTED],
        checkingModel({ [SUPPORTED]: plan }),
        [],
        { paceTimers: checkClock().timers },
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
  const LINES = "Verdict: supported\nEvidence: [1]";
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

  // protects=verdict lines written beside cite with no marker, then the marked Explanation or the last lines after it, give the sentence its verdict and Citation in the model's own three requests; fails_when=the lines are dropped as a preamble and the check reads "not checked"; no_claim=how often a real model writes it so.
  test.each([
    {
      shape: "the verdict lines, then the marked sentence",
      beside: LINES,
      after: `Explanation: ${SAYS} [^1]`,
    },
    {
      shape: "the whole reply, then only its last lines",
      beside: `Verdict: supported\nExplanation: ${SAYS}`,
      after: "Evidence: [1]",
    },
  ])("$shape: the sentence is Supported, with its Citation", async ({ beside, after }) => {
    const model = citesBeside({ quote: SPRING_QUOTE, beside, after });
    const { core, client, check } = await mindWith([SUPPORTED], model);

    expect(await check()).toEqual({ kind: "checked", sentences: 1, checked: 1, smallModel: false });

    const [checked] = await shownChecks(core, client);
    expect(checked?.shown).toEqual({ state: "supported" });
    expect(checked?.check.says).toBe(SAYS);
    expect(checked?.check.evidence).toMatchObject({ quote: SPRING_QUOTE, check: "found" });
    // The cite, then the verdict: its first search is made for it (#3512).
    expect(model.doStreamCalls).toHaveLength(2);
  });

  // protects=a Chinese check whose verdict lines come beside cite and whose sentence or last lines come after it, as Claude Haiku 5.5 wrote them, is Contradicted with its Citation and the Chinese sentence; fails_when=it reads "not checked"; no_claim=the verdict a real model gives.
  test.each([
    {
      shape: "the verdict lines, then the marked sentence",
      sentence: "乙方自2027年2月11日起入职。",
      quote: "乙方自2027年1月11日起入职",
      beside:
        "The labour contract states the start date as 2027年1月11日, not 2027年2月11日.\n\nVerdict: contradicted\nEvidence: [1]",
      after: "Explanation: 劳动合同书写明乙方自2027年1月11日起入职，不是2027年2月11日。[^1]",
      says: "劳动合同书写明乙方自2027年1月11日起入职，不是2027年2月11日。",
    },
    {
      shape: "the whole reply, then only its last lines",
      sentence: "乙方每年有15天带薪年休假。",
      quote: "乙方每年享有带薪年休假10天",
      beside:
        "Verdict: contradicted\n\nExplanation: 劳动合同书写明乙方每年享有带薪年休假10天，不是15天。",
      after: "Evidence: [1]",
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
      after: `${LINES}\nExplanation: ${SAYS} [^1]`,
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
      first: "Verdict: unsupported",
      last: `Explanation: ${SAYS} [^1]`,
    },
    {
      language: "zh-CN" as const,
      sentence: "乙方每年享有带薪年休假10天。",
      quote: LEAVE_QUOTE,
      first: "Verdict: contradicted\nEvidence: [1]",
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
      lines: "Verdict: contradicted\nEvidence: [1]",
      between: "Let me correct the quote.",
      says: HARBOUR_SAYS,
    },
    {
      language: "zh-CN" as const,
      sentence: "乙方每年有15天带薪年休假。",
      quote: LEAVE_QUOTE,
      lines: "Verdict: contradicted\nEvidence: [1]",
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
        () => ({ text: `Explanation: ${each.says} [^1]` }),
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
      earlier: "Verdict: contradicted\nEvidence: [1]",
      later: LINES,
      says: SAYS,
      state: "supported",
    },
    {
      language: "en" as const,
      sentence: CONTRADICTED,
      quote: HARBOUR_QUOTE,
      earlier: LINES,
      later: "Verdict: contradicted\nEvidence: [1]",
      says: HARBOUR_SAYS,
      state: "contradicted",
    },
    {
      language: "zh-CN" as const,
      sentence: "乙方每年有15天带薪年休假。",
      quote: LEAVE_QUOTE,
      earlier: "Verdict: supported\nEvidence: [1]",
      later: "Verdict: contradicted\nEvidence: [1]",
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
        () => ({ text: `Explanation: ${each.says} [^1]` }),
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

describe("A reply with a verdict and no recorded quote (#3595)", () => {
  const SALES_DOC = {
    name: "Tile sales 2025.md",
    contents:
      "# Tile sales 2025\n\nIn 2025 sales of floor tiles came to £2,416,000 and sales of wall tiles to £1,087,500.",
  };
  const SALES_SENTENCE = "Floor and wall tiles together sold £3,503,500 in 2025.";
  const SALES_QUOTE =
    "sales of floor tiles came to £2,416,000 and sales of wall tiles to £1,087,500";
  const SALES_SAYS =
    "The report gives £2,416,000 for floor tiles and £1,087,500 for wall tiles, totalling £3,503,500.";

  const askedToCite = (call: ModelCall) =>
    JSON.stringify(call.options.prompt).includes("Your verdict rests on no recorded quote");

  // protects=a Run that writes a verdict in text without calling cite gets one more turn to record its quote and finishes Supported with that Citation (#3595); fails_when=the sentence is left Not checked (no-evidence); no_claim=how often a real model omits cite.
  test("a verdict in text without calling cite gets one more turn to record its quote", async () => {
    const model = scriptedModel(
      (call) => {
        if (!askedToCite(call)) {
          return {
            text: `Details: total £3,503,500 / £2,416,000 + £1,087,500 = £3,503,500, same.\nVerdict: supported\nExplanation: ${SALES_SAYS}\nEvidence: []\nWorking: 2,416,000 + 1,087,500 = 3,503,500`,
          };
        }
        const search = call.results.find((result) => result.tool === "search_documents");
        const passage = shownPassages(search?.text ?? "").find((each) =>
          each.text.includes(SALES_QUOTE),
        );
        return {
          calls: [
            {
              tool: "cite",
              input: {
                citations: [{ marker: 1, passage: passage?.id ?? "P1", quote: SALES_QUOTE }],
                verdict: "supported",
                explanation: `${SALES_SAYS} [^1]`,
                working: "2,416,000 + 1,087,500 = 3,503,500",
              },
            },
          ],
        };
      },
      { generate: checkGenerate({}) },
    );
    const { core, client, check } = await mindWith([SALES_SENTENCE], model, [SALES_DOC]);

    expect(await check()).toEqual({ kind: "checked", sentences: 1, checked: 1, smallModel: false });

    const [checked] = await shownChecks(core, client);
    expect(checked?.shown).toEqual({ state: "supported" });
    expect(checked?.check.evidence).toMatchObject({ quote: SALES_QUOTE, check: "found" });
    expect(model.doStreamCalls).toHaveLength(2);
  });

  // protects=a verdict written beside calculate with a follow-up line that omits Verdict still triggers cite-first and records its quote (#3595); fails_when=cite-first ignores setAside and leaves the sentence Not checked; no_claim=none beyond protects.
  test("a verdict written beside calculate without calling cite still gets its turn to record its quote", async () => {
    const model = scriptedModel(
      (call) => {
        const search = call.results.find((result) => result.tool === "search_documents");
        const passage = shownPassages(search?.text ?? "").find((each) =>
          each.text.includes(SALES_QUOTE),
        );
        if (askedToCite(call)) {
          return {
            calls: [
              {
                tool: "cite",
                input: {
                  citations: [{ marker: 1, passage: passage?.id ?? "P1", quote: SALES_QUOTE }],
                  verdict: "supported",
                  explanation: `${SALES_SAYS} [^1]`,
                },
              },
            ],
          };
        }
        if (!call.results.some((result) => result.tool === "calculate")) {
          return {
            text: `Verdict: supported\nExplanation: ${SALES_SAYS}\nEvidence: []`,
            calls: [
              {
                tool: "calculate",
                input: {
                  figures: [
                    {
                      marker: 1,
                      label: "Total tile sales",
                      shown: "£3,503,500",
                      formula: "floor + wall",
                      inputs: [
                        {
                          name: "floor",
                          label: "Floor tiles",
                          value: 2_416_000,
                          passage: passage?.id ?? "P1",
                          quote: SALES_QUOTE,
                        },
                        {
                          name: "wall",
                          label: "Wall tiles",
                          value: 1_087_500,
                          passage: passage?.id ?? "P1",
                          quote: SALES_QUOTE,
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          };
        }
        return { text: `Explanation: ${SALES_SAYS}` };
      },
      { generate: checkGenerate({}) },
    );
    const { core, client, check } = await mindWith([SALES_SENTENCE], model, [SALES_DOC]);

    expect(await check()).toEqual({ kind: "checked", sentences: 1, checked: 1, smallModel: false });

    const [checked] = await shownChecks(core, client);
    expect(checked?.shown).toEqual({ state: "supported" });
    expect(checked?.check.evidence).toMatchObject({ quote: SALES_QUOTE, check: "found" });
  });

  // protects=a verdict whose only quote is not found word for word stays Not checked even after its extra turn (#3595); fails_when=the sentence is marked Supported without a verbatim quote; no_claim=none beyond protects.
  test("a verdict that still records no verbatim quote on its extra turn stays Not checked", async () => {
    const model = scriptedModel(
      (call) => {
        const search = call.results.find((result) => result.tool === "search_documents");
        const passage = shownPassages(search?.text ?? "").find((each) =>
          each.text.includes(SALES_QUOTE),
        );
        if (!askedToCite(call)) {
          return {
            text: `Verdict: supported\nExplanation: ${SALES_SAYS}\nEvidence: [1]\n<cite>[{"marker":1,"passage":"${passage?.id ?? "P1"}","quote":"floor and wall tiles sold 3,503,500"}]</cite>`,
          };
        }
        return {
          text: `Verdict: supported\nExplanation: ${SALES_SAYS}\nEvidence: []`,
        };
      },
      { generate: checkGenerate({}) },
    );
    const { core, client, check } = await mindWith([SALES_SENTENCE], model, [SALES_DOC]);

    expect(await check()).toEqual({ kind: "checked", sentences: 1, checked: 0, smallModel: false });

    const [checked] = await shownChecks(core, client);
    expect(checked?.shown).toEqual({ state: "not-checked", reason: "no-evidence" });
    expect(checked?.check.evidence).toBeNull();
    expect(model.doStreamCalls).toHaveLength(2);
  });
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

  // protects=#2313: a Folder move keeps a result its Citations back and asks for a re-check of one the whole Folder backed (an absence with no quote); fails_when=a quoted result is forgotten, or a whole-Folder result is kept in a Folder whose Documents were never read.
  test("a Folder move keeps a quoted result and needs a re-check for a whole-Folder one", () => {
    const quote = {
      passageId: "p1",
      documentId: "d1",
      documentName: "Tides.md",
      contentHash: "h1",
      pageFrom: 1,
      pageTo: 1,
      location: null,
      quote: "Spring tides happen at new moon and at full moon.",
      check: "found" as const,
      checkReason: null,
    };
    const versions = new Map([["d1", "h1"]]);
    const quoted: ClaimCheckAttributes = {
      ...LEFT_CHECKING,
      state: "supported",
      text: SUPPORTED,
      evidence: quote,
      scope: { folderId: "folder-a", widened: false },
      versions: [{ documentId: "d1", contentHash: "h1" }],
    };
    const absence: ClaimCheckAttributes = {
      ...LEFT_CHECKING,
      state: "supported",
      text: "The lease has no break clause.",
      evidence: null,
      scope: { folderId: "folder-a", widened: false },
      versions: [],
      readDocuments: [
        { documentId: "d1", documentName: "Lease.md", contentHash: "h1", locations: [] },
      ],
    };
    const now = (folderId: string) => ({
      text: SUPPORTED,
      footing: "not-yet-known" as const,
      versions,
      folderId,
      scope: null,
    });
    expect(claimCheckShown(quoted, now("folder-a"))).toEqual({ state: "supported" });
    expect(claimCheckShown(quoted, now("folder-b"))).toEqual({ state: "supported" });
    expect(
      claimCheckShown(absence, {
        ...now("folder-b"),
        text: absence.text,
      }),
    ).toEqual({
      state: "needs-recheck",
      why: "scope",
    });
    // A mixed claim keeps its quote but its absence part was read whole: the move still re-checks it.
    const part = (start: number, end: number, more: object) => ({
      span: { start, end },
      kind: "fact" as const,
      verdict: "supported" as const,
      evidence: [],
      says: null,
      unsupported: null,
      calculation: null,
      reason: null,
      detail: null,
      versions: [],
      excluded: [],
      citedCaseUnchecked: false,
      citedCaseFound: false,
      ...more,
    });
    const mixed: ClaimCheckAttributes = {
      ...quoted,
      text: "The lease has no break clause. The rent is £10,000.",
      evidence: null,
      parts: [
        part(0, 29, {
          readDocuments: [
            { documentId: "d1", documentName: "Lease.md", contentHash: "h1", locations: [] },
          ],
        }),
        part(30, 54, { evidence: [quote] }),
      ],
    };
    expect(
      claimCheckShown(mixed, {
        footing: "not-yet-known",
        text: mixed.text,
        versions,
        folderId: "folder-b",
        scope: null,
      }),
    ).toEqual({ state: "needs-recheck", why: "scope" });
    // A widened search, and the User's own chosen scope, do not follow the Folder.
    expect(
      claimCheckShown(
        {
          ...quoted,
          scope: { folderId: "folder-a", widened: true },
        },
        now("folder-b"),
      ),
    ).toEqual({ state: "supported" });
    const chosen = folderScope("folder-x");
    expect(
      claimCheckShown(
        { ...absence, scope: { folderId: "folder-a", widened: false, chosen } },
        {
          footing: "not-yet-known",
          text: absence.text,
          versions,
          folderId: "folder-b",
          scope: chosen,
        },
      ),
    ).toEqual({ state: "supported" });
    // An Unsupported verdict says nothing in the Folder stated the rest, so a move re-checks it
    // even when its quote is found there.
    const unstated: ClaimCheckAttributes = {
      ...quoted,
      state: "unsupported",
      evidence: null,
      unsupported: {
        reason: "The lease doesn't say it.",
        covered: "the rent",
        uncovered: "the break clause",
        quoted: quote,
      },
    };
    expect(claimCheckShown(unstated, now("folder-a"))).toEqual({ state: "unsupported" });
    expect(claimCheckShown(unstated, now("folder-b"))).toEqual({
      state: "needs-recheck",
      why: "scope",
    });
    // A mixed claim that is not Unsupported overall, with one Unsupported part: the same.
    const mixedUnsupported: ClaimCheckAttributes = {
      ...quoted,
      state: "contradicted",
      text: "The rent is £10,000 and there is no break clause.",
      evidence: quote,
      parts: [
        part(0, 22, { verdict: "supported", evidence: [quote] }),
        part(23, 50, { verdict: "unsupported" }),
      ],
    };
    expect(
      claimCheckShown(mixedUnsupported, {
        footing: "not-yet-known",
        text: mixedUnsupported.text,
        versions,
        folderId: "folder-b",
        scope: null,
      }),
    ).toEqual({ state: "needs-recheck", why: "scope" });
    // A whole read under a widened search is not the Folder's: the move keeps the verdict.
    expect(
      claimCheckShown(
        { ...absence, scope: { folderId: "folder-a", widened: true } },
        { ...now("folder-b"), text: absence.text },
      ),
    ).toEqual({ state: "supported" });
    // A part with an empty read list is no whole read: the move keeps a quoted claim.
    const emptyPartRead: ClaimCheckAttributes = {
      ...quoted,
      text: "The rent is £10,000 and the term is five years.",
      evidence: null,
      parts: [
        part(0, 22, { evidence: [quote], readDocuments: [] }),
        part(23, 46, { evidence: [quote] }),
      ],
    };
    expect(
      claimCheckShown(emptyPartRead, {
        footing: "not-yet-known",
        text: emptyPartRead.text,
        versions,
        folderId: "folder-b",
        scope: null,
      }),
    ).toEqual({ state: "supported" });
    // A check that landed nothing is not rewritten: the move has no result to protect.
    for (const [reason, left] of [
      ["cost-cap", { state: "not-checked", reason: "cost-cap" }],
      ["kept-inside", { state: "not-checked", reason: "kept-inside" }],
    ] as const)
      expect(
        claimCheckShown(
          { ...quoted, state: "not-checked", reason, evidence: null },
          now("folder-b"),
        ),
      ).toEqual(left);
  });

  test("Tidy's spaces and comma widths alone keep a check without parts' verdict", () => {
    const check: ClaimCheckAttributes = {
      ...LEFT_CHECKING,
      state: "supported",
      text: "导出为Word文件,你好。",
    };
    const now = {
      text: "导出为 Word 文件，你好。",
      footing: "not-yet-known" as const,
      versions: null,
      folderId: null,
      scope: null,
    };
    expect(claimCheckShown(check, now)).toEqual({ state: "supported" });
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

  // protects=#2313: filing a checked Note in a Folder that holds the Documents its Citations quote keeps every result, and the Note reads Checked in English and Chinese; fails_when=the move makes its checks need a re-check, or anything but the Documents' own change does; no_claim=what a new check's Search scope is after the move (checkScope.test.ts).
  test.each(["en", "zh-CN"] as const)(
    "moving the Mind to another Folder keeps its checks, in %s",
    async (language) => {
      const { core, client, check, mind, tides } = await mindWith([SUPPORTED]);
      await core.updateSettings({ user: { language } });
      await check();
      const before = noteStateParts(
        readNoteState({
          footing: [],
          cellFigures: [],
          doc: client.doc,
          documents: await core.listDocuments(),
          keptCitationTexts: [],
          folderId: null,
        }).state ?? fail(),
        (key, params) => translate(language, key, params),
        language,
      );
      expect(before[0]).toMatch(language === "en" ? /^Checked / : /^已核对 /);

      const folder = await core.createLibraryGroup({ name: "Coasts", description: "" });
      await core.moveToFolder({ documentIds: [tides.id], folderId: folder.id });
      await core.moveToFolder({ mindIds: [mind.id], folderId: folder.id });

      expect((await shownChecks(core, client, folder.id))[0]?.shown).toEqual({
        state: "supported",
      });
      const after = readNoteState({
        footing: [],
        cellFigures: [],
        doc: client.doc,
        documents: await core.listDocuments(),
        keptCitationTexts: [],
        folderId: folder.id,
      });
      expect(after.state).toMatchObject({ kind: "checked", look: 0 });
      expect(
        noteStateParts(
          after.state ?? fail(),
          (key, params) => translate(language, key, params),
          language,
        )[0],
      ).toBe(before[0]);

      // The pair: a new version of the Document it quotes makes it need a re-check again.
      const changed = `${TIDES.contents}\n\nNeap tides come in between.`;
      await writeFile(tides.path, changed);
      await core.reconcileDocuments();
      const [processed] = await waitForProcessing(core, [tides.id]);
      expect(processed?.contentHash).toBe(sha256(changed));
      expect((await shownChecks(core, client, folder.id))[0]?.shown).toMatchObject({
        state: "needs-recheck",
        why: "new-version",
      });
      expect(
        readNoteState({
          footing: [],
          cellFigures: [],
          doc: client.doc,
          documents: await core.listDocuments(),
          keptCitationTexts: [],
          folderId: folder.id,
        }).state,
      ).toMatchObject({ kind: "not-checked" });
    },
  );
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

  // protects=a Note a tab shows again from the copy it kept, not opened again, has settled what nothing works on any more, as opening it does: a sentence a check that threw left “checking” says stopped, and an Answer left being written with nothing writing it is stopped (#3115); fails_when=the sentence still reads checking, or the Answer still reads as being written, until the Note is opened anew; no_claim=what makes a check throw.
  test("a check and an Answer left unfinished in an open Note are settled when a tab shows it again", async () => {
    const { core, client, mind } = await mindWith([SUPPORTED]);
    const left = { ...LEFT_CHECKING, request: "a check that threw" };
    writeMind(client, [
      paragraph(text(SUPPORTED, left)),
      { type: "question", attrs: { id: "question-1" }, content: [{ type: "text", text: "Why?" }] },
      {
        type: "answer",
        attrs: { id: "answer-1", questionId: "question-1", status: "streaming" },
        content: [{ type: "paragraph", content: [{ type: "text", text: "Because" }] }],
      },
    ]);
    await client.settled();
    const answerStatus = () => {
      let status: unknown = null;
      readMind(client).descendants((node) => {
        if (node.type.name === "answer") status = node.attrs.status;
      });
      return status;
    };
    expect(answerStatus()).toBe("streaming");

    await core.settleUnfinished(mind.id);

    expect((await shownChecks(core, client)).map((each) => each.shown)).toEqual([
      { state: "not-checked", reason: "stopped" },
    ]);
    expect(answerStatus()).toBe("stopped");
  });

  test("a check stopped halfway leaves the sentences not checked yet “stopped”", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = scriptedModel(
      (call) => {
        if (!call.results.some((result) => result.tool === "search_documents")) {
          return { calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }] };
        }
        if (sentenceOf(call) === UNSUPPORTED)
          return { text: "Verdict: unsupported", pause: { after: 0, until: held } };
        return { text: "Verdict: unsupported" };
      },
      { generate: judgesNothing },
    );
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
  test("its instructions keep the search and the Passages out of the explanation, and name no date beside a Passage (#2311)", async () => {
    const calls: ModelCall[] = [];
    const { check } = await mindWith([CONTRADICTED], checkingModel(PLANS, calls));
    await check();
    const system = calls[0]?.system ?? "";
    expect(system).toContain("Never mention the search, the Passages");
    expect(system).not.toContain("date attribute");
  });
});

describe("Why a sentence is unsupported", () => {
  const HALF = "Spring tides happen at new moon and at full moon, creating very high waters.";
  const OWNER =
    "教程讨论了训练速度、鲁棒性和内存需求之间的权衡：已有实验通常显示，拟牛顿方法比梯度下降更快；一阶优化方法通常更加稳健，但速度较慢。";

  const reasonOf = async (reply: string, sentence = HALF, language: "en" | "zh-CN" = "en") => {
    const { core, client, check } = await mindWith(
      [sentence],
      checkingModel({ [sentence]: { reply: { text: reply } } }),
    );
    await core.updateSettings({ user: { language } });
    await check();
    const [shown] = await shownChecks(core, client);
    return shown?.check.unsupported;
  };

  test("asks for the reason", async () => {
    const calls: ModelCall[] = [];
    const { check } = await mindWith([UNSUPPORTED], checkingModel(PLANS, calls));
    await check();
    expect(calls[0]?.system).toContain("Explanation: one plain sentence in English");
    expect(calls[0]?.system).toContain("for not found, say what the Documents don't say;");
  });

  test("is kept with the check: the reason", async () => {
    expect(
      await reasonOf(
        "Verdict: unsupported\nExplanation: Tides gives the moon phases, not what they cause.",
      ),
    ).toEqual({
      reason: "Tides gives the moon phases, not what they cause.",
      covered: null,
      uncovered: null,
    });
  });

  test("keeps the owner's sentence in Chinese", async () => {
    expect(
      await reasonOf("Verdict: unsupported\nExplanation: 引用只比较了速度。", OWNER, "zh-CN"),
    ).toEqual({
      reason: "引用只比较了速度。",
      covered: null,
      uncovered: null,
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
    plans[HALF] = { reply: { text: "Verdict: unsupported\nExplanation: Not stated." } };
    await check();
    expect((await shownChecks(core, client))[0]?.check.unsupported).toEqual({
      reason: "Not stated.",
      covered: null,
      uncovered: null,
    });
  });
});
