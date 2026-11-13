import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { checkCitedSentences } from "../../eval/everyday/support";
import { CITATION_NODE, type Core, type Document } from "../../src/core";
import { claimsOf } from "../../src/renderer/src/editor/claimChecks";
import type { ClaimCheckShown } from "../../src/shared/claimChecks";
import { checkGenerate, checkReply, type Plan, SAME_DETAIL, sentenceOf } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { recordRows } from "../helpers/csv";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";
import { para, pptxOf, sp, txBody } from "../helpers/pptx";

/*
 * Every reader of a sentence's check shows a ✓ only where the record it rests on is one the
 * sentence's own Citation holds, by the card's "Already cited" rule (#3050): the Note, the check
 * record, the AI use statement, an export, and the everyday evaluation's record of an Answer's
 * sentences. The check's reply writes its records into its text (#3032). The shapes are those the
 * evaluation's research requests showed, in English and Chinese, beside the "Already cited" rule's
 * own cases, which keep their ✓.
 */

const slide = (...lines: string[]) => ({
  shapes: sp({
    id: 2,
    name: "Body",
    txBox: true,
    body: txBody(lines.map((line) => para(line)).join("")),
  }),
});

const LINES = {
  en: {
    compute: "Computation and memory grow linearly with the input length during training.",
    win: "On two test sets the Halden model beat the recurrent systems and was cheaper to run in parallel.",
    built: "The Halden model is assembled entirely from weighted-key lookups.",
    long: "Quality holds on inputs as long as a million tokens.",
    recurrent: "The model is fully recurrent, with no lookup across the whole input.",
    step: "any two positions are one step apart",
    pass: "information passes from one position to the next",
    fragment: "grow linearly with the input length",
    within: "memory grow linearly with the input length",
  },
  zh: {
    compute: "训练时，计算量和内存随输入长度线性增长。",
    win: "在两个测试集上，Halden 模型胜过了循环系统，而且并行运行更便宜。",
    built: "Halden 模型完全由加权键查找构成。",
    long: "在极长的输入上，质量依然保持。",
    recurrent: "该模型是完全循环的，不在整个输入上做查找。",
    step: "任意两个位置之间只隔一步",
    pass: "信息逐个位置向后传递",
    fragment: "随输入长度线性增长",
    within: "内存随输入长度线性增长",
  },
} as const;

/** Two slides: every quote a sentence cites is on the first. */
const DECK = {
  name: "Scaling.pptx",
  contents: pptxOf({
    slides: [
      slide(
        LINES.en.compute,
        LINES.en.win,
        LINES.en.built,
        LINES.zh.compute,
        LINES.zh.win,
        LINES.zh.built,
      ),
      slide(LINES.en.long, LINES.en.recurrent, LINES.zh.long, LINES.zh.recurrent),
    ],
  }),
};

/** A table whose rows each say one thing of one kind of layer. */
const ROWS = {
  name: "Layers.md",
  contents: [
    "# Layers",
    "",
    "| Layer | Path between positions |",
    "|---|---|",
    `| Weighted keys | ${LINES.en.step} |`,
    `| Recurrent | ${LINES.en.pass} |`,
    `| 加权键层 | ${LINES.zh.step} |`,
    `| 循环层 | ${LINES.zh.pass} |`,
    "",
  ].join("\n"),
};

type Held = "deck" | "rows";
const NAMES: Record<Held, string> = { deck: "Scaling", rows: "Layers" };

interface Shape {
  /** What the evaluation's research requests showed, or the "Already cited" rule's own case. */
  name: string;
  sentence: string;
  /** The quote its one Citation gives, and the Document it is in. */
  cites: string;
  in: Held;
  /** Each part the check names, with the records its reply writes for it, the deciding one first. */
  parts: { text: string; records: string[] }[];
  /** Whether its ✓ shows: every part rests on a record its Citation holds. */
  checked: boolean;
}

/** A sentence the check judges whole, on these records. */
const whole = (sentence: string, records: string[]) => ({
  sentence,
  parts: [{ text: sentence, records }],
});

function shapes(language: "en" | "zh"): Shape[] {
  const line = LINES[language];
  const en = language === "en";
  return [
    {
      name: "a line from another page",
      ...whole(
        en
          ? "It keeps its quality on inputs as long as a million tokens."
          : "它在极长的输入上仍保持质量。",
        [line.long],
      ),
      cites: line.compute,
      in: "deck",
      checked: false,
    },
    {
      name: "a part resting on another line, beside one its Citation holds",
      sentence: en
        ? "It is fully recurrent, and its computation grows linearly with the input length."
        : "它是完全循环的，计算量随输入长度线性增长。",
      parts: en
        ? [
            { text: "It is fully recurrent", records: [line.recurrent] },
            {
              text: "its computation grows linearly with the input length",
              records: [line.compute],
            },
          ]
        : [
            { text: "它是完全循环的", records: [line.recurrent] },
            { text: "计算量随输入长度线性增长", records: [line.compute] },
          ],
      cites: line.compute,
      in: "deck",
      checked: false,
    },
    {
      name: "a table row that isn't cited, beside one that is",
      sentence: en
        ? "With weighted keys any two positions are one step apart, and in recurrent layers information passes from one position to the next."
        : "加权键层中任意两个位置之间只隔一步，循环层中信息逐个位置向后传递。",
      parts: en
        ? [
            {
              text: "With weighted keys any two positions are one step apart",
              records: [line.step],
            },
            {
              text: "in recurrent layers information passes from one position to the next",
              records: [line.pass],
            },
          ]
        : [
            { text: "加权键层中任意两个位置之间只隔一步", records: [line.step] },
            { text: "循环层中信息逐个位置向后传递", records: [line.pass] },
          ],
      cites: line.step,
      in: "rows",
      checked: false,
    },
    {
      name: "another line on the cited page",
      ...whole(
        en
          ? "The Halden model is built only from weighted-key lookups."
          : "Halden 模型只由加权键查找构成。",
        [line.built],
      ),
      cites: line.win,
      in: "deck",
      checked: false,
    },
    {
      name: "a second record held by neither the Citation nor the first record",
      sentence: en
        ? "Its computation grows linearly with the input length, and its quality holds on inputs of a million tokens."
        : "它的计算量随输入长度线性增长，在极长的输入上质量依然保持。",
      parts: en
        ? [
            {
              text: "Its computation grows linearly with the input length",
              records: [line.compute, line.recurrent],
            },
            { text: "its quality holds on inputs of a million tokens", records: [line.long] },
          ]
        : [
            { text: "它的计算量随输入长度线性增长", records: [line.compute, line.recurrent] },
            { text: "在极长的输入上质量依然保持", records: [line.long] },
          ],
      cites: line.fragment,
      in: "deck",
      checked: false,
    },
    {
      name: "the cited quote itself",
      ...whole(
        en
          ? "Training computation grows linearly with the input length."
          : "训练时的计算量随输入长度线性增长。",
        [line.compute],
      ),
      cites: line.compute,
      in: "deck",
      checked: true,
    },
    {
      name: "words inside the cited clause",
      ...whole(
        en ? "Memory grows linearly with the input length." : "它的内存随输入长度线性增长。",
        [line.within],
      ),
      cites: line.compute,
      in: "deck",
      checked: true,
    },
    {
      name: "a wider clause, whose more the sentence doesn't say",
      ...whole(
        en
          ? "Its memory grows linearly with the input length."
          : "它的内存占用随输入长度线性增长。",
        [line.compute],
      ),
      cites: line.fragment,
      in: "deck",
      checked: true,
    },
  ];
}

/** A check's reply that gives Supported and writes its records into its text, never calling cite. */
const writing = (records: readonly string[], document: string): Plan => ({
  verdict: "supported",
  judgement: "same",
  reply: {
    text: [
      "Verdict: supported",
      "Absence: no",
      SAME_DETAIL,
      "Explanation: The Document says so.",
      `Evidence: [${records.map((_, index) => index + 1).join(", ")}]`,
      ...records.map((quote, index) => `[^${index + 1}]: ${document}, “${quote}”`),
    ].join("\n"),
  },
});

/** A model that checks each part on its records, and names a sentence's parts as a check's Run does. */
function recordingModel(all: readonly Shape[]) {
  const plans: Record<string, Plan> = {};
  for (const shape of all) {
    for (const part of shape.parts) plans[part.text] = writing(part.records, NAMES[shape.in]);
  }
  return scriptedModel(
    (call) => {
      const reply = checkReply(call, plans);
      const first = !call.results.some((result) => result.tool === "search_documents");
      const shape = all.find((each) => each.sentence === sentenceOf(call));
      if (!first || !shape || shape.parts.length < 2 || !call.system.includes("Parts:"))
        return reply;
      const parts = shape.parts.map((part) => ({ kind: "fact", text: part.text }));
      return { ...reply, text: `Parts: ${JSON.stringify(parts)}` };
    },
    { generate: checkGenerate(plans, '{"passage": null}') },
  );
}

/** Each shape as a paragraph of its own, its Citation before the stop, as the User wrote it. */
function writeShapes(client: MindClient, all: readonly Shape[], documents: Record<Held, Document>) {
  writeMind(
    client,
    all.map((shape, index) => {
      const document = documents[shape.in];
      return {
        type: "paragraph",
        attrs: { id: `s${index}` },
        content: [
          { type: "text", text: shape.sentence.slice(0, -1) },
          {
            type: CITATION_NODE,
            attrs: {
              documentId: document.id,
              documentName: document.name,
              contentHash: document.contentHash,
              ...(shape.in === "deck" && { pageFrom: 1, pageTo: 1 }),
              quote: shape.cites,
              check: "found",
            },
          },
          { type: "text", text: shape.sentence.slice(-1) },
        ],
      } satisfies JSONContent;
    }),
  );
}

async function checkAll(core: Core, mindId: string, all: readonly Shape[]) {
  await core.checkSentences({
    requestId: crypto.randomUUID(),
    mindId,
    action: "check-against-documents",
    from: { blockId: "s0", offset: 0 },
    to: { blockId: `s${all.length - 1}`, offset: (all.at(-1)?.sentence.length ?? 0) + 1 },
  });
}

/** A ✓, or why there is none. */
const shownAs = (shown: ClaimCheckShown): string =>
  shown.state === "supported" ? "✓" : shown.state === "not-checked" ? shown.reason : shown.state;

/** The AI use statement's list of checked sentences: each one's result, in the Note's order. */
async function statementResults(core: Core, mindId: string): Promise<string[]> {
  const statement = await connectToMind(core, (await core.createAiUseStatement(mindId)).id);
  const results: string[] = [];
  readMind(statement).descendants((node) => {
    if (node.type.name !== "table") return true;
    const rows: string[][] = [];
    node.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => void cells.push(cell.textContent));
      rows.push(cells);
    });
    if (rows[0]?.[0] === "Sentence") results.push(...rows.slice(1).map((row) => row[1] ?? ""));
    return false;
  });
  return results;
}

describe.each(["en", "zh"] as const)("in %s", (language) => {
  const all = shapes(language);

  // protects=a sentence whose check rests on a record its Citation doesn't hold (another page, another line, an uncited table row, a second record held by neither) shows no ✓ in the Note, the check record or the AI use statement, and isn't marked in an export, while the cited quote, words inside its clause and a wider clause whose more the sentence doesn't say keep their ✓; the mark keeps the model's Supported (#3050); fails_when=any reader shows a ✓ beside a Citation whose words don't say the sentence, reads it Unsupported, or takes a held ✓ away; no_claim=how the card draws it.
  test("every reader of the Note shows the ✓ only where the Citation holds what it rests on", async () => {
    const { core, client, mind, documents } = await setUpWithDocuments(recordingModel(all), [
      DECK,
      ROWS,
    ]);
    const [deck, rows] = documents;
    if (!deck || !rows) throw new Error("The Documents weren't added.");
    const out = await createTempDataFolder();
    await core.setOutputLocation(out);
    writeShapes(client, all, { deck, rows });
    await client.settled();

    await checkAll(core, mind.id, all);
    await client.settled();

    const { claims } = claimsOf(readMind(client), {
      footing: "not-yet-known",
      versions: null,
      folderId: null,
      scope: null,
    });
    expect(claims.map((claim) => claim.check.state)).toEqual(all.map(() => "supported"));
    expect(claims.map((claim, index) => [all[index]?.name, shownAs(claim.shown)])).toEqual(
      all.map((shape) => [shape.name, shape.checked ? "✓" : "found-elsewhere"]),
    );
    expect(claims[0]?.check.evidence?.pageFrom).toBe(2);

    const saved = await core.saveCheckRecord(mind.id);
    if (saved.status !== "saved") throw new Error(`The check record wasn't saved: ${saved.status}`);
    const csv = await readFile(
      join(out, `${saved.file.name.replace(/\.(pdf|csv)$/, "")}.csv`),
      "utf8",
    );
    expect(
      recordRows(csv)
        .filter((row) => row.Kind === "Sentence")
        .map((row) => [row.Sentence, row.Result]),
    ).toEqual(all.map((shape) => [shape.sentence, shape.checked ? "Supported" : "Not checked"]));

    const listed = await statementResults(core, mind.id);
    expect(listed.map((result, index) => [all[index]?.name, result])).toEqual(
      all.map((shape) => [shape.name, shape.checked ? "Supported" : "Not checked"]),
    );

    const exported = await core.exportMind(mind.id, { format: "docx", commentFailedChecks: true });
    expect(exported.sentenceChecks).toMatchObject({
      contradicted: 0,
      notFound: 0,
      unsupported: 0,
      needsRecheck: 0,
      comments: 0,
    });
  });

  // protects=the everyday evaluation's record of an Answer's cited sentences reads each check as the Note does: a ✓ resting on a record the sentence's Citation doesn't hold is Not checked, found elsewhere, and the "Already cited" rule's cases keep their Supported (#3050); fails_when=the record counts a ✓ the Note doesn't show, or takes a held one away; no_claim=the report's wording.
  test("the evaluation's record of an Answer reads each check as the Note does", async () => {
    const { core, documents } = await setUpWithDocuments(recordingModel(all), [DECK, ROWS]);
    const [deck, rows] = documents;
    if (!deck || !rows) throw new Error("The Documents weren't added.");
    const of: Record<Held, Document> = { deck, rows };
    const answer = {
      text: all
        .map(
          ({ sentence }, index) => `${sentence.slice(0, -1)}[^${index + 1}]${sentence.slice(-1)}`,
        )
        .join(" "),
      citations: all.map((shape, index) => ({
        marker: index + 1,
        documentName: of[shape.in].name,
        documentId: of[shape.in].id,
        contentHash: of[shape.in].contentHash,
        quote: shape.cites,
      })),
    };

    const support = await checkCitedSentences(core, answer);

    expect(support.map((each) => [each.sentence, each.verdict, each.reason])).toEqual(
      all.map((shape) =>
        shape.checked
          ? [shape.sentence, "supported", null]
          : [shape.sentence, "not-checked", "found-elsewhere"],
      ),
    );
  });
});
