/**
 * The AI flows `npm run eval:speed` times (eval/speed/README.md), each driven through the core as
 * the app drives it, in English and Chinese. A flow's run is timed from the User's action, as
 * the events the window shows arrive: the first sign of work, the first words (in the panel or
 * the page), the first change in the page, the end, and the longest wait with no sign between them. The
 * model requests and local steps it made come from the core's own timing records
 * (src/core/timing), tagged with the flow.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { type Core, type Document, messageReference } from "../../src/core";
import { pageBlocks } from "../../src/shared/answerBlocks";
import { connectToMind } from "../../tests/helpers/mindClient";
import { note, writeMind } from "../../tests/helpers/minds";
import { ask } from "../everyday/asking";
import { LIBRARY_FLOWS } from "./libraryFlows";
import { type Flow, type FlowContext, type Language, timed, wordsAtEnd } from "./signs";

export { type Flow, type FlowContext, type FlowSigns, type Language, SIGNS, timed } from "./signs";

const inLanguage = <T>(language: Language, words: Record<Language, T>): T => words[language];

/** A Research Task of one step that takes longer than this is stopped and counted as failed. */
const TASK_LIMIT_MS = 5 * 60_000;

/** A Mind with these paragraphs, settled, and the ids of its paragraphs. */
async function mindWith(core: Core, language: Language, paragraphs: readonly string[]) {
  const mind = await core.createMind({ title: inLanguage(language, BRIEFING) });
  const client = await connectToMind(core, mind.id);
  const blocks = paragraphs.map((text) => note(text));
  writeMind(client, blocks);
  await client.settled();
  return { mindId: mind.id, blockIds: blocks.map((block) => String(block.attrs?.id)) };
}

const BRIEFING = { en: "Briefing", "zh-CN": "简报" };
const NOTES = { en: "Notes for Monday's briefing.", "zh-CN": "周一简报的笔记。" };
const INFORMAL = {
  en: "it says the bank will cut emissions by 45% by 2032 and that it helps clients do it too.",
  "zh-CN": "报告说银行到2032年会减排45%，还会帮客户一起减。",
};
const CLAIM = {
  en: "The Vantrell report sets targets for its financed emissions.",
  "zh-CN": "Vantrell 的报告为其融资排放设定了目标。",
};
const SUMMARISE = {
  en: "Summarise the Vantrell report's emissions targets in a short paragraph",
  "zh-CN": "用一小段话概括 Vantrell 报告的排放目标",
};
const LONGER = { en: "Make the summary longer.", "zh-CN": "把摘要写长一点。" };
const UN_CLAIM = {
  en: "The Norvath Assembly's 2022 annual report covers its work in more than 90 countries.",
  "zh-CN": "Norvath Assembly 2022 年度报告介绍了它在 90 多个国家的工作。",
};

/** Two sentences of the Vantrell report, each with the words of it a Citation quotes and its page. */
const CITED = [
  {
    en: "Vantrell aims to finance more than $1.4 trillion for sustainable development over eight years.",
    "zh-CN": "Vantrell 计划在八年内为可持续发展提供超过 1.4 万亿美元的资金。",
    quote: "more than $1.4 trillion over eight years",
    page: 8,
  },
  {
    en: "Vantrell plans to cut its Scope 1 and 2 emissions by 45% by 2032.",
    "zh-CN": "Vantrell 计划到 2032 年将范围一和范围二排放减少 45%。",
    quote: "cutting Scope 1 and 2 emissions by 45% by 2032",
    page: 20,
  },
] as const;

/** A paragraph of `sentence` with a found Citation of `document`, as an Answer added to a Note writes one. */
function citedParagraph(
  sentence: string,
  document: Document,
  quote: string,
  page: number,
): JSONContent {
  return {
    type: "paragraph",
    attrs: { id: randomUUID() },
    content: [
      { type: "text", text: `${sentence} ` },
      {
        type: "citation",
        attrs: {
          passageId: randomUUID(),
          documentId: document.id,
          documentName: document.name,
          contentHash: document.contentHash,
          pageFrom: page,
          pageTo: page,
          location: null,
          quote,
          check: "found",
          checkReason: null,
        },
      },
    ],
  };
}

/** A short document someone else wrote, to verify: what the sample reports say, in four sentences. */
const BRIEFING_NOTE = {
  en: [
    "# Briefing note",
    "",
    "Vantrell aims to finance more than $1.4 trillion for sustainable development over eight years.",
    "",
    "In 2022 Vantrell financed and facilitated about $118 billion toward that target.",
    "",
    "Vantrell plans to cut the emissions of its own operations by 45% by 2032.",
    "",
    "The Norvath Assembly's Stability Fund approved $142 million in programming in 2022.",
  ],
  "zh-CN": [
    "# 简报",
    "",
    "Vantrell 计划在八年内为可持续发展提供超过 1.4 万亿美元的资金。",
    "",
    "2022 年，Vantrell 为该目标提供和促成了约 1180 亿美元的资金。",
    "",
    "Vantrell 计划到 2032 年将自身运营的排放减少 45%。",
    "",
    "Norvath Assembly 的稳定基金在 2022 年批准了 1.42 亿美元的项目资金。",
  ],
};

function asked(text: Record<Language, string>, paragraphs: (language: Language) => string[]) {
  return async ({ core, language }: FlowContext) => {
    const { mindId } = await mindWith(core, language, paragraphs(language));
    return timed(core, mindId, () =>
      ask(core, { text: text[language], mindId, conversationId: null, focus: null }),
    );
  };
}

const documentsNamed = (documents: ReadonlyMap<string, Document>, ...parts: string[]) =>
  parts.flatMap(
    (part) => [...documents.values()].find((document) => document.name.includes(part))?.id ?? [],
  );

export const FLOWS: readonly Flow[] = [
  {
    id: "question",
    label: "Ask a Question in the assistant",
    run: asked(
      {
        en: "What does the Vantrell report say about emissions?",
        "zh-CN": "Norvath Assembly 2022 年度报告的重点是什么？",
      },
      (language) => [NOTES[language]],
    ),
  },
  {
    id: "assistant-write",
    label: "Ask the assistant to write into the page",
    run: asked(
      {
        en: "Add the ESG report's main targets to my notes",
        "zh-CN": "把 ESG 报告的主要目标加到我的笔记里",
      },
      (language) => [NOTES[language]],
    ),
  },
  {
    id: "assistant-edit",
    label: "Ask the assistant to edit a paragraph",
    run: asked(
      { en: "Make the second paragraph more formal", "zh-CN": "把第二段改得更正式" },
      (language) => [CLAIM[language], INFORMAL[language]],
    ),
  },
  {
    id: "assistant-longer",
    label: "Ask the assistant to make a summary it added to the page longer",
    async run({ core, language }) {
      const { mindId } = await mindWith(core, language, [NOTES[language]]);
      const question = SUMMARISE[language];
      const summary = await ask(core, {
        text: question,
        mindId,
        conversationId: null,
        focus: null,
      });
      await core.addToNote({
        mindId,
        blocks: pageBlocks(summary, question),
        origin: { from: messageReference(summary.conversationId, summary.id), question },
        model: summary.model,
      });
      const client = await connectToMind(core, mindId);
      await client.settled();
      return timed(core, mindId, () =>
        ask(core, {
          text: LONGER[language],
          mindId,
          conversationId: summary.conversationId,
          focus: null,
        }),
      );
    },
  },
  {
    id: "edit-with-ai",
    label: "Edit with AI: improve a paragraph",
    async run({ core, language }) {
      const text = INFORMAL[language];
      const { mindId, blockIds } = await mindWith(core, language, [text]);
      const blockId = blockIds[0] ?? "";
      return timed(core, mindId, () =>
        core.editWithAi({
          requestId: randomUUID(),
          mindId,
          from: { blockId, offset: 0 },
          to: { blockId, offset: text.length },
          text,
          action: "improve",
        }),
      );
    },
  },
  {
    id: "find-support",
    label: "Find support for a sentence",
    async run({ core, language }) {
      const text = CLAIM[language];
      const { mindId, blockIds } = await mindWith(core, language, [text]);
      const blockId = blockIds[0] ?? "";
      return timed(core, mindId, () =>
        core.checkSentences({
          requestId: randomUUID(),
          mindId,
          action: "find-support",
          from: { blockId, offset: 0 },
          to: { blockId, offset: text.length },
          allDocuments: true,
        }),
      );
    },
  },
  {
    id: "check-mind",
    label: "Check this Mind (three sentences)",
    async run({ core, language }) {
      const { mindId } = await mindWith(core, language, [
        CLAIM[language],
        INFORMAL[language],
        UN_CLAIM[language],
      ]);
      return timed(core, mindId, () =>
        core.checkMind({ requestId: randomUUID(), mindId, mode: "all", allDocuments: true }),
      );
    },
  },
  {
    id: "suggestion",
    label: "A suggestion as you write",
    async run({ core, language }) {
      const paragraph = inLanguage(language, {
        en: "Vantrell's 2022 report says that the bank",
        "zh-CN": "Vantrell 2022 年的报告说，这家银行",
      });
      const { mindId } = await mindWith(core, language, [paragraph]);
      return wordsAtEnd(
        await timed(core, mindId, () =>
          core.suggestNext({
            requestId: randomUUID(),
            mindId,
            paragraph,
            scope: { folderIds: [], tagIds: [], documentIds: [] },
          }),
        ),
      );
    },
  },
  {
    id: "comparison",
    label: "A comparison table: 2 Documents × 2 Questions",
    async run({ core, language, documents }) {
      const { mindId } = await mindWith(core, language, [NOTES[language]]);
      return timed(core, mindId, async () => {
        const filled = new Promise<void>((resolve) => {
          const stop = core.on("comparison.filling", (event) => {
            if (event.mindId !== mindId || event.filling) return;
            stop();
            resolve();
          });
        });
        const started = await core.compareDocuments({
          mindId,
          documentIds: documentsNamed(documents, "Vantrell", "Norvath"),
          questions: inLanguage(language, {
            en: ["What does it report about emissions?", "Who wrote it?"],
            "zh-CN": ["它对排放说了什么？", "它是谁写的？"],
          }),
        });
        if (!("started" in started) || !started.started) {
          throw new Error(`Not started: ${JSON.stringify(started)}`);
        }
        await filled;
      });
    },
  },
  {
    id: "calculation",
    label: "Ask a Question whose answer is a Calculated figure",
    run: asked(
      {
        en: "What share of the roughly $118 billion Vantrell financed toward its target in 2022 went to green financing?",
        "zh-CN": "Vantrell 2022 年为其目标提供的约 1180 亿美元中，绿色融资占多大比例？",
      },
      (language) => [NOTES[language]],
    ),
  },
  {
    id: "chart",
    label: "Ask the assistant to add a chart to the page",
    run: asked(
      {
        en: "Add a bar chart of what Vantrell financed toward its target in 2022, green and development, to my notes",
        "zh-CN": "把 Vantrell 2022 年为目标提供的绿色融资和发展融资做成柱状图，加到我的笔记里",
      },
      (language) => [NOTES[language]],
    ),
  },
  {
    id: "contradictions",
    label:
      "Check for contradictions: two cited sentences against the other Documents in their Folder",
    async run({ core, language, documents }) {
      const [vantrell, ...others] = documentsNamed(
        documents,
        "Vantrell",
        "Norvath",
        "National Risk",
      );
      const report = [...documents.values()].find((document) => document.id === vantrell);
      if (!report || others.length === 0) throw new Error("The sample reports aren't all here.");
      const folder = await core.createLibraryGroup({
        name: inLanguage(language, { en: "Climate finance", "zh-CN": "气候金融" }),
        description: "",
      });
      try {
        await core.moveToFolder({ documentIds: [report.id, ...others], folderId: folder.id });
        const mind = await core.createMind({
          title: inLanguage(language, BRIEFING),
          folderId: folder.id,
        });
        const client = await connectToMind(core, mind.id);
        writeMind(
          client,
          CITED.map((each) => citedParagraph(each[language], report, each.quote, each.page)),
        );
        await client.settled();
        return await timed(core, mind.id, () =>
          core.checkContradictions({ requestId: randomUUID(), mindId: mind.id }),
        );
      } finally {
        // Its Documents go back to Not in a Folder, so the flows after it search and sort as before.
        await core.deleteLibraryGroup(folder.id);
      }
    },
  },
  {
    id: "verify-document",
    label: "Verify a short document someone else wrote: read it, find its claims, check them",
    async run({ core, language }) {
      const folder = await mkdtemp(join(tmpdir(), "incarnamind-speed-verify-"));
      const path = join(folder, `${inLanguage(language, BRIEFING)} ${randomUUID().slice(0, 8)}.md`);
      await writeFile(path, BRIEFING_NOTE[language].join("\n"));
      let documentId: string | null = null;
      try {
        return await timed(core, null, async () => {
          const verified = await core.verifyDocument({ path });
          if (!verified.ok) throw new Error(`Not verified: ${verified.reason}`);
          documentId = verified.documentId;
          const mindId = verified.mind.id;
          const found = await core.findClaims({
            requestId: randomUUID(),
            mindId,
            allDocuments: true,
          });
          if (found.kind !== "found") throw new Error(`No claims found: ${JSON.stringify(found)}`);
          await core.verifyClaims({ requestId: randomUUID(), mindId, allDocuments: true });
        });
      } finally {
        // A new file each run, so each is read for the first time, and out of the Library after.
        if (documentId) await core.deleteDocument(documentId);
        await rm(folder, { recursive: true, force: true });
      }
    },
  },
  {
    id: "research-task",
    label: "A Research Task of one step from the Library, to its draft in the page",
    async run({ core, language }) {
      const { mindId } = await mindWith(core, language, [NOTES[language]]);
      return timed(core, mindId, async () => {
        const topic = inLanguage(language, {
          en: "How the Vantrell report sets targets for financed emissions",
          "zh-CN": "Vantrell 报告如何为融资排放设定目标",
        });
        let taskId: string | null = null;
        const ended = new Promise<string>((resolve) => {
          const stop = core.on("task.changed", (task) => {
            if (task.id !== taskId || task.status === "running") return;
            stop();
            resolve(task.status === "done" ? "done" : `${task.status}: ${task.problem ?? ""}`);
          });
        });
        const started = await core.startResearch({
          mindId,
          topic,
          plan: {
            title: topic,
            steps: [
              inLanguage(language, {
                en: "Find the report's targets for financed emissions and the years they run to",
                "zh-CN": "找出报告中融资排放的目标及其目标年份",
              }),
            ],
          },
          sources: { web: false, library: true },
          writeInto: { mindId },
          scope: { folderIds: [], tagIds: [], documentIds: [] },
        });
        if (!started.started) throw new Error(`Not started: ${JSON.stringify(started)}`);
        const id = started.task.id;
        taskId = id;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<"late">((resolve) => {
          timer = setTimeout(() => resolve("late"), TASK_LIMIT_MS);
        });
        const end = await Promise.race([ended, late]).finally(() => clearTimeout(timer));
        if (end === "late") {
          // Stopped, so a stream left open doesn't hold the run and its report back.
          await core.stopTask(id);
          throw new Error("The Research Task took too long.");
        }
        if (end !== "done") throw new Error(`The Task ended ${end}`);
      });
    },
  },
  {
    id: "research",
    label: "Plan a Research Task",
    async run({ core, language }) {
      const { mindId } = await mindWith(core, language, [NOTES[language]]);
      return wordsAtEnd(
        await timed(core, mindId, () =>
          core.planResearch({
            mindId,
            topic: inLanguage(language, {
              en: "How banks set targets for financed emissions",
              "zh-CN": "银行如何为融资排放设定目标",
            }),
            sources: { web: false, library: true },
          }),
        ),
      );
    },
  },
  ...LIBRARY_FLOWS,
];
