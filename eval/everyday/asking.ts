/**
 * Asking an everyday request through the core, as the assistant does, and
 * holding its Answer to the guards in ./checks: what `npm run eval:everyday`
 * runs for each request, and what other evaluations that ask the assistant
 * the same way reuse. Also the Documents the requests are asked over.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { vi } from "vitest";
import * as Y from "yjs";
import {
  type AnswerUsage,
  type AskedQuote,
  BLOCK_ID_ATTRIBUTE,
  type ChatModelChoice,
  CITATION_NODE,
  type ConversationAnswer,
  type Core,
  MIND_CONTENT_FIELD,
  type MindFocus,
  messageReference,
} from "../../src/core";
import { forPage } from "../../src/core/answers/pointersBack";
import { toolRecordLines } from "../../src/core/answers/toolRecord";
import { plainText } from "../../src/core/mindText";
import type { createAiSdkChatModel } from "../../src/core/providers/models";
import { pageBlocks } from "../../src/shared/answerBlocks";
import { namesOneOf, sourcesAsText } from "../../src/shared/namedSources";
import { resolveProposals } from "../../src/shared/proposals";
import { connectToMind } from "../../tests/helpers/mindClient";
import { heading, note, writeMind } from "../../tests/helpers/minds";
import { paragraph, wordFile } from "../../tests/helpers/word";
import { importWordBytes } from "../../tests/helpers/wordMinds";
import type { ChatSettings, readConfig } from "../lib/config";
import type { EvalDocument } from "../lib/evaluationSet";
import type { Library } from "../lib/library";
import type { Log } from "../lib/log";
import type { EverydayCase } from "./cases";
import {
  givenToMindsOf,
  pointersIn,
  type RequestFailure,
  type RequestOutcome,
  requestFailures,
  rewrittenLater,
  takenOut,
} from "./checks";
import { DATED_TEXTS } from "./dated";
import { citedClaims } from "./dates";
import { type Decision, decisionInput, type Forcing, type Route } from "./decisions";
import { judgeClaims, judgeToolClaims } from "./judge";
import type { Asks, ReaskWatch } from "./reasks";
import { checkCitedSentences, type SentenceSupport } from "./support";

const ROOT = resolve(__dirname, "../..");

/** A request as `runCase` asks it: which Documents it is asked over is the caller's. */
export type AskedRequest = Omit<EverydayCase, "library">;

/** A public file the evaluation fetches once into the cache, checked against its SHA-256. */
interface FetchedFile {
  key: string;
  url: string;
  file: string;
  sha256: string;
}

/** The two arXiv papers of the owner's own conversation. */
export const PAPERS: readonly FetchedFile[] = [
  {
    key: "graphst",
    url: "https://arxiv.org/pdf/2306.10683v1",
    file: "2306.10683v1.pdf",
    sha256: "295ffa4d0840a1956ea4094473978b01d4e2fb00299eb7fde9e45a300d4958db",
  },
  {
    key: "tutorial",
    url: "https://arxiv.org/pdf/1609.04846v1",
    file: "A Tutorial about Random Neural Networks in Supervised Learning.pdf",
    sha256: "41799311b54eb75bee7011f6d6210cd14a8e3517bf79686dd9acd40569598cfa",
  },
];

/** The State Administration of Foreign Exchange's table of official reserve assets, in Chinese and English, whose cells give the figures of a difference (#1444). */
export const RESERVES: readonly FetchedFile[] = [
  {
    key: "reserves",
    url: "https://www.safe.gov.cn/safe/file/file/20261007/ce2e1161712644ecb5337cb5cf64dcc4.xlsx",
    file: "官方储备资产（2026年）.xlsx",
    sha256: "1d572c50679ca8e6f5bad9f21231986a2d9e61aaf6835117840e19bf9710208b",
  },
];

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A request whose Answer takes longer is stopped and counted as failed. */
export const ANSWER_TIMEOUT_MS = 5 * 60_000;

async function fetchChecked(
  cacheDir: string,
  files: readonly FetchedFile[],
  log: Log,
  pauseMs: number,
): Promise<EvalDocument[]> {
  const folder = join(cacheDir, "everyday");
  await mkdir(folder, { recursive: true });
  const documents: EvalDocument[] = [];
  for (const wanted of files) {
    const path = join(folder, wanted.file);
    if (!existsSync(path) || sha256(await readFile(path)) !== wanted.sha256) {
      log(`Fetching ${wanted.url}`);
      await new Promise((done) => setTimeout(done, pauseMs));
      const response = await fetch(wanted.url, {
        headers: { "User-Agent": "IncarnaMind document evaluation" },
      });
      if (!response.ok) throw new Error(`${wanted.url} answered HTTP ${response.status}.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (sha256(bytes) !== wanted.sha256)
        throw new Error(`${wanted.url} isn't the file expected.`);
      await writeFile(`${path}.partial`, bytes);
      await rename(`${path}.partial`, path);
    }
    documents.push({ key: wanted.key, path });
  }
  return documents;
}

/** arXiv asks for one request every three seconds. */
export const fetchPapers = (cacheDir: string, log: Log) =>
  fetchChecked(cacheDir, PAPERS, log, 3_000);

export const fetchReserves = (cacheDir: string, log: Log) =>
  fetchChecked(cacheDir, RESERVES, log, 0);

export async function reports(): Promise<EvalDocument[]> {
  const folder = join(ROOT, "data");
  const realFolder = join(folder, "real");
  const pdfsIn = async (directory: string) =>
    (await readdir(directory))
      .filter((name) => name.endsWith(".pdf"))
      .map((name) => ({ key: name, path: join(directory, name) }));
  return [...(await pdfsIn(folder)), ...(await pdfsIn(realFolder))];
}

export interface CaseResult {
  id: string;
  language: "en" | "zh-CN";
  request: string;
  model: string;
  failures: RequestFailure[];
  /** Sentences the judge read as a passive check or calculation that no call ran (#1796): counted, not failed. */
  toolPassive?: string[];
  reply: string;
  page: string;
  /** What the guard took out: sentences of the reply, by Add to note, and Blocks of what the calls gave to write into Minds. */
  removed: string[];
  /** Sentences of what the calls gave that the model's edit_mind or the app's own check rewrote after the guard, and what the Mind holds now. */
  rewritten: { given: string; now: string | null }[];
  /** Calls that copied the last Answer into a Mind (`answer: true`). */
  copies: number;
  pointersLeft: number;
  calls: string[];
  /** The Mind's Blocks that changed, as they read before and once its changes are accepted. */
  changes: { block: number; before: string; after: string }[];
  seconds: number;
  /** From the start to the last Answer's end, before it is checked. */
  answeredSeconds: number;
  error: string | null;
  /** The Answers' tokens, its earlier requests' included (not Edit with AI's or the judge's). */
  usage: AnswerUsage;
  /** The markers the app took out of its Answers because no Citation backed them. */
  droppedMarkers: number;
  /** How often the app asked the model inside this Answer: again, and once for Citations. */
  asks: Asks;
  /** A research request: each cited sentence of the reply, as the app's own check judged it; null for the others. */
  support: SentenceSupport[] | null;
  /** A summary: its sentences outside headings that make a claim, and how many carry a Citation; null for the others. */
  claims: { claims: number; cited: number } | null;
  /** Arm C (./decisions): what the decision model chose for the request, and how many of its model requests were forced; absent in arms A and B. */
  decision?: { choice: Route; confidence: number; forced: number };
}

/**
 * Asks in the assistant and resolves with the Answer as stored once it has ended. When it asks
 * the User which (ask_user), the option naming `choose` is chosen; without one, the User reads
 * the question and the Answer waits for them, so it is stopped there and `stopped` is told.
 */
export async function ask(
  core: Core,
  input: {
    text: string;
    mindId: string | null;
    conversationId: string | null;
    focus: MindFocus | null;
    onScreen?: string[];
    quotes?: AskedQuote[];
  },
  { choose, stopped }: { choose?: string; stopped?: () => void } = {},
): Promise<ConversationAnswer> {
  const asked = await core.askInConversation(input);
  if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
  const answering = core.on("question.asked", (request) => {
    if (request.answerId !== asked.answerId) return;
    const wanted = choose?.toLocaleLowerCase();
    // An option named exactly that comes first: "Project plan" isn't "Project plan (draft)".
    const option = wanted
      ? (request.question.options.find((each) => each.label.toLocaleLowerCase() === wanted) ??
        request.question.options.find((each) =>
          `${each.label} ${each.description}`.toLocaleLowerCase().includes(wanted),
        ))
      : undefined;
    if (option) {
      void core.answerUserQuestion(request.requestId, {
        skipped: false,
        chosen: [option.label],
        wrote: null,
      });
      return;
    }
    stopped?.();
    void core.stopConversationAnswer({
      conversationId: asked.conversation.id,
      answerId: asked.answerId,
    });
  });
  try {
    return await answerOf(core, asked.conversation.id, asked.answerId);
  } finally {
    answering();
  }
}

async function answerOf(
  core: Core,
  conversationId: string,
  answerId: string,
): Promise<ConversationAnswer> {
  const ended = await new Promise<boolean>((done) => {
    const timer = setTimeout(() => end(false), ANSWER_TIMEOUT_MS);
    const stops = [
      core.on("answer.finished", (event) => event.answerId === answerId && end(true)),
      core.on("answer.failed", (event) => event.answerId === answerId && end(true)),
    ];
    function end(inTime: boolean) {
      clearTimeout(timer);
      for (const stop of stops) stop();
      done(inTime);
    }
  });
  if (!ended) {
    await core.stopConversationAnswer({ conversationId, answerId });
    throw new Error(`No Answer within ${ANSWER_TIMEOUT_MS / 60_000} minutes.`);
  }
  const { messages } = await core.getConversation(conversationId);
  const answer = messages.find((message) => message.id === answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer was kept.");
  return answer;
}

async function askExample(core: Core, language: "en" | "zh-CN") {
  await core.updateSettings({ user: { language } });
  const { mindId } = await core.createExamples();
  const asked = await vi.waitFor(() => core.askReadyQuestion(), {
    timeout: 2 * 60_000,
    interval: 500,
  });
  return { conversationId: asked.conversationId, mindId };
}

async function importWord(library: Library, word: NonNullable<EverydayCase["word"]>) {
  const [title = "", ...body] = word.paragraphs;
  const folder = join(library.dataDir, "word");
  await mkdir(folder, { recursive: true });
  return importWordBytes(
    library.core,
    folder,
    wordFile({
      body: [paragraph(title, { style: "Title" }), ...body.map((each) => paragraph(each))].join(""),
    }),
    { name: word.name, origin: "own", addOriginal: true },
  );
}

/** The top-level Blocks, by id, as they read once these requests' changes are accepted. */
function acceptedTexts(doc: Y.Doc, requests: ReadonlySet<string>): Map<string, string> {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  const blocks = copy.getXmlFragment(MIND_CONTENT_FIELD);
  copy.transact(() => resolveProposals(blocks, (ref) => requests.has(ref.request), "accept"));
  return new Map(
    blocks
      .toArray()
      .flatMap((block) =>
        block instanceof Y.XmlElement
          ? [[String(block.getAttribute(BLOCK_ID_ATTRIBUTE)), plainText(block)]]
          : [],
      ),
  );
}

function citedDocuments(doc: Y.Doc): string[] {
  const found: string[] = [];
  const visit = (element: Y.XmlElement | Y.XmlFragment) => {
    for (const child of element.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      const id = child.getAttribute("documentId");
      if (child.nodeName === CITATION_NODE && typeof id === "string") found.push(id);
      visit(child);
    }
  };
  visit(doc.getXmlFragment(MIND_CONTENT_FIELD));
  return found;
}

/** The words a request asks about, cited where they were selected as the viewer cites them (#101). */
async function quoteOf(
  core: Core,
  scoped: readonly { id: string; name: string }[],
  { document, page, words }: NonNullable<EverydayCase["quote"]>,
): Promise<AskedQuote> {
  const found = scoped.find((each) => each.name === document);
  if (!found) throw new Error(`No Document “${document}” to select words in.`);
  const cited = await core.citeSelection({
    documentId: found.id,
    parts: [{ unit: page, text: words }],
  });
  if (cited.check !== "found") {
    throw new Error(`“${words}” isn't on p. ${page} of “${document}”: ${cited.checkReason}.`);
  }
  const { quote, pageFrom, pageTo, location } = cited;
  return { documentId: found.id, documentName: found.name, quote, pageFrom, pageTo, location };
}

export async function runCase(
  library: Library,
  scoped: { id: string; name: string }[],
  judge: ReturnType<typeof createAiSdkChatModel>,
  model: string,
  each: AskedRequest,
  {
    watch,
    checkModel = null,
    deciding,
    asking,
    calculates = false,
  }: {
    /** Watches the app's own asks inside the Answer; none watched without it. */
    watch?: ReaskWatch;
    /** Called just before the request itself is asked, after the turns it follows. */
    asking?: () => void;
    /** The model the cited sentences are checked on; null: the default chat model. */
    checkModel?: ChatModelChoice | null;
    /** Arm C: decides each request first, and forces the chat model's requests as the decision says. */
    deciding?: { decide(text: string): Promise<Decision>; forcing: Forcing };
    /** The model is offered `calculate` (`ModelFacts.calculates`). */
    calculates?: boolean;
  } = {},
): Promise<CaseResult> {
  const { core } = library;
  const started = Date.now();
  const usage: AnswerUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
  };
  let droppedMarkers = 0;
  const counting = core.on("answer.finished", (event) => {
    droppedMarkers += event.droppedMarkers;
    usage.inputTokens += event.usage.inputTokens;
    usage.outputTokens += event.usage.outputTokens;
    usage.cachedInputTokens += event.usage.cachedInputTokens;
    usage.cacheWriteTokens += event.usage.cacheWriteTokens;
  });
  const example = each.afterExample ? await askExample(core, each.language) : null;
  const imported = each.word ? await importWord(library, each.word) : null;
  const mindId =
    imported?.mindId ??
    (each.inExample ? example?.mindId : null) ??
    (each.mind ? (await core.createMind({ title: each.mind.title })).id : null);
  const mind = mindId ? { id: mindId } : null;
  const client = imported?.client ?? (mind ? await connectToMind(core, mind.id) : null);
  if (client && each.mind) {
    writeMind(
      client,
      each.mind.blocks.map((line) =>
        line.startsWith("## ")
          ? heading(2, line.slice(3))
          : line.startsWith("# ")
            ? heading(1, line.slice(2))
            : note(line),
      ),
    );
    await client.settled();
  }
  const idsNow = () =>
    client
      ? client.blocks
          .toArray()
          .map((block) =>
            block instanceof Y.XmlElement ? String(block.getAttribute(BLOCK_ID_ATTRIBUTE)) : "",
          )
      : [];
  const onScreen = (each.onScreen ?? []).map((name) => {
    const found = scoped.find((document) => document.name === name);
    if (!found) throw new Error(`No Document “${name}” to open on screen.`);
    return found.id;
  });
  if (each.selectNote && mind && client) {
    const noted = await ask(core, {
      text: each.selectNote,
      mindId: mind.id,
      conversationId: null,
      focus: null,
    });
    await core.addToNote({
      mindId: mind.id,
      blocks: pageBlocks(noted, each.selectNote),
      origin: { from: messageReference(noted.conversationId, noted.id), question: each.selectNote },
      model: noted.model,
    });
    await client.settled();
  }
  let ids = idsNow();
  let before = client ? acceptedTexts(client.doc, new Set()) : new Map<string, string>();
  const focus: MindFocus | null =
    (each.selectAll || each.selectNote) && client
      ? { selection: [...before.values()].join("\n\n"), blockIds: ids }
      : null;
  let conversationId: string | null = example?.conversationId ?? null;
  const earlierCalls: ConversationAnswer["toolCalls"] = [];
  let last: ConversationAnswer | null = null;
  const pageOf = (): "empty" | "text" | "none" =>
    client
      ? idsNow().length === 0 ||
        [...acceptedTexts(client.doc, new Set()).values()].every((text) => text.trim() === "")
        ? "empty"
        : "text"
      : "none";
  const asked: string[] = [];
  const decided: { last: Decision | null } = { last: null };
  const decideFirst = async (text: string) => {
    if (!deciding) return;
    decided.last = await deciding.decide(
      decisionInput({ request: text, page: pageOf(), earlier: asked }),
    );
    deciding.forcing.begin(decided.last);
  };

  for (const earlier of each.before ?? []) {
    const fromExample = each.beforeInExample === true;
    await decideFirst(earlier);
    asked.push(earlier);
    const answer = await ask(core, {
      text: earlier,
      mindId: (fromExample ? example?.mindId : mind?.id) ?? null,
      conversationId,
      focus: fromExample ? null : focus,
      onScreen,
    });
    conversationId = answer.conversationId;
    earlierCalls.push(...answer.toolCalls);
    last = answer;
  }
  let addedBlocks: number[] | undefined;
  if (each.addToNote && last && mind && client) {
    const earlier = new Set(ids);
    await core.addToNote({
      mindId: mind.id,
      blocks: pageBlocks(last, each.before?.at(-1) ?? ""),
      origin: {
        from: messageReference(last.conversationId, last.id),
        question: each.before?.at(-1) ?? "",
      },
      model: last.model,
    });
    await client.settled();
    ids = idsNow();
    addedBlocks = ids.flatMap((id, block) => (earlier.has(id) ? [] : [block]));
    before = acceptedTexts(client.doc, new Set());
  }
  const quoted = each.quote ? await quoteOf(core, scoped, each.quote) : null;
  watch?.begin(each.firstReply ?? null);
  await decideFirst(each.request);
  const stoppedAtAsk = { last: false };
  asking?.();
  const answer = await ask(
    core,
    {
      text: each.request,
      mindId: mind?.id ?? null,
      conversationId,
      focus,
      onScreen,
      ...(quoted && { quotes: [quoted] }),
    },
    { choose: each.answerAsk, stopped: () => (stoppedAtAsk.last = true) },
  );
  const answeredSeconds = (Date.now() - started) / 1000;
  const asks = watch ? { ...watch.end() } : { again: 0, citations: 0 };
  const forced = deciding ? deciding.forcing.end() : 0;
  const decision = decided.last;
  counting();
  const minds = await core.listMinds();
  const names = (id: string) => minds.find((each) => each.id === id)?.title ?? null;
  const record = toolRecordLines(answer.toolCalls, names);
  const support = each.research ? await checkCitedSentences(core, answer, checkModel) : null;
  const verdict = await judgeClaims(
    judge,
    answer.text,
    record,
    toolRecordLines(earlierCalls, names),
  );
  // Judged where it is the request's point, and under every reply the app's own line flags (#1796).
  const toolVerdict =
    each.expected.honestTools || (answer.steps?.unrunTools ?? []).length > 0
      ? await judgeToolClaims(judge, answer.text, record)
      : null;
  const changed = new Set(
    answer.toolCalls.flatMap((call) => (call.mindChange ? [call.mindChange.mindId] : [])),
  );
  const requests = new Set(
    answer.toolCalls.flatMap((call) => (call.mindChange ? [call.mindChange.request] : [])),
  );
  const citedInMinds: string[] = [];
  const sourcesAsTextIn: string[] = [];
  const writtenInMinds: string[] = [];
  const documentNames = scoped.map((document) => document.name);
  for (const mindId of changed) {
    const written = await connectToMind(core, mindId);
    await written.settled();
    citedInMinds.push(...citedDocuments(written.doc));
    const was = mindId === mind?.id ? before : new Map<string, string>();
    for (const [id, text] of acceptedTexts(written.doc, requests)) {
      sourcesAsTextIn.push(
        ...sourcesAsText(text, (source) => namesOneOf(source.name, documentNames)),
      );
      if (was.get(id) !== text) writtenInMinds.push(text);
    }
  }
  let changes: CaseResult["changes"] = [];
  if (client) {
    await client.settled();
    const after = acceptedTexts(client.doc, requests);
    changes = ids.flatMap((id, block) =>
      after.get(id) === before.get(id)
        ? []
        : [{ block, before: before.get(id) ?? "", after: after.get(id) ?? "(removed)" }],
    );
  }
  const changedBlocks = changes.map((change) => change.block);
  const page = forPage(answer.text, each.request);
  const givenToMinds = givenToMindsOf(
    answer.toolCalls,
    last ? { text: last.text, question: each.before?.at(-1) ?? "" } : null,
  );
  const outcome: RequestOutcome = {
    expected: each.expected,
    answer,
    verdict,
    toolVerdict,
    calculates,
    askedFrom: mind?.id ?? null,
    citedInMinds,
    changedBlocks,
    addedBlocks,
    sourcesAsText: sourcesAsTextIn,
    writtenInMinds,
    addedToPage: page,
    givenToMinds,
    askedAgain: asks.again > 0,
    scoped,
    texts: each.expected.textDates ? DATED_TEXTS : undefined,
    stoppedAtAsk: stoppedAtAsk.last,
    ...(quoted && { quoted }),
  };
  const failures = requestFailures(outcome);
  return {
    id: each.id,
    language: each.language,
    request: each.request,
    model,
    failures,
    ...(toolVerdict?.passive &&
      toolVerdict.passive.length > 0 && { toolPassive: toolVerdict.passive }),
    reply: answer.text,
    page,
    removed: takenOut(outcome).removed,
    rewritten: rewrittenLater(outcome),
    copies: givenToMinds.filter((given) => given.question !== undefined).length,
    pointersLeft: pointersIn([page, ...writtenInMinds].join("\n\n")).length,
    calls: record,
    changes,
    seconds: (Date.now() - started) / 1000,
    answeredSeconds,
    error: answer.status === "failed" ? `${answer.errorKind}: ${answer.errorMessage}` : null,
    usage,
    droppedMarkers,
    asks,
    support,
    claims: each.summary ? citedClaims(answer.text) : null,
    ...(decision && {
      decision: { choice: decision.choice, confidence: decision.confidence, forced },
    }),
  };
}

// Never the model under test, which would judge its own claims.
const JUDGE_MODEL = "claude-sonnet-5-5";
const JUDGE_OF_SONNET = "claude-opus-5-5";

/**
 * The model that judges claims: INCARNAMIND_EVAL_JUDGE_*, else, on an
 * Anthropic key, Claude Sonnet 5.5, or Opus 5.5 when Sonnet is under test.
 */
export function judgeOf(config: ReturnType<typeof readConfig>, chat: ChatSettings): ChatSettings {
  if (config.judge) return config.judge;
  if (chat.kind !== "anthropic") {
    throw new Error(
      "Set INCARNAMIND_EVAL_JUDGE_KIND, _MODEL and _KEY: the claims are judged by another model than the one asked.",
    );
  }
  return { ...chat, modelId: chat.modelId === JUDGE_MODEL ? JUDGE_OF_SONNET : JUDGE_MODEL };
}
