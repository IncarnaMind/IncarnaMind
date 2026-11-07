/**
 * A Note made from an Answer carries the judgement the Answer's own check gave its sentences, on a
 * real model (#2313). Each case of `answerChecksCarried.cases.ts` is asked in a data folder of its
 * own and its sentences are judged as the app judges them. Then three Notes are made from the
 * Answer as the window makes them (Add to note into a Note of the User's, Add to note with only the
 * first cited paragraph selected, and Write as a note), and each Note's marks are read back from
 * the Note beside what the Answer's own Citations say of each sentence.
 *
 * The bar: every sentence the judgement settled carries exactly that verdict, a sentence it didn't
 * settle carries none, and no sentence reads Supported unless each of its Citations was judged
 * supported. A sentence that reads alike twice in one Answer is left out of the first part (it
 * may carry nothing) but not of the last.
 *
 * Runs only with INCARNAMIND_LIVE_KEY (a DeepSeek key; INCARNAMIND_LIVE_MODEL, "deepseek-flash" by
 * default). INCARNAMIND_LIVE_REPORT appends a line per run with what was spent so far, at the
 * catalog's peak price, and INCARNAMIND_LIVE_MAX_USD (2 by default) starts no run past it.
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { ConversationAnswer, Core } from "../../src/core";
import { forPage } from "../../src/core/answers/pointersBack";
import { CITATION_NODE, type ConversationQuestion } from "../../src/core/api";
import { messageReference } from "../../src/core/references";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { readNoteState } from "../../src/renderer/src/noteState";
import {
  answerBlocks,
  asQuoteChecked,
  pageBlocks,
  withAnswerChecks,
} from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { citedSentences } from "../../src/shared/citedSentences";
import { comparableSentence, INLINE_NODE } from "../../src/shared/sentences";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { billedModels } from "../helpers/liveBilling";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { CASES, type CarriedCase, ENTRY_POINTS, RUNS } from "./answerChecksCarried.cases";

const KEY = process.env.INCARNAMIND_LIVE_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_MODEL ?? "deepseek-flash";
const MAX_USD = Number(process.env.INCARNAMIND_LIVE_MAX_USD ?? 2);
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;
const { createChatModel, spent, tokens } = billedModels(MODEL, "deepseek");

type Verdict = "supported" | "unsupported" | "contradicted";
type Entry = (typeof ENTRY_POINTS)[number];

/** A sentence's words as the Answer and the Note both compare them: no marker, no space before one. */
const wordsOf = (text: string) =>
  comparableSentence(text.replace(new RegExp(`\\s+(?=${INLINE_NODE})`, "gu"), ""));

/**
 * What the Answer's own Citations say of each cited sentence: contradicted or unsupported when one
 * of them was judged so, supported when every one was judged supported, else nothing.
 */
function judgedSentences(answer: ConversationAnswer, question: string) {
  const byMarker = new Map(answer.citations.map((citation) => [citation.marker, citation]));
  return citedSentences(forPage(answer.text, question), answer.figures).map((cited) => {
    const citations = cited.markers.map((marker) => byMarker.get(marker));
    const known = citations.flatMap((citation) => (citation ? [citation] : []));
    const verdict: Verdict | null = cited.calculated
      ? null
      : known.some((citation) => citation.check === "contradicted")
        ? "contradicted"
        : known.some((citation) => citation.check === "unsupported")
          ? "unsupported"
          : citations.every((citation) => citation?.check === "found" && citation.judgedAt)
            ? "supported"
            : null;
    return { words: wordsOf(cited.sentence), verdict };
  });
}

/** The text of some Blocks, each Block's apart, an inline node other than text as one character. */
const textOfBlocks = (nodes: readonly NodeJSON[]): string =>
  nodes
    .map((node) =>
      node.type === "text"
        ? (node.text ?? "")
        : node.content
          ? `${textOfBlocks(node.content)} `
          : INLINE_NODE,
    )
    .join("");

/** The first top-level Block of the Answer, as its panel holds it, that cites: the selected part. */
function firstCitedBlock(answer: ConversationAnswer): NodeJSON[] {
  const cites = (node: NodeJSON): boolean =>
    node.type === CITATION_NODE || (node.content ?? []).some(cites);
  const block = answerBlocks(answer).find(cites);
  return block ? [block] : [];
}

async function answered(core: Core, text: string) {
  const result = await core.askInConversation({ text });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  const started = Date.now();
  while (Date.now() - started < 600_000) {
    const { messages } = await core.getConversation(result.conversation.id);
    const answer = messages.find((message) => message.id === result.answerId);
    if (answer?.kind === "answer" && answer.status !== "streaming") {
      if (answer.status === "failed") throw new Error(`The Answer failed: ${answer.errorMessage}`);
      if (!answer.citations.some((citation) => citation.check === "checking")) {
        const question = messages.find(
          (message): message is ConversationQuestion =>
            message.kind === "question" && message.id === answer.questionId,
        );
        return { answer, question, conversationId: result.conversation.id };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`No judged Answer to “${text}” in 10 minutes.`);
}

/** Makes one Note from the Answer as `entry` does, and reads its marks and its state back. */
async function noteFrom(
  core: Core,
  entry: Entry,
  made: Awaited<ReturnType<typeof answered>>,
  language: CarriedCase["language"],
) {
  const { answer, question, conversationId } = made;
  const asked = question?.text ?? "";
  const scope = question?.scope ?? null;
  const blocks =
    entry === "selected"
      ? withAnswerChecks(
          asQuoteChecked(firstCitedBlock(answer), answer.status),
          answer,
          asked,
          scope,
        )
      : withAnswerChecks(pageBlocks(answer, asked), answer, asked, scope);
  const mind = await core.createMind({ title: entry === "write" ? asked : "My notes" });
  const client = await connectToMind(core, mind.id);
  if (entry !== "write") {
    writeMind(client, [
      {
        type: "paragraph",
        content: [{ type: "text", text: language === "zh-CN" ? "我的笔记。" : "My own notes." }],
      },
    ]);
    await client.settled();
  }
  await core.addToNote({
    mindId: mind.id,
    blocks,
    origin: { from: messageReference(conversationId, answer.id), question: asked },
    model: answer.model,
  });
  await client.settled();
  const marks = claimSpans(readMind(client)).map((span) => ({
    words: wordsOf(span.check.text),
    state: span.check.state,
    fromAnswer: span.check.fromAnswer ?? null,
  }));
  const state = readNoteState({
    doc: client.doc,
    cellFigures: [],
    documents: await core.listDocuments(),
    keptCitationTexts: [],
    folderId: mind.folderId,
  }).state;
  return { blocks, marks, state: state?.kind ?? null };
}

describe.skipIf(!KEY)(
  "The judgement an Answer's sentences got, carried into its Notes, live",
  () => {
    test(`${MODEL}: each Note carries exactly the Answer's judgement, and nothing it didn't judge Supported`, {
      timeout: 7_200_000,
    }, async () => {
      const failures: string[] = [];
      const totals = { runs: 0, notes: 0, sentences: 0, carried: 0, exact: 0, falseSupported: 0 };
      for (let run = 1; run <= RUNS; run++) {
        for (const each of CASES) {
          if (spent() >= MAX_USD) {
            failures.push(
              `stopped before ${each.name}, run ${run}: ${spent().toFixed(4)} USD spent`,
            );
            continue;
          }
          const dataDir = await createTempDataFolder();
          const sources = await createTempDataFolder();
          const core = startCore(dataDir, { createChatModel });
          core.on(
            "consent.requested",
            (asked) => void core.respondToConsent(asked.requestId, true),
          );
          core.on(
            "approval.requested",
            (request) => void core.respondToApproval(request.requestId, "deny"),
          );
          await core.saveChatProvider({ kind: "deepseek", apiKey: KEY ?? "", modelId: MODEL });
          await core.updateSettings({ user: { language: each.language } });
          const paths = await Promise.all(
            each.documents.map((document) =>
              writeSourceFile(sources, document.name, document.contents),
            ),
          );
          await addAndProcess(core, paths);
          let line: Record<string, unknown> = { case: each.name, run, model: MODEL };
          try {
            const made = await answered(core, each.question);
            totals.runs++;
            const judged = judgedSentences(made.answer, made.question?.text ?? "");
            const repeated = new Set(
              judged
                .map((sentence) => sentence.words)
                .filter((words, at, all) => all.indexOf(words) !== at),
            );
            const entries: Record<string, unknown> = {};
            for (const entry of ENTRY_POINTS) {
              const note = await noteFrom(core, entry, made, each.language);
              totals.notes++;
              const shown = wordsOf(textOfBlocks(note.blocks));
              const expected = judged.filter(
                (sentence) => !repeated.has(sentence.words) && shown.includes(sentence.words),
              );
              const wrong = expected.flatMap((sentence) => {
                const carried = note.marks.filter((mark) => mark.words === sentence.words);
                const states = carried.map((mark) => mark.state);
                const right =
                  sentence.verdict === null
                    ? states.length === 0
                    : states.length === 1 && states[0] === sentence.verdict;
                return right ? [] : [{ ...sentence, carried: states }];
              });
              const falseSupported = note.marks.filter(
                (mark) =>
                  mark.state === "supported" &&
                  !judged.some(
                    (sentence) => sentence.words === mark.words && sentence.verdict === "supported",
                  ),
              );
              totals.sentences += expected.length;
              totals.carried += note.marks.length;
              totals.exact += expected.length - wrong.length;
              totals.falseSupported += falseSupported.length;
              for (const miss of wrong) {
                failures.push(`${each.name}, run ${run}, ${entry}: ${JSON.stringify(miss)}`);
              }
              for (const mark of falseSupported) {
                failures.push(
                  `${each.name}, run ${run}, ${entry}: Supported it wasn't judged: ${mark.words}`,
                );
              }
              entries[entry] = {
                state: note.state,
                sentences: expected.length,
                marks: note.marks,
                wrong,
                falseSupported: falseSupported.length,
              };
            }
            line = {
              ...line,
              answer: made.answer.text,
              citations: made.answer.citations.map(({ marker, check, judgedAt, verdict }) => ({
                marker,
                check,
                judged: judgedAt !== undefined,
                ...(verdict && { verdict }),
              })),
              judged,
              entries,
            };
          } catch (error) {
            failures.push(`${each.name}, run ${run}: ${String(error)}`);
            line = { ...line, error: String(error) };
          } finally {
            core.close();
          }
          line = { ...line, spentUsd: Number(spent().toFixed(4)), tokens: tokens() };
          if (REPORT) await appendFile(REPORT, `${JSON.stringify(line)}\n`);
        }
      }
      const summary = {
        model: MODEL,
        ...totals,
        spentUsd: Number(spent().toFixed(4)),
        tokens: tokens(),
      };
      if (REPORT) await appendFile(REPORT, `${JSON.stringify({ summary, failures })}\n`);
      expect(failures).toEqual([]);
    });
  },
);
