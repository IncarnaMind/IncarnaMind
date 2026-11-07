import { writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { ConversationAnswer, Core } from "../../src/core";
import { messageReference } from "../../src/core";
import { answerBlocks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import {
  citationAttributesOf,
  newVersionCitation,
  parseQuotedWords,
  parseQuotedWordsCheck,
} from "../../src/shared/citations";
import { recheckCitations } from "../../src/shared/noteBlocks";
import { answerEnded, checkedResult, citingModel, setUpWithDocuments } from "../helpers/citations";
import { waitForProcessing } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { buildPdf } from "../helpers/pdf";

/**
 * A Citation that an Answer's own quoted words made "Quote not found" (#483) stays not found where
 * the Answer lands in a Note (#2612): Add to note, New note and the Note open in the editor check
 * it again there, and the words the Answer quoted are checked with its quote, not left behind.
 */

const CASES = {
  en: {
    pdf: buildPdf([
      { lines: ["Tides and the Moon", "The Moon's gravity raises two tidal bulges on the Earth."] },
      {
        lines: [
          "Spring and neap tides",
          "Spring tides happen just after a new moon or a full moon.",
        ],
      },
    ]),
    name: "Tides.pdf",
    query: "spring tides",
    question: "When are spring tides?",
    quote: "Spring tides happen just after a new moon or a full moon.",
    madeUp: "spring tides happen only at a full moon",
    onPage: "happen just after a new moon or a full moon",
    otherPage: "The Moon's gravity raises two tidal bulges on the Earth",
    changed: buildPdf([
      { lines: ["Tides and the Moon", "The Moon's gravity raises two tidal bulges on the Earth."] },
      {
        lines: [
          "Spring and neap tides",
          "Spring tides happen soon after a new moon or a full moon.",
        ],
      },
    ]),
    changedQuote: "Spring tides happen soon after a new moon or a full moon.",
    changedTo: "happen soon after a new moon or a full moon",
    sentence: (words: string) => `The guide says “${words}” [^1].`,
  },
  zh: {
    pdf: buildPdf([
      { chineseLines: ["潮汐与月球", "月球的引力在地球上形成两个潮汐隆起。"] },
      { chineseLines: ["大潮与小潮", "大潮出现在新月或满月之后不久。"] },
    ]),
    name: "潮汐.pdf",
    query: "大潮",
    question: "大潮在什么时候出现？",
    quote: "大潮出现在新月或满月之后不久。",
    madeUp: "大潮只在满月时出现",
    onPage: "大潮出现在新月或满月之后不久",
    otherPage: "月球的引力在地球上形成两个潮汐隆起",
    changed: buildPdf([
      { chineseLines: ["潮汐与月球", "月球的引力在地球上形成两个潮汐隆起。"] },
      { chineseLines: ["大潮与小潮", "大潮发生在新月或满月之后不久。"] },
    ]),
    changedQuote: "大潮发生在新月或满月之后不久。",
    changedTo: "大潮发生在新月或满月之后不久",
    sentence: (words: string) => `指南写道“${words}”[^1]。`,
  },
} as const;

type Language = keyof typeof CASES;

/** A core with an Answer citing page 2, whose sentence quotes `words`. */
async function answerQuoting(language: Language, words: string) {
  const wanted = CASES[language];
  const model = citingModel({
    query: wanted.query,
    records: (passages) => [
      {
        marker: 1,
        passage: passages.find((each) => each.text.includes(wanted.quote.slice(0, 6)))?.id,
        pageFrom: 2,
        pageTo: 2,
        quote: wanted.quote,
      },
    ],
    answer: wanted.sentence(words),
  });
  const { core, documents } = await setUpWithDocuments(model, [
    { name: wanted.name, contents: wanted.pdf },
  ]);
  const result = await core.askInConversation({ text: wanted.question });
  if (!result.asked) throw new Error("Not asked.");
  await answerEnded(core, result.answerId);
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((each) => each.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return { core, answer, question: wanted.question, document: documents[0] };
}

function citationsOf(blocks: readonly NodeJSON[]): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (node: NodeJSON) => {
    if (node.type === "citation") found.push(node.attrs ?? {});
    for (const child of node.content ?? []) visit(child);
  };
  for (const block of blocks) visit(block);
  return found;
}

async function citationsInMind(core: Core, mindId: string) {
  const found: Record<string, unknown>[] = [];
  readMind(await connectToMind(core, mindId)).descendants((node) => {
    if (node.type.name === "citation") found.push(node.attrs);
  });
  return found;
}

const intoMind = async (
  core: Core,
  answer: ConversationAnswer,
  question: string,
  title: string,
) => {
  const mind = await core.createMind({ title });
  await core.addToNote({
    mindId: mind.id,
    blocks: answerBlocks(answer),
    origin: { from: messageReference(answer.conversationId, answer.id), question },
    model: answer.model,
  });
  return citationsInMind(core, mind.id);
};

/** The three ways an Answer lands in a Note, as the assistant's Add to note and New note do them. */
const LANDINGS = {
  "Add to note": (core: Core, answer: ConversationAnswer, question: string) =>
    intoMind(core, answer, question, "Tides"),
  "New note": (core: Core, answer: ConversationAnswer, question: string) =>
    intoMind(core, answer, question, ""),
  "the open Note": async (core: Core, answer: ConversationAnswer) =>
    citationsOf(
      await recheckCitations(answerBlocks(answer), (input) =>
        core.recheckCitation({ ...input, mindId: null }),
      ),
    ),
} as const;

const words = (attributes: Record<string, unknown>) =>
  parseQuotedWords(attributes.quotedWords)
    ?.answer.map((piece) => piece.text)
    .join("");

const asked = (text: string) => ({ answer: [{ text, found: false }], closest: null });

async function rewrite(
  core: Core,
  document: { id: string; path?: string | null },
  pdf: Uint8Array,
) {
  if (!document.path) throw new Error("No Document.");
  await writeFile(document.path, pdf);
  await core.reconcileDocuments();
  await waitForProcessing(core, [document.id]);
}

describe.each(Object.keys(CASES) as Language[])(
  "An Answer's Citation landing in a Note (%s)",
  (language) => {
    // protects=a Citation not found because the Answer's quoted words aren't on its page stays not found, with those words for its card, wherever the Answer lands in a Note (#2612); fails_when=the landing checks the quote alone and reads it found; no_claim=Citations found before, the test below.
    test.each(Object.keys(LANDINGS) as (keyof typeof LANDINGS)[])(
      "quoted words the page doesn't have: still not found through %s",
      async (landing) => {
        const { core, answer, question } = await answerQuoting(language, CASES[language].madeUp);
        expect(answer.citations).toEqual([
          expect.objectContaining({ check: "not-found", checkReason: "quoted-words-not-on-pages" }),
        ]);

        const [landed] = await LANDINGS[landing](core, answer, question);
        expect(landed).toMatchObject({
          check: "not-found",
          checkReason: "quoted-words-not-on-pages",
        });
        expect(words(landed ?? {})).toBe(CASES[language].madeUp);
      },
    );

    // protects=the quoted words go with the landing check only to keep a not-found, so a Citation whose quoted words are on its page lands found, as before (#2612); fails_when=the landing check reads every Citation with quoted words as not found; no_claim=none beyond protects.
    test.each(Object.keys(LANDINGS) as (keyof typeof LANDINGS)[])(
      "quoted words the page has: found through %s, as before",
      async (landing) => {
        const { core, answer, question } = await answerQuoting(language, CASES[language].onPage);
        expect(answer.citations).toEqual([expect.objectContaining({ check: "found" })]);

        const [landed] = await LANDINGS[landing](core, answer, question);
        expect(landed).toMatchObject({ check: "found", checkReason: null });
      },
    );
  },
);

// protects=the core's recheck takes the words a Citation couldn't find with its quote (#2612): not on the cited page, not found, though another page of the Document has them; on it, found; fails_when=the recheck reads the quote alone, looks for the words outside the cited Units, or never lets the words be found; no_claim=which version a landing checks, ADR-0017's amendment.
test("checked again with the words the Answer quoted, a Citation is found only where its page has them", async () => {
  const { core, answer } = await answerQuoting("en", CASES.en.madeUp);
  const [citation] = answer.citations;
  if (!citation) throw new Error("No Citation.");
  const input = {
    documentId: citation.documentId,
    quote: citation.quote,
    pageFrom: citation.pageFrom,
    pageTo: citation.pageTo,
    contentHash: citation.contentHash,
    mindId: null,
  };

  expect(
    await core.recheckCitation({ ...input, quotedWords: asked(CASES.en.madeUp) }),
  ).toMatchObject({
    check: "not-found",
    checkReason: "quoted-words-not-on-pages",
  });
  expect(
    await core.recheckCitation({ ...input, quotedWords: asked(CASES.en.otherPage) }),
  ).toMatchObject({
    check: "not-found",
    checkReason: "quoted-words-not-on-pages",
  });
  expect(
    await core.recheckCitation({ ...input, quotedWords: asked(CASES.en.onPage) }),
  ).toMatchObject({
    check: "found",
    checkReason: null,
  });
});

// protects=after its Document changed, a landing checks a Citation in the version it quotes (ADR-0017's amendment), and the words the Answer quoted are looked for there too (#2612): not found when that version lacks them, found when it has them; fails_when=the quoted version's check reads the quote alone, or never lets the words be found; no_claim=none beyond protects.
test("after its Document changed, a Citation not found for its quoted words lands not found", async () => {
  const { core, answer, question, document } = await answerQuoting("en", CASES.en.madeUp);
  if (!document) throw new Error("No Document.");
  await rewrite(
    core,
    document,
    buildPdf([
      { lines: ["Tides and the Moon", "The Moon raises two tidal bulges on the Earth."] },
      { lines: ["Spring and neap tides", CASES.en.quote, "Neap tides come at the quarter moons."] },
    ]),
  );

  const [landed] = await LANDINGS["Add to note"](core, answer, question);
  expect(landed).toMatchObject({ check: "not-found", checkReason: "quoted-words-not-on-pages" });

  const [citation] = answer.citations;
  if (!citation) throw new Error("No Citation.");
  expect(
    await core.recheckCitation({
      documentId: citation.documentId,
      quote: citation.quote,
      pageFrom: citation.pageFrom,
      pageTo: citation.pageTo,
      contentHash: citation.contentHash,
      quotedWords: asked(CASES.en.onPage),
      mindId: null,
    }),
  ).toMatchObject({ inQuotedVersion: { check: "found", checkReason: null } });
});

describe.each(Object.keys(CASES) as Language[])(
  "Update the sentence… once the cited words changed (%s)",
  (language) => {
    const wanted = CASES[language];
    /** The landed Citation of an Answer quoting `quoted`, updated to the Document's changed words as its card does it, whose check sends no quoted words. */
    const updated = async (quoted: string) => {
      const { core, answer, question, document } = await answerQuoting(language, quoted);
      if (!document) throw new Error("No Document.");
      const [landed] = await LANDINGS["Add to note"](core, answer, question);
      expect(landed).toMatchObject({
        check: "not-found",
        checkReason: "quoted-words-not-on-pages",
      });
      await rewrite(core, document, wanted.changed);
      const cited = {
        ...citationAttributesOf(landed ?? {}),
        quotedWords: parseQuotedWordsCheck(landed?.quotedWords),
      };
      const recheck = checkedResult(
        await core.recheckCitation({
          documentId: document.id,
          quote: cited.quote ?? "",
          pageFrom: cited.pageFrom ?? null,
          pageTo: cited.pageTo ?? null,
          contentHash: cited.contentHash ?? null,
          mindId: null,
        }),
      );
      expect(recheck.changed?.now).toMatchObject({ quote: wanted.changedQuote, check: "found" });
      return newVersionCitation(cited, recheck);
    };

    // protects=Update the sentence… cites the words the Document changed to, but the sentence keeps the words it quoted until it is rewritten, and the rewrite can fail or be refused: a Citation not found for them stays not found, with them for its card (#2612); fails_when=the update reads found, or drops the words; no_claim=the rewrite through Edit with AI.
    test("words the changed page doesn't have either: still not found, with them", async () => {
      const update = await updated(wanted.madeUp);
      expect(update).toMatchObject({
        quote: wanted.changedQuote,
        check: "not-found",
        checkReason: "quoted-words-not-on-pages",
        quotedWords: { closest: null },
      });
      expect(words(update ?? {})).toBe(wanted.madeUp);
    });

    // protects=the positive beside it: words the Answer quoted that the Document changed to are in the quote the Citation now cites, so it reads found (#2612); fails_when=every update of a Citation with words not found reads not found; no_claim=none beyond protects.
    test("the words the page changed to: found", async () => {
      expect(await updated(wanted.changedTo)).toMatchObject({
        quote: wanted.changedQuote,
        check: "found",
        checkReason: null,
        quotedWords: null,
      });
    });
  },
);
