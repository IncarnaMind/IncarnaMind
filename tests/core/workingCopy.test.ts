/**
 * A Mind imported from Word is the working copy of its original (#1036):
 * asked "What is this résumé about?" beside it, an Answer cites the original
 * though no word of the Question is in it. A short Document's whole text goes
 * with the Question, as Passages a search would give, within a budget counted
 * as sent and fitted to the model's window; a long one's opening comes back
 * for a search that finds nothing. A Question about another Document searches
 * it as before.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { CoreAdapters } from "../../src/core";
import { estimateTokens } from "../../src/core/answers/context";
import { UP_FRONT_TOKEN_LIMIT } from "../../src/core/answers/documentText";
import { wordFileOf } from "../../src/shared/wordFiles";
import { askAssistant } from "../helpers/assistant";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { turnOnEmbeddings } from "../helpers/embedding";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { paragraph, wordFile } from "../helpers/word";
import { importWordMind } from "../helpers/wordMinds";

const RESUME = [
  paragraph("张伟", { style: "Title" }),
  paragraph("工作经历", { style: "Heading1" }),
  paragraph("2019 年至今在北京一家物流公司担任数据分析师，负责运输成本模型和周报。"),
  paragraph("教育背景", { style: "Heading1" }),
  paragraph("2015 年至 2019 年就读于武汉大学统计学专业，获学士学位。"),
];

const ABOUT_THE_RESUME = /this résumé|这份简历/;

const upFrontIn = (prompt: string) =>
  /<document-text>[\s\S]*?<\/document-text>/.exec(prompt)?.[0] ?? "";

const lastQuestion = (call: ModelCall) => call.prompt.split("\n").filter(Boolean).at(-1) ?? "";

/**
 * A model that, asked about "this résumé" with Passages given up front, cites
 * the first of them; otherwise searches the Question's words first, as a small
 * model does, then cites the first Passage found.
 */
function citingFirst(): { model: ReturnType<typeof scriptedModel>; prompts: string[] } {
  const prompts: string[] = [];
  const model = scriptedModel(
    (call: ModelCall): ScriptedReply => {
      prompts.push(call.prompt);
      const given = shownPassages(upFrontIn(call.prompt));
      const fromGiven = given.length > 0 && ABOUT_THE_RESUME.test(lastQuestion(call));
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (!fromGiven && searches.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query: lastQuestion(call) } }] };
      }
      if (!call.results.some((result) => result.tool === "cite")) {
        const [first] = fromGiven ? given : shownPassages(searches.at(-1)?.text ?? "");
        if (!first) return { text: "That Document isn't among your Documents." };
        const quote = first.text.split("\n").find((line) => line.trim().length > 8) ?? first.text;
        return {
          calls: [
            { tool: "cite", input: { citations: [{ marker: 1, passage: first.id, quote }] } },
          ],
        };
      }
      return { text: "It is a résumé [^1]." };
    },
    { judgesItsAnswers: true },
  );
  return { model, prompts };
}

/** Ollama's word on its model: a window of `numCtx` tokens. */
const ollamaWithWindow = (numCtx: number): CoreAdapters["ollamaModels"] => ({
  describe: async () => ({
    digest: null,
    capabilities: ["completion", "tools"],
    contextLength: numCtx,
    parameters: null,
    support: "tools",
    chat: true,
    remote: false,
    settings: { numCtx, outputTokens: numCtx / 4, keepAlive: "5m", think: false },
  }),
  loaded: async () => true,
  running: async () => true,
});

async function startWithModel({ numCtx }: { numCtx?: number } = {}) {
  const { model, prompts } = citingFirst();
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    ...(numCtx !== undefined && { ollamaModels: ollamaWithWindow(numCtx) }),
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  return { core, prompts, sources: await createTempDataFolder() };
}

async function setUp(body: readonly string[], { embeddings = false } = {}) {
  const { core, prompts, sources } = await startWithModel();
  if (embeddings) await turnOnEmbeddings(core);
  await mkdir(sources, { recursive: true });
  const path = join(sources, "ZW-2026.docx");
  await writeFile(path, wordFile({ body: body.join("") }));
  const imported = await importWordMind(core, { path, origin: "own", addOriginal: true });
  const documentId = wordFileOf(imported.client.doc)?.documentId;
  if (!documentId) throw new Error("The original wasn't added.");
  await waitForProcessing(core, [documentId]);
  return { core, mindId: imported.mindId, documentId, prompts, sources };
}

/** `count` lines of about `tokens` tokens each, no word in two of them. */
function lines(count: number, tokens: number): string[] {
  let word = 0;
  const words = () =>
    Array.from({ length: tokens - 2 }, () => (word++).toString(36).padStart(3, "0")).join(" ");
  return Array.from({ length: count }, (_, at) => `Line ${at + 1}: ${words()}`);
}

describe("A Mind imported from Word, and its original", { timeout: 60_000 }, () => {
  // protects=asked about "this résumé" beside its imported Mind, in Chinese and English, with embeddings off and on, an Answer cites the original, found, from its text given up front, though the Question shares no word with it, and the model is told the Mind is its working copy; fails_when=the Answer has no Citation, says the file isn't there, the text isn't given, or the model isn't told; no_claim=what a real model writes.
  test.each([
    ["这份简历讲了什么？", false],
    ["What is this résumé about?", false],
    ["这份简历讲了什么？", true],
    ["What is this résumé about?", true],
  ] as const)("“%s” cites the original (embeddings on: %s)", async (text, embeddings) => {
    const { core, mindId, documentId, prompts } = await setUp(RESUME, { embeddings });

    const answer = await askAssistant(core, { text, mindId });

    expect(answer.text).toBe("It is a résumé [^1].");
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0]).toMatchObject({ documentId, check: "found" });
    expect(answer.toolCalls.map((call) => call.tool)).not.toContain("search_documents");
    const block = upFrontIn(prompts[0] ?? "");
    expect(block).toContain('The whole text of "ZW-2026"');
    expect(estimateTokens(block)).toBeLessThanOrEqual(UP_FRONT_TOKEN_LIMIT);
  });

  // protects=a working copy's original too long to give whole still searches, and a search that finds nothing gets its opening Passages, which the Answer cites; fails_when=its whole text is sent, or the empty search ends the Answer with no Citation; no_claim=none beyond protects.
  test("too long to give whole, an empty search gets the original's opening", async () => {
    const long = Array.from({ length: 200 }, (_, at) =>
      paragraph(
        `第 ${at + 1} 项：负责华北区运输成本模型的第 ${at + 1} 个版本，并按周向管理层汇报结果与偏差原因。`,
      ),
    );
    const { core, mindId, documentId, prompts } = await setUp([...RESUME, ...long]);

    const answer = await askAssistant(core, { text: "What is this résumé about?", mindId });

    expect(prompts[0]).not.toContain("<document-text>");
    expect(answer.citations[0]).toMatchObject({ documentId, check: "found" });
  });

  // protects=beside the working copy, a Question about another Document finds and cites that one as before; fails_when=it cites the original, or finds nothing; no_claim=none beyond protects.
  test("a Question about another Document cites that Document", async () => {
    const { core, mindId, sources } = await setUp(RESUME);
    const lease = await writeSourceFile(
      sources,
      "Lease.md",
      `# Lease\n\n${Array.from({ length: 80 }, (_, at) => `Clause ${at + 1}: the rent is reviewed every year in March, and the tenant keeps the garden.`).join("\n\n")}\n`,
    );
    const [added] = await addAndProcess(core, [lease]);

    const answer = await askAssistant(core, {
      text: "When is the rent reviewed in March?",
      mindId,
    });

    expect(answer.citations[0]).toMatchObject({ documentId: added?.id, check: "found" });
  });
});

describe("A short scope's whole text, given with the Question", { timeout: 60_000 }, () => {
  // protects=the budget counts the text as sent, each Passage's tags too: twelve Notes whose text alone fits go up front only if they fit with their tags; fails_when=more than the budget is sent, or Notes that fit aren't given; no_claim=the exact cost of a tag.
  test.each([
    [4, true],
    [5, false],
  ])("is counted as sent: twelve Notes of %i lines given: %s", async (count, given) => {
    const { core, prompts, sources } = await startWithModel();
    const notes = await Promise.all(
      Array.from({ length: 12 }, (_, at) =>
        writeSourceFile(sources, `Note ${at + 1}.md`, `${lines(count, 98).join("\n")}\n`),
      ),
    );
    await addAndProcess(core, notes);

    await askAssistant(core, { text: "What do my notes say?" });

    const block = upFrontIn(prompts[0] ?? "");
    expect(block !== "").toBe(given);
    expect(estimateTokens(block)).toBeLessThanOrEqual(UP_FRONT_TOKEN_LIMIT);
  });

  // protects=Passages overlap, and the overlap is sent once: a Document whose Passages hold more than the budget, but whose text doesn't, goes up front with every line once; fails_when=a line is sent twice, the Document isn't given, or the block is over budget; no_claim=none beyond protects.
  test("drops the Passages' overlap, so each line goes once", async () => {
    const { core, prompts, sources } = await startWithModel();
    const text = lines(45, 100);
    const handbook = await writeSourceFile(sources, "Handbook.md", `${text.join("\n")}\n`);
    await addAndProcess(core, [handbook]);

    await askAssistant(core, { text: "What does the handbook say?" });

    const block = upFrontIn(prompts[0] ?? "");
    expect(block).toContain('The whole text of "Handbook"');
    expect(estimateTokens(block)).toBeLessThanOrEqual(UP_FRONT_TOKEN_LIMIT);
    for (const line of text) expect(block.split(line)).toHaveLength(2);
  });

  // protects=the notes a search's Passages get go with the same Passages given up front, e.g. the one for amounts in brackets (#978); fails_when=the block lacks the note; no_claim=the note's words.
  test("carries the notes a search's Passages carry", async () => {
    const { core, prompts, sources } = await startWithModel();
    const statement = await writeSourceFile(
      sources,
      "Statement.md",
      "# Statement\n\nRevenue: 80,000\n\nRent: (12,500)\n\nNet: 67,500\n",
    );
    await addAndProcess(core, [statement]);

    await askAssistant(core, { text: "What does the statement say?" });

    expect(upFrontIn(prompts[0] ?? "")).toContain(
      "An amount in brackets in these Passages is negative",
    );
  });

  // protects=where the model's window is small, less goes up front: a Document that fits the budget of a large window isn't given to a model with a 16k window, and nothing says it was; fails_when=the block or its claim is sent; no_claim=the exact share of the window.
  test("is fitted to the model's window", async () => {
    const { core, prompts, sources } = await startWithModel({ numCtx: 16_384 });
    const handbook = await writeSourceFile(
      sources,
      "Handbook.md",
      `${lines(5, 1_000).join("\n")}\n`,
    );
    await addAndProcess(core, [handbook]);

    await askAssistant(core, { text: "What does the handbook say?" });

    expect(prompts[0]).not.toContain("<document-text>");
    expect(prompts[0]).not.toContain("The whole text of");
  });
});
