import type { MockLanguageModelV4 } from "ai/test";
import { expect } from "vitest";
import type {
  AnswerSearchTuning,
  CitationAttributes,
  CitationRecheck,
  Core,
  CoreAdapters,
  CoreEvents,
  Document,
  RecheckResult,
} from "../../src/core";
import { createTempDataFolder, startCore } from "./core";
import { addAndProcess, writeSourceFile } from "./documents";
import { turnOnEmbeddings } from "./embedding";
import { connectToMind, type MindClient } from "./mindClient";
import { answerIn, editMind, question, writeMind } from "./minds";
import {
  lastAnswerCall,
  type ModelCall,
  promptOf,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "./models";

/** A Passage as the search Tool showed it to the model. */
export interface ShownPassage {
  id: string;
  document: string;
  /** Its date as the model reads it, when known: `date="2025-05-14"`, `file-created="2026-10-18"`. */
  date: string | null;
  /** A PDF's: "3" or "3-4". Null for other kinds, which have a `location`. */
  pages: string | null;
  /** Every kind but PDF: where the Passage is, e.g. "slides 3–4" or "lines 1–12". */
  location: string | null;
  text: string;
}

/** For `answerSearch`: each search an Answer makes, as the names of the Documents its Passages came from. */
export function recordSearches() {
  const searches: string[][] = [];
  const answerSearch: AnswerSearchTuning = {
    observe: ({ passages }) =>
      searches.push([...new Set(passages.map((passage) => passage.documentName))].sort()),
  };
  return { searches, answerSearch };
}

/** The Passages in a search result (or in instructions), as the model reads them. */
export function shownPassages(result: string): ShownPassage[] {
  const passages: ShownPassage[] = [];
  const pattern =
    /<passage id="([^"]+)" document="([^"]*)"(?: ((?:date|file-created|file-modified)="[^"]+"))?(?: pages="([^"]+)")?(?: location="([^"]+)")?(?: cite="never")?>\n([\s\S]*?)\n<\/passage>/g;
  for (const match of result.matchAll(pattern)) {
    passages.push({
      id: match[1] as string,
      document: match[2] as string,
      date: match[3] ?? null,
      pages: match[4] ?? null,
      location: match[5] ?? null,
      text: match[6] as string,
    });
  }
  return passages;
}

export function transcriptCitations(
  call: ModelCall,
  shown: readonly ShownPassage[],
  quotes: Readonly<Record<number, string>>,
): ScriptedReply | null {
  const cited = call.results.filter((result) => result.tool === "cite").at(-1);
  const needsContext = cited?.text.includes("quote enough surrounding words") ?? false;
  if (cited && !needsContext) return null;
  const citations = Object.entries(quotes).map(([marker, quote]) => {
    const passage = shown.find((passage) => passage.text.includes(quote));
    return {
      marker: Number(marker),
      passage: passage?.id,
      quote:
        needsContext && passage
          ? passage.text.replace(/\[\d{1,2}:\d{2}(?::\d{2})?(?: [^\]\n]+)?\]\s*/g, "")
          : quote,
    };
  });
  return { calls: [{ tool: "cite", input: { citations } }] };
}

/** What a citing model does, step by step: search, give its records, then answer. */
export interface CitingPlan {
  /** What it searches for. */
  query: string;
  /** Its records, from the Passages the search showed it. */
  records(passages: ShownPassage[]): unknown[];
  /** Its Answer, with markers. */
  answer: string;
  /** What it writes before searching: a preamble. */
  preamble?: string;
  /** Holds the Answer's stream back once `after` characters are out, until `until` resolves. */
  pause?: { after: number; until: Promise<void> };
}

/** A model that calls Tools: it searches once, cites, then writes its Answer. */
export function citingModel(plan: CitingPlan): MockLanguageModelV4 {
  return scriptedModel((call: ModelCall): ScriptedReply => {
    if (!call.tools.includes("search_documents")) return { text: "No Tools were offered." };
    const searches = call.results.filter((result) => result.tool === "search_documents");
    const cited = call.results.some((result) => result.tool === "cite");
    if (searches.length === 0) {
      return {
        text: plan.preamble,
        calls: [{ tool: "search_documents", input: { query: plan.query } }],
      };
    }
    if (!cited) {
      const passages = shownPassages(searches.at(-1)?.text ?? "");
      return { calls: [{ tool: "cite", input: { citations: plan.records(passages) } }] };
    }
    return { text: plan.answer, pause: plan.pause };
  });
}

/** A model for a core under test that is never asked an Answer. */
export const unaskedModel = () => scriptedModel(() => ({ text: "No Answer was asked." }));

/** What the model was told about its records: the result of its last `cite` call. */
export function citeFeedback(model: MockLanguageModelV4): string {
  const last = model.doStreamCalls[lastAnswerCall(model)];
  if (!last) throw new Error("The model wasn't asked anything.");
  const texts: string[] = [];
  for (const message of last.prompt) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolName === "cite" && part.output.type === "text") {
        texts.push(part.output.value);
      }
    }
  }
  return texts.at(-1) ?? "";
}

/** A file to add as a Document. */
export interface SourceFile {
  name: string;
  contents: string | Uint8Array;
}

/**
 * A core with a local chat model (no consent needed), the files added and
 * processed as Documents, and a Mind with a client.
 */
export async function setUpWithDocuments(
  model: MockLanguageModelV4,
  files: readonly SourceFile[],
  overrides: Partial<CoreAdapters> = {},
  /** `embeddings`: turn them on (the built-in model) before the files are added; they are off by default. */
  { embeddings = false }: { embeddings?: boolean } = {},
) {
  const folder = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const models = scriptedModels(model);
  const core = startCore(folder, { createChatModel: models.createChatModel, ...overrides });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  if (embeddings) await turnOnEmbeddings(core);
  const paths = await Promise.all(
    files.map((file) => writeSourceFile(sources, file.name, file.contents)),
  );
  const documents: Document[] = paths.length > 0 ? await addAndProcess(core, paths) : [];
  const mind = await core.createMind({ title: "Tides" });
  const client = await connectToMind(core, mind.id);
  return { core, dataDir: folder, documents, mind, client, models };
}

/** Asks a Question at the end of the Mind and gives back what the model was sent for it. */
export async function contextOfNextQuestion(
  core: Core,
  client: MindClient,
  mindId: string,
  model: MockLanguageModelV4,
  text = "Which quarter grew most?",
): Promise<string> {
  const calls = model.doStreamCalls.length;
  const asked = question(text);
  editMind(client, (blocks) => [...blocks, asked]);
  await client.settled();
  const result = await core.askQuestion({ mindId, questionId: asked.attrs.id });
  if (!result.asked) throw new Error("The Question wasn't asked.");
  await answerEnded(core, result.answerId);
  return promptOf(model, calls)
    .map((message) => message.text)
    .join("\n\n");
}

/** Resolves with the next "answer.finished" or "answer.failed" event for this Answer. */
export function answerEnded(
  core: Core,
  answerId: string,
): Promise<
  | { event: "finished"; payload: CoreEvents["answer.finished"] }
  | { event: "failed"; payload: CoreEvents["answer.failed"] }
> {
  return new Promise((resolve) => {
    const stops = [
      core.on("answer.finished", (payload) => {
        if (payload.answerId !== answerId) return;
        for (const stop of stops) stop();
        resolve({ event: "finished", payload });
      }),
      core.on("answer.failed", (payload) => {
        if (payload.answerId !== answerId) return;
        for (const stop of stops) stop();
        resolve({ event: "failed", payload });
      }),
    ];
  });
}

/** Writes a Question into the Mind and asks it; returns the Answer's id. */
export async function askNew(
  core: Core,
  client: MindClient,
  mindId: string,
  text: string,
): Promise<string> {
  const asked = question(text);
  writeMind(client, [asked]);
  await client.settled();
  const result = await core.askQuestion({ mindId, questionId: asked.attrs.id });
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  return result.answerId;
}

/** Writes a Question into the Mind, asks it, and waits for its Answer to finish. */
export async function askAndFinish(
  core: Core,
  client: MindClient,
  mindId: string,
  text: string,
): Promise<{ answerId: string; finished: CoreEvents["answer.finished"] }> {
  const answerId = await askNew(core, client, mindId, text);
  const ended = await answerEnded(core, answerId);
  if (ended.event !== "finished") {
    throw new Error(`The Answer failed: ${JSON.stringify(ended.payload.error)}`);
  }
  // The core writes the Answer before it emits the event, and pushes each change to clients as it stores it.
  return { answerId, finished: ended.payload };
}

/**
 * The Citation nodes in an Answer, in order, as the editor reads them: their
 * Citation's attributes, without the `proposal` attribute every inline node
 * has (null where no Proposal adds or removes it).
 */
export function citationsIn(client: MindClient, answerId: string): CitationAttributes[] {
  const found: CitationAttributes[] = [];
  answerIn(client, answerId).descendants((node) => {
    if (node.type.name !== "citation") return;
    const { proposal: _proposal, ...attributes } = node.attrs;
    found.push(attributes as CitationAttributes);
  });
  return found;
}

/** Asserts there is exactly one Citation in the Answer and returns it. */
export function onlyCitation(client: MindClient, answerId: string): CitationAttributes {
  const citations = citationsIn(client, answerId);
  expect(citations).toHaveLength(1);
  return citations[0] as CitationAttributes;
}

/** A re-check that read its Document: one kept inside a wall fails the test that expected a read. */
export function checkedResult(result: RecheckResult): CitationRecheck {
  if ("keptInside" in result) throw new Error(`The Citation is kept inside ${result.keptInside}.`);
  return result;
}
