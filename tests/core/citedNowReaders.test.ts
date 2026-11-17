import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { checkCitedSentences } from "../../eval/everyday/support";
import { CITATION_NODE, type Core, type Document } from "../../src/core";
import { claimsOf } from "../../src/renderer/src/editor/claimChecks";
import type { ClaimCheckShown } from "../../src/shared/claimChecks";
import { checkingModel, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { recordRows } from "../helpers/csv";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { para, pptxOf, sp, txBody } from "../helpers/pptx";

/*
 * Every reader of a sentence's check shows a ✓ only where the record it rests on is one the
 * sentence's own Citation holds, by the card's "Already cited" rule (#3050): the Note, the check
 * record, the AI use statement, an export, and the everyday evaluation's record of an Answer's
 * sentences. The shapes are those the evaluation's research requests showed, in English and
 * Chinese, beside the "Already cited" rule's own cases, which keep their ✓.
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
    fragment: "grow linearly with the input length",
    within: "memory grow linearly with the input length",
  },
  zh: {
    compute: "训练时，计算量和内存随输入长度线性增长。",
    win: "在两个测试集上，Halden 模型胜过了循环系统，而且并行运行更便宜。",
    built: "Halden 模型完全由加权键查找构成。",
    long: "在极长的输入上，质量依然保持。",
    recurrent: "该模型是完全循环的，不在整个输入上做查找。",
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

interface Shape {
  /** What the evaluation's research requests showed, or the "Already cited" rule's own case. */
  name: string;
  sentence: string;
  /** The quote its one Citation gives. */
  cites: string;
  /** The quote the check records for it with `cite`. */
  record: string;
  /** Whether its ✓ shows: it rests on a record its Citation holds. */
  checked: boolean;
}

function shapes(language: "en" | "zh"): Shape[] {
  const line = LINES[language];
  const en = language === "en";
  return [
    {
      name: "a line from another page",
      sentence: en
        ? "It keeps its quality on inputs as long as a million tokens."
        : "它在极长的输入上仍保持质量。",
      record: line.long,
      cites: line.compute,
      checked: false,
    },
    {
      name: "another line on the cited page",
      sentence: en
        ? "The Halden model is built only from weighted-key lookups."
        : "Halden 模型只由加权键查找构成。",
      record: line.built,
      cites: line.win,
      checked: false,
    },
    {
      name: "the cited quote itself",
      sentence: en
        ? "Training computation grows linearly with the input length."
        : "训练时的计算量随输入长度线性增长。",
      record: line.compute,
      cites: line.compute,
      checked: true,
    },
    {
      name: "words inside the cited clause",
      sentence: en
        ? "Memory grows linearly with the input length."
        : "它的内存随输入长度线性增长。",
      record: line.within,
      cites: line.compute,
      checked: true,
    },
    {
      name: "a wider clause, whose more the sentence doesn't say",
      sentence: en
        ? "Its memory grows linearly with the input length."
        : "它的内存占用随输入长度线性增长。",
      record: line.compute,
      cites: line.fragment,
      checked: true,
    },
  ];
}

/** A model that checks each sentence Supported on its record, which it records with `cite`. */
const recordingModel = (all: readonly Shape[]) =>
  checkingModel(
    Object.fromEntries(
      all.map((shape): [string, Plan] => [
        shape.sentence,
        {
          verdict: "supported",
          judgement: "same",
          quote: shape.record,
          says: "The Document says so.",
        },
      ]),
    ),
  );

/** Each shape as a paragraph of its own, its Citation before the stop, as the User wrote it. */
function writeShapes(client: MindClient, all: readonly Shape[], document: Document) {
  writeMind(
    client,
    all.map(
      (shape, index) =>
        ({
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
                pageFrom: 1,
                pageTo: 1,
                quote: shape.cites,
                check: "found",
              },
            },
            { type: "text", text: shape.sentence.slice(-1) },
          ],
        }) satisfies JSONContent,
    ),
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

  // protects=a sentence whose check rests on a record its Citation doesn't hold (another page, another line on the cited page) shows no ✓ in the Note, the check record or the AI use statement, and isn't marked in an export, while the cited quote, words inside its clause and a wider clause whose more the sentence doesn't say keep their ✓; the mark keeps the model's Supported (#3050); fails_when=any reader shows a ✓ beside a Citation whose words don't say the sentence, reads it Unsupported, or takes a held ✓ away; no_claim=how the card draws it.
  test("every reader of the Note shows the ✓ only where the Citation holds what it rests on", async () => {
    const { core, client, mind, documents } = await setUpWithDocuments(recordingModel(all), [DECK]);
    const [deck] = documents;
    if (!deck) throw new Error("The Document wasn't added.");
    const out = await createTempDataFolder();
    await core.setOutputLocation(out);
    writeShapes(client, all, deck);
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
    const { core, documents } = await setUpWithDocuments(recordingModel(all), [DECK]);
    const [deck] = documents;
    if (!deck) throw new Error("The Document wasn't added.");
    const answer = {
      text: all
        .map(
          ({ sentence }, index) => `${sentence.slice(0, -1)}[^${index + 1}]${sentence.slice(-1)}`,
        )
        .join(" "),
      citations: all.map((shape, index) => ({
        marker: index + 1,
        documentName: deck.name,
        documentId: deck.id,
        contentHash: deck.contentHash,
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
