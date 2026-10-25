import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  BLOCK_ID_ATTRIBUTE,
  type CitationCheck,
  type ClaimCheckAttributes,
  type Core,
  type Document,
  GENERATED_MARK,
  NotFoundError,
} from "../../src/core";
import { contentHash } from "../../src/core/answers/blocks";
import { formatDate } from "../../src/shared/dates";
import { checkingModel, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient, typeInto } from "../helpers/mindClient";
import { heading, note, question, readMind, writeMind } from "../helpers/minds";

/*
 * The AI use statement (#739), as the User sees it: a new Mind whose text
 * states counts drawn from what the Mind records. Every figure here is one
 * the fixture Mind was built to hold, so a count that drifts from the Mind
 * fails.
 */

const AI = { type: GENERATED_MARK };
const NOW = "2026-10-14T09:00:00.000Z";

const text = (value: string, ...marks: { type: string; attrs?: object }[]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks.length > 0 && { marks }),
});
const paragraph = (...content: JSONContent[]): JSONContent => ({
  type: "paragraph",
  attrs: { id: randomUUID() },
  content,
});
/** A paragraph of AI text with a Block id, which the record can follow. */
const aiParagraph = (id: string, value: string): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content: [text(value, AI)],
});

function citation(document: Document, check: CitationCheck): JSONContent {
  return {
    type: "citation",
    attrs: {
      passageId: "passage-1",
      documentId: document.id,
      documentName: "Tides",
      contentHash: document.contentHash,
      pageFrom: null,
      pageTo: null,
      quote: "Spring tides happen at new moon.",
      check,
      checkReason: check === "not-found" ? "quote-not-on-pages" : null,
    },
  };
}

function checked(
  document: Document,
  sentence: string,
  state: ClaimCheckAttributes["state"],
  model: { providerId: string; modelId: string },
  asked = sentence,
): ClaimCheckAttributes {
  return {
    id: randomUUID(),
    request: "request-1",
    action: "check-against-documents",
    state,
    reason: state === "not-checked" ? "refused" : null,
    detail: null,
    ...model,
    text: asked,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [{ documentId: document.id, contentHash: document.contentHash }],
    excluded: [],
    checkedAt: NOW,
  };
}

const call = (tool: string, source: string, status: "done" | "failed") => ({
  id: randomUUID(),
  tool,
  source,
  input: {},
  status,
  resultCount: null,
});

async function setUp(language: "en" | "zh-CN" = "en") {
  const dataDir = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const core = startCore(dataDir, { now: manualClock(NOW).now });
  await core.updateSettings({ user: { language } });
  const path = await writeSourceFile(sources, "Tides.txt", "Spring tides happen at new moon.");
  const [tides] = await addAndProcess(core, [path]);
  const haiku = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  const local = await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: "Thesis" });
  const client = await connectToMind(core, mind.id);
  return { core, mind, client, tides: tides as Document, haiku, local };
}

type Part =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "table"; rows: string[][] };

/** The statement Mind's text as a person reads it: headings, paragraphs and each table's rows. */
async function statementOf(core: Core, mindId: string): Promise<{ title: string; parts: Part[] }> {
  const made = await core.createAiUseStatement(mindId);
  const client = await connectToMind(core, made.id);
  const parts: Part[] = [];
  readMind(client).forEach((node) => {
    if (node.type.name === "heading") parts.push({ kind: "heading", text: node.textContent });
    else if (node.type.name === "paragraph") {
      parts.push({ kind: "paragraph", text: node.textContent });
    } else if (node.type.name === "table") {
      const rows: string[][] = [];
      node.forEach((row) => {
        const cells: string[] = [];
        row.forEach((cell) => void cells.push(cell.textContent));
        rows.push(cells);
      });
      parts.push({ kind: "table", rows });
    }
  });
  return { title: made.title, parts };
}

const tablesOf = (parts: readonly Part[]) =>
  parts.flatMap((part) => (part.kind === "table" ? [part.rows] : []));
const headingsOf = (parts: readonly Part[]) =>
  parts.flatMap((part) => (part.kind === "heading" ? [part.text] : []));
const paragraphsOf = (parts: readonly Part[]) =>
  parts.flatMap((part) => (part.kind === "paragraph" ? [part.text] : []));

function blockIndex(client: MindClient, id: string): number {
  const index = client.blocks
    .toArray()
    .findIndex(
      (child) => child instanceof Y.XmlElement && child.getAttribute(BLOCK_ID_ATTRIBUTE) === id,
    );
  if (index < 0) throw new Error(`No Block ${id}.`);
  return index;
}

/** Types into an AI paragraph the way the User does: their words are theirs, not AI text. */
function typeAfter(client: MindClient, id: string, words: string): void {
  const block = client.blocks.get(blockIndex(client, id)) as Y.XmlElement;
  const run = block.get(0) as Y.XmlText;
  run.insert(run.length, words, { [GENERATED_MARK]: null });
}

const FIRST = "Spring tides come at new and full moon.";
const SECOND = "Penguins nest above the harbour.";
const LONG =
  "Harbours publish the times of high water on their notice boards every year without fail.";
const FOURTH = "Nobody would say.";
const EDITED = "Edited since it was checked.";

const NOTE_EN =
  "Schools have their own forms for declaring AI use. Use these counts to fill in yours.";

const checkRecord = (mindId: string, model: { providerId: string; modelId: string }) => ({
  mindId,
  kind: "sentence-checked" as const,
  characters: 0,
  ...model,
});

/** The fixture: AI text kept and rewritten, accepted changes, and Citations and sentence checks of every result. */
async function writeThesis(setup: Awaited<ReturnType<typeof setUp>>) {
  const { core, mind, client, tides, haiku, local } = setup;
  const asked = question("What drives the tides?");
  const [p1, p2, p3, p4] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const answer = (
    model: { providerId: string; modelId: string },
    content: JSONContent[],
    extra: Record<string, unknown> = {},
  ): JSONContent => ({
    type: "answer",
    attrs: {
      id: randomUUID(),
      questionId: asked.attrs.id,
      status: "done",
      generatedMarks: true,
      ...model,
      ...extra,
    },
    content,
  });
  const haikuModel = { providerId: haiku.id, modelId: "claude-haiku-5-5" };
  const localModel = { providerId: local.id, modelId: "local-model" };
  const first = answer(
    haikuModel,
    [
      paragraph(
        text("The Moon pulls the sea twice a day.", AI),
        text(" "),
        citation(tides, "found"),
      ),
    ],
    {
      toolCalls: JSON.stringify([
        call("search_documents", "documents", "done"),
        call("search_documents", "documents", "done"),
        call("find_sources", "sources", "done"),
        call("search_web", "web", "done"),
        call("search_web", "web", "failed"),
        call("use_skill", "skill", "done"),
      ]),
    },
  );
  const second = answer(
    localModel,
    [
      paragraph(
        text("Tides are higher in autumn.", AI),
        citation(tides, "not-found"),
        citation(tides, "cant-check"),
      ),
    ],
    { generatedHash: "written-before-the-user-edited-it" },
  );
  const sentences = [
    [FIRST, "supported", haikuModel],
    [SECOND, "unsupported", haikuModel],
    [LONG, "contradicted", localModel],
    [FOURTH, "not-checked", haikuModel],
  ] as const;
  writeMind(client, [
    heading(1, "Introduction"),
    note("I wrote this introduction myself."),
    asked,
    first,
    heading(1, "Methods"),
    aiParagraph(p1, "Spring tides happen at new moon and full moon."),
    aiParagraph(p2, "Neap tides are weaker."),
    aiParagraph(p3, "Tidal ranges differ between harbours."),
    aiParagraph(p4, "This paragraph was deleted again."),
    paragraph(
      ...sentences.flatMap(([sentence, state, model]) => [
        text(sentence, { type: "claimCheck", attrs: checked(tides, sentence, state, model) }),
        text(" "),
      ]),
      text(EDITED, {
        type: "claimCheck",
        attrs: checked(tides, EDITED, "supported", haikuModel, "As it was checked."),
      }),
    ),
    // A change still waiting isn't the Mind's: its AI text and Citation count for nothing.
    {
      ...paragraph(text("Waiting for a yes. ", AI), citation(tides, "found")),
      attrs: {
        id: randomUUID(),
        proposal: { id: "waiting", request: "ask", kind: "insert" },
      },
    },
    heading(1, "Results"),
    second,
    paragraph(
      text("The tables agree "),
      citation(tides, "found"),
      text(", though not always "),
      citation(tides, "unsupported"),
      text(" and sometimes not at all "),
      citation(tides, "contradicted"),
      text(" and one is being checked "),
      citation(tides, "checking"),
      text("."),
    ),
  ]);
  await client.settled();
  // As the core leaves an Answer it has just written: its fingerprint is its text as it is.
  for (const child of client.blocks.toArray()) {
    if (
      child instanceof Y.XmlElement &&
      child.nodeName === "answer" &&
      child.getAttribute("generatedHash") == null
    ) {
      child.setAttribute("generatedHash", contentHash(child));
    }
  }
  await client.settled();
  await core.recordAiUse([
    { mindId: mind.id, kind: "answer-added", characters: 46, blockIds: [p1], ...haikuModel },
    { mindId: mind.id, kind: "answer-added", characters: 22, blockIds: [p2], ...haikuModel },
    {
      mindId: mind.id,
      kind: "edit-with-ai-accepted",
      characters: 37,
      blockIds: [p3],
      ...localModel,
    },
    { mindId: mind.id, kind: "answer-added", characters: 33, blockIds: [p4], ...haikuModel },
    { mindId: mind.id, kind: "suggestion-accepted", characters: 12, ...localModel },
    { mindId: mind.id, kind: "assistant-change-rejected", characters: 40, ...localModel },
    ...[...Array(6)].map(() => checkRecord(mind.id, haikuModel)),
    ...[...Array(2)].map(() => checkRecord(mind.id, localModel)),
  ]);
  typeAfter(client, p2, " I measured them on the pier myself.");
  client.blocks.delete(blockIndex(client, p4), 1);
  await client.settled();
}

describe("The AI use statement", () => {
  test("states counts that match the Mind: models and uses, AI text by section, and checks by result", async () => {
    const setup = await setUp();
    await writeThesis(setup);
    const { core, mind } = setup;
    const before = (await core.openMind(mind.id)).state;

    const { title, parts } = await statementOf(core, mind.id);

    expect(title).toBe("AI use statement: Thesis");
    expect(headingsOf(parts)).toEqual([
      "AI models and what they were used for",
      "AI text, by section",
      "Checks",
    ]);
    expect(paragraphsOf(parts)[0]).toBe(
      `Drawn from the record IncarnaMind keeps of this document, as of ${formatDate(NOW, "en")}. It covers only what IncarnaMind recorded, so add any use of AI elsewhere, and edit this before you attach it.`,
    );
    const [uses, sections, citations, sentences, checkedList] = tablesOf(parts);
    const haiku = "Claude Haiku 5.5 (Anthropic)";
    expect(uses).toEqual([
      ["Use", "Model", "Times"],
      ["Answers written", haiku, "1"],
      ["Answers written", "local-model", "1"],
      ["Answers added to the document", haiku, "3"],
      ["Changes from Edit with AI accepted", "local-model", "1"],
      ["Writing suggestions accepted", "local-model", "1"],
      ["Searches of the author’s own Documents", haiku, "2"],
      ["Searches of public scholarly sources (Find sources)", haiku, "1"],
      ["Web searches", haiku, "1"],
      ["Sentences checked against the Documents", haiku, "6"],
      ["Sentences checked against the Documents", "local-model", "2"],
    ]);
    // One Answer kept as written and one rewritten; of the accepted changes, two kept, one
    // rewritten by typing, one removed again.
    expect(sections).toEqual([
      ["Section", "Pieces kept as written", "Pieces rewritten", "Words of AI text now"],
      ["Introduction", "1", "0", "8"],
      ["Methods", "2", "1", "18"],
      ["Results", "0", "1", "5"],
      ["Total", "3", "2", "31"],
    ]);
    expect(paragraphsOf(parts)).toContain("Pieces of AI text removed from the document: 1.");
    expect(citations).toEqual([
      ["Result", "Citations"],
      ["Quote found", "2"],
      ["Quote not found", "1"],
      ["Could not be checked", "1"],
      ["Claim unsupported by the Document", "1"],
      ["Claim contradicted by the Document", "1"],
      ["Still being checked", "1"],
    ]);
    expect(sentences).toEqual([
      ["Result", "Sentences"],
      ["Supported", "1"],
      ["Unsupported", "1"],
      ["Contradicted", "1"],
      ["Needs re-check", "1"],
      ["Not checked", "1"],
    ]);
    const on = formatDate(NOW, "en");
    expect(checkedList).toEqual([
      ["Sentence", "Result", "Model", "Checked"],
      [FIRST, "Supported", haiku, on],
      [SECOND, "Unsupported", haiku, on],
      [
        "Harbours publish the times of high water on their notice boards every…",
        "Contradicted",
        "local-model",
        on,
      ],
      [FOURTH, "Not checked", "", ""],
      [EDITED, "Changed since checked", haiku, on],
    ]);
    expect(paragraphsOf(parts).at(-1)).toBe(NOTE_EN);

    // The Mind it is of is left exactly as it was.
    expect((await core.openMind(mind.id)).state).toEqual(before);
    expect(readMind(setup.client).textContent).toContain("I wrote this introduction myself.");
  });

  test("opens as a new Mind in the Folder of the one it is of, as plain text that is no AI text and no AI use", async () => {
    const { core } = await setUp();
    const folder = await core.createLibraryGroup({ name: "Thesis", description: "" });
    const mind = await core.createMind({ title: "Chapter one", folderId: folder.id });
    const client = await connectToMind(core, mind.id);
    const id = randomUUID();
    writeMind(client, [aiParagraph(id, "Spring tides happen at new moon.")]);
    await client.settled();
    await core.recordAiUse([
      { mindId: mind.id, kind: "answer-added", characters: 32, blockIds: [id] },
    ]);

    const made = await core.createAiUseStatement(mind.id);

    expect(made.id).not.toBe(mind.id);
    expect(made.title).toBe("AI use statement: Chapter one");
    expect(made.folderId).toBe(folder.id);
    expect((await core.listMinds()).map((each) => each.id)).toEqual(
      expect.arrayContaining([mind.id, made.id]),
    );
    const statement = await connectToMind(core, made.id);
    let marked = 0;
    readMind(statement).descendants((node) => {
      if (node.marks.some((each) => each.type.name === GENERATED_MARK)) marked++;
    });
    expect(marked).toBe(0);
    expect(await core.listAiUse(made.id)).toEqual([]);
    // It is the User's to reword.
    typeInto(statement, 0, 0, "Reworded. ");
    await statement.settled();
    const again = readMind(await connectToMind(core, made.id));
    expect(again.child(0).textContent).toMatch(/^Reworded\. Drawn from the record/);
  });

  test("an empty Mind says there is nothing to report, with no table of zeros", async () => {
    const { core, mind } = await setUp();

    const { title, parts } = await statementOf(core, mind.id);

    expect(title).toBe("AI use statement: Thesis");
    expect(headingsOf(parts)).toEqual([]);
    expect(tablesOf(parts)).toEqual([]);
    expect(paragraphsOf(parts)).toEqual([
      expect.stringContaining("Drawn from the record IncarnaMind keeps"),
      "There is nothing to report: IncarnaMind has no record of AI use in this document, and the document has no Citations or checks.",
      NOTE_EN,
    ]);
  });

  test("a Mind with no AI text says so, and still counts its Citations", async () => {
    const { core, mind, client, tides } = await setUp();
    writeMind(client, [
      heading(1, "Tides"),
      paragraph(text("I read it in the harbour office "), citation(tides, "found"), text(".")),
    ]);
    await client.settled();

    const { parts } = await statementOf(core, mind.id);

    expect(paragraphsOf(parts)).toContain(
      "IncarnaMind has no record of AI writing, suggesting changes, searching or checking sentences for this document.",
    );
    expect(paragraphsOf(parts)).toContain("This document has no AI text.");
    expect(tablesOf(parts)).toEqual([
      [
        ["Result", "Citations"],
        ["Quote found", "1"],
        ["Quote not found", "0"],
      ],
    ]);
  });

  test("a Mind with no headings counts its AI text as one whole, with no total row", async () => {
    const { core, mind, client, haiku } = await setUp();
    const id = randomUUID();
    writeMind(client, [aiParagraph(id, "Spring tides happen at new moon.")]);
    await client.settled();
    await core.recordAiUse([
      {
        mindId: mind.id,
        kind: "answer-added",
        characters: 32,
        blockIds: [id],
        providerId: haiku.id,
        modelId: "claude-haiku-5-5",
      },
    ]);

    const { parts } = await statementOf(core, mind.id);

    expect(tablesOf(parts)[1]).toEqual([
      ["Section", "Pieces kept as written", "Pieces rewritten", "Words of AI text now"],
      ["Whole document", "1", "0", "6"],
    ]);
  });

  test("AI text before the first heading is counted under its own name", async () => {
    const { core, mind, client } = await setUp();
    writeMind(client, [aiParagraph(randomUUID(), "Spring tides."), heading(1, "Tides")]);
    await client.settled();

    const { parts } = await statementOf(core, mind.id);

    // Marked as AI text, though the record holds no entry for it: the words are counted, no piece.
    expect(tablesOf(parts)[0]).toEqual([
      ["Section", "Pieces kept as written", "Pieces rewritten", "Words of AI text now"],
      ["Before the first heading", "0", "0", "2"],
    ]);
  });

  test("Chinese headings are the section names, and the statement follows the interface language", async () => {
    const { core, mind, client, haiku } = await setUp("zh-CN");
    const id = randomUUID();
    writeMind(client, [
      heading(1, "第一章 绪论"),
      aiParagraph(id, "潮汐是海水的周期性涨落。"),
      heading(1, "第二章 方法"),
      note("本章为作者自己撰写。"),
    ]);
    await client.settled();
    await core.recordAiUse([
      {
        mindId: mind.id,
        kind: "answer-added",
        characters: 12,
        blockIds: [id],
        providerId: haiku.id,
        modelId: "claude-haiku-5-5",
      },
    ]);

    const { title, parts } = await statementOf(core, mind.id);

    expect(title).toBe("AI 使用声明：Thesis");
    expect(headingsOf(parts)).toEqual([
      "一、使用的 AI 模型及用途",
      "二、AI 生成文字的保留与改写（按章节）",
      "三、引用与说法的核对",
    ]);
    const [uses, sections] = tablesOf(parts);
    expect(uses).toEqual([
      ["用途", "模型", "次数"],
      ["将助手的回答加入文档", "Claude Haiku 5.5 (Anthropic)", "1"],
    ]);
    // The section with no AI text isn't listed; Chinese is counted by character.
    expect(sections).toEqual([
      ["章节", "保留原文（处）", "已改写（处）", "现存 AI 生成文字（字）"],
      ["第一章 绪论", "1", "0", "11"],
    ]);
    expect(paragraphsOf(parts).at(-1)).toBe(
      "各学校对 AI 使用声明另有格式要求，请以学校提供的表格为准，可据此处的统计数字填写。",
    );
  });

  test("the same Mind gives the same counts in either language", async () => {
    const setup = await setUp();
    await writeThesis(setup);
    const english = await statementOf(setup.core, setup.mind.id);
    await setup.core.updateSettings({ user: { language: "zh-CN" } });
    const chinese = await statementOf(setup.core, setup.mind.id);

    const counts = (parts: readonly Part[]) =>
      tablesOf(parts).map((rows) =>
        rows.slice(1).map((row) => row.filter((cell) => /^\d+$/.test(cell))),
      );
    expect(counts(chinese.parts)).toEqual(counts(english.parts));
    expect(chinese.title).toBe("AI 使用声明：Thesis");
    expect(paragraphsOf(english.parts)).toContain(
      "Sentences the author had checked against the Documents, with Check against Documents, by result:",
    );
    expect(paragraphsOf(chinese.parts)).toContain("以下是“对照文档核对”的结果：");
  });

  test("refuses a Mind that isn't there", async () => {
    const { core } = await setUp();
    await expect(core.createAiUseStatement(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a Citation of a Document deleted since counts as its badge shows it: it can't be checked", async () => {
    const { core, mind, client, tides } = await setUp();
    writeMind(client, [paragraph(text("Per Tides "), citation(tides, "found"), text("."))]);
    await client.settled();
    await core.deleteDocument(tides.id);

    const { parts } = await statementOf(core, mind.id);

    // The Document is gone, so the Citation can't be checked now, as its badge says.
    expect(tablesOf(parts)[0]).toEqual([
      ["Result", "Citations"],
      ["Quote found", "0"],
      ["Quote not found", "0"],
      ["Could not be checked", "1"],
    ]);
  });
});

describe("Checks in the statement", () => {
  const TIDES = {
    name: "Tides.md",
    contents:
      "# Tides\n\nSpring tides happen at new moon and at full moon.\n\nHarbours publish the times of high water every year.\n",
  };
  const OFFICE = {
    name: "Harbour office.md",
    contents:
      "# Harbour office\n\nThe harbour office publishes the times of high water every week.\n",
  };
  const MOON = "Spring tides come at new and full moon.";
  const YEARLY = "Harbours publish the times of high water every year.";
  const PENGUINS = "Penguins nest on the cliffs above the harbour.";
  const PLANS: Record<string, Plan> = {
    [MOON]: { verdict: "supported", quote: "Spring tides happen at new moon and at full moon" },
    [YEARLY]: {
      verdict: "contradicted",
      quote: "The harbour office publishes the times of high water every week.",
      says: "The harbour office says every week, not every year.",
    },
    [PENGUINS]: { verdict: "unsupported" },
  };
  const NO_RECORD = /has no record of AI writing/;

  /** A Mind in a Folder with both Documents, and a scripted model on this computer. */
  async function checking(...body: JSONContent[]) {
    const setup = await setUpWithDocuments(checkingModel(PLANS), [TIDES, OFFICE], {
      now: manualClock(NOW).now,
    });
    const { core } = setup;
    const folder = await core.createLibraryGroup({ name: "Harbours", description: "" });
    await core.moveToFolder({
      documentIds: setup.documents.map((each) => each.id),
      folderId: folder.id,
    });
    const mind = await core.createMind({ title: "Harbour notes", folderId: folder.id });
    const client = await connectToMind(core, mind.id);
    writeMind(client, body);
    await client.settled();
    const check = (
      block: JSONContent,
      length: number,
      action: "find-support" | "check-against-documents" = "find-support",
      model?: { providerId: string; modelId: string },
    ) =>
      core.checkSentences({
        requestId: randomUUID(),
        mindId: mind.id,
        action,
        from: { blockId: block.attrs?.id, offset: 0 },
        to: { blockId: block.attrs?.id, offset: length },
        ...(model && { model }),
      });
    return { ...setup, mind, client, folder, check };
  }

  const sentencesBlock = (...sentences: string[]) => paragraph(text(sentences.join(" ")));
  const on = formatDate(NOW, "en");

  test("checks alone are a row of the uses table, with the model and how many, and the statement never says there is no record", async () => {
    const block = sentencesBlock(MOON, PENGUINS);
    const { core, mind, check } = await checking(block);
    await check(block, MOON.length + 1 + PENGUINS.length);
    await check(block, MOON.length + 1 + PENGUINS.length);

    const { parts } = await statementOf(core, mind.id);

    const [uses, sentences, listed] = tablesOf(parts);
    expect(uses).toEqual([
      ["Use", "Model", "Times"],
      ["Sentences checked against the Documents", "local-model", "4"],
    ]);
    expect(sentences).toEqual([
      ["Result", "Sentences"],
      ["Supported", "1"],
      ["Unsupported", "1"],
    ]);
    expect(listed).toEqual([
      ["Sentence", "Result", "Model", "Checked"],
      [MOON, "Supported", "local-model", on],
      [PENGUINS, "Unsupported", "local-model", on],
    ]);
    expect(paragraphsOf(parts).filter((each) => NO_RECORD.test(each))).toEqual([]);
    expect(paragraphsOf(parts)).toContain("This document has no AI text.");
  });

  test("checks beside written text are listed with it", async () => {
    const answer = randomUUID();
    const block = sentencesBlock(MOON);
    const { core, mind, client, check } = await checking(aiParagraph(answer, "Neap tides."), block);
    await core.recordAiUse([
      { mindId: mind.id, kind: "answer-added", characters: 11, blockIds: [answer] },
    ]);
    await check(block, MOON.length);
    await client.settled();

    const { parts } = await statementOf(core, mind.id);

    expect(tablesOf(parts)[0]).toEqual([
      ["Use", "Model", "Times"],
      ["Answers added to the document", "Not recorded", "1"],
      ["Sentences checked against the Documents", "local-model", "1"],
    ]);
  });

  test("a Mind nothing was used on says there is nothing to report, with no row of checks", async () => {
    const { core, mind } = await checking(sentencesBlock(MOON));

    const { parts } = await statementOf(core, mind.id);

    expect(paragraphsOf(parts).filter((each) => NO_RECORD.test(each))).toHaveLength(0);
    expect(tablesOf(parts)).toEqual([]);
    expect(paragraphsOf(parts)).toContain(
      "There is nothing to report: IncarnaMind has no record of AI use in this document, and the document has no Citations or checks.",
    );
  });

  test("checking the whole Mind counts each sentence the model judged", async () => {
    const { core, mind } = await checking(sentencesBlock(MOON, YEARLY, PENGUINS));

    await core.checkMind({ requestId: "all", mindId: mind.id, mode: "all" });
    const { parts } = await statementOf(core, mind.id);

    expect(tablesOf(parts)[0]).toEqual([
      ["Use", "Model", "Times"],
      ["Sentences checked against the Documents", "local-model", "3"],
    ]);
  });

  test("a check for contradictions counts every claim the model judged, though only a contradiction keeps a mark", async () => {
    const cited = (document: Document): JSONContent => ({
      type: "citation",
      attrs: {
        passageId: "passage-1",
        documentId: document.id,
        documentName: document.name,
        contentHash: document.contentHash,
        pageFrom: null,
        pageTo: null,
        quote: "Harbours publish the times of high water every year.",
        check: "found",
        checkReason: null,
      },
    });
    const { core, mind, documents } = await checking();
    const [tides] = documents;
    if (!tides) throw new Error("Tides was not added");
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      paragraph(text(`${YEARLY} `), cited(tides), text(` ${PENGUINS} `), cited(tides)),
    ]);
    await client.settled();

    await core.checkContradictions({ requestId: "contradictions", mindId: mind.id });
    const { parts } = await statementOf(core, mind.id);

    expect(tablesOf(parts)[0]).toEqual([
      ["Use", "Model", "Times"],
      ["Sentences checked against the Documents", "local-model", "2"],
    ]);
    expect(tablesOf(parts).at(-1)?.slice(1)).toEqual([[YEARLY, "Contradicted", "local-model", on]]);
  });

  test("a sentence checked again with another model lists both models, and shows the latest", async () => {
    const block = sentencesBlock(MOON);
    const { core, mind, check } = await checking(block);
    await check(block, MOON.length);
    const other = await core.saveChatProvider({ kind: "ollama", modelId: "other-model" });
    await check(block, MOON.length, "find-support", {
      providerId: other.id,
      modelId: "other-model",
    });

    const { parts } = await statementOf(core, mind.id);

    expect(tablesOf(parts)[0]).toEqual([
      ["Use", "Model", "Times"],
      ["Sentences checked against the Documents", "local-model", "1"],
      ["Sentences checked against the Documents", "other-model", "1"],
    ]);
    expect(tablesOf(parts).at(-1)).toEqual([
      ["Sentence", "Result", "Model", "Checked"],
      [MOON, "Supported", "other-model", on],
    ]);
  });

  test("when the record has been cleared, the checks still on the page are counted by the model that made them", async () => {
    const block = sentencesBlock(MOON, PENGUINS);
    const { core, mind, check } = await checking(block);
    await check(block, MOON.length + 1 + PENGUINS.length);
    await core.clearAiUse();

    const { parts } = await statementOf(core, mind.id);

    expect(tablesOf(parts)[0]).toEqual([
      ["Use", "Model", "Times"],
      ["Sentences checked against the Documents", "local-model", "2"],
    ]);
    expect(paragraphsOf(parts).filter((each) => NO_RECORD.test(each))).toEqual([]);
  });

  test("in Chinese, the row, the list and its dates are in Chinese", async () => {
    const block = sentencesBlock(MOON);
    const { core, mind, check } = await checking(block);
    await core.updateSettings({ user: { language: "zh-CN" } });
    await check(block, MOON.length);

    const { parts } = await statementOf(core, mind.id);

    expect(tablesOf(parts)[0]).toEqual([
      ["用途", "模型", "次数"],
      ["对照文档核对句子", "local-model", "1"],
    ]);
    expect(tablesOf(parts).at(-1)).toEqual([
      ["句子", "核对结果", "模型", "核对日期"],
      [MOON, "有依据", "local-model", formatDate(NOW, "zh-CN")],
    ]);
  });
});
