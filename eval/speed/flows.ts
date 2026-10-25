/**
 * The AI flows `npm run eval:speed` times (eval/speed/README.md), each driven through the core as
 * the app drives it, in English and Chinese. A flow's run is timed from the User's action, as
 * the events the window shows arrive: the first sign of work, the first words (in the panel or
 * the page), the first change in the page, the end, and the longest wait with no sign between them. The
 * model requests and local steps it made come from the core's own timing records
 * (src/core/timing), tagged with the flow.
 */
import { randomUUID } from "node:crypto";
import { type Core, type CoreEventName, type Document, messageReference } from "../../src/core";
import { pageBlocks } from "../../src/shared/answerBlocks";
import { connectToMind } from "../../tests/helpers/mindClient";
import { note, writeMind } from "../../tests/helpers/minds";
import { ask } from "../everyday/asking";

export type Language = "en" | "zh-CN";

export interface FlowContext {
  core: Core;
  language: Language;
  /** The sample reports. */
  documents: ReadonlyMap<string, Document>;
}

/** When the window saw each kind of sign, in milliseconds from the User's action. */
export interface FlowSigns {
  /** The User's action, after whatever the flow set up first. */
  startedAt: string;
  firstSignMs: number | null;
  firstWordsMs: number | null;
  /** The first change in the page, which an Answer's words in the panel may come before. */
  firstChangeMs: number | null;
  doneMs: number;
  /** The longest stretch with no new sign of work, from the action to the end. */
  longestQuietMs: number;
}

export interface Flow {
  id: string;
  /** What a User does, for the report. */
  label: string;
  run(context: FlowContext): Promise<FlowSigns>;
}

// A suggestion and a Research plan arrive whole, when the call returns: their words come at the end.
const wordsAtEnd = (signs: FlowSigns): FlowSigns => ({
  ...signs,
  firstWordsMs: signs.firstWordsMs ?? signs.doneMs,
});

/** The events that show the User something is happening; those in `WORDS` carry words. */
export const SIGNS: readonly CoreEventName[] = [
  "answer.started",
  "answer.phase",
  "answer.reasoning",
  "answer.delta",
  "answer.toolCallStarted",
  "answer.toolCallFinished",
  "answer.citationAdded",
  "mind.writing",
  "mind.update",
  "comparison.filling",
  "task.changed",
];
const WORDS: ReadonlySet<CoreEventName> = new Set(["answer.delta", "mind.update"]);

/** Times `act` by the signs the core sends while it runs, those of the Mind `mindId` only. */
export async function timed(
  core: Core,
  mindId: string,
  act: () => Promise<unknown>,
): Promise<FlowSigns> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const at = () => performance.now() - start;
  const signs: number[] = [];
  let firstWordsMs: number | null = null;
  let firstChangeMs: number | null = null;
  const stops = SIGNS.map((event) =>
    core.on(event, (payload: unknown) => {
      const place = payload as { mindId?: string | null };
      if (typeof place.mindId === "string" && place.mindId !== mindId) return;
      signs.push(at());
      if (WORDS.has(event)) firstWordsMs ??= at();
      if (event === "mind.update") firstChangeMs ??= at();
    }),
  );
  try {
    await act();
  } finally {
    for (const stop of stops) stop();
  }
  const doneMs = at();
  const marks = [0, ...signs, doneMs];
  const longestQuietMs = marks
    .slice(1)
    .reduce((longest, mark, index) => Math.max(longest, mark - (marks[index] ?? 0)), 0);
  return {
    startedAt,
    firstSignMs: signs[0] ?? null,
    firstWordsMs,
    firstChangeMs,
    doneMs,
    longestQuietMs,
  };
}

const inLanguage = <T>(language: Language, words: Record<Language, T>): T => words[language];

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
  en: "it says the bank will cut emissions a lot by 2030 and that it helps clients do it too.",
  "zh-CN": "报告说银行到2030年会大幅减排，还会帮客户一起减。",
};
const CLAIM = {
  en: "The JP Morgan report sets targets for its financed emissions.",
  "zh-CN": "摩根大通的报告为其融资排放设定了目标。",
};
const SUMMARISE = {
  en: "Summarise the JP Morgan report's emissions targets in a short paragraph",
  "zh-CN": "用一小段话概括摩根大通报告的排放目标",
};
const LONGER = { en: "Make the summary longer.", "zh-CN": "把摘要写长一点。" };
const UN_CLAIM = {
  en: "The UN's 2022 annual report covers its work in more than 190 countries.",
  "zh-CN": "联合国 2022 年度报告介绍了它在 190 多个国家的工作。",
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
        en: "What does the JP Morgan report say about emissions?",
        "zh-CN": "联合国 2022 年度报告的重点是什么？",
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
        en: "JP Morgan's 2022 report says that the bank",
        "zh-CN": "摩根大通 2022 年的报告说，这家银行",
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
          documentIds: documentsNamed(documents, "JP Morgan", "United Nations"),
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
];
