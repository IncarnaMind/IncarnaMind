/**
 * A Note's figure whose separators it doesn't settle ("£1,284 million" in two short lines) is read
 * by the app, never asked of the model (#3088), in this order: the Passage the check relies on
 * writes it identically, so it is the same figure; the Note's own language; the way the Document
 * the sentence cites writes its numbers; the interface language. The interface language alone
 * gives a ✓ only when its reading agrees, and never a verdict that the other reading would undo.
 * A figure still read two ways says both, never that the model didn't read the Documents.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { Document } from "../../src/core";
import type { Language } from "../../src/core/language";
import { reasonText } from "../../src/renderer/src/cost";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { readClaimCheck } from "../../src/shared/claimChecks";
import { translate } from "../../src/shared/i18n";
import {
  checkGenerate,
  isCheckRun,
  requestedFigures,
  SAME_DETAIL,
  sentenceOf,
  unsupportedReply,
} from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

interface SourceFile {
  name: string;
  contents: string;
}

const report = (line: string): SourceFile => ({
  name: "Northwind Retail results.txt",
  contents: [
    "Northwind Retail plc results for the quarter",
    line,
    "The figures are unaudited and they are for the 13 weeks to 26 September 2026.",
    "",
  ].join("\n"),
});

/** An English report, which writes "." for decimals and "," for thousands. */
const AS_NOTE = report("Group revenue was £1,284 million, up 4.2% on the third quarter of 2025.");
const IN_BILLIONS = report(
  "Group revenue was £1.284 billion, up 4.2% on the third quarter of 2025.",
);
const AS_DECIMAL = report(
  "Group revenue was £1.284 million, up 4.2% on the third quarter of 2025.",
);
const OTHER_VALUE = report(
  "Group revenue was £1,500 million, up 4.2% on the third quarter of 2025.",
);
const IN_YUAN = report(
  "Group revenue was 1,284 million yuan, up 4.2% on the third quarter of 2025.",
);

/** A Document that writes "," for decimals and "." for thousands, in no language the app tells. */
const COMMA_DECIMALS: SourceFile = {
  name: "Northwind kennzahlen.txt",
  contents: [
    "Northwind",
    "Revenue GBP 1.284",
    "Cash GBP 1.284.000",
    "Costs GBP 1.234.567",
    "Margin 38,6%",
    "",
  ].join("\n"),
};

/** Words that tell the Note's language, in a paragraph of their own above the checked one. */
const GERMAN = "Die Gruppe hat ein gutes Quartal gehabt, und das ist für uns nicht schlecht.";
const ENGLISH = "The board met on Tuesday and it was the first meeting of the year.";

/**
 * A judge that searches, cites `quote` and binds every requested figure to `number` as the quote
 * writes it, naming no reading of its own, and calls each Supported.
 */
function binding(quote: string, number: string) {
  return (call: ModelCall): ScriptedReply => {
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0)
      return { calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }] };
    const shown = [
      ...searches.flatMap((each) => shownPassages(each.text)),
      ...shownPassages(call.prompt),
    ];
    const passage = shown.find((each) => each.text.includes(quote));
    if (!passage) return { text: unsupportedReply(call) };
    if (!call.results.some((result) => result.tool === "cite"))
      return {
        calls: [
          { tool: "cite", input: { citations: [{ marker: 1, passage: passage.id, quote }] } },
        ],
      };
    const items = requestedFigures(call).map(({ id }) => ({
      id,
      verdict: "supported",
      scope: "same",
      topic: "found",
      roles: "same",
      says: null,
      reading: null,
      relation: "equals",
      source: { citation: 1, number },
      measure: null,
      calculation: null,
    }));
    return {
      text: `Verdict: supported\nAbsence: no\n${SAME_DETAIL}\nExplanation: It says ${quote}. [^1]\nEvidence: [1]\nFigures: ${JSON.stringify({ items, remainder: null })}`,
    };
  };
}

interface Row {
  above?: string;
  sentence: string;
  document: SourceFile;
  quote: string;
  number: string;
  /** The sentence cites the line of its Document that holds `quote`. */
  cites?: true;
}

/** Checks the last line of a new Note as Check against Documents does: its card, and its check Runs. */
async function check(row: Row, language: Language) {
  const calls: ModelCall[] = [];
  const reply = binding(row.quote, row.number);
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      return isCheckRun(call) ? reply(call) : { text: "Done." };
    },
    { generate: checkGenerate({}) },
  );
  const { core, mind, client, documents } = await setUpWithDocuments(model, [row.document]);
  await core.updateSettings({ user: { language } });
  const [document] = documents as [Document];
  const content: JSONContent[] = [{ type: "text", text: row.sentence }];
  if (row.cites) {
    const line = row.document.contents.split("\n").find((each) => each.includes(row.quote)) ?? "";
    const selected = await core.citeSelection({
      documentId: document.id,
      parts: [{ unit: null, text: line }],
    });
    content.push({
      type: "citation",
      attrs: {
        passageId: selected.passageId,
        documentId: document.id,
        documentName: document.name,
        contentHash: selected.contentHash,
        quote: selected.quote,
        pageFrom: selected.pageFrom,
        pageTo: selected.pageTo,
        location: selected.location,
        check: selected.check,
      },
    });
  }
  writeMind(client, [
    ...(row.above
      ? [
          {
            type: "paragraph",
            attrs: { id: "above" },
            content: [{ type: "text", text: row.above }],
          },
        ]
      : []),
    { type: "paragraph", attrs: { id: "line" }, content },
  ]);
  await client.settled();
  await core.checkSentences({
    requestId: "check",
    mindId: mind.id,
    action: "check-against-documents",
    from: { blockId: "line", offset: 0 },
    to: { blockId: "line", offset: row.sentence.length },
  });
  await client.settled();
  const span = claimSpans(readMind(client)).find((each) => each.sentence.text === row.sentence);
  core.close();
  if (!span) throw new Error(`${row.sentence} wasn't checked.`);
  const { check: checked } = span;
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(language, key, params);
  return {
    state: checked.state,
    line:
      checked.state === "not-checked" && checked.reason
        ? reasonText(t, language, checked.reason, checked.detail)
        : null,
    calls: calls.filter(isCheckRun),
  };
}

const twoWays = (language: Language, shown: string, first: string, second: string) =>
  language === "en"
    ? `“${shown}” could mean ${first} or ${second}, so it wasn’t checked.`
    : `“${shown}”可能是 ${first}，也可能是 ${second}，所以未核对。`;

const ok = { state: "supported", line: null };
const wrong = { state: "contradicted", line: null };

describe.each(["en", "zh-CN"] as const)("the order a separator is read in (%s)", (language) => {
  // protects=the issue's own case: a two-line Note's "£1,284 million", which the judge names no reading of, is Supported by a Passage that writes it the same way (#3088); fails_when=it reads Not checked for want of a reading; no_claim=how a real model binds the figure.
  test("1. the Passage writes it identically: the same figure, no reading asked", async () => {
    const result = await check(
      {
        sentence: "Revenue was £1,284 million.",
        document: AS_NOTE,
        quote: "Group revenue was £1,284 million",
        number: "£1,284 million",
      },
      language,
    );
    expect({ state: result.state, line: result.line }).toEqual(ok);
  });

  // protects=a German Note, whose language reads "1,284" as 1.284, that copies "£1,284 million" from an English report is the report's figure, not a thousand times less (#3088); fails_when=it comes back Contradicted; no_claim=a German Note's own figure that its Passage writes another way (the next row).
  test("1. a German Note copying the figure identically is the same figure", async () => {
    const result = await check(
      {
        above: GERMAN,
        sentence: "Der Umsatz war £1,284 million.",
        document: AS_NOTE,
        quote: "Group revenue was £1,284 million",
        number: "£1,284 million",
      },
      language,
    );
    expect({ state: result.state, line: result.line }).toEqual(ok);
  });

  // protects=a Note whose language is told reads its figure in that language when the Passage writes it another way, and may come out Contradicted (#3088); fails_when=the interface language or the Passage overrides the Note's own; no_claim=a Note that copies its Passage's writing (step 1).
  test("2. the Note's own language: English agrees, German reads a thousand times less", async () => {
    const english = await check(
      {
        above: ENGLISH,
        sentence: "Revenue was £1,284 million.",
        document: IN_BILLIONS,
        quote: "Group revenue was £1.284 billion",
        number: "£1.284 billion",
      },
      language,
    );
    expect({ state: english.state, line: english.line }).toEqual(ok);
    const german = await check(
      {
        above: GERMAN,
        sentence: "Der Umsatz war £1,284 million.",
        document: IN_BILLIONS,
        quote: "Group revenue was £1.284 billion",
        number: "£1.284 billion",
      },
      language,
    );
    expect({ state: german.state, line: german.line }).toEqual(wrong);
  });

  // protects=a short Note's figure is read the way the Document it cites writes numbers ("," for decimals here), before the interface language, and that reading may be Supported or Contradicted (#3088); fails_when=the interface language reads it, or it is left Not checked; no_claim=what tells a Document's way apart from its language (tests/shared/figures).
  test("3. the cited Document's own way: Supported, and Contradicted", async () => {
    const agrees = await check(
      {
        sentence: "Revenue was £1,284 thousand.",
        document: COMMA_DECIMALS,
        quote: "Revenue GBP 1.284",
        number: "GBP 1.284",
        cites: true,
      },
      language,
    );
    expect({ state: agrees.state, line: agrees.line }).toEqual(ok);
    const differs = await check(
      {
        sentence: "Cash was £1,284 thousand.",
        document: COMMA_DECIMALS,
        quote: "Cash GBP 1.284.000",
        number: "GBP 1.284.000",
        cites: true,
      },
      language,
    );
    expect({ state: differs.state, line: differs.line }).toEqual(wrong);
  });

  // protects=with nothing else to go by, the interface language's reading gives a ✓ when it agrees, and the ordinary verdict when neither reading does (#3088); fails_when=it reads Not checked though a reading is settled; no_claim=a reading the other one would undo (the next rows).
  test("4. the interface language: Supported when it agrees, Contradicted when neither does", async () => {
    const agrees = await check(
      {
        sentence: "Revenue was £1,284 million.",
        document: IN_BILLIONS,
        quote: "Group revenue was £1.284 billion",
        number: "£1.284 billion",
      },
      language,
    );
    expect({ state: agrees.state, line: agrees.line }).toEqual(ok);
    const neither = await check(
      {
        sentence: "Revenue was £1,284 million.",
        document: OTHER_VALUE,
        quote: "Group revenue was £1,500 million",
        number: "£1,500 million",
      },
      language,
    );
    expect({ state: neither.state, line: neither.line }).toEqual(wrong);
  });

  // protects=when only the interface language reads the figure and its reading disagrees where the other would agree, the figure is Not checked with both readings named, never ✓, Contradicted or Unsupported, "1,284" against a decimal "1.284" and the reverse (#3088); fails_when=it reads Contradicted, Supported or the unread-Documents line; no_claim=a Note whose language or cited Document settles it.
  test("4. the interface language disagreeing where the other reading agrees: both ways", async () => {
    const grouped = await check(
      {
        sentence: "Revenue was £1,284 million.",
        document: AS_DECIMAL,
        quote: "Group revenue was £1.284 million",
        number: "£1.284 million",
      },
      language,
    );
    expect({ state: grouped.state, line: grouped.line }).toEqual({
      state: "not-checked",
      line: twoWays(language, "£1,284 million", "1,284 million GBP", "1.284 million GBP"),
    });
    const decimal = await check(
      {
        sentence: "Revenue was £1.284 million.",
        document: AS_NOTE,
        quote: "Group revenue was £1,284 million",
        number: "£1,284 million",
      },
      language,
    );
    expect({ state: decimal.state, line: decimal.line }).toEqual({
      state: "not-checked",
      line: twoWays(language, "£1.284 million", "1.284 million GBP", "1,284 million GBP"),
    });
  });

  // protects=a figure the app can't read one way, "¥" with neither yuan nor yen named in the Note, whose reading the judge doesn't name, says both readings, and the model is offered only that choice, in the figure's own spacing (#3088); fails_when=the unread-Documents line shows, the separator is offered, or a reading reads "1,284million"; no_claim=a "¥" the Note's own words settle.
  test("the app can't read it: ¥ as yuan or yen", async () => {
    const result = await check(
      {
        sentence: "Revenue was ¥1,284 million.",
        document: IN_YUAN,
        quote: "Group revenue was 1,284 million yuan",
        number: "1,284 million yuan",
      },
      language,
    );
    expect({ state: result.state, line: result.line }).toEqual({
      state: "not-checked",
      line: twoWays(language, "¥1,284 million", "1,284 million CNY", "1,284 million JPY"),
    });
    const offered = result.calls.map(
      (call) => /<figures>\n([\s\S]*?)\n<\/figures>/.exec(call.prompt)?.[1],
    );
    expect(offered[0]).toContain(
      '"ambiguities":[{"kind":"currency","readings":[{"reading":1,"means":"1,284 million CNY"},{"reading":2,"means":"1,284 million JPY"}]}]',
    );
    expect(offered.join("\n")).not.toContain('"separator"');
  });
});

describe("a mark an older build reads", () => {
  const mark = {
    id: "check-1",
    request: "request-1",
    action: "check-against-documents",
    state: "not-checked",
    reason: "a-reason-from-a-later-build",
    detail: '{"shown":"£1,284 million"}',
    providerId: null,
    modelId: "claude-haiku-5-5",
    text: "Revenue was £1,284 million.",
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    versions: [],
    excluded: [],
    checkedAt: "2026-11-14T00:00:00.000Z",
  };

  // protects=a reason this build doesn't know, as an older build meets "two-readings", reads as Not checked with no reason and nothing thrown, in a sentence and in a part (#3088); fails_when=reading the mark throws or the mark is dropped; no_claim=what the card shows for no reason.
  test("drops a reason it doesn't know, in the sentence and in its parts", () => {
    expect(readClaimCheck(mark)).toMatchObject({ state: "not-checked", reason: null });
    const parted = readClaimCheck({
      ...mark,
      parts: [
        {
          kind: "fact",
          span: { start: 0, end: 26 },
          verdict: "not-checked",
          reason: "a-reason-from-a-later-build",
          detail: null,
        },
      ],
    });
    expect(parted).toMatchObject({ state: "not-checked" });
    expect(parted?.reason).not.toBe("a-reason-from-a-later-build");
  });
});
