import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { checkCitedSentences, countedVerdict } from "../../eval/everyday/support";
import {
  ANSWER_BLOCK,
  CITATION_NODE,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  type Core,
  type Document,
  GENERATED_MARK,
  QUESTION_BLOCK,
} from "../../src/core";
import { failedSentences } from "../../src/core/exports/sentenceChecks";
import { claimsOf, markOf } from "../../src/renderer/src/editor/claimChecks";
import { noteHealth } from "../../src/renderer/src/editor/healthCounts";
import { opinionsIn } from "../../src/renderer/src/editor/opinionLocations";
import { noteStateOf } from "../../src/renderer/src/noteState";
import { checkWithParts } from "../../src/shared/claimParts";
import { setTextOrigin } from "../../src/shared/textOrigins";
import { askAssistant } from "../helpers/assistant";
import { checkGenerate, checkReply, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { answerEnded, setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { recordRows } from "../helpers/csv";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { boundEditor, typeText } from "../helpers/editor";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, resolveChanges, shownWithAiText, writeMind } from "../helpers/minds";
import { judgesNothing, type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

/*
 * Whose sentence a check reads (#3019): one the assistant wrote that holds a part left out as an
 * opinion never reads Supported, as the Note holds it when its check lands. Every word AI text, in
 * no one else's file, makes it the assistant's; a word the User typed makes it theirs, and theirs
 * keep today's rule.
 */

const LINE = "The tide turns twice a day.";
const LINE_ZH = "港口的潮水每天都会涨落两次。";
const TIDES = { name: "Tides.md", contents: `# Tides\n\n${LINE}\n\n${LINE_ZH}\n` };

const FACT = "Tides turn twice in a day here";
const FACT_ZH = "这里的潮水每天涨落两次";
const SENTENCES = {
  en: `${FACT}, so boats should leave early.`,
  zh: `${FACT_ZH}，所以船应该早点出发。`,
  enFirst: `So boats should leave early, as tides turn twice in a day here.`,
  zhFirst: `所以船应该早点出发，因为${FACT_ZH}。`,
  typed: `${FACT}, so boats should really leave early.`,
  longer: `${FACT}, so boats should leave very early.`,
  enChanged: "Tides turn twice each day here, so boats should leave early.",
  zhChanged: "这里的潮水每日涨落两次，所以船应该早点出发。",
} as const;

/** How the check names each sentence's parts in its first turn, as the sorter would. */
const PARTS: Record<string, { kind: "fact" | "opinion"; text: string }[]> = {
  [SENTENCES.en]: [
    { kind: "fact", text: FACT },
    { kind: "opinion", text: "so boats should leave early" },
  ],
  [SENTENCES.zh]: [
    { kind: "fact", text: FACT_ZH },
    { kind: "opinion", text: "所以船应该早点出发" },
  ],
  [SENTENCES.enFirst]: [
    { kind: "opinion", text: "So boats should leave early" },
    { kind: "fact", text: "tides turn twice in a day here" },
  ],
  [SENTENCES.zhFirst]: [
    { kind: "opinion", text: "所以船应该早点出发" },
    { kind: "fact", text: FACT_ZH },
  ],
  [SENTENCES.typed]: [
    { kind: "fact", text: FACT },
    { kind: "opinion", text: "so boats should really leave early" },
  ],
  [SENTENCES.enChanged]: [
    { kind: "fact", text: "Tides turn twice each day here" },
    { kind: "opinion", text: "so boats should leave early" },
  ],
  [SENTENCES.zhChanged]: [
    { kind: "fact", text: "这里的潮水每日涨落两次" },
    { kind: "opinion", text: "所以船应该早点出发" },
  ],
};

const PLANS: Record<string, Plan> = {
  [FACT]: { verdict: "supported", quote: LINE, says: LINE, judgement: "same" },
  "tides turn twice in a day here": {
    verdict: "supported",
    quote: LINE,
    says: LINE,
    judgement: "same",
  },
  [FACT_ZH]: { verdict: "supported", quote: LINE_ZH, says: LINE_ZH, judgement: "same" },
  "Tides turn twice each day here": {
    verdict: "supported",
    quote: LINE,
    says: LINE,
    judgement: "same",
  },
  这里的潮水每日涨落两次: {
    verdict: "supported",
    quote: LINE_ZH,
    says: LINE_ZH,
    judgement: "same",
  },
  [`${FACT}.`]: { verdict: "supported", quote: LINE, says: LINE, judgement: "same" },
  [`${FACT_ZH}。`]: { verdict: "supported", quote: LINE_ZH, says: LINE_ZH, judgement: "same" },
};

/** A check that names its sentence's parts in its first turn, as the sorter would, then checks each as `PLANS` say. */
function partsReply(call: ModelCall) {
  const named = PARTS[sentenceOf(call)];
  if (named && call.results.length === 0 && call.system.includes("Parts:"))
    return {
      text: `Parts: ${JSON.stringify(named)}`,
      calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }],
    };
  return checkReply(call, PLANS);
}

function partsModel(calls: ModelCall[] = []) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      return partsReply(call);
    },
    { generate: checkGenerate(PLANS) },
  );
}

const AI = [{ type: GENERATED_MARK }];

const citationOf = (tides: Document, quote: string): JSONContent => ({
  type: CITATION_NODE,
  attrs: {
    documentId: tides.id,
    documentName: tides.name,
    contentHash: tides.contentHash,
    quote,
    check: "found",
  },
});

/** A paragraph holding `sentence`, its Citation before its stop, each run with its own marks. */
const paragraph = (id: string, runs: JSONContent[], citation: JSONContent, stop: JSONContent) => ({
  type: "paragraph",
  attrs: { id },
  content: [...runs, citation, stop],
});

const run = (text: string, ai: boolean): JSONContent => ({
  type: "text",
  text,
  ...(ai && { marks: AI }),
});

/** `sentence` as one paragraph, all of it AI text or none, its Citation of `quote` before its stop. */
const written = (id: string, sentence: string, citation: JSONContent, ai: boolean) =>
  paragraph(id, [run(sentence.slice(0, -1), ai)], citation, run(sentence.slice(-1), ai));

const shownIn = (client: MindClient) =>
  claimsOf(readMind(client), {
    footing: "not-yet-known",
    versions: null,
    folderId: null,
    scope: null,
  }).claims;

async function checkParagraph(core: Core, mindId: string, id: string, length: number) {
  await core.checkSentences({
    requestId: crypto.randomUUID(),
    mindId,
    action: "check-against-documents",
    from: { blockId: id, offset: 0 },
    to: { blockId: id, offset: length },
  });
}

async function setUp(calls: ModelCall[] = []) {
  const set = await setUpWithDocuments(partsModel(calls), [TIDES]);
  const [tides] = set.documents;
  if (!tides) throw new Error("Tides.md wasn't added.");
  return { ...set, tides };
}

const readsOf = (client: MindClient) =>
  shownIn(client).map((claim) => ({
    shown: claim.shown,
    parts: claim.check.parts?.map((part) => [part.kind, part.verdict, part.byAssistant ?? null]),
  }));

describe("Check against Documents on a Note", { timeout: 30_000 }, () => {
  // protects=a sentence every word of which is AI text, whose cited fact is supported and whose conclusion the check left out as an opinion, reads Not checked for the assistant's own conclusion, in English and Chinese and with the conclusion first; the same sentence the User wrote reads Supported as before; parts keep their rows either way; fails_when=the assistant's sentence shows ✓, the User's loses it, or a part's own result changes; no_claim=the card's look.
  test.each([
    ["en", SENTENCES.en, LINE],
    ["zh", SENTENCES.zh, LINE_ZH],
    ["en, conclusion first", SENTENCES.enFirst, LINE],
    ["zh, conclusion first", SENTENCES.zhFirst, LINE_ZH],
  ] as const)("%s", async (_case, sentence, quote) => {
    const { core, client, mind, tides } = await setUp();
    writeMind(client, [
      written("ai", sentence, citationOf(tides, quote), true),
      written("mine", sentence, citationOf(tides, quote), false),
    ]);
    await client.settled();
    await checkParagraph(core, mind.id, "ai", sentence.length + 1);
    await checkParagraph(core, mind.id, "mine", sentence.length + 1);
    await client.settled();

    const opinionFirst = PARTS[sentence]?.[0]?.kind === "opinion";
    const rows = (byAssistant: true | null) =>
      opinionFirst
        ? [
            ["opinion", null, byAssistant],
            ["fact", "supported", null],
          ]
        : [
            ["fact", "supported", null],
            ["opinion", null, byAssistant],
          ];
    expect(readsOf(client)).toEqual([
      { shown: { state: "not-checked", reason: "assistant-conclusion" }, parts: rows(true) },
      { shown: { state: "supported" }, parts: rows(null) },
    ]);
  });

  // protects=whose a sentence is follows the Note's text as the editor leaves it: a word the User types in the middle of an AI sentence isn't AI text, so the sentence is theirs and keeps its ✓; words they only delete leave the rest AI text, so it stays the assistant's; fails_when=a typed word leaves the sentence the assistant's, or a deletion makes it the User's; no_claim=the editor's own marks, which tests/renderer/aiText.test.ts holds.
  test("a word typed in the middle, and words deleted", async () => {
    const { core, client, mind, tides } = await setUp();
    writeMind(client, [
      written("typed", SENTENCES.en, citationOf(tides, LINE), true),
      written("deleted", SENTENCES.longer, citationOf(tides, LINE), true),
    ]);
    await client.settled();
    const editor = boundEditor(client);
    const at = (words: string, block: number) => {
      let found = -1;
      editor.state.doc.child(block).descendants((node, pos) => {
        if (found < 0 && node.isText && node.text?.includes(words))
          found = pos + (node.text?.indexOf(words) ?? 0);
        return found < 0;
      });
      let start = 0;
      for (let index = 0; index < block; index++) start += editor.state.doc.child(index).nodeSize;
      return start + 1 + found;
    };
    editor.commands.setTextSelection(at("leave early", 0));
    typeText(editor, "really ");
    const very = at("very ", 1);
    editor.view.dispatch(editor.state.tr.delete(very, very + "very ".length));
    await client.settled();
    // As the editor leaves them: the typed word outside the AI text, the rest still in it.
    expect(shownWithAiText(readMind(client).child(0))).toBe(
      "«Tides turn twice in a day here, so boats should »really «leave early»￼«.»",
    );
    expect(shownWithAiText(readMind(client).child(1))).toBe(`«${SENTENCES.en.slice(0, -1)}»￼«.»`);
    await checkParagraph(core, mind.id, "typed", SENTENCES.typed.length + 1);
    await checkParagraph(core, mind.id, "deleted", SENTENCES.en.length + 1);
    await client.settled();

    expect(readsOf(client).map((each) => each.shown)).toEqual([
      { state: "supported" },
      { state: "not-checked", reason: "assistant-conclusion" },
    ]);
  });

  // protects=AI text from someone else's file (a Word file imported from someone else, a web page, an outside agent) keeps today's rule, while an Answer that read a checked document is still the assistant's; fails_when=someone else's text reads as the assistant's conclusion, or the assistant's loses the rule because its Answer read a checked document; no_claim=how origins are recorded.
  test.each([
    ["imported", "supported"],
    ["web-page", "supported"],
    ["outside-agent", "supported"],
    ["checked-document", "not-checked"],
  ] as const)("AI text whose Block's origin is %s", async (origin, state) => {
    const { core, client, mind, tides } = await setUp();
    writeMind(client, [written("s", SENTENCES.en, citationOf(tides, LINE), true)]);
    await client.settled();
    setTextOrigin(client.doc, ["s"], origin);
    await client.settled();
    await checkParagraph(core, mind.id, "s", SENTENCES.en.length + 1);
    await client.settled();
    expect(shownIn(client)[0]?.shown.state).toBe(state);
  });

  // protects=Check anyway on the assistant's conclusion judges it as any part, and the sentence then takes its parts' worst result, Unsupported where no Document states it; Check this Note doesn't send the sentence again on its own; fails_when=Check anyway leaves the sentence Not checked for the conclusion, or Check this Note asks about it again; no_claim=the card's buttons.
  test("Check anyway, and Check this Note", async () => {
    const calls: ModelCall[] = [];
    const { core, client, mind, tides } = await setUp(calls);
    writeMind(client, [written("s", SENTENCES.en, citationOf(tides, LINE), true)]);
    await client.settled();
    await checkParagraph(core, mind.id, "s", SENTENCES.en.length + 1);
    await client.settled();
    const asked = calls.length;
    expect((await core.planMindCheck(mind.id, "changed")).kind).toBe("unchanged");
    expect(calls.length).toBe(asked);

    const [claim] = shownIn(client);
    const opinion = claim?.check.parts?.find((part) => part.kind === "opinion");
    if (!claim || !opinion) throw new Error("The sentence has an opinion part.");
    await core.checkSentences({
      requestId: crypto.randomUUID(),
      mindId: mind.id,
      action: "check-against-documents",
      from: { blockId: "s", offset: 0 },
      to: { blockId: "s", offset: SENTENCES.en.length + 1 },
      part: { id: claim.check.id, span: opinion.span },
    });
    await client.settled();
    expect(readsOf(client)).toEqual([
      {
        shown: { state: "unsupported" },
        parts: [
          ["fact", "supported", null],
          ["opinion", "unsupported", null],
        ],
      },
    ]);
  });

  // protects=Check against a Document, which reads the User's pick whole and lands its mark only once it has read it, reads whose the sentence is from its place too: the assistant's conclusion reads Not checked, the User's sentence keeps its ✓; fails_when=a whole read's first mark on AI text shows ✓ beside the assistant's conclusion; no_claim=how a whole read sizes its windows.
  test("Check against a Document, read whole", async () => {
    const { core, client, mind, tides } = await setUp();
    writeMind(client, [
      written("ai", SENTENCES.en, citationOf(tides, LINE), true),
      written("mine", SENTENCES.en, citationOf(tides, LINE), false),
    ]);
    await client.settled();
    const pick = { folderIds: [], tagIds: [], documentIds: [tides.id] };
    for (const id of ["ai", "mine"]) {
      const place = {
        from: { blockId: id, offset: 0 },
        to: { blockId: id, offset: SENTENCES.en.length + 1 },
      };
      const plan = await core.planDocumentCheck({ mindId: mind.id, ...place, within: pick });
      if (plan.kind !== "ready") throw new Error(`The pick can't be read: ${plan.kind}.`);
      await core.checkSentences({
        requestId: crypto.randomUUID(),
        mindId: mind.id,
        action: "check-against-document",
        ...place,
        within: pick,
        plan: plan.id,
      });
    }
    await client.settled();
    expect(readsOf(client)).toEqual([
      {
        shown: { state: "not-checked", reason: "assistant-conclusion" },
        parts: [
          ["fact", "supported", null],
          ["opinion", null, true],
        ],
      },
      {
        shown: { state: "supported" },
        parts: [
          ["fact", "supported", null],
          ["opinion", null, null],
        ],
      },
    ]);
  });
});

/** Each language's words for a write: the line it cites, its sentence, and the User's own words. */
const WRITES = {
  en: {
    quote: LINE,
    fact: FACT,
    stop: ".",
    sentence: SENTENCES.en,
    own: "Sales were flat",
    conclusion: ", so boats should leave early",
    changed: SENTENCES.enChanged,
    accepted: "«Tides turn twice each day here», so boats should leave early￼«.»",
    content: `${SENTENCES.en.slice(0, -1)}[^1].`,
    word: "really ",
    before: "leave early",
  },
  zh: {
    quote: LINE_ZH,
    fact: FACT_ZH,
    stop: "。",
    sentence: SENTENCES.zh,
    own: "销量持平",
    conclusion: "，所以船应该早点出发",
    changed: SENTENCES.zhChanged,
    accepted: "«这里的潮水每日涨落两次»，所以船应该早点出发￼«。»",
    content: `${SENTENCES.zh.slice(0, -1)}[^1]。`,
    word: "真的",
    before: "应该",
  },
} as const;

/** A model that writes `content()` into the Note with a Citation of `quote`, and checks as `PLANS` say. */
function writingModel(quote: string, content: () => string) {
  return scriptedModel(
    (call) => {
      if (isCheckRun(call)) return partsReply(call);
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search) return { calls: [{ tool: "search_documents", input: { query: "tides" } }] };
      if (!call.results.some((result) => result.tool === "cite")) {
        const passage = shownPassages(search.text).find((each) => each.text.includes(quote));
        return {
          calls: [
            { tool: "cite", input: { citations: [{ marker: 1, passage: passage?.id, quote }] } },
          ],
        };
      }
      if (!call.results.some((result) => result.tool === "add_to_mind"))
        return { calls: [{ tool: "add_to_mind", input: { content: content() } }] };
      return { text: "Added it." };
    },
    { generate: judgesNothing },
  );
}

/** A Note in a Folder holding Tides.md, on a provider whose checks may run, and `model` writing. */
async function writingSetUp(model: ReturnType<typeof scriptedModel>) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  for (const flow of ["chat", "checks"] as const)
    if (saved.service) await core.allowDataFlow(flow, saved.service.id);
  const sources = await createTempDataFolder();
  const documents = await addAndProcess(core, [
    await writeSourceFile(sources, TIDES.name, TIDES.contents),
  ]);
  const folder = await core.createLibraryGroup({ name: "Coast", description: "" });
  await core.moveToFolder({ documentIds: documents.map((each) => each.id), folderId: folder.id });
  const mind = await core.createMind({ title: "Harbour", folderId: folder.id });
  const client = await connectToMind(core, mind.id);
  const scope = { folderIds: [folder.id], tagIds: [], documentIds: [] };
  return { core, mind, client, scope };
}

/** The mark the check stored for `text`, as it stored it: while a change waits, the Note's sentence also holds the words it takes out. */
const storedFor = (client: MindClient, text: string) => {
  const check = shownIn(client).find((claim) => claim.check.text === text)?.check;
  return {
    state: check?.state,
    reason: check?.reason,
    parts: check?.parts?.map((part) => [part.kind, part.verdict, part.byAssistant ?? null]),
  };
};

const ASSISTANT_CONCLUSION = {
  state: "not-checked",
  reason: "assistant-conclusion",
  parts: [
    ["fact", "supported", null],
    ["opinion", null, true],
  ],
};

const USER_CONCLUSION = {
  state: "supported",
  reason: null,
  parts: [
    ["fact", "supported", null],
    ["opinion", null, null],
  ],
};

/** As the Note reads `stored` once nothing waits. */
const asRead = ({
  state,
  reason,
  parts,
}: typeof ASSISTANT_CONCLUSION | typeof USER_CONCLUSION) => ({
  shown: state === "supported" ? { state } : { state, reason },
  parts,
});

describe("The assistant's own write", { timeout: 60_000 }, () => {
  // protects=a sentence the assistant writes whole into a Note, with a cited fact and its own conclusion, lands Not checked for that conclusion, its fact's row Supported, in English and Chinese, while its change waits and once the User accepts it; fails_when=it lands with ✓; no_claim=what the Answer says.
  test.each(["en", "zh"] as const)("a new sentence, written whole, %s", async (language) => {
    const words = WRITES[language];
    const { core, mind, client, scope } = await writingSetUp(
      writingModel(words.quote, () => words.content),
    );
    await askAssistant(core, { text: "Add a line on tides to this Note", mindId: mind.id, scope });
    await client.settled();
    expect(storedFor(client, words.sentence)).toEqual(ASSISTANT_CONCLUSION);
    expect(readsOf(client)).toEqual([asRead(ASSISTANT_CONCLUSION)]);
    await resolveChanges(client, "accept");
    await client.settled();
    expect(readsOf(client)).toEqual([asRead(ASSISTANT_CONCLUSION)]);
  });

  // protects=whose sentence a write's check reads is decided where it lands, by the rule every later check uses: a write over the User's own sentence, whole, makes it the assistant's, Not checked for its conclusion; one that changes a few words in a sentence holding the User's own conclusion leaves it theirs, ✓ as before; read as the waiting change leaves it, so a word of the User's it takes out never counts; the same while the change waits, once it is accepted, and on Check again, in English and Chinese; fails_when=the User's conclusion lands as the assistant's, the assistant's whole sentence lands as the User's, or Check again reads it otherwise than the write's check did; no_claim=how the write's changes are cut into words.
  test.each([
    ["the User's sentence, written over whole", "en", "whole"],
    ["the User's sentence, written over whole", "zh", "whole"],
    ["a few words changed in a sentence holding the User's conclusion", "en", "few"],
    ["a few words changed in a sentence holding the User's conclusion", "zh", "few"],
    ["a word the User typed, which the write takes out", "en", "takes out"],
    ["a word the User typed, which the write takes out", "zh", "takes out"],
  ] as const)("%s, %s", async (_case, language, change) => {
    const words = WRITES[language];
    const whole = change === "whole";
    const few = change === "few";
    let content = few || whole ? `${words.fact}[^1]${words.stop}` : words.content;
    const { core, mind, client, scope } = await writingSetUp(
      writingModel(words.quote, () => content),
    );
    const first = await askAssistant(core, {
      text: "Add a line on tides to this Note",
      mindId: mind.id,
      scope,
    });
    await client.settled();
    await resolveChanges(client, "accept");
    await client.settled();
    const paragraph = client.blocks.get(0);
    const typed = paragraph instanceof Y.XmlElement ? paragraph.get(0) : null;
    if (!(typed instanceof Y.XmlText)) throw new Error("No sentence to type in.");
    // Typed, as the editor writes it: not AI text.
    client.doc.transact(() => {
      if (whole) {
        typed.delete(0, words.fact.length);
        typed.insert(0, words.own, { [GENERATED_MARK]: null });
      } else if (few) typed.insert(words.fact.length, words.conclusion, { [GENERATED_MARK]: null });
      else
        typed.insert(words.sentence.indexOf(words.before), words.word, { [GENERATED_MARK]: null });
    });
    await client.settled();
    // Written again from every Document: over the User's words, its change waits for them.
    const sentence = few ? words.changed : words.sentence;
    content = `${sentence.slice(0, -1)}[^1]${words.stop}`;
    const again = await core.regenerateConversationAnswer({
      conversationId: first.conversationId,
      answerId: first.id,
      clearScope: true,
    });
    if (!again.asked) throw new Error("Not asked again.");
    await answerEnded(core, again.answerId);
    await client.settled();

    const landed = few ? USER_CONCLUSION : ASSISTANT_CONCLUSION;
    expect(storedFor(client, sentence)).toEqual(landed);
    await resolveChanges(client, "accept");
    await client.settled();
    if (few) expect(shownWithAiText(readMind(client).child(0))).toBe(words.accepted);
    expect(readsOf(client)).toEqual([asRead(landed)]);
    const id = client.blocks.get(0);
    if (!(id instanceof Y.XmlElement)) throw new Error("No paragraph.");
    await checkParagraph(
      core,
      mind.id,
      String(id.getAttribute("id")),
      readMind(client).child(0).content.size,
    );
    await client.settled();
    expect(readsOf(client)).toEqual([asRead(landed)]);
  });
});

/** A stored check on `SENTENCES.en`: its fact Supported on `LINE`, its conclusion left out. */
function storedCheck(tides: Document, byAssistant: boolean): ClaimCheckAttributes {
  const evidence = {
    passageId: "passage-1",
    documentId: tides.id,
    documentName: tides.name,
    contentHash: tides.contentHash,
    pageFrom: null,
    pageTo: null,
    location: null,
    quote: LINE,
    check: "found" as const,
    checkReason: null,
  };
  const common = {
    says: null,
    unsupported: null,
    calculation: null,
    reason: null,
    detail: null,
    versions: [{ documentId: tides.id, contentHash: tides.contentHash }],
    excluded: [],
    citedCaseUnchecked: false,
    citedCaseFound: false,
  };
  const opinion = "so boats should leave early";
  const start = SENTENCES.en.indexOf(opinion);
  return checkWithParts(
    {
      id: byAssistant ? "assistant" : "user",
      request: "run",
      action: "check-against-documents",
      state: "checking",
      reason: null,
      detail: null,
      providerId: "anthropic",
      modelId: "claude-haiku-5-5",
      text: SENTENCES.en,
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: { folderId: null, widened: false },
      versions: [],
      excluded: [],
      checkedAt: "2026-11-13T09:00:00.000Z",
    },
    [
      {
        ...common,
        span: { start: 0, end: FACT.length },
        kind: "fact",
        verdict: "supported",
        evidence: [evidence],
        decidingEvidence: 0,
      },
      {
        ...common,
        span: { start, end: start + opinion.length },
        kind: "opinion",
        verdict: null,
        evidence: [],
        ...(byAssistant && { byAssistant: true as const }),
      },
    ],
  );
}

/** `SENTENCES.en` as AI text with `check`'s mark on its words, its Citation of `LINE` before its stop. */
const marked = (id: string, tides: Document, check: ClaimCheckAttributes): JSONContent => {
  const marks = [...AI, { type: CLAIM_CHECK_MARK, attrs: check }];
  return paragraph(
    id,
    [{ type: "text", text: SENTENCES.en.slice(0, -1), marks }],
    citationOf(tides, LINE),
    { type: "text", text: ".", marks },
  );
};

describe("Every reader of a stored result", { timeout: 30_000 }, () => {
  // protects=one stored result whose conclusion is the assistant's reads Not checked, never Supported, in every place a sentence's result shows: the card and its margin mark, the badge (which it doesn't hold back from Checked, counted with the opinions left out), the Word export's comments, the check record and the AI use statement; the same parts without the flag read Supported in each, as before; fails_when=any reader shows the assistant's sentence Supported, or the badge counts it as to check; no_claim=each reader's own words, which their own tests hold.
  test("card, margin mark, badge, export, check record and AI use statement", async () => {
    const { core, client, mind, tides } = await setUp();
    const assistant = storedCheck(tides, true);
    const user = storedCheck(tides, false);
    writeMind(client, [marked("a", tides, assistant), marked("u", tides, user)]);
    await client.settled();

    const claims = shownIn(client);
    expect(claims.map((claim) => claim.shown)).toEqual([
      { state: "not-checked", reason: "assistant-conclusion" },
      { state: "supported" },
    ]);
    expect(claims.map(markOf)).toEqual(["not-checked", "supported"]);

    const doc = readMind(client);
    const health = noteHealth(doc, {
      claims,
      citationCheck: (attributes) => attributes.check,
      skipped: new Set(),
      unexamined: new Set(),
      kept: [],
    });
    expect([health.checkable, health.supported, health.toCheck.length]).toEqual([2, 1, 0]);
    expect(noteStateOf(health)?.kind).toBe("checked");
    // The badge's opinions line names both conclusions, the assistant's among them.
    expect(opinionsIn(doc, client.doc).map((opinion) => opinion.id)).toEqual(["assistant", "user"]);

    const exported = failedSentences(client.blocks, {
      versions: new Map([[tides.id, tides.contentHash]]),
      folderId: null,
      scope: null,
      quoteOf: (citation) => citation.quote ?? "",
      sourceOf: () => tides.name,
      scopeItemName: () => null,
    });
    expect([...exported.keys()]).toEqual([]);

    const out = await createTempDataFolder();
    await core.setOutputLocation(out);
    const saved = await core.saveCheckRecord(mind.id);
    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    const csv = readFileSync(
      join(out, `${saved.file.name.replace(/\.(pdf|csv)$/, "")}.csv`),
      "utf8",
    );
    const results = recordRows(csv)
      .filter((row) => row.Kind === "Sentence")
      .map((row) => row.Result);
    expect(results).toEqual(["Not checked", "Supported"]);

    const statement = await core.createAiUseStatement(mind.id);
    const rows: string[][] = [];
    readMind(await connectToMind(core, statement.id)).descendants((node) => {
      if (node.type.name !== "tableRow") return true;
      const cells: string[] = [];
      node.forEach((cell) => void cells.push(cell.textContent));
      rows.push(cells);
      return false;
    });
    const sentenceRows = rows.filter((cells) => cells.some((cell) => cell.startsWith("Tides")));
    expect(sentenceRows.map((cells) => cells.includes("Not checked"))).toEqual([true, false]);
    expect(sentenceRows.map((cells) => cells.includes("Supported"))).toEqual([false, true]);
  });
});

/** An Answer holding `sentence`: an older one, AI text as a whole, unless `generatedMarks`. */
const answer = (sentence: JSONContent, generatedMarks = false): JSONContent[] => [
  { type: QUESTION_BLOCK, attrs: { id: "q" }, content: [{ type: "text", text: "Tides?" }] },
  {
    type: ANSWER_BLOCK,
    attrs: { id: "answer", questionId: "q", ...(generatedMarks && { generatedMarks: true }) },
    content: [sentence],
  },
];

describe("A sentence in an Answer", { timeout: 30_000 }, () => {
  // protects=a sentence in an older Answer, whose words are AI text as a whole, is the assistant's though its words carry no mark; one in an Answer that read a web page is still the assistant's, its origin being what the Answer read; one in a newer Answer whose words the User typed is theirs; fails_when=an Answer's sentence reads as the User's for its origin or its unmarked older words, or the User's typed words read as the assistant's; no_claim=how Answers mark their words.
  test.each([
    ["an older Answer", false, false, null, "not-checked"],
    ["an Answer that read a web page", true, true, "web-page", "not-checked"],
    ["the User's words in a newer Answer", true, false, null, "supported"],
  ] as const)("%s", async (_case, generatedMarks, ai, origin, state) => {
    const { core, client, mind, tides } = await setUp();
    writeMind(
      client,
      answer(written("p", SENTENCES.en, citationOf(tides, LINE), ai), generatedMarks),
    );
    await client.settled();
    if (origin) setTextOrigin(client.doc, ["answer"], origin);
    await checkParagraph(core, mind.id, "p", SENTENCES.en.length + 1);
    await client.settled();
    expect(shownIn(client)[0]?.shown.state).toBe(state);
  });
});

const BOATS = "The harbour holds 40 boats.";
const FIGURED = "The harbour holds 40 boats, so it should grow.";

describe("Check anyway on the conclusion of a sentence whose figures are checked", {
  timeout: 30_000,
}, () => {
  // protects=while Check anyway judges the conclusion of a sentence whose figures each have their own check, the sentence reads checking, as a plain sentence does, whoever wrote it, never ✓ for as long as the model takes; once it answers, the conclusion's result is the sentence's; fails_when=the sentence shows ✓ while its conclusion is being judged; no_claim=the card's own words while it runs.
  test.each([
    ["the assistant's", true, "not-checked"],
    ["the User's", false, "supported"],
  ] as const)("%s sentence", async (_case, ai, landed) => {
    let hold: { until: Promise<void>; reached: () => void } | null = null;
    const model = scriptedModel(
      (call) => {
        const named = sentenceOf(call) === FIGURED && call.system.includes("Parts:");
        const reply =
          named && call.results.length === 0
            ? {
                text: `Parts: ${JSON.stringify([
                  { kind: "fact", text: "The harbour holds 40 boats" },
                  { kind: "opinion", text: "so it should grow" },
                ])}`,
                calls: [{ tool: "search_documents", input: { query: FIGURED } }],
              }
            : checkReply(call, {
                [FIGURED]: { verdict: "supported", quote: BOATS, says: BOATS },
                "The harbour holds 40 boats": { verdict: "supported", quote: BOATS, says: BOATS },
              });
        const held = hold;
        if (!held) return reply;
        hold = null;
        return { ...reply, pause: { after: 0, until: held.until, reached: held.reached } };
      },
      { generate: checkGenerate({}) },
    );
    const set = await setUpWithDocuments(model, [
      { name: "Harbour.md", contents: `# Harbour\n\n${BOATS}\n` },
    ]);
    const { core, client, mind } = set;
    const [harbour] = set.documents;
    if (!harbour) throw new Error("Harbour.md wasn't added.");
    writeMind(client, [written("s", FIGURED, citationOf(harbour, BOATS), ai)]);
    await client.settled();
    await checkParagraph(core, mind.id, "s", FIGURED.length + 1);
    await client.settled();
    const [claim] = shownIn(client);
    expect(claim?.check.figures?.map((figure) => figure.state)).toEqual(["supported"]);
    expect(claim?.shown.state).toBe(landed);
    const opinion = claim?.check.parts?.find((part) => part.kind === "opinion");
    if (!claim || !opinion) throw new Error("The sentence has an opinion part.");

    let release = () => {};
    let reached = () => {};
    const asked = new Promise<void>((resolve) => {
      reached = resolve;
    });
    hold = {
      until: new Promise<void>((resolve) => {
        release = resolve;
      }),
      reached,
    };
    const anyway = core.checkSentences({
      requestId: crypto.randomUUID(),
      mindId: mind.id,
      action: "check-against-documents",
      from: { blockId: "s", offset: 0 },
      to: { blockId: "s", offset: FIGURED.length + 1 },
      part: { id: claim.check.id, span: opinion.span },
    });
    await asked;
    await client.settled();
    const running = shownIn(client)[0];
    expect(running?.check.parts?.find((part) => part.kind === "opinion")?.verdict).toBe("checking");
    expect(running?.check.figures?.map((figure) => figure.state)).toEqual(["supported"]);
    expect(running?.shown).toEqual({ state: "checking" });
    release();
    await anyway;
    await client.settled();
    expect(shownIn(client)[0]?.shown).toEqual({ state: "unsupported" });
  });
});

describe("The evaluation's record", { timeout: 30_000 }, () => {
  // protects=the everyday evaluation and the answer-support run read an Answer's cited sentence as the Note reads the same sentence written by the assistant, on the same check: Not checked for the assistant's own conclusion, or, when its fact's Supported rests on a Passage its Citation doesn't hold, found elsewhere, and either way not counted Supported; fails_when=the record and the Note give the sentence different results, or the record counts a ✓ the Note never shows; no_claim=the record's other fields, which tests/eval/everydaySupport.test.ts holds.
  test.each([
    ["its own Citation", LINE, "assistant-conclusion"],
    ["a Passage its Citation doesn't hold", LINE_ZH, "found-elsewhere"],
  ] as const)("a fact resting on %s", async (_case, quote, reason) => {
    const { core, client, mind, tides } = await setUp();
    writeMind(client, [written("ai", SENTENCES.en, citationOf(tides, quote), true)]);
    await client.settled();
    await checkParagraph(core, mind.id, "ai", SENTENCES.en.length + 1);
    await client.settled();
    const [record] = await checkCitedSentences(core, {
      text: `${SENTENCES.en.slice(0, -1)}[^1].`,
      citations: [
        {
          marker: 1,
          documentName: tides.name,
          documentId: tides.id,
          contentHash: tides.contentHash,
          quote,
        },
      ],
    });
    if (!record) throw new Error("The sentence isn't recorded.");
    expect(shownIn(client).map((claim) => claim.shown)).toEqual([{ state: "not-checked", reason }]);
    expect([record.verdict, record.reason]).toEqual(["not-checked", reason]);
    expect(countedVerdict(record)).toBe("not-checked");
  });
});
