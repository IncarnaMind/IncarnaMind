/**
 * The pair set through a real Answer (#3410). Each pair's sentence is the User's draft in a Note,
 * and a Question asks for it in a note to the client in its own wording, and for what its Document
 * says of another clause: the Answer restates the sentence, the model's to cite or not, having read
 * the Document's Passage. Asked in the Note, the Note is then checked as Check this Note checks it;
 * asked in the assistant with the Note in focus, the Answer judges its own sentences as it ends.
 * Needs a chat model (`INCARNAMIND_EVAL_CHAT_*`, eval/README.md) and, for one with a price, a cap.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import * as Y from "yjs";
import {
  BLOCK_ID_ATTRIBUTE,
  type ChatModelChoice,
  type Core,
  type MarkedCitation,
  MIND_CONTENT_FIELD,
} from "../../src/core";
import { uncitedSentences } from "../../src/core/answers/checks/answerCheck";
import { likeness, wordsOf } from "../../src/core/answers/markerPlacement";
import { answerSentences } from "../../src/shared/answerSentences";
import { labelOf, priceOf, usdOf } from "../citations/cost";
import { checkNote } from "../citations/harness";
import { askOne } from "../lib/citations";
import { chatProviderOf, readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { createRecorder } from "../minds/record";
import { DOCUMENTS, PAIRS, type UncitedPair } from "./pairs";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** The least likeness an Answer's sentence needs to the pair's to be its restatement. */
const RESTATED = 0.5;

type Place = "note" | "assistant";

function questionOf(pair: UncitedPair): { draft: string; question: string } {
  const document = DOCUMENTS.find((each) => each.key === pair.document);
  const hook = document?.hooks.find((each) => each.sentence !== pair.passage);
  if (!document || !hook) throw new Error(`${pair.id}: no Document or other clause to ask about`);
  return pair.language === "en"
    ? {
        draft: `Draft for the client: ${pair.sentence}`,
        question: `Write my draft sentence above as a short note to the client, keeping its wording; just reply, don't change my page. Then add one sentence on what “${document.name}” says about ${hook.topic}.`,
      }
    : {
        draft: `给客户的草稿：${pair.sentence}`,
        question: `把我上面的草稿句子写成给客户的一段简短说明，保留原来的措辞；直接回复，不要改动我的页面。然后再加一句，说明“${document.name}”关于${hook.topic}说了什么。`,
      };
}

/** Of `sentences`, the one most like `text`, if alike enough. */
function likest<T extends { text: string }>(text: string, sentences: readonly T[], least: number) {
  const words = wordsOf(text);
  let best: { sentence: T; score: number } | null = null;
  for (const sentence of sentences) {
    const { score } = likeness(words, wordsOf(sentence.text));
    if (score >= least && (!best || score > best.score)) best = { sentence, score };
  }
  return best;
}

/**
 * The Answer's sentence that restates the pair's: the one most like it of those no nearer its
 * Passage, so a correction that quotes the Passage isn't taken for the draft written out.
 */
function restatementOf<T extends { text: string }>(pair: UncitedPair, sentences: readonly T[]) {
  const passage = wordsOf(pair.passage);
  return likest(
    pair.sentence,
    sentences.filter(
      (sentence) =>
        likeness(wordsOf(sentence.text), wordsOf(pair.sentence)).score >=
        likeness(wordsOf(sentence.text), passage).score,
    ),
    RESTATED,
  );
}

interface Restated {
  sentence: string;
  /** Its Citations as the User sees them: the quote and its check. */
  citations: {
    quote: string;
    check: string;
    checkReason?: string | null;
    verdict?: string | null;
    /** The Answer's judgement found it for a sentence its model left uncited (#3410). */
    foundByCheck?: boolean;
  }[];
}

/** Asked in the Note: the Answer's restatement, and the check of the Note for that sentence. */
async function inNote(
  library: Parameters<typeof askOne>[0],
  pair: UncitedPair,
  timeoutMs: number,
  secrets: readonly string[],
) {
  const { draft, question } = questionOf(pair);
  const answer = await askOne(
    library,
    {
      id: pair.id,
      language: pair.language,
      crossLingual: false,
      question,
      expected: { document: "", pages: [1, 1] as [number, number], quote: "" },
    },
    1,
    timeoutMs,
    [draft],
  );
  const mindId = answer.status === "done" ? answer.mindId : undefined;
  const checked =
    mindId === undefined
      ? null
      : await checkNote(library.core, mindId, question, timeoutMs, secrets);
  const found = restatementOf(pair, answer.sentences);
  const restated: Restated | null = found && {
    sentence: found.sentence.text,
    citations: answer.citations
      .filter((citation) => citation.sentence === found.sentence.text)
      .map(({ quote, check, checkReason }) => ({ quote, check, checkReason })),
  };
  const marks = checked?.check.kind === "checked" ? checked.check.sentences : [];
  const mark = restated
    ? likest(
        restated.sentence,
        marks.map((each) => ({ ...each, text: each.sentence })),
        0.8,
      )
    : null;
  return {
    status: answer.status,
    text: answer.text,
    restated,
    mark: mark && { outcome: mark.sentence.outcome, says: mark.sentence.says },
    marks,
    stop: checked?.stop ?? null,
  };
}

/** A Note of the User's own `paragraphs`, for the assistant's Question to have in focus. */
async function noteOf(core: Core, title: string, paragraphs: readonly string[]): Promise<string> {
  const mind = await core.createMind({ title });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, (await core.openMind(mind.id)).state);
  const before = Y.encodeStateVector(doc);
  doc.getXmlFragment(MIND_CONTENT_FIELD).push(
    paragraphs.map((words) => {
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.setAttribute(BLOCK_ID_ATTRIBUTE, randomUUID());
      paragraph.insert(0, [new Y.XmlText(words)]);
      return paragraph;
    }),
  );
  await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(doc, before));
  doc.destroy();
  return mind.id;
}

/**
 * Asked in the assistant with the draft's Note in focus: the restatement, once the Answer has
 * judged its sentences, with its Citations and, for one it left uncited, its mark (#3410).
 */
async function inAssistant(
  core: Core,
  pair: UncitedPair,
  model: ChatModelChoice,
  timeoutMs: number,
) {
  const { draft, question } = questionOf(pair);
  const mindId = await noteOf(core, `Evaluation ${pair.id}`, [draft]);
  const started = Date.now();
  const asked = await core.askInConversation({ text: question, mindId, model });
  if (!asked.asked) throw new Error(`${pair.id} couldn't be asked: ${JSON.stringify(asked)}`);
  const ended = started + timeoutMs;
  for (;;) {
    const { messages } = await core.getConversation(asked.conversation.id);
    const answer = messages.find((message) => message.id === asked.answerId);
    const cited =
      answer?.kind === "answer" &&
      answer.status !== "streaming" &&
      !answer.citations.some((citation) => citation.check === "checking");
    // An Answer that read Passages judges its uncited sentences too, and its steps keep the list
    // once that judgement gave a verdict, empty when it marked none. One with none to judge has
    // no list and waits for nothing; one whose list never comes is recorded as timed out.
    const uncitedLeft =
      answer?.kind === "answer" &&
      (answer.steps?.readPassages?.length ?? 0) > 0 &&
      uncitedSentences(answer.text).length > 0 &&
      answer.steps?.uncitedChecks === undefined;
    const done = cited && !uncitedLeft;
    if ((done || Date.now() > ended) && answer?.kind === "answer") {
      const cited = new Map<number, MarkedCitation>(
        answer.citations.map((citation) => [citation.marker, citation]),
      );
      const found = restatementOf(pair, answerSentences(answer.text));
      const restated: Restated | null = found && {
        sentence: found.sentence.text,
        citations: found.sentence.markers.flatMap((marker) => {
          const citation = cited.get(marker);
          return citation
            ? [
                {
                  quote: citation.quote,
                  check: citation.check,
                  checkReason: citation.checkReason,
                  verdict: citation.verdict ?? null,
                  foundByCheck: citation.foundByCheck === true,
                },
              ]
            : [];
        }),
      };
      const words = restated ? wordsOf(restated.sentence) : null;
      const mark = words
        ? answer.steps?.uncitedChecks?.find(
            (each) => likeness(words, wordsOf(each.sentence)).score >= 0.9,
          )
        : undefined;
      await core.closeMind(mindId);
      return {
        status: done ? answer.status : "timed-out",
        text: answer.text,
        restated,
        uncited: mark ? { check: mark.check, verdict: mark.verdict } : null,
        uncitedChecks: answer.steps?.uncitedChecks ?? null,
        seconds: (Date.now() - started) / 1000,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

test("the pair set through a real Answer", async () => {
  const log = createLog();
  const config = readConfig(root);
  const chat = config.chat;
  if (!chat) throw new Error("No model to ask: set INCARNAMIND_EVAL_CHAT_* (eval/README.md).");
  const ref = { kind: chat.kind, modelId: chat.modelId, endpoint: chat.endpoint };
  const price = priceOf(ref);
  const cap = Number(process.env.INCARNAMIND_EVAL_UNCITED_CAP_USD ?? Number.NaN);
  if (price && !(cap > 0)) {
    throw new Error("Set INCARNAMIND_EVAL_UNCITED_CAP_USD for a model with a price.");
  }
  const only = process.env.INCARNAMIND_EVAL_UNCITED_ONLY?.split(",").map((each) => each.trim());
  const pairs = PAIRS.filter((pair) => !only || only.includes(pair.id));
  const where = process.env.INCARNAMIND_EVAL_UNCITED_PLACES?.split(",").map((each) => each.trim());
  const places = (["note", "assistant"] as const).filter(
    (place) => !where || where.includes(place),
  );
  const secrets = chat.apiKey === null ? [] : [chat.apiKey];

  const out = join(root, "eval", "results", "uncited");
  const folder = join(out, "documents");
  mkdirSync(folder, { recursive: true });
  const documents = DOCUMENTS.map((document) => {
    const path = join(folder, `${document.name}.md`);
    writeFileSync(path, `${document.text.split("\n").join("\n\n")}\n`);
    return { key: document.key, path };
  });

  const recorder = createRecorder();
  const library = await openLibrary({
    name: "uncited",
    embedder: createWorkerEmbedder(),
    modelCache: join(config.cacheDir, "models"),
    reranker: createWorkerCrossEncoder(config.rerankOnCpu),
    documents,
    keep: config.keepData,
    log,
    embeddings: false,
    chatModels: (inner) => recorder.chatModels(inner),
  });
  const { core } = library;
  // Setting the model is the consent to send it the Questions, the Passages and the Notes' sentences.
  const stopConsent = core.on("consent.requested", (request) => {
    core
      .respondToConsent(
        request.requestId,
        request.flow.id === "chat" || request.flow.id === "checks",
      )
      .catch((error: unknown) => console.error(error));
  });
  const spent = () => usdOf(recorder.chat, price, chat.kind) ?? 0;
  const results: Record<string, unknown>[] = [];
  try {
    const provider = await core.saveChatProvider(chatProviderOf(chat));
    const model = { providerId: provider.id, modelId: chat.modelId };
    if (price) {
      await core.updateSettings({ user: { monthlyCap: { currency: "USD", amount: cap } } });
    }
    run: for (const pair of pairs) {
      for (const place of places satisfies readonly Place[]) {
        if (price && spent() >= cap) {
          log(`Stopped before ${pair.id}: $${spent().toFixed(4)} spent, the cap is $${cap}`);
          break run;
        }
        const requests = recorder.chat.requests;
        const note =
          place === "note" ? await inNote(library, pair, config.answerTimeoutMs, secrets) : null;
        const result = note ?? (await inAssistant(core, pair, model, config.answerTimeoutMs));
        results.push({
          id: pair.id,
          place,
          kind: pair.kind,
          language: pair.language,
          same: pair.same,
          heldOut: pair.heldOut,
          ...result,
          requests: recorder.chat.requests - requests,
          usd: spent(),
        });
        const shown = result.restated
          ? result.restated.citations.map((each) => each.check).join("+") || "uncited"
          : "not restated";
        const mark = note ? `; mark ${note.mark?.outcome ?? "none"}` : "";
        log(`${pair.id} ${place}: ${result.status}; ${shown}${mark} ($${spent().toFixed(4)})`);
        if (note?.stop) {
          log(`Stopped: ${note.stop}`);
          break run;
        }
      }
    }
  } finally {
    stopConsent();
    await library.close();
  }
  writeFileSync(
    join(out, `answers-${labelOf(chat).replaceAll("/", "-")}.json`),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  expect(results.length).toBeGreaterThan(0);
});
