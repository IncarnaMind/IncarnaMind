/**
 * What a sentence says about an Analysis's figure besides its number, judged on a real model
 * (#2544): each case of `analysisFigureWords.ts` writes its Document into a data folder of its own,
 * a scripted Answer runs the Analysis and writes the Note, the User accepts it (and, for a retyped
 * case, types the sentence's words around the figure), and Check judges it. Every surface is read:
 * the sentence's mark or the cell's own check, the figure's schedule row, the badge and Home, whose
 * reading the export's line shows too. A wrong name is never Supported on any of them. The cases of
 * `analysisFigureLists.ts` are lists (#2584), some in an Answer the User adds to a Note.
 *
 * INCARNAMIND_LIVE_SET=words (or lists) runs it, with INCARNAMIND_LIVE_PROVIDER ("anthropic" or
 * "deepseek"), INCARNAMIND_LIVE_KEY and INCARNAMIND_LIVE_MODEL; INCARNAMIND_LIVE_JUDGE=scripted
 * answers every check with a consistent "same" instead, at no cost, to read what code alone holds
 * and what the Note says once written. INCARNAMIND_LIVE_REPORT appends a line per case,
 * INCARNAMIND_LIVE_MAX_USD stops starting cases past it, and INCARNAMIND_LIVE_SHARD ("2/4") runs
 * every fourth.
 */
import { randomUUID } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { expect, test } from "vitest";
import * as Y from "yjs";
import type { Core } from "../../src/core";
import { createFakeAnalysisRuntime, type FakeAnswer } from "../../src/core/analysis/fake";
import { nodeOf, topLevelBlocks } from "../../src/core/answers/blocks";
import {
  ANALYSIS_TABLE_ATTRIBUTE,
  CALCULATED_FIGURE_NODE,
  CLAIM_CHECK_MARK,
  type ConversationAnswer,
  MIND_CONTENT_FIELD,
} from "../../src/core/api";
import { writeXlsx } from "../../src/core/exports/xlsx";
import { messageReference } from "../../src/core/references";
import { homeReading, readNoteState } from "../../src/renderer/src/noteState";
import {
  type AnalysisCell,
  type AnalysisJob,
  type AnalysisValue,
  noAnalysisOutput,
} from "../../src/shared/analysis";
import { pageBlocks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { readCalculatedFigureAttributes } from "../../src/shared/calculatedFigures";
import { readClaimCheck } from "../../src/shared/claimChecks";
import { figureRunsOfAnswer } from "../../src/shared/figureRuns";
import { FIGURE_LISTS } from "../helpers/analysisFigureLists";
import {
  FIGURE_WORDS,
  WORDS_DATASETS,
  type WordsCase,
  type WordsDataset,
  type WordsFigure,
  wordsLabel,
} from "../helpers/analysisFigureWords";
import { askAssistant } from "../helpers/assistant";
import { checkGenerate, checkReply, isCheckRun, listedSentences } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess } from "../helpers/documents";
import { billedModels } from "../helpers/liveBilling";
import { routedChecks } from "../helpers/liveChecks";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { resolveChanges } from "../helpers/minds";
import { type GenerateCall, type ModelCall, scriptedModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";
import { para, pptxOf, sp, txBody, xfrm } from "../helpers/pptx";
import { escapeXml, paragraph, table, wordFile } from "../helpers/word";

const SET = process.env.INCARNAMIND_LIVE_SET;
const RUNS = SET === "words" || SET === "lists";
const SCRIPTED = process.env.INCARNAMIND_LIVE_JUDGE === "scripted";
const PROVIDER = process.env.INCARNAMIND_LIVE_PROVIDER === "deepseek" ? "deepseek" : "anthropic";
const KEY = process.env.INCARNAMIND_LIVE_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_MODEL ??
  (PROVIDER === "deepseek" ? "deepseek-flash" : "claude-haiku-5-5");
const MAX_USD = Number(process.env.INCARNAMIND_LIVE_MAX_USD ?? Number.POSITIVE_INFINITY);
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;
const { createChatModel: real, spent } = billedModels(MODEL, PROVIDER);

const [part, parts] = (process.env.INCARNAMIND_LIVE_SHARD ?? "1/1").split("/").map(Number);
const CASES = (SET === "lists" ? FIGURE_LISTS : FIGURE_WORDS).filter(
  (_, at) => at % (parts || 1) === (part || 1) - 1,
);

/** The case's Document, written into a folder of its own, as the format it names. */
async function writeDataset(set: WordsDataset, folder: string): Promise<string> {
  const path = join(folder, set.file);
  const lines = [set.columns, ...set.rows].map((row) =>
    row.map((value) => (typeof value === "number" ? value.toLocaleString("en-US") : value)),
  );
  const contents = (() => {
    switch (set.kind) {
      case "csv":
        return [set.columns, ...set.rows].map((row) => row.join(",")).join("\n");
      case "xlsx":
        return writeXlsx(
          {
            sheets: [
              {
                id: "sheet",
                name: set.title.en,
                columns: set.columns.map((_, at) => ({ id: String(at) })),
                rows: [set.columns, ...set.rows].map((row, at) => ({
                  id: String(at),
                  ...(at === 0 && { header: true }),
                  cells: row.map((value, column) => ({
                    column: String(column),
                    value:
                      typeof value === "number"
                        ? { kind: "number" as const, number: value }
                        : { kind: "text" as const, text: value },
                  })),
                })),
              },
            ],
          },
          deflateRawSync,
          { author: "Test", created: "2026-11-06T00:00:00.000Z" },
        );
      case "pdf":
        return buildPdf([
          {
            lines: [set.title.en],
            placed: lines.flatMap((cells, row) =>
              cells.map((text, column) => ({ text, x: 72 + column * 120, y: 660 - row * 16 })),
            ),
          },
        ]);
      case "docx":
        return wordFile({
          body: [paragraph(set.title.en, { style: "Title" }), table(lines)].join(""),
        });
      case "pptx": {
        const cellXml = (text: string) =>
          `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-GB"/><a:t>${escapeXml(text)}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`;
        const frame = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="1100000"/><a:ext cx="8000000" cy="3600000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${'<a:gridCol w="2000000"/>'.repeat(set.columns.length)}</a:tblGrid>${lines
          .map((row) => `<a:tr h="300000">${row.map(cellXml).join("")}</a:tr>`)
          .join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
        const title = sp({
          id: 2,
          name: "Title",
          ph: `<p:ph type="title"/>`,
          spPr: xfrm(457200, 200000, 8000000, 800000),
          body: txBody(para(escapeXml(set.title.en))),
        });
        return pptxOf({ slides: [{ shapes: title + frame }] });
      }
    }
  })();
  await writeFile(path, contents);
  return path;
}

const runsOf = (rows: readonly number[]) =>
  rows.reduce<[number, number][]>((runs, row) => {
    const last = runs.at(-1);
    if (last && row === last[1] + 1) last[1] = row;
    else runs.push([row, row]);
    return runs;
  }, []);

const numberOf = (cell: AnalysisCell | undefined) =>
  typeof cell === "number" ? cell : Number(String(cell ?? "").replaceAll(",", ""));

/** The case's figures, [=1] first. */
const figuresOf = (held: WordsCase): WordsFigure[] => [held.figure, ...(held.also ?? [])];

/** The Analysis's results from its input as IncarnaMind read it, so each is worked out again to the same number. */
function answerFor(held: WordsCase, job: AnalysisJob): FakeAnswer {
  const set: WordsDataset = WORDS_DATASETS[held.figure.dataset];
  const input = job.inputs.find((each) => each.kind === "table");
  if (input?.kind !== "table") throw new Error(`No table input: ${JSON.stringify(job.inputs)}`);
  const columnAt = (heading: string) => {
    const found = input.columns.findIndex((each) => each.trim().toLowerCase() === heading);
    if (found < 0) throw new Error(`No ${heading} column in ${input.columns.join(", ")}`);
    return found;
  };
  const keyAt = columnAt(set.key);
  const [, , first = held.figure.column] = set.columns;
  const firstAt = columnAt(first);
  const rows = input.rows.map((cells, index) => ({
    cells,
    number: input.rowNumbers?.[index] ?? input.firstRow + index,
  }));
  const figureOf = (each: WordsFigure, at: number): AnalysisValue => {
    const valueAt = columnAt(each.column);
    const kept = rows.filter((row) => String(row.cells[keyAt]).trim() === each.group);
    const values = kept.map((row) => numberOf(row.cells[valueAt]));
    const total = values.reduce((sum, value) => sum + value, 0);
    return {
      kind: "figure",
      name: `figure_${at + 1}`,
      label: wordsLabel(held.language, each),
      unit: set.units[each.column] ?? "",
      value:
        each.how === "sum"
          ? total
          : each.how === "mean"
            ? total / values.length
            : Math.max(...values),
      of: {
        input: set.input,
        columns: [input.columns[valueAt] ?? each.column],
        rows: runsOf(kept.map((row) => row.number)),
        count: kept.length,
        how: each.how,
      },
    };
  };
  const groups = [...new Set(rows.map((row) => String(row.cells[keyAt]).trim()))];
  const totals = groups.map((group) => [
    group,
    rows
      .filter((row) => String(row.cells[keyAt]).trim() === group)
      .reduce((sum, row) => sum + numberOf(row.cells[firstAt]), 0),
  ]);
  return {
    output: {
      ...noAnalysisOutput(),
      results: [
        {
          kind: "table",
          name: "totals",
          label: set.title[held.language],
          unit: set.units[first] ?? "",
          table: {
            columns: [set.key, first],
            rows: totals,
            rowCount: totals.length,
            columnCount: 2,
          },
        },
        ...figuresOf(held).map(figureOf),
      ],
    },
  };
}

function codeOf(held: WordsCase): string {
  const set: WordsDataset = WORDS_DATASETS[held.figure.dataset];
  const [, , first] = set.columns;
  return [
    `df = inputs["${set.input}"]`,
    `totals = df.groupby("${set.key}", as_index=False)["${first}"].sum()`,
    `result("totals", totals, "${set.title[held.language]}")`,
    ...figuresOf(held).map(
      (each, at) =>
        `figure("figure_${at + 1}", df[df["${set.key}"] == "${each.group}"]["${each.column}"], "${each.how}", "${wordsLabel(held.language, each)}")`,
    ),
  ].join("\n");
}

/** What a retyped case's Answer writes in place of its sentence: the figure in a line of its own. */
const PLACEHOLDER = { en: "Figure: [=1].", "zh-CN": "数字：[=1]。" } as const;

function contentOf(held: WordsCase): string {
  const { shape, sentence } = held;
  const body = (() => {
    switch (shape.kind) {
      case "answer":
        return `${shape.before ? `${shape.before}${held.language === "en" ? " " : ""}` : ""}${sentence}`;
      case "line":
        return `${shape.line}\n\n${sentence}`;
      case "heading":
        return `## ${shape.heading}\n\n${sentence}`;
      case "retyped":
        return PLACEHOLDER[held.language];
      case "cell":
        return `${shape.caption}\n\n| ${shape.headings[0]} | ${shape.headings[1]} |\n| --- | --- |\n| ${shape.label} | ${sentence} |`;
      case "list":
        return sentence;
    }
  })();
  const set: WordsDataset = WORDS_DATASETS[held.figure.dataset];
  return [`# ${set.title[held.language]}`, "", "[=table 1]", "", body].join("\n");
}

/** A list the Answer gives in the assistant, for the User to add to a Note, rather than writing it into one. */
const addedOf = (held: WordsCase) => held.shape.kind === "list" && held.shape.added === true;

function answering(held: WordsCase) {
  const set: WordsDataset = WORDS_DATASETS[held.figure.dataset];
  const title = set.title[held.language];
  const code = codeOf(held);
  return scriptedModel(
    (call: ModelCall) => {
      if (isCheckRun(call)) return checkReply(call, {});
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search) return { calls: [{ tool: "search_documents", input: { query: set.title.en } }] };
      if (!call.results.some((result) => result.tool === "run_analysis")) {
        const base = set.file.replace(/\.[a-z]+$/u, "");
        const passage = shownPassages(search.text).find((each) => each.document.startsWith(base));
        return {
          calls: [
            {
              tool: "run_analysis",
              input: { title, inputs: [{ name: set.input, passage: passage?.id ?? "" }], code },
            },
          ],
        };
      }
      if (addedOf(held)) return { text: contentOf(held) };
      if (!call.results.some((result) => result.tool === "create_mind"))
        return { calls: [{ tool: "create_mind", input: { title, content: contentOf(held) } }] };
      return { text: held.language === "en" ? "Written into the note." : "已写入笔记。" };
    },
    {
      generate: (call: GenerateCall) => {
        if (call.system.startsWith("You sort the sentences"))
          return {
            text: JSON.stringify({
              sentences: listedSentences(call.prompt).map(({ number, text }) => ({
                number,
                parts: [{ kind: "fact", text }],
              })),
            }),
          };
        return checkGenerate({})(call);
      },
    },
  );
}

/** The User types the sentence's words around the figure, in the line that holds it alone. */
function retype(client: MindClient, sentence: string): void {
  const [said = "", after = ""] = sentence.split("[=1]");
  const line = client.blocks
    .toArray()
    .find(
      (each): each is Y.XmlElement =>
        each instanceof Y.XmlElement &&
        each.nodeName === "paragraph" &&
        each
          .toArray()
          .some((node) => node instanceof Y.XmlElement && node.nodeName === CALCULATED_FIGURE_NODE),
    );
  if (!line) throw new Error("No line holds the figure.");
  client.doc.transact(() => {
    const nodes = line.toArray();
    const at = nodes.findIndex(
      (node) => node instanceof Y.XmlElement && node.nodeName === CALCULATED_FIGURE_NODE,
    );
    for (let index = nodes.length - 1; index >= 0; index--)
      if (index !== at && nodes[index] instanceof Y.XmlText) line.delete(index, 1);
    const figureAt = line
      .toArray()
      .findIndex(
        (node) => node instanceof Y.XmlElement && node.nodeName === CALCULATED_FIGURE_NODE,
      );
    if (after) line.insert(figureAt + 1, [new Y.XmlText(after)]);
    if (said) line.insert(figureAt, [new Y.XmlText(said)]);
  });
}

/** Add to note on the whole Answer, as the assistant's button does it, into a Note of the User's own. */
async function addedToNote(core: Core, answer: ConversationAnswer, question: string) {
  const mind = await core.createMind({ title: "Added" });
  const blocks = pageBlocks(answer, question);
  await core.addToNote({
    mindId: mind.id,
    blocks,
    figureRuns: figureRunsOfAnswer(answer, blocks),
    origin: { from: messageReference(answer.conversationId, answer.id), question },
    model: answer.model,
  });
  return mind.id;
}

interface Read {
  /** The check on the sentence's words, or on the cell's figure, that holds the Analysis's figure. */
  sentence: string;
  /** What the Note says there once written, its figures as shown. */
  written: string;
}

const stateOf = (check: ReturnType<typeof readClaimCheck>) =>
  check ? (check.state === "not-checked" ? `not-checked ${check.reason}` : check.state) : "none";

function readNote(blocks: readonly NodeJSON[]): Read {
  let sentence = "none";
  let written = "";
  const textOf = (node: NodeJSON): string =>
    node.type === "text"
      ? (node.text ?? "")
      : node.type === CALCULATED_FIGURE_NODE
        ? (readCalculatedFigureAttributes(node.attrs)?.figure.shown ?? "")
        : (node.content ?? []).map(textOf).join(node.type === "tableRow" ? " | " : "");
  const holdsFigure = (node: NodeJSON): boolean =>
    node.type === CALCULATED_FIGURE_NODE || (node.content ?? []).some(holdsFigure);
  for (const block of blocks) {
    if (block.attrs?.[ANALYSIS_TABLE_ATTRIBUTE] || !holdsFigure(block)) continue;
    written = textOf(block);
    const visit = (node: NodeJSON) => {
      for (const mark of node.marks ?? []) {
        const check = mark.type === CLAIM_CHECK_MARK ? readClaimCheck(mark.attrs) : null;
        if (check?.figures?.some((figure) => figure.calculated?.figure.analysis))
          sentence = stateOf(check);
      }
      if (node.type === CALCULATED_FIGURE_NODE && block.type === "table") {
        const check = readClaimCheck(node.attrs?.claimCheck);
        if (check) sentence = stateOf(check);
      }
      for (const child of node.content ?? []) visit(child);
    };
    visit(block);
  }
  return { sentence, written };
}

test.skipIf(!RUNS || (!SCRIPTED && KEY === undefined)).each(CASES.map((held) => ({ ...held })))(
  "$name ($kind): an Analysis figure's words are the judge's, and never a false Supported",
  { timeout: 600_000 },
  async (held) => {
    if (spent() > MAX_USD) return;
    const set: WordsDataset = WORDS_DATASETS[held.figure.dataset];
    const heard: string[] = [];
    const scripted = answering(held);
    const core = startCore(await createTempDataFolder(), {
      createChatModel: SCRIPTED ? () => scripted : routedChecks(scripted, real, heard),
      analysisRuntime: createFakeAnalysisRuntime({ answer: (job) => answerFor(held, job) }),
      // The catalog offers the Analysis Tool only to models measured with it; the Answer here is
      // scripted, and only the check runs on the model.
      ...(!SCRIPTED && PROVIDER === "deepseek" && { modelFacts: () => ({ analysisTool: true }) }),
    });
    core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));
    const saved = await core.saveChatProvider({
      kind: SCRIPTED ? "anthropic" : PROVIDER,
      apiKey: SCRIPTED ? "sk-ant-test" : (KEY ?? ""),
      modelId: SCRIPTED ? "claude-haiku-5-5" : MODEL,
    });
    if (saved.service) await core.allowDataFlow("chat", saved.service.id);
    if (held.language === "zh-CN") await core.updateSettings({ user: { language: "zh-CN" } });
    await addAndProcess(core, [await writeDataset(set, await createTempDataFolder())]);
    const question =
      held.language === "en"
        ? `Summarise ${set.title.en} by ${set.key}${addedOf(held) ? "" : " and write a note"}.`
        : `按${set.key}汇总${set.title["zh-CN"]}${addedOf(held) ? "" : "并写成笔记"}。`;
    const asked = await askAssistant(core, {
      text: question,
      mindId: (await core.createMind({ title: "Questions" })).id,
      analyse: true,
    });
    const made = addedOf(held)
      ? await addedToNote(core, asked, question)
      : asked.toolCalls.find((call) => call.tool === "create_mind" && call.status === "done")
          ?.mindChange?.mindId;
    if (!made) throw new Error(`No Note: ${JSON.stringify(asked.toolCalls).slice(0, 600)}`);
    const client = await connectToMind(core, made);
    await client.settled();
    await resolveChanges(client, "accept");
    if (held.shape.kind === "retyped") {
      retype(client, held.sentence);
      await client.settled();
    }
    await core.checkMind({ requestId: randomUUID(), mindId: made, mode: "changed" });
    await client.settled();
    const rows = (await core.getFigureSchedule(made)).rows
      .filter((row) => !row.analysisTable && row.calculated?.figure.analysis)
      .map((row) =>
        row.shown.state === "not-checked" ? `not-checked ${row.shown.reason}` : row.shown.state,
      );
    const read = readNote(
      topLevelBlocks(client.doc.getXmlFragment(MIND_CONTENT_FIELD)).map(nodeOf),
    );
    const documents = await core.listDocuments();
    const [stored] = await core.readMindContents([made]);
    if (!stored) throw new Error("No content.");
    const badge =
      readNoteState({
        doc: client.doc,
        cellFigures: stored.cellFigures,
        documents,
        keptCitationTexts: [],
        folderId: null,
      }).state?.kind ?? "none";
    const home =
      homeReading(stored, {
        documents,
        keptCitationTexts: [],
        library: await core.getLibrary(),
        folderId: null,
      }).state?.kind ?? "none";
    core.close();
    const stated = read.sentence === "supported";
    const green = stated || rows.includes("supported") || badge === "checked" || home === "checked";
    const recalled = stated && rows.length > 0 && rows.every((each) => each === "supported");
    const disagrees =
      stated !== (rows.length > 0 && rows.every((each) => each === "supported")) ||
      (!stated && (badge === "checked" || home === "checked")) ||
      badge !== home;
    const outcome = held.right
      ? recalled
        ? "recalled"
        : "missed"
      : green
        ? "FALSE SUPPORTED"
        : "held";
    if (REPORT)
      await appendFile(
        REPORT,
        `${JSON.stringify({ name: held.name, language: held.language, kind: held.kind, source: set.kind, shape: held.shape.kind === "list" ? `${held.shape.added ? "added" : "list"} ${held.shape.form}` : held.shape.kind, right: held.right, outcome, disagrees, sentence: read.sentence, rows, badge, home, written: read.written, said: held.sentence, heard, spent: Number(spent().toFixed(4)) })}\n`,
      );
    // A Note whose figure no check reached would read "held" while testing nothing.
    expect(read.sentence).not.toBe("none");
    expect(rows.length).toBeGreaterThan(0);
    if (!held.right) expect(outcome).toBe("held");
  },
);
