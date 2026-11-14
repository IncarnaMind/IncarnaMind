/**
 * A Note that cites an example Document keeps reading it once the User has a Document of their own
 * (#3083, beside #1942): its checks, its Answers and the assistant in it. And a check never judges
 * a sentence for want of a cited Document its Note's Search scope leaves out: it names the Document
 * and sends nothing for it; a wall keeps its own reason.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import type { Core, Document, SearchScope } from "../../src/core";
import type { Language } from "../../src/core/language";
import { reasonText } from "../../src/renderer/src/cost";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { translate } from "../../src/shared/i18n";
import { setMindScope } from "../../src/shared/mindScope";
import { askAssistant } from "../helpers/assistant";
import {
  checkGenerate,
  isCheckRun,
  type Plan,
  requestedFigures,
  SAME_DETAIL,
  sentenceOf,
  unsupportedReply,
} from "../helpers/checks";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { editMind, question, readMind, writeMind } from "../helpers/minds";
import {
  type GenerateCall,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

const EXAMPLES = resolve(__dirname, "../../resources/examples");

const SETS = {
  en: {
    report: "Northwind Retail · Q3 2026 results",
    ebitda: "Underlying EBITDA was £96 million, against £118 million a year earlier.",
    revenue: "Revenue was £1,284 million, up 4.2% year on year.",
    revenueQuote: "Group revenue was £1,284 million, up 4.2% on the third quarter of 2025.",
    own: "Harbour Foods board pack",
    ownLine: "Harbour Foods sells through its own shops and online.",
    ownEbitda: "Harbour Foods’ underlying EBITDA was £12 million in 2025.",
    onlyOnline: "Harbour Foods sells only online.",
    says: "The board pack says it sells through its own shops and online.",
    revenueOwn: "Revenue at Harbour Foods was £200 million in 2025.",
    depot: "Harbour Foods plans a new depot in Leeds.",
    query: "underlying EBITDA",
  },
  "zh-CN": {
    report: "Northwind Retail · 2026 年第三季度业绩",
    ebitda: "基础 EBITDA 为 9,600 万英镑，上年同期为 1.18 亿英镑。",
    revenue: "集团收入为 12.84 亿英镑，同比增长 4.2%。",
    revenueQuote: "集团收入为 12.84 亿英镑，同比增长 4.2%。",
    own: "海港食品董事会资料",
    ownLine: "海港食品通过自有门店和线上渠道销售。",
    ownEbitda: "海港食品 2025 年的基础 EBITDA 为 1,200 万英镑。",
    onlyOnline: "海港食品只在线上销售。",
    says: "董事会资料写的是它通过自有门店和线上渠道销售。",
    revenueOwn: "海港食品 2025 年的收入为 2 亿英镑。",
    depot: "海港食品计划在利兹新建一个仓库。",
    query: "基础 EBITDA",
  },
} as const;

const text = (value: string): JSONContent => ({ type: "text", text: value });
const documentsScope = (...documentIds: string[]): SearchScope => ({
  folderIds: [],
  tagIds: [],
  documentIds,
});

/**
 * A check Run that searches with its sentence, cites the shown Passage holding its plan's quote and
 * gives the plan's verdict, each figure bound to the same words in that quote; with no such Passage
 * shown, Unsupported.
 */
function checking(plans: Record<string, Plan>, call: ModelCall): ScriptedReply {
  const claim = sentenceOf(call);
  const plan = plans[claim];
  const searches = call.results.filter((result) => result.tool === "search_documents");
  if (searches.length === 0)
    return { calls: [{ tool: "search_documents", input: { query: claim } }] };
  const shown = [
    ...searches.flatMap((each) => shownPassages(each.text)),
    ...shownPassages(call.prompt),
  ];
  const quote = plan?.quote;
  const holding = quote ? shown.find((each) => each.text.includes(quote)) : undefined;
  if (!plan || !quote || !holding || plan.verdict === "unsupported")
    return { text: unsupportedReply(call) };
  if (!call.results.some((result) => result.tool === "cite"))
    return {
      calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage: holding.id, quote }] } }],
    };
  const lines = `Verdict: ${plan.verdict}\nAbsence: no\n${SAME_DETAIL}${plan.says ? `\n${plan.says} [^1]` : ""}`;
  const figures = requestedFigures(call);
  if (figures.length === 0) return { text: lines };
  const items = figures.map(({ id, shown: chars, reading }) => ({
    id,
    verdict: plan.verdict,
    scope: "same",
    topic: "found",
    roles: "same",
    says: null,
    reading,
    relation: "equals",
    source: { citation: 1, number: chars },
    measure: null,
    calculation: null,
  }));
  return { text: `${lines}\nFigures: ${JSON.stringify({ items, remainder: null })}` };
}

/**
 * Answers search with `query` once, then end, and a Question's search is rewritten to `query`;
 * every request, streamed or not, is kept.
 */
function modelFor(plans: Record<string, Plan>, query: string) {
  const calls: ModelCall[] = [];
  const generated: GenerateCall[] = [];
  const judge = checkGenerate(plans);
  const generate = (call: GenerateCall) =>
    call.question === undefined ? { text: query } : judge(call);
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      if (isCheckRun(call)) return checking(plans, call);
      if (call.tools.includes("search_documents") && call.results.length === 0)
        return { calls: [{ tool: "search_documents", input: { query } }] };
      return { text: "Done." };
    },
    {
      generate: (call) => {
        generated.push(call);
        return generate(call);
      },
    },
  );
  return { model, calls, generated };
}

async function examplesReady(core: Core): Promise<Document[]> {
  const examples = await core.getExamples();
  return vi.waitFor(
    async () => {
      const read = await core.listDocuments({ linkedFolderId: examples.linkedFolderId ?? "" });
      expect(read.length).toBe(2);
      expect(read.every((each) => each.status === "ready")).toBe(true);
      return read;
    },
    { timeout: 30_000 },
  );
}

/** The shipped credit example in `language`, and one Document of the User's own beside it. */
async function setUp(language: Language) {
  const words = SETS[language];
  const plans: Record<string, Plan> = {
    [words.ebitda]: { verdict: "supported", quote: words.ebitda },
    [words.revenue]: { verdict: "supported", quote: words.revenueQuote },
    [words.ownLine]: { verdict: "supported", quote: words.ownLine },
    [words.onlyOnline]: { verdict: "contradicted", quote: words.ownLine, says: words.says },
    [words.revenueOwn]: { verdict: "unsupported" },
    [words.depot]: { verdict: "unsupported" },
  };
  const { model, calls, generated } = modelFor(plans, words.query);
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    paths: { dataDir, examples: EXAMPLES },
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.updateSettings({ user: { language } });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  await core.createExamples();
  const examples = await examplesReady(core);
  const report = examples.find((each) => each.name === words.report);
  if (!report) throw new Error("The example's Q3 report isn't there.");
  const sources = await createSourceFolder();
  const [own] = await addAndProcess(core, [
    await writeSourceFile(
      sources,
      `${words.own}.md`,
      `# ${words.own}\n\n${words.ownLine}\n\n${words.ownEbitda}\n`,
    ),
  ]);
  if (!own) throw new Error("The User's Document wasn't added.");
  return { core, words, report, own, calls, generated, language };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

/** A Citation of `line` in `document`, made as the viewer makes one from selected words. */
async function cite(setup: Setup, document: Document, line: string, unit: number | null) {
  const selected = await setup.core.citeSelection({
    documentId: document.id,
    parts: [{ unit, text: line }],
  });
  return {
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
  } satisfies JSONContent;
}

const citesReport = (setup: Setup) => cite(setup, setup.report, setup.words.ebitda, 1);
const citesOwn = (setup: Setup) => cite(setup, setup.own, setup.words.ownLine, null);

/** A new Note of the User's, one paragraph per line, each line followed by its Citations. */
async function noteWith(setup: Setup, lines: readonly (readonly [string, ...JSONContent[]])[]) {
  const mind = await setup.core.createMind({ title: "Summary of my documents" });
  const client = await connectToMind(setup.core, mind.id);
  writeMind(
    client,
    lines.map(([line, ...citations], index) => ({
      type: "paragraph",
      attrs: { id: `line-${index}` },
      content: [text(line), ...citations],
    })),
  );
  await client.settled();
  return { mindId: mind.id, client };
}

/** Asks a Question at the end of the Note, as the User adds one under what they wrote. */
async function askInNote(setup: Setup, { mindId, client }: { mindId: string; client: MindClient }) {
  const asked = question("What was EBITDA?");
  editMind(client, (blocks) => [...blocks, asked]);
  await client.settled();
  const result = await setup.core.askQuestion({ mindId, questionId: asked.attrs.id });
  if (!result.asked) throw new Error("The Question wasn't asked.");
  expect((await answerEnded(setup.core, result.answerId)).event).toBe("finished");
}

async function checkNote(setup: Setup, mindId: string, client: MindClient) {
  const run = await setup.core.checkMind({ requestId: randomUUID(), mindId, mode: "all" });
  expect(run).toMatchObject({ kind: "checked" });
  await client.settled();
}

/** Each sentence's result as its card shows it: its state, and its reason line in the language. */
function cards(client: MindClient, language: Language) {
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(language, key, params);
  return new Map(
    claimSpans(readMind(client)).map(({ sentence, check }) => [
      sentence.text,
      {
        state: check.state,
        line:
          check.state === "not-checked" && check.reason
            ? reasonText(t, language, check.reason, check.detail)
            : null,
      },
    ]),
  );
}

/** The Documents whose Passages a check Run of `sentence`, or any Run when null, was shown. */
const shownTo = (calls: readonly ModelCall[], sentence: string | null = null) =>
  new Set(
    calls
      .filter((call) => isCheckRun(call) && (sentence === null || sentenceOf(call) === sentence))
      .flatMap((call) =>
        [call.prompt, ...call.results.map((result) => result.text)].flatMap((each) =>
          shownPassages(each).map((passage) => passage.document),
        ),
      ),
  );

/** The Documents an Answer's own searches returned. */
const searchedBy = (calls: readonly ModelCall[]) =>
  new Set(
    calls
      .filter((call) => !isCheckRun(call))
      .flatMap((call) =>
        call.results
          .filter((result) => result.tool === "search_documents")
          .flatMap((result) => shownPassages(result.text).map((passage) => passage.document)),
      ),
  );

const outsideLine = (language: Language, name: string) =>
  translate(language, "claim.reason.outside-scope", { detail: name });

describe.each(["en", "zh-CN"] as const)("a Note citing an example Document (%s)", (language) => {
  // protects=with the example and one Document of the User's own, a new Note's sentence that is the cited example's own words reads Supported, and so does the uncited one beside it (#3083); fails_when=the cited example is left out of the Note's checks and the sentence reads Unsupported or Not found; no_claim=how a real model words its verdict.
  test("keeps reading it: the cited sentence and the one beside it read Supported", async () => {
    const setup = await setUp(language);
    const { words } = setup;
    const { mindId, client } = await noteWith(setup, [
      [words.ebitda, await citesReport(setup)],
      [words.revenue],
    ]);

    await checkNote(setup, mindId, client);

    const shown = cards(client, language);
    expect(shown.get(words.ebitda)).toEqual({ state: "supported", line: null });
    expect(shown.get(words.revenue)).toEqual({ state: "supported", line: null });
    expect(shownTo(setup.calls, words.revenue)).toContain(words.report);
    // The Library's count and its default scope stay the User's own (#1942).
    expect(await setup.core.countScopeDocuments(undefined)).toBe(1);
    setup.core.close();
  });

  // protects=in the same state, a Note that cites no example Document still finds nothing in the examples, and finds the User's own Document (#1942); fails_when=every Note reaches the examples once one Note cites them; no_claim=Organize and the Library's own tests (#1942's).
  test("a Note that cites none still finds nothing in the examples, and its own Document", async () => {
    const setup = await setUp(language);
    const { words } = setup;
    await noteWith(setup, [[words.ebitda, await citesReport(setup)]]);
    const other = await noteWith(setup, [[words.revenue], [words.ownLine]]);

    await checkNote(setup, other.mindId, other.client);

    const shown = cards(other.client, language);
    expect(shown.get(words.ownLine)).toEqual({ state: "supported", line: null });
    expect(shown.get(words.revenue)?.state).toBe("unsupported");
    expect(shownTo(setup.calls)).toContain(words.own);
    expect(shownTo(setup.calls)).not.toContain(words.report);
    setup.core.close();
  });

  // protects=an Answer and the assistant in a Note that cites an example Document read that Document, beside the User's own; in a Note that cites none they read only the User's own (#3083, #1942); fails_when=Answers and checks of the same Note disagree on what it may read, or every Note reaches the examples; no_claim=what the model writes.
  test("its Answers and the assistant in it can read it; another Note's can't", async () => {
    const setup = await setUp(language);
    const { words } = setup;
    const citing = await noteWith(setup, [[words.ebitda, await citesReport(setup)]]);
    const plain = await noteWith(setup, [[words.ownLine]]);

    let from = setup.calls.length;
    await askInNote(setup, citing);
    expect(searchedBy(setup.calls.slice(from))).toEqual(new Set([words.report, words.own]));
    from = setup.calls.length;
    await askAssistant(setup.core, { text: "What was EBITDA?", mindId: citing.mindId });
    expect(searchedBy(setup.calls.slice(from))).toEqual(new Set([words.report, words.own]));

    from = setup.calls.length;
    await askInNote(setup, plain);
    expect(searchedBy(setup.calls.slice(from))).toEqual(new Set([words.own]));
    from = setup.calls.length;
    await askAssistant(setup.core, { text: "What was EBITDA?", mindId: plain.mindId });
    expect(searchedBy(setup.calls.slice(from))).toEqual(new Set([words.own]));
    setup.core.close();
  });
});

describe.each(["en", "zh-CN"] as const)(
  "a cited Document outside the Note's Search scope (%s)",
  (language) => {
    // protects=a sentence whose every Citation is of a Document the Note's Search scope leaves out reads Not checked, naming the Document, and no request is sent for it, until Search all Documents reads it there; the sentence beside it citing a Document in the scope is judged as before (#3083); fails_when=the sentence reads Unsupported or Not found for want of the Document, or a model is asked about it; no_claim=the Note's sort of its sentences into parts, which lists every sentence.
    test("every Citation outside: Not checked, the Document named, nothing sent for it", async () => {
      const setup = await setUp(language);
      const { words } = setup;
      const { mindId, client } = await noteWith(setup, [
        [words.ebitda, await citesReport(setup)],
        [words.ownLine, await citesOwn(setup)],
      ]);
      setMindScope(client.doc, documentsScope(setup.own.id));
      await client.settled();

      await checkNote(setup, mindId, client);

      const shown = cards(client, language);
      expect(shown.get(words.ebitda)).toEqual({
        state: "not-checked",
        line: outsideLine(language, words.report),
      });
      expect(shown.get(words.ownLine)).toEqual({ state: "supported", line: null });
      expect(setup.calls.filter(isCheckRun).some((call) => sentenceOf(call) === words.ebitda)).toBe(
        false,
      );
      expect(shownTo(setup.calls, words.ownLine)).toEqual(new Set([words.own]));

      // Checked alone, and a second time, it sends nothing at all.
      const sent = setup.calls.length + setup.generated.length;
      for (const _time of [1, 2]) {
        await setup.core.checkSentences({
          requestId: randomUUID(),
          mindId,
          action: "check-against-documents",
          from: { blockId: "line-0", offset: 0 },
          to: { blockId: "line-0", offset: words.ebitda.length + 1 },
        });
        await client.settled();
        expect(cards(client, language).get(words.ebitda)).toEqual({
          state: "not-checked",
          line: outsideLine(language, words.report),
        });
      }
      expect(setup.calls.length + setup.generated.length).toBe(sent);

      // The card's Search all Documents checks it where its cited Document is.
      await setup.core.checkSentences({
        requestId: randomUUID(),
        mindId,
        action: "check-against-documents",
        from: { blockId: "line-0", offset: 0 },
        to: { blockId: "line-0", offset: words.ebitda.length + 1 },
        allDocuments: true,
      });
      await client.settled();
      expect(cards(client, language).get(words.ebitda)).toEqual({
        state: "supported",
        line: null,
      });
      setup.core.close();
    });

    // protects=a sentence citing one Document inside the scope and one outside: Supported and Contradicted from what was read stand, and Unsupported or Not found, with or without figures, reads Not checked naming the left-out Document (#3083); fails_when=a verdict of Unsupported is given for want of the left-out Document, or a verdict the Document inside settles is hidden; no_claim=how a real model decides.
    test("one Citation inside and one outside: verdicts stand, Unsupported gives way", async () => {
      const setup = await setUp(language);
      const { words } = setup;
      const both = async () => [await citesReport(setup), await citesOwn(setup)];
      const { mindId, client } = await noteWith(setup, [
        [words.ownLine, ...(await both())],
        [words.onlyOnline, ...(await both())],
        [words.revenueOwn, ...(await both())],
        [words.depot, ...(await both())],
      ]);
      setMindScope(client.doc, documentsScope(setup.own.id));
      await client.settled();

      await checkNote(setup, mindId, client);

      const shown = cards(client, language);
      const left = { state: "not-checked", line: outsideLine(language, words.report) };
      expect(shown.get(words.ownLine)).toEqual({ state: "supported", line: null });
      expect(shown.get(words.onlyOnline)).toEqual({ state: "contradicted", line: null });
      expect(shown.get(words.revenueOwn)).toEqual(left);
      expect(shown.get(words.depot)).toEqual(left);
      expect(shownTo(setup.calls)).toEqual(new Set([words.own]));
      setup.core.close();
    });
  },
);

describe("a cited Document behind another wall", () => {
  // protects=a Document behind another Folder's wall is never read and keeps its own reason, Kept inside, beside the scope's rule (#1934, #3083); fails_when=the walled Citation reads as outside the Search scope, or its Document is read; no_claim=the wall's own Citation re-check.
  test("keeps Kept inside, and nothing is read", async () => {
    const setup = await setUp("en");
    const { words } = setup;
    await addAndProcess(setup.core, [
      await writeSourceFile(
        await createSourceFolder(),
        "Other memo.md",
        "The memo was approved.\n",
      ),
    ]);
    const client = await setup.core.createLibraryGroup({ name: "Client A", description: "" });
    await setup.core.assignDocumentGroup(setup.own.id, client.id);
    const note = await noteWith(setup, [[words.ownLine, await citesOwn(setup)]]);
    await setup.core.updateLibraryGroup(client.id, {
      name: "Client A",
      description: "",
      keepInside: true,
    });

    await checkNote(setup, note.mindId, note.client);

    expect(cards(note.client, "en").get(words.ownLine)).toEqual({
      state: "not-checked",
      line: "Kept inside Client A",
    });
    expect(shownTo(setup.calls)).not.toContain(words.own);
    setup.core.close();
  });
});

describe("the example removed, brought back and made again", () => {
  // protects=a Note citing the example reads it until the example is removed, and again once Undo brings the same Documents back; a removed Document is gone, not left out, so it reads as before (#3083); fails_when=Undo leaves the Note unable to read its cited example, or a removed example reads as outside the Search scope; no_claim=what a Citation of a removed Document shows itself.
  test("removed, it reads as on main; Undo brings it back", async () => {
    const setup = await setUp("en");
    const { words } = setup;
    const { mindId, client } = await noteWith(setup, [[words.ebitda, await citesReport(setup)]]);
    await checkNote(setup, mindId, client);
    expect(cards(client, "en").get(words.ebitda)).toEqual({ state: "supported", line: null });

    await setup.core.removeExamples();
    await checkNote(setup, mindId, client);
    expect(cards(client, "en").get(words.ebitda)?.state).toBe("unsupported");

    await setup.core.restoreExamples();
    await examplesReady(setup.core);
    await checkNote(setup, mindId, client);
    expect(cards(client, "en").get(words.ebitda)).toEqual({ state: "supported", line: null });
    setup.core.close();
  });
});
