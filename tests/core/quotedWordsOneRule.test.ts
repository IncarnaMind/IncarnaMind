/**
 * Words a sentence puts in quotation marks are judged by one rule wherever its Citation is
 * checked (#2712): the same quote and pages give the same verdict through the Answer, the
 * assistant writing into a Note, a landing in a Note, Recheck, Edit with AI, Update the
 * sentence…, Replace and "already cited", in English and Chinese.
 */
import { writeFile } from "node:fs/promises";
import { type Editor, getSchema, type JSONContent } from "@tiptap/core";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import type { CitationAttributes, CitationToRecheck, QuotedWords } from "../../src/core/api";
import { citationDecision } from "../../src/renderer/src/editor/alreadyCited";
import {
  citationNumbersPlugin,
  numberedCitations,
} from "../../src/renderer/src/editor/citationNumbers";
import type { ShownClaim } from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  newVersionCitation,
  type QuotedWordsOnPage,
  quotedWordsOnPage,
} from "../../src/shared/citations";
import { askAssistant, changesIn } from "../helpers/assistant";
import { checkReply, isCheckRun } from "../helpers/checks";
import {
  checkedResult,
  mindCitations,
  type ShownPassage,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { waitForProcessing } from "../helpers/documents";
import { wholeParagraph } from "../helpers/editing";
import { connectToMind } from "../helpers/mindClient";
import { resolveChanges, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";
import { buildPdf, type PdfPage } from "../helpers/pdf";

vi.mock("../../src/renderer/src/core", () => ({ core: {} }));
vi.mock("../../src/renderer/src/editWithAi", () => ({ resolveProposalsIn: vi.fn() }));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: vi.fn() }));

const { replaceCitation } = await import("../../src/renderer/src/checks");

interface Case {
  name: string;
  pages: PdfPage[];
  /** The next version: the Citation's quote changed by a word, the quoted words where they were. */
  changed: PdfPage[];
  query: string;
  question: string;
  /** The page the Citation cites and its quote, which is on it. */
  page: number;
  quote: string;
  changedQuote: string;
  /** The sentence, its marker where the Citation is. */
  sentence(words: string): string;
  /** Words the cited page holds by the rule, and words it doesn't. */
  onPage: string;
  notOnPage: string;
}

const CASES: Record<string, Record<"en" | "zh", Case>> = {
  "words that run on to the next page": {
    en: {
      name: "Board minutes.pdf",
      pages: [
        { lines: ["Board minutes", "Members agreed that the committee will meet on"] },
        {
          lines: ["the first Monday of each month from January.", "The chair closed the meeting."],
        },
      ],
      changed: [
        { lines: ["Board minutes", "Members voted that the committee will meet on"] },
        {
          lines: ["the first Monday of each month from January.", "The chair closed the meeting."],
        },
      ],
      query: "committee meet monthly",
      question: "When will the committee meet?",
      page: 1,
      quote: "Members agreed that the committee will meet on",
      changedQuote: "Members voted that the committee will meet on",
      sentence: (words) => `The minutes say “${words}” [^1].`,
      onPage: "the committee will meet on the first Monday of each month",
      notOnPage: "the committee will meet on the first Friday of each month",
    },
    zh: {
      name: "董事会纪要.pdf",
      pages: [
        { chineseLines: ["董事会会议纪要", "成员同意委员会将于每月的"] },
        { chineseLines: ["第一个星期一举行会议，自一月起。", "主席宣布会议结束。"] },
      ],
      changed: [
        { chineseLines: ["董事会会议纪要", "成员一致同意委员会将于每月的"] },
        { chineseLines: ["第一个星期一举行会议，自一月起。", "主席宣布会议结束。"] },
      ],
      query: "委员会 会议",
      question: "委员会什么时候开会？",
      page: 1,
      quote: "成员同意委员会将于每月的",
      changedQuote: "成员一致同意委员会将于每月的",
      sentence: (words) => `纪要写道“${words}”[^1]。`,
      onPage: "委员会将于每月的第一个星期一举行会议",
      notOnPage: "委员会将于每月的第一个星期五举行会议",
    },
  },
  "words elsewhere on the cited page than its quote": {
    en: {
      name: "Budget.pdf",
      pages: [
        { lines: ["Budget 2027"] },
        { lines: ["Summary of the year"] },
        {
          lines: [
            "The committee approved the budget on 4 May.",
            "Spending will rise by a third next year.",
          ],
        },
      ],
      changed: [
        { lines: ["Budget 2027"] },
        { lines: ["Summary of the year"] },
        {
          lines: [
            "The committee approved the budget on 5 May.",
            "Spending will rise by a third next year.",
          ],
        },
      ],
      query: "budget spending",
      question: "What did the committee decide?",
      page: 3,
      quote: "The committee approved the budget on 4 May.",
      changedQuote: "The committee approved the budget on 5 May.",
      sentence: (words) => `The budget says “${words}” [^1].`,
      onPage: "Spending will rise by a third next year",
      notOnPage: "Spending will rise by a half next year",
    },
    zh: {
      name: "预算.pdf",
      pages: [
        { chineseLines: ["二〇二七年预算"] },
        { chineseLines: ["年度摘要"] },
        { chineseLines: ["委员会于5月4日批准了预算。", "明年支出将增加三分之一。"] },
      ],
      changed: [
        { chineseLines: ["二〇二七年预算"] },
        { chineseLines: ["年度摘要"] },
        { chineseLines: ["委员会于5月5日批准了预算。", "明年支出将增加三分之一。"] },
      ],
      query: "预算 支出",
      question: "委员会决定了什么？",
      page: 3,
      quote: "委员会于5月4日批准了预算。",
      changedQuote: "委员会于5月5日批准了预算。",
      sentence: (words) => `预算写道“${words}”[^1]。`,
      onPage: "明年支出将增加三分之一",
      notOnPage: "明年支出将增加一半",
    },
  },
  "words before an abbreviation, or a full stop inside the quotation marks": {
    en: {
      name: "Fee schedule.pdf",
      pages: [
        { lines: ["Fee schedule", "The fee is 3% per week after the grace period of ten days."] },
      ],
      changed: [
        {
          lines: ["Fee schedule", "The fee is 3% per week after the grace period of twelve days."],
        },
      ],
      query: "fee per week grace period",
      question: "What does the schedule say?",
      page: 1,
      quote: "after the grace period of ten days",
      changedQuote: "after the grace period of twelve days",
      sentence: (words) => `The schedule says "${words}," said Mr. Smith[^1].`,
      onPage: "The fee is 3% per week",
      notOnPage: "The fee is 5% per week",
    },
    zh: {
      name: "收费表.pdf",
      pages: [{ chineseLines: ["收费表", "逾期每周收取3%的费用，宽限期为十天。"] }],
      changed: [{ chineseLines: ["收费表", "逾期每周收取3%的费用，宽限期为十二天。"] }],
      query: "费用 宽限期",
      question: "收费表怎么写？",
      page: 1,
      quote: "宽限期为十天",
      changedQuote: "宽限期为十二天",
      sentence: (words) => `收费表写道“${words}。”史密斯先生如是说[^1]。`,
      onPage: "逾期每周收取3%的费用",
      notOnPage: "逾期每周收取5%的费用",
    },
  },
  "words the Document holds or doesn't": {
    en: {
      name: "Tides.pdf",
      pages: [
        {
          lines: ["Tides and the Moon", "The Moon's gravity raises two tidal bulges on the Earth."],
        },
        {
          lines: [
            "Spring and neap tides",
            "Spring tides happen just after a new moon or a full moon.",
          ],
        },
      ],
      changed: [
        {
          lines: ["Tides and the Moon", "The Moon's gravity raises two tidal bulges on the Earth."],
        },
        {
          lines: [
            "Spring and neap tides",
            "Spring tides come just after a new moon or a full moon.",
          ],
        },
      ],
      query: "spring tides",
      question: "When are spring tides?",
      page: 2,
      quote: "Spring tides happen just after a new moon or a full moon.",
      changedQuote: "Spring tides come just after a new moon or a full moon.",
      sentence: (words) => `The guide says “${words}” [^1].`,
      onPage: "just after a new moon or a full moon",
      notOnPage: "spring tides happen only at a full moon",
    },
    zh: {
      name: "潮汐.pdf",
      pages: [
        { chineseLines: ["潮汐与月球", "月球的引力在地球上形成两个潮汐隆起。"] },
        { chineseLines: ["大潮与小潮", "大潮出现在新月或满月之后不久。"] },
      ],
      changed: [
        { chineseLines: ["潮汐与月球", "月球的引力在地球上形成两个潮汐隆起。"] },
        { chineseLines: ["大潮与小潮", "大潮发生在新月或满月之后不久。"] },
      ],
      query: "大潮",
      question: "大潮在什么时候出现？",
      page: 2,
      quote: "大潮出现在新月或满月之后不久。",
      changedQuote: "大潮发生在新月或满月之后不久。",
      sentence: (words) => `指南写道“${words}”[^1]。`,
      onPage: "在新月或满月之后不久",
      notOnPage: "大潮只在满月时出现",
    },
  },
};

const WRITE = { en: "Write this into a new note.", zh: "把这写进一篇新笔记。" } as const;
const SHORTER = { en: "In short: ", zh: "简言之：" } as const;

/**
 * One model for every path: it answers by searching, citing the page and writing `sentence`;
 * asked to write a note, it writes the sentence into a new one; asked to edit, it keeps the
 * passage's words and its Citation.
 */
function modelFor(wanted: Case, language: "en" | "zh", sentence: string) {
  const records = (passages: ShownPassage[]) => [
    {
      marker: 1,
      passage: passages[0]?.id,
      pageFrom: wanted.page,
      pageTo: wanted.page,
      quote: wanted.quote,
    },
  ];
  return scriptedModel(
    (call: ModelCall): ScriptedReply => {
      if (isCheckRun(call)) return checkReply(call, {});
      const edited = /<passage>\n([\s\S]*?)\n<\/passage>/.exec(call.prompt);
      if (call.prompt.includes("<task action=") && edited) {
        return { text: `${SHORTER[language]}${edited[1]}` };
      }
      if (!call.tools.includes("search_documents")) return { text: "No Tools were offered." };
      const search = call.results.filter((result) => result.tool === "search_documents").at(-1);
      if (!search) return { calls: [{ tool: "search_documents", input: { query: wanted.query } }] };
      const cite = { tool: "cite", input: { citations: records(shownPassages(search.text)) } };
      if (call.prompt.includes(WRITE[language])) {
        if (call.results.some((result) => result.tool === "create_mind")) return { text: "Done." };
        const write = { tool: "create_mind", input: { title: "Notes", content: sentence } };
        return { calls: [cite, write] };
      }
      if (!call.results.some((result) => result.tool === "cite")) return { calls: [cite] };
      return { text: sentence };
    },
    { judgesItsAnswers: true },
  );
}

const asked = (words: string): QuotedWords => ({
  answer: [{ text: words, found: false }],
  closest: null,
});

/** The sentence as a Note holds it: its words, and the Citation where its marker is. */
function paragraph(sentence: string, citation: CitationAttributes, id?: string): JSONContent {
  const [before = "", after = ""] = sentence.split("[^1]");
  return {
    type: "paragraph",
    ...(id && { attrs: { id } }),
    content: [
      { type: "text", text: before },
      { type: "citation", attrs: citation },
      ...(after ? [{ type: "text", text: after }] : []),
    ],
  };
}

const schema = getSchema(noteExtensions());

/** An editor holding the sentence, and the card of its check, which found the Citation's page. */
function cardOf(sentence: string, citation: CitationAttributes) {
  let state = EditorState.create({
    doc: schema.nodeFromJSON({ type: "doc", content: [paragraph(sentence, citation)] }),
    plugins: [citationNumbersPlugin()],
  });
  const editor = {
    get state() {
      return state;
    },
    view: {
      dispatch(tr: Transaction) {
        state = state.apply(tr);
      },
    },
  } as unknown as Editor;
  const text = state.doc.textContent;
  const evidence = { ...citation, check: "found", checkReason: null, quotedWords: null } as const;
  const claim = {
    check: { id: "check-1", state: "supported", evidence, calculation: null },
    from: 1,
    to: 1 + text.length + 1,
    sentence: { from: 1, to: 1 + text.length + 1, text },
    shown: { state: "supported" },
  } as unknown as ShownClaim;
  return { editor, claim, evidence };
}

const checkOf = (citations: readonly { check: string }[]) => citations[0]?.check;

async function rewrite(
  core: Core,
  document: { id: string; path?: string | null },
  pages: PdfPage[],
) {
  if (!document.path) throw new Error("No Document.");
  await writeFile(document.path, buildPdf(pages));
  await core.reconcileDocuments();
  await waitForProcessing(core, [document.id]);
}

/** The verdict of each path on the sentence quoting `words`. */
async function verdicts(wanted: Case, language: "en" | "zh", words: string) {
  const sentence = wanted.sentence(words);
  const { core, documents, mind } = await setUpWithDocuments(modelFor(wanted, language, sentence), [
    { name: wanted.name, contents: buildPdf(wanted.pages) },
  ]);
  const [document] = documents;
  if (!document) throw new Error("No Document.");
  const found: Record<string, string | undefined> = {};

  const answer = await askAssistant(core, { text: wanted.question });
  found["the Answer"] = checkOf(answer.citations);
  const [made] = changesIn(
    await askAssistant(core, { text: `${wanted.question} ${WRITE[language]}`, mindId: mind.id }),
  );
  found["the assistant writing into a Note"] = checkOf(
    mindCitations(await connectToMind(core, made?.mindId ?? "")),
  );

  // The Citation as an earlier check left it: not found for the words its sentence quoted.
  const [citation] = answer.citations;
  if (!citation) throw new Error("No Citation.");
  const cited: CitationAttributes = {
    passageId: citation.passageId,
    documentId: citation.documentId,
    documentName: citation.documentName,
    contentHash: citation.contentHash,
    pageFrom: citation.pageFrom,
    pageTo: citation.pageTo,
    location: citation.location,
    quote: citation.quote,
    check: "not-found",
    checkReason: "quoted-words-not-on-pages",
    quotedWords: asked(words),
  };
  const recheck = (input: CitationToRecheck) => core.recheckCitation({ ...input, mindId: null });
  const again: CitationToRecheck = {
    documentId: citation.documentId,
    quote: citation.quote,
    pageFrom: citation.pageFrom,
    pageTo: citation.pageTo,
    location: citation.location,
    contentHash: citation.contentHash,
  };

  const landing = await core.createMind({ title: "Landing" });
  await core.addToNote({
    mindId: landing.id,
    blocks: [paragraph(sentence, cited)],
    origin: null,
    model: null,
  });
  found["a landing in a Note"] = checkOf(mindCitations(await connectToMind(core, landing.id)));

  found.Recheck = checkedResult(await recheck({ ...again, quotedWords: asked(words) })).check;

  const edited = await core.createMind({ title: "Edited" });
  const client = await connectToMind(core, edited.id);
  writeMind(client, [paragraph(sentence, cited, "quoted")]);
  await client.settled();
  expect(
    await core.editWithAi(wholeParagraph(client, edited.id, "quoted", "shorten")),
  ).toMatchObject({ kind: "proposed" });
  await resolveChanges(client, "accept");
  found["Edit with AI"] = checkOf(mindCitations(client));

  const card = cardOf(sentence, cited);
  const verdict = await quotedWordsOnPage(recheck, card.evidence, asked(words));
  const onPage: QuotedWordsOnPage = () => verdict;
  const decision = citationDecision(card.editor.state, card.claim, onPage);
  found['"already cited"'] = { replace: "found", already: "not-found" }[decision.kind as string];
  const [numbered] = numberedCitations(card.editor.state);
  if (!numbered) throw new Error("No Citation in the card's sentence.");
  replaceCitation(card.editor, { citation: numbered, evidence: card.evidence }, onPage);
  found.Replace = checkOf(numberedCitations(card.editor.state).map((each) => each.attributes));

  await rewrite(core, document, wanted.changed);
  const looked = checkedResult(await recheck(again));
  expect(looked.changed?.now).toMatchObject({ quote: wanted.changedQuote, check: "found" });
  const target = newVersionCitation(cited, looked);
  const updated = await quotedWordsOnPage(
    recheck,
    { ...target, documentId: cited.documentId },
    asked(words),
  );
  found["Update the sentence…"] = newVersionCitation(cited, looked, () => updated)?.check;
  return found;
}

const PATHS = [
  "the Answer",
  "the assistant writing into a Note",
  "a landing in a Note",
  "Recheck",
  "Edit with AI",
  "Update the sentence…",
  "Replace",
  '"already cited"',
] as const;

const every = (check: "found" | "not-found") =>
  Object.fromEntries(PATHS.map((path) => [path, check]));

describe.each(Object.keys(CASES))("%s", { timeout: 60_000 }, (name) => {
  describe.each(["en", "zh"] as const)("(%s)", (language) => {
    const wanted = CASES[name]?.[language] as Case;

    // protects=words the cited page holds by the Answer's rule read found through every path that checks the Citation (#2712); fails_when=a path reads them on the quote alone, or the cited Units alone, and calls them not found; no_claim=how the card words it.
    test("words the page holds: found everywhere", async () => {
      expect(await verdicts(wanted, language, wanted.onPage)).toEqual(every("found"));
    });

    // protects=the negative beside it: words the cited page doesn't hold read not found through every path, the assistant's writing into a Note included (#2712); fails_when=a path reads them found, or never checks them; no_claim=none beyond protects.
    test("words it doesn't hold: not found everywhere", async () => {
      expect(await verdicts(wanted, language, wanted.notOnPage)).toEqual(every("not-found"));
    });
  });
});
