/**
 * A sentence whose words are only the name of a Document it cites says where a row came from, not
 * what it claims (#3093): no check reads it, in a table's cell, a list item or a line of its own,
 * with or without the file's extension, in brackets, or with the place its Citation points at. Any
 * other word keeps it read, and so do the right and the wrong sentences beside it.
 */
import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { CLAIM_CHECK_MARK } from "../../src/core/api";
import { claimSpans, claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { readNoteState } from "../../src/renderer/src/noteState";
import { mindScopeOf } from "../../src/shared/mindScope";
import { askAssistant, changesIn } from "../helpers/assistant";
import {
  checkGenerate,
  checkReply,
  isCheckRun,
  listedSentences,
  type Plan,
  requestedFigures,
  sentenceOf,
} from "../helpers/checks";
import {
  answerEnded,
  answerJudged,
  citationOf,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { connectToMind, FROM_CORE } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import {
  type GenerateCall,
  type GeneratedReply,
  type ModelCall,
  scriptedModel,
} from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

interface Line {
  text: string;
  /** The name of the Document its Citation is of, and the line it quotes. */
  cites: string;
  quote: string;
}

const LANGUAGES = [
  {
    language: "en",
    documents: [
      { name: "Lease 1.txt", contents: "The rent for unit 1 is 1000 euros a month.\n" },
      { name: "Lease 2.txt", contents: "The rent for unit 2 is 1100 euros a month.\n" },
      { name: "Lease 3.txt", contents: "The rent for unit 3 is 1200 euros a month.\n" },
      { name: "1043.txt", contents: "The deposit is 1044 euros.\n" },
      {
        name: "Northwind revenue rose 12% in Q3.txt",
        contents: "Northwind revenue rose 12% in Q3.\n",
      },
      { name: "Rent is 1100 euros a month.txt", contents: "Rent is 1100 euros a month.\n" },
      {
        name: "Lease 4.pdf",
        contents: buildPdf([
          { lines: ["The rent for unit 4 is 1300 euros a month."] },
          { lines: ["The deposit for unit 4 is 2600 euros."] },
        ]),
      },
    ],
    header: ["Item", "Source"],
    cells: [
      {
        label: "Rent",
        text: "Lease 1",
        cites: "Lease 1",
        quote: "The rent for unit 1 is 1000 euros a month.",
      },
      {
        label: "Deposit",
        text: "Lease 2.txt",
        cites: "Lease 2",
        quote: "The rent for unit 2 is 1100 euros a month.",
      },
    ],
    items: [
      { text: "(Lease 3)", cites: "Lease 3", quote: "The rent for unit 3 is 1200 euros a month." },
      { text: "[Lease 2]", cites: "Lease 2", quote: "The rent for unit 2 is 1100 euros a month." },
    ],
    lines: [
      { text: "Lease 4, p. 2", cites: "Lease 4", quote: "The deposit for unit 4 is 2600 euros." },
      { text: "Lease 1", cites: "Lease 1", quote: "The rent for unit 1 is 1000 euros a month." },
      {
        text: "Source: Lease 2",
        cites: "Lease 2",
        quote: "The rent for unit 2 is 1100 euros a month.",
      },
      {
        text: "see Lease 2",
        cites: "Lease 2",
        quote: "The rent for unit 2 is 1100 euros a month.",
      },
      {
        text: "Source: Northwind revenue rose 12% in Q3",
        cites: "Northwind revenue rose 12% in Q3",
        quote: "Northwind revenue rose 12% in Q3.",
      },
      { text: "“Lease 1”", cites: "Lease 1", quote: "The rent for unit 1 is 1000 euros a month." },
      { text: "Lease 4 (p. 2)", cites: "Lease 4", quote: "The deposit for unit 4 is 2600 euros." },
    ],
    right: {
      text: "The rent for unit 1 is 1000 euros a month.",
      cites: "Lease 1",
      quote: "The rent for unit 1 is 1000 euros a month.",
    },
    wrong: {
      text: "The rent for unit 2 is 1300 euros a month.",
      cites: "Lease 2",
      quote: "The rent for unit 2 is 1100 euros a month.",
    },
    says: "Lease 2 says the rent for unit 2 is 1100 euros a month.",
    stillRead: [
      {
        text: "Lease 2 sets the rent.",
        cites: "Lease 2",
        quote: "The rent for unit 2 is 1100 euros a month.",
      },
      { text: "Lease 3", cites: "Lease 2", quote: "The rent for unit 2 is 1100 euros a month." },
      { text: "Lease 4, p. 1", cites: "Lease 4", quote: "The deposit for unit 4 is 2600 euros." },
      { text: "1043", cites: "1043", quote: "The deposit is 1044 euros." },
      {
        text: "Northwind revenue rose 12% in Q3",
        cites: "Northwind revenue rose 12% in Q3",
        quote: "Northwind revenue rose 12% in Q3.",
      },
      {
        text: "Rent is 1100 euros a month",
        cites: "Rent is 1100 euros a month",
        quote: "Rent is 1100 euros a month.",
      },
      {
        text: "Void: Lease 2",
        cites: "Lease 2",
        quote: "The rent for unit 2 is 1100 euros a month.",
      },
      { text: "Lease 4 (p. 1)", cites: "Lease 4", quote: "The deposit for unit 4 is 2600 euros." },
    ],
    label: {
      text: "Source: Lease 2",
      cites: "Lease 2",
      quote: "The rent for unit 2 is 1100 euros a month.",
    },
    answerOnly: {
      text: "Lease 4, p. 2",
      cites: "Lease 4",
      quote: "The deposit for unit 4 is 2600 euros.",
    },
  },
  {
    language: "zh-CN",
    documents: [
      { name: "附件3.txt", contents: "二号铺月租金为1100元。\n" },
      { name: "合同2.txt", contents: "三号铺月租金为1200元。\n" },
      { name: "附件5.txt", contents: "四号铺月租金为1300元。\n" },
      { name: "8806.txt", contents: "押金编号为8807。\n" },
      { name: "三季度收入增长12%.txt", contents: "三季度收入增长12%。\n" },
      {
        name: "附件4.pdf",
        contents: buildPdf([
          { lines: ["Rent for unit 5: 1400 yuan a month."] },
          { lines: ["Deposit for unit 5: 2800 yuan."] },
        ]),
      },
    ],
    header: ["项目", "来源"],
    cells: [
      { label: "租金", text: "附件3", cites: "附件3", quote: "二号铺月租金为1100元。" },
      { label: "押金", text: "合同2.txt", cites: "合同2", quote: "三号铺月租金为1200元。" },
    ],
    items: [
      { text: "（附件5）", cites: "附件5", quote: "四号铺月租金为1300元。" },
      { text: "【合同2】", cites: "合同2", quote: "三号铺月租金为1200元。" },
    ],
    lines: [
      { text: "附件4，第2页", cites: "附件4", quote: "Deposit for unit 5: 2800 yuan." },
      { text: "附件3", cites: "附件3", quote: "二号铺月租金为1100元。" },
      { text: "来源：附件3", cites: "附件3", quote: "二号铺月租金为1100元。" },
      { text: "见合同2", cites: "合同2", quote: "三号铺月租金为1200元。" },
      { text: "《附件3》", cites: "附件3", quote: "二号铺月租金为1100元。" },
      { text: "「附件5」", cites: "附件5", quote: "四号铺月租金为1300元。" },
      { text: "附件4（第2页）", cites: "附件4", quote: "Deposit for unit 5: 2800 yuan." },
    ],
    right: { text: "二号铺月租金为1100元。", cites: "附件3", quote: "二号铺月租金为1100元。" },
    wrong: { text: "三号铺月租金为1300元。", cites: "合同2", quote: "三号铺月租金为1200元。" },
    says: "合同2写明三号铺月租金为1200元。",
    stillRead: [
      { text: "附件3规定了租金。", cites: "附件3", quote: "二号铺月租金为1100元。" },
      { text: "合同2", cites: "附件3", quote: "二号铺月租金为1100元。" },
      { text: "附件4，第1页", cites: "附件4", quote: "Deposit for unit 5: 2800 yuan." },
      { text: "8806", cites: "8806", quote: "押金编号为8807。" },
      { text: "三季度收入增长12%", cites: "三季度收入增长12%", quote: "三季度收入增长12%。" },
      { text: "租金：附件3", cites: "附件3", quote: "二号铺月租金为1100元。" },
      { text: "附件4（第1页）", cites: "附件4", quote: "Deposit for unit 5: 2800 yuan." },
    ],
    label: { text: "来源：附件3", cites: "附件3", quote: "二号铺月租金为1100元。" },
    answerOnly: { text: "附件3", cites: "附件3", quote: "二号铺月租金为1100元。" },
  },
] as const;

type Example = (typeof LANGUAGES)[number];

/** How the scripted model checks: the right sentence Supported, the wrong one Contradicted on its quote. */
const plansOf = (example: Example): Record<string, Plan> => ({
  [example.right.text]: { verdict: "supported", quote: example.right.quote },
  [example.wrong.text]: {
    verdict: "contradicted",
    quote: example.wrong.quote,
    says: example.says,
    judgement: "conflict",
  },
  [example.stillRead[0].text]: { verdict: "supported", quote: example.stillRead[0].quote },
});

/** A batch of an Answer's sentences, judged as `plans` say; unsupported with no plan. */
function batchReply(call: GenerateCall, plans: Record<string, Plan>): GeneratedReply {
  const sentences = [
    ...call.prompt.matchAll(/<sentence number="(\d+)">\n([\s\S]*?)\n<\/sentence>/g),
  ];
  return {
    text: JSON.stringify({
      sentences: sentences.map(([, number, sentence = ""]) => ({
        number: Number(number),
        kind: "fact",
        verdict: plans[sentence]?.verdict ?? "unsupported",
        roles: "same",
        time: "same",
        quoted: "states",
        says: plans[sentence]?.says ?? null,
      })),
    }),
  };
}

const batchedSentences = (calls: readonly GenerateCall[]) =>
  calls
    .filter((call) => call.question === "sentence-batch")
    .flatMap((call) =>
      [...call.prompt.matchAll(/<sentence number="\d+">\n([\s\S]*?)\n<\/sentence>/g)].map(
        (match) => match[1],
      ),
    );

/** What the scripted assistant answers, citing `quotes` as markers 1, 2…; with `write`, what it writes into a new Note. */
interface Answering {
  text: string;
  quotes: readonly string[];
  write?: string;
}

async function setUp(example: Example, answer?: Answering) {
  const calls: ModelCall[] = [];
  const asked: GenerateCall[] = [];
  const plans = plansOf(example);
  const labels = new Set<string>([...example.header, ...example.cells.map((each) => each.label)]);
  const generate = checkGenerate(plans);
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      if (isCheckRun(call) || !answer) return checkReply(call, plans);
      const searches = call.results.filter((result) => result.tool === "search_documents");
      const next = answer.quotes[searches.length];
      if (next !== undefined)
        return { calls: [{ tool: "search_documents", input: { query: next } }] };
      if (!call.results.some((result) => result.tool === "cite")) {
        const passages = searches.flatMap((each) => shownPassages(each.text));
        const citations = answer.quotes.map((quote, index) => ({
          marker: index + 1,
          passage: passages.find((each) => each.text.includes(quote))?.id,
          quote,
        }));
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      if (answer.write && !call.results.some((result) => result.tool === "create_mind"))
        return {
          calls: [{ tool: "create_mind", input: { title: "Rents", content: answer.write } }],
        };
      return { text: answer.text };
    },
    {
      generate(call) {
        asked.push(call);
        if (call.question === "sentence-batch") return batchReply(call, plans);
        // Every sentence it is shown makes a claim, but a row's label: what the check is sent is the core's choice.
        if (call.question === "find-claims")
          return {
            text: JSON.stringify({
              sentences: listedSentences(call.prompt).map(({ number, text: words }) => ({
                number,
                parts: labels.has(words) ? [] : [{ kind: "fact", text: words }],
              })),
            }),
          };
        return generate(call);
      },
    },
  );
  const setup = await setUpWithDocuments(model, example.documents);
  const byName = (name: string) => {
    const document = setup.documents.find((each) => each.name === name);
    if (!document)
      throw new Error(
        `No Document named ${name}: ${setup.documents.map((each) => each.name).join(", ")}`,
      );
    return document;
  };
  return { ...setup, calls, asked, byName };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

/** A line's paragraph: its words, then its Citation; a mark of an earlier check on its words, if given. */
async function lineOf(setup: Setup, id: string, line: Line, mark?: Record<string, unknown>) {
  return {
    type: "paragraph",
    attrs: { id },
    content: [
      {
        type: "text",
        text: line.text,
        ...(mark && { marks: [{ type: CLAIM_CHECK_MARK, attrs: mark }] }),
      },
      await citationOf(setup.core, setup.byName(line.cites), line.quote),
    ],
  } satisfies JSONContent;
}

const cell = (type: string, content: JSONContent[]): JSONContent => ({
  type,
  attrs: { colspan: 1, rowspan: 1 },
  content,
});

/** The Note of every case: a table with a Source column, a list, lines of their own, and the sentences still read. */
async function noteOf(setup: Setup, example: Example) {
  const [first, second] = example.cells;
  writeMind(setup.client, [
    {
      type: "table",
      attrs: { id: "table" },
      content: [
        {
          type: "tableRow",
          content: example.header.map((words, index) =>
            cell("tableHeader", [
              {
                type: "paragraph",
                attrs: { id: `head-${index}` },
                content: [{ type: "text", text: words }],
              },
            ]),
          ),
        },
        ...(await Promise.all(
          [first, second].map(async (row, index) => ({
            type: "tableRow",
            content: [
              cell("tableCell", [
                {
                  type: "paragraph",
                  attrs: { id: `label-${index}` },
                  content: [{ type: "text", text: row.label }],
                },
              ]),
              cell("tableCell", [await lineOf(setup, `source-${index}`, row)]),
            ],
          })),
        )),
      ],
    },
    {
      type: "bulletList",
      content: await Promise.all(
        example.items.map(async (item, index) => ({
          type: "listItem",
          content: [await lineOf(setup, `item-${index}`, item)],
        })),
      ),
    },
    ...(await Promise.all(
      example.lines.map((line, index) => lineOf(setup, `line-${index}`, line)),
    )),
    await lineOf(setup, "right", example.right),
    await lineOf(setup, "wrong", example.wrong),
    ...(await Promise.all(
      example.stillRead.map((line, index) => lineOf(setup, `read-${index}`, line)),
    )),
  ]);
  await setup.client.settled();
}

const onlyNames = (example: Example) => [
  ...example.cells.map((each) => each.text),
  ...example.items.map((each) => each.text),
  ...example.lines.map((each) => each.text),
];
const readSentences = (example: Example) => [
  example.right.text,
  example.wrong.text,
  ...example.stillRead.map((each) => each.text),
];

/** The sentences check Runs were sent, each once. */
const sentTo = (calls: readonly ModelCall[], from = 0) => [
  ...new Set(
    calls
      .slice(from)
      .filter((call) => isCheckRun(call) && call.results.length === 0)
      .map(sentenceOf),
  ),
];
const listed = (asked: readonly GenerateCall[], from = 0) =>
  asked
    .slice(from)
    .filter((call) => call.question === "find-claims")
    .flatMap((call) => listedSentences(call.prompt).map((each) => each.text));

/** Each mark's sentence and state, in the Note's order. */
const marksIn = (setup: Setup) =>
  claimSpans(readMind(setup.client)).map(({ sentence, check }) => [sentence.text, check.state]);

async function stateOf(setup: Setup) {
  return readNoteState({
    footing: [],
    doc: setup.client.doc,
    cellFigures: [],
    documents: await setup.core.listDocuments(),
    keptCitationTexts: [],
    folderId: null,
  }).state;
}

/** A Note of a name-only cell carrying an earlier check's Unsupported mark, and the right sentence. */
async function staleNote(setup: Setup, example: Example) {
  const [named] = example.cells;
  const old = {
    id: "earlier",
    request: "earlier",
    action: "check-against-documents",
    state: "unsupported",
    reason: null,
    detail: null,
    providerId: "provider",
    modelId: "model",
    text: named.text,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt: "2026-11-14T09:00:00.000Z",
  };
  writeMind(setup.client, [
    await lineOf(setup, "named", named, old),
    await lineOf(setup, "right", example.right),
  ]);
  await setup.client.settled();
}

/** The sentences the editor shows a card for. */
const cardsIn = (setup: Setup) =>
  claimsOf(readMind(setup.client), {
    footing: "not-yet-known",
    versions: null,
    folderId: null,
    scope: mindScopeOf(setup.client.doc),
  }).claims.map(({ sentence }) => sentence.text);

describe.each(LANGUAGES)("a sentence that only names its source ($language)", (example) => {
  // protects=Check this note reads no sentence whose words are only the name of a Document it cites, in a cell, a list item or a line, with or without the extension, in brackets, quotation or title marks, after a source label, or with its Citation's place, written after a comma or in brackets, gives it no mark and counts it nowhere, while the right and the wrong sentence beside it, a bare name that states a measured figure, any other word before a name, another Document's name, another page and a Document named only by a number are read as before, twice alike (#3093); fails_when=a name-only sentence is sent, marked or counted, or a sentence still to read is left out; no_claim=what a real model makes of a name.
  test("Check this note leaves it out and reads the rest, twice alike", async () => {
    const setup = await setUp(example);
    await noteOf(setup, example);
    const before = await stateOf(setup);

    const first = await setup.core.checkMind({
      requestId: randomUUID(),
      mindId: setup.mind.id,
      mode: "all",
    });
    await setup.client.settled();

    expect(sentTo(setup.calls).sort()).toEqual([...readSentences(example)].sort());
    for (const words of onlyNames(example)) expect(listed(setup.asked)).not.toContain(words);
    const marks = marksIn(setup);
    expect(marks.map(([words]) => words).sort()).toEqual([...readSentences(example)].sort());
    expect(marks).toContainEqual([example.right.text, "supported"]);
    expect(marks).toContainEqual([example.wrong.text, "contradicted"]);
    expect(first).toMatchObject({ kind: "checked", sentences: readSentences(example).length });
    expect(before?.checkable).toBe(readSentences(example).length);

    const calls = setup.calls.length;
    const again = await setup.core.checkMind({
      requestId: randomUUID(),
      mindId: setup.mind.id,
      mode: "all",
    });
    await setup.client.settled();
    expect(again).toEqual(first);
    expect(marksIn(setup)).toEqual(marks);
    for (const words of onlyNames(example)) expect(sentTo(setup.calls, calls)).not.toContain(words);
    setup.core.close();
  });

  // protects=Check against Documents on the whole Note sends no name-only sentence and marks none, and checks the right and the wrong sentence in the same selection (#3093); fails_when=a name-only sentence is sent or marked; no_claim=the selection's own toolbar.
  test("Check against Documents leaves it out and checks the rest", async () => {
    const setup = await setUp(example);
    await noteOf(setup, example);
    const last = example.stillRead.length - 1;
    await setup.core.checkSentences({
      requestId: randomUUID(),
      mindId: setup.mind.id,
      action: "check-against-documents",
      from: { blockId: "head-0", offset: 0 },
      to: { blockId: `read-${last}`, offset: (example.stillRead[last]?.text.length ?? 0) + 1 },
      allDocuments: true,
    });
    await setup.client.settled();

    for (const words of onlyNames(example)) expect(sentTo(setup.calls)).not.toContain(words);
    expect(sentTo(setup.calls)).toEqual(
      expect.arrayContaining([example.right.text, example.wrong.text]),
    );
    const marks = marksIn(setup);
    for (const words of onlyNames(example))
      expect(marks.map(([text]) => text)).not.toContain(words);
    expect(marks).toContainEqual([example.right.text, "supported"]);
    expect(marks).toContainEqual([example.wrong.text, "contradicted"]);
    setup.core.close();
  });

  // protects=a mark an earlier check left on a name-only sentence shows no card even before a check, is gone after the next Check this note, and undoing that check's edits as one step brings back the mark and what was there (#3093); fails_when=the old mark shows a card, stays, or the undo can't bring it back; no_claim=the editor's own Undo keys.
  test("a mark an earlier check left on it shows nothing, goes with the next check, and comes back with its Undo", async () => {
    const setup = await setUp(example);
    const [named] = example.cells;
    await staleNote(setup, example);
    expect(marksIn(setup)).toEqual([[named.text, "unsupported"]]);
    expect(cardsIn(setup)).toEqual([]);
    const undo = new Y.UndoManager(setup.client.blocks, {
      trackedOrigins: new Set([FROM_CORE]),
      captureTimeout: 60_000,
    });

    await setup.core.checkMind({ requestId: randomUUID(), mindId: setup.mind.id, mode: "all" });
    await setup.client.settled();
    expect(marksIn(setup)).toEqual([[example.right.text, "supported"]]);

    undo.undo();
    await setup.client.settled();
    expect(marksIn(setup)).toEqual([[named.text, "unsupported"]]);
    undo.destroy();
    setup.core.close();
  });

  // protects=a whole read of a Document, Check against a Document, takes an earlier check's mark off a name-only sentence it touches, as Check against Documents does (#3093); fails_when=the old mark stays after the read; no_claim=what the read finds for the other sentence.
  test("a whole read of a Document takes the earlier mark off it too", async () => {
    const setup = await setUp(example);
    const [named] = example.cells;
    await staleNote(setup, example);
    const place = {
      from: { blockId: "named", offset: 0 },
      to: { blockId: "right", offset: example.right.text.length + 1 },
    };
    const within = { folderIds: [], tagIds: [], documentIds: [setup.byName(named.cites).id] };
    const plan = await setup.core.planDocumentCheck({ mindId: setup.mind.id, ...place, within });
    if (plan.kind !== "ready") throw new Error(`The pick can't be read: ${plan.kind}.`);
    await setup.core.checkSentences({
      requestId: randomUUID(),
      mindId: setup.mind.id,
      action: "check-against-document",
      ...place,
      within,
      plan: plan.id,
    });
    await setup.client.settled();

    expect(marksIn(setup).map(([text]) => text)).not.toContain(named.text);
    setup.core.close();
  });

  // protects=an Answer's judgement reads no sentence that only names the Document its Citation is of, and that Citation keeps its own quote check, while the right and the wrong sentence of the same Answer are judged (#3093); fails_when=the name-only sentence is judged, or its Citation's check changes; no_claim=how the Answer's steps word it.
  test("an Answer's judgement leaves it out and judges the rest", async () => {
    const text = `${example.right.text} [^1]\n\n${example.wrong.text} [^2]\n\n- ${example.answerOnly.text} [^3]\n\n${example.label.text} [^4]\n`;
    const setup = await setUp(example, {
      text,
      quotes: [
        example.right.quote,
        example.wrong.quote,
        example.answerOnly.quote,
        example.label.quote,
      ],
    });
    const asked = await setup.core.askInConversation({ text: "What are the rents?" });
    if (!asked.asked) throw new Error("Not asked.");
    expect((await answerEnded(setup.core, asked.answerId)).event).toBe("finished");
    const answer = await answerJudged(setup.core, asked.conversation.id, asked.answerId);

    const judged = batchedSentences(setup.asked);
    expect(judged).toEqual(expect.arrayContaining([example.right.text, example.wrong.text]));
    expect(judged).not.toContain(example.answerOnly.text);
    expect(judged).not.toContain(example.label.text);
    const checkOf = (marker: number) =>
      answer.citations.find((each) => each.marker === marker)?.check;
    expect(checkOf(1)).toBe("found");
    expect(checkOf(2)).toBe("contradicted");
    expect(checkOf(3)).toBe("found");
    setup.core.close();
  });

  // protects=the check of what the assistant writes reads no sentence that only names its source, a Source column's cell or a bracketed name, and counts none, while the right sentence of the same write is checked and marked (#3093); fails_when=a name-only sentence is counted, sent or marked; no_claim=how a real model writes its table.
  test("the check of what the assistant writes leaves it out and checks the rest", async () => {
    const [cell] = example.cells;
    const [item] = example.items;
    const write = `| ${example.header[0]} | ${example.header[1]} |\n|---|---|\n| ${cell.label} | ${cell.text} [^1] |\n\n- ${item.text} [^2]\n\n${example.label.text} [^3]\n\n${example.right.text} [^1]\n`;
    const setup = await setUp(example, {
      text: "Done.",
      quotes: [example.right.quote, item.quote, example.label.quote],
      write,
    });
    const answer = await askAssistant(setup.core, { text: "Write the rents into a new note" });
    const made = changesIn(answer).find((change) => change.created);
    if (!made) throw new Error("No Note was made.");

    expect(made.selfCheck).toMatchObject({ cited: 1, sent: 1, failed: 0 });
    const client = await connectToMind(setup.core, made.mindId);
    await client.settled();
    expect(
      claimSpans(readMind(client)).map(({ sentence, check }) => [
        sentence.text.trim(),
        check.state,
      ]),
    ).toEqual([[example.right.text, "supported"]]);
    for (const words of [cell.text, item.text, example.label.text])
      expect(sentTo(setup.calls)).not.toContain(words);
    setup.core.close();
  });

  // protects=a cell that names two Documents it cites is read, as the rule leaves it, and is sent with neither name's number as a figure (#3093); fails_when=it is left out, or a name's number is asked for; no_claim=what a real model judges it.
  test("a cell that names two Documents it cites is still read, with neither name's number", async () => {
    const setup = await setUp(example);
    const [first, second] = example.cells;
    const text = example.language === "en" ? "Lease 1, Lease 2" : "附件3、合同2";
    writeMind(setup.client, [
      {
        type: "paragraph",
        attrs: { id: "two" },
        content: [
          { type: "text", text },
          await citationOf(setup.core, setup.byName(first.cites), first.quote),
          await citationOf(setup.core, setup.byName(second.cites), second.quote),
        ],
      },
      await lineOf(setup, "right", example.right),
    ]);
    await setup.client.settled();
    await setup.core.checkMind({ requestId: randomUUID(), mindId: setup.mind.id, mode: "all" });
    await setup.client.settled();

    const run = setup.calls.find(
      (call) => isCheckRun(call) && call.results.length === 0 && sentenceOf(call) === text,
    );
    expect(run && requestedFigures(run)).toEqual([]);
    expect(marksIn(setup)).toEqual([
      [text, "unsupported"],
      [example.right.text, "supported"],
    ]);
    setup.core.close();
  });
});
