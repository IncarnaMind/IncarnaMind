import type {
  AnswerPhase,
  AnswerToolCall,
  AskedFrom,
  ClaimedTool,
  ConversationAnswer,
  MarkedCitation,
  MindRead,
} from "../../core/api";
import { markersIn } from "../../shared/answerBlocks";

/**
 * An Answer's steps in the assistant (#391), from what its row keeps: its
 * phases, Tool calls, reasoning and Citations. The folded line sums them up,
 * the timeline lists them, and while the Answer is written the line says
 * which step it is on. Only data: the component words them.
 */

/** The Tool an Answer searches the Documents with. */
export const SEARCH = "search_documents";
export const RUN_SCRIPT = "run_skill_script";
/** The Documents' Tool whose figures an Answer shows: one call sums up all of them (ADR-0021). */
export const CALCULATE = "calculate";

/** What the steps are read from. */
export interface StepsInput {
  answer: Pick<
    ConversationAnswer,
    "text" | "citations" | "toolCalls" | "model" | "steps" | "read"
  > &
    Partial<Pick<ConversationAnswer, "status">>;
  /**
   * The Mind in focus when the Question was asked; null when none was. Its
   * Answer read it (`answer.read`), unless it couldn't: say, an Answer written
   * before #544.
   */
  askedFrom: AskedFrom | null;
  /** The Question was about a selection in the Mind (#565). */
  selection?: boolean;
  /** It was asked while its Mind's meeting was recording: the assistant listened to the live transcript. */
  meeting: boolean;
}

/** A source a search led to: the first of its Citations at one place in one Document. */
export type StepSource = MarkedCitation;

/** A Document the request held whole, by id, with the name a Citation of it carries when one does. */
export interface ReadDocument {
  documentId: string;
  name: string | null;
}

export interface MindReadLine {
  kind: "read";
  mind: MindRead;
  share: number | null;
  selection?: true;
}

export type StepRow =
  /**
   * The model's reasoning summary, and how long it thought. `thinking`: it is still
   * working, so far with this summary (see `LiveRows`).
   */
  | { kind: "reasoning"; model: string; summary: string; seconds: number; thinking?: true }
  /** A model that gave no reasoning summary, and how long the Answer took when that is known. */
  | { kind: "answered"; model: string; seconds: number | null }
  /** The Mind the Answer read, all of it or part of it: `share` of it (#564), when part and known. */
  | { kind: "read"; mind: MindRead; share: number | null; selection?: true }
  /** The Mind it was asked from, which it didn't read. */
  | { kind: "asked"; mind: AskedFrom }
  /** One search, or several in a row, with the sources their Citations point to. */
  | {
      kind: "search";
      calls: AnswerToolCall[];
      found: number;
      used: number;
      sources: StepSource[];
      /** One of its searches is still running. */
      running?: true;
    }
  /** The Documents whose whole text went with the Question, and where its Citations point into them. */
  | { kind: "read-documents"; documents: ReadDocument[]; sources: StepSource[] }
  /** A search that failed, where it happened. */
  | { kind: "failed-search"; call: AnswerToolCall }
  /** A Document read that failed, where it happened. */
  | { kind: "failed-read"; call: AnswerToolCall }
  /** A search the User stopped the Answer in: it didn't fail. */
  | { kind: "stopped-search"; call: AnswerToolCall }
  /** A Connector's Tool, Find sources or a Skill script. */
  | { kind: "call"; call: AnswerToolCall }
  /** A Skill, loaded by the model or chosen for the Question, with the files it read. */
  | { kind: "skill"; name: string; use: AnswerToolCall | null; reads: AnswerToolCall[] }
  /** Its first reply said these Tools ran, and none had: the model was asked once more (#1796). */
  | { kind: "asked-again"; tools: readonly ClaimedTool[] }
  /** The figures the Answer shows, each calculated from its cited inputs. */
  | { kind: "calculated"; count: number }
  /** The Citations checked against their sources, and how many weren't found; `running`: being checked now. */
  | {
      kind: "check";
      count: number;
      notFound: number;
      /** Citations whose quote is found and whose sentence it doesn't support (#2311). */
      needALook?: number;
      running?: true;
    };

export type FoldedLine =
  | { kind: "searched"; sources: number; extraScopes: number }
  /**
   * A search whose Answer cited nothing of its own (#760): the Passages it
   * read, and how many sentences were cited after checking them against
   * those (0: none could be matched).
   */
  | { kind: "read-passages"; passages: number; citedAfterChecking: number }
  | { kind: "searched-web"; sources: number }
  /** The Documents whose whole text went with the Question, and the Mind it read beside them. */
  | { kind: "read-documents"; documents: ReadDocument[]; read: MindReadLine | null }
  | { kind: "listened"; sources: number }
  | MindReadLine
  | { kind: "asked"; mind: AskedFrom }
  | { kind: "answered"; model: string };

export type LiveStep =
  | { kind: "waiting" }
  | { kind: "consent" }
  | { kind: "loading" }
  | { kind: "reading"; mind: AskedFrom }
  | { kind: "searching" }
  | { kind: "call"; call: AnswerToolCall }
  | { kind: "thinking"; summary: string }
  | { kind: "writing" }
  | { kind: "checking"; count: number }
  | { kind: "checking-figures" }
  | { kind: "checking-claims" };

const isSearch = (call: AnswerToolCall) =>
  call.source === "documents" && (call.tool === SEARCH || call.tool === "read_document");
export const isCalculated = (call: AnswerToolCall) =>
  call.source === "documents" && call.tool === CALCULATE;

/** Whole seconds, at least 1. */
const seconds = (ms: number) => Math.max(1, Math.round(ms / 1000));

/** A text field of what a Tool call was asked, or "". */
const field = (call: AnswerToolCall, name: string): string => {
  const value: unknown = call.input?.[name];
  return typeof value === "string" ? value : "";
};

/** A summary's Markdown emphasis left out: providers set its headings in bold. */
export const plainSummary = (summary: string) =>
  summary.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*\*/g, "");

/**
 * The latest of a reasoning summary, for the one live line: the last of its
 * headings (a provider titles each part in bold), else its last sentence,
 * which is the one still being written.
 */
export function latestReasoning(summary: string | null | undefined): string {
  const paragraphs = (summary ?? "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const heading = paragraphs.findLast((paragraph) => /^\*\*[^*]+\*\*$/.test(paragraph));
  if (heading) return plainSummary(heading);
  const sentences = plainSummary(paragraphs.at(-1) ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?。！？][”"’')）」]*)(?![”"’')）」])\s*/)
    .filter((sentence) => /[\p{L}\p{N}]/u.test(sentence));
  return sentences.at(-1)?.trim() ?? "";
}

/** The Citations an Answer shows, one for each marker in its text that has one. */
function shownCitations({ text, citations }: Pick<StepsInput["answer"], "text" | "citations">) {
  const cited = new Map(citations.map((citation) => [citation.marker, citation]));
  return markersIn(text).flatMap((marker) => cited.get(marker) ?? []);
}

/** The first row: the model's reasoning, or the model that answered and how long it took. */
function modelRow(answer: StepsInput["answer"], live: LiveStep | undefined): StepRow | null {
  const model = answer.model?.modelId;
  if (!model) return null;
  const reasoning = answer.steps?.reasoning;
  if (live) {
    return {
      kind: "reasoning",
      model,
      summary: reasoning?.summary ?? "",
      seconds: seconds(reasoning?.ms ?? 0),
      ...(live.kind === "thinking" && { thinking: true as const }),
    };
  }
  if (reasoning) {
    return { kind: "reasoning", model, summary: reasoning.summary, seconds: seconds(reasoning.ms) };
  }
  const sentAt = Date.parse(answer.steps?.sentAt ?? "");
  const finishedAt = Date.parse(answer.steps?.finishedAt ?? "");
  const took = finishedAt - sentAt;
  return { kind: "answered", model, seconds: Number.isNaN(took) ? null : seconds(took) };
}

/** Where a Citation points, to tell two sources apart. */
const placeOf = (citation: MarkedCitation) =>
  `${citation.documentId}\n${citation.pageFrom}-${citation.pageTo}\n${JSON.stringify(citation.location)}`;

// An Answer written before searches kept their Passages can't tell its searches' Citations apart.
const forgetful = (call: AnswerToolCall) =>
  call.status === "done" && (call.resultCount ?? 0) > 0 && !call.passages;

function searchBehind(
  calls: readonly AnswerToolCall[],
  citation: MarkedCitation,
): AnswerToolCall | undefined {
  const searches = calls.filter((call) => isSearch(call) && call.status !== "failed");
  return searches.some(forgetful)
    ? searches.at(-1)
    : searches.find((call) => call.passages?.includes(citation.passageId));
}

// A web page the Answer read is named by its own call.
function citedWithoutSearch({
  toolCalls,
  citations,
}: Pick<StepsInput["answer"], "toolCalls" | "citations">): MarkedCitation[] {
  const pages = new Set(
    toolCalls.flatMap((call) =>
      call.webPage && "documentId" in call.webPage ? [call.webPage.documentId] : [],
    ),
  );
  return citations.filter(
    (citation) => !pages.has(citation.documentId) && !searchBehind(toolCalls, citation),
  );
}

// An Answer written before its request was recorded can only say what its Citations prove: the
// Documents it cites that no search found.
function readDocuments(answer: StepsInput["answer"]): ReadDocument[] {
  const sent = answer.steps?.sent;
  const named = (documentId: string) =>
    answer.citations.find((citation) => citation.documentId === documentId)?.documentName ?? null;
  return sent
    ? sent.documents.map((documentId) => ({ documentId, name: named(documentId) }))
    : documentsOf(citedWithoutSearch(answer)).map((citation) => ({
        documentId: citation.documentId,
        name: citation.documentName,
      }));
}

/** The Citations into the Documents read with the Question that no search found. */
function citedFromRead(answer: StepsInput["answer"]): MarkedCitation[] {
  const sent = answer.steps?.sent;
  if (!sent) return citedWithoutSearch(answer);
  const read = new Set(sent.documents);
  return answer.citations.filter(
    (citation) => read.has(citation.documentId) && !searchBehind(answer.toolCalls, citation),
  );
}

const documentsOf = (citations: readonly MarkedCitation[]) =>
  citations.filter(
    (citation, at) => citations.findIndex((each) => each.documentId === citation.documentId) === at,
  );

const placesOf = (citations: readonly MarkedCitation[]) =>
  citations.filter(
    (citation, at) => citations.findIndex((each) => placeOf(each) === placeOf(citation)) === at,
  );

/** The Mind the Answer read, or the one it was asked from and didn't read. */
const mindRow = ({ answer, askedFrom, selection }: StepsInput) =>
  answer.read
    ? ({
        kind: "read",
        mind: answer.read,
        share: answer.read.partial ? (answer.steps?.readShare ?? null) : null,
        ...(selection && !answer.read.partial && { selection: true as const }),
      } as const)
    : askedFrom
      ? ({ kind: "asked", mind: askedFrom } as const)
      : null;

// A question the Tool refused, or one left open when its Answer stopped, waits for nothing now.
const unansweredQuestion = (call: AnswerToolCall) =>
  call.source === "asks" && call.status !== "running" && !call.asked?.answer;

/**
 * The rows of the unfolded timeline, in order: the model's reasoning (or
 * who answered), the Mind read, unless the folded line already says so and
 * there is no share of it to say (#564), the Documents whose whole text went
 * with the Question, the
 * searches and other calls in the order they started (searches in a row as
 * one, a failed one where it happened), the model asked again about Tools its
 * first reply said ran, the figures calculated, and the check of the Citations
 * last. A call still waiting for the User has no row: its
 * approval card shows instead.
 *
 * While the Answer is written (`live`: its step now), the rows are the same in
 * the same order, so each is added where it will stay: the model's from the
 * start, with the summary so far; every call as it starts; the Citations'
 * check once it begins, and from then on until the Answer is written, even
 * while a model that streams word by word has more text than Citations
 * (`checking`: how many it counted when it last began). The Mind read is there
 * from the start too, even where the folded line will say so once the Answer
 * is written.
 */
export function stepRows(
  input: StepsInput,
  live?: LiveStep,
  checking: number | null = null,
): StepRow[] {
  const { answer } = input;
  const rows: StepRow[] = [];
  const first = modelRow(answer, live);
  if (first) rows.push(first);
  const mind = mindRow(input);
  const shared = mind?.kind === "read" && mind.share !== null;
  if (mind && (live || shared || foldedLine(input)?.kind !== mind.kind)) rows.push(mind);
  const read = input.meeting && !answer.steps?.sent ? [] : readDocuments(answer);
  if (read.length > 0) {
    rows.push({
      kind: "read-documents",
      documents: read,
      sources: placesOf(citedFromRead(answer)),
    });
  }

  const searches: Extract<StepRow, { kind: "search" }>[] = [];
  const skills = new Map<string, Extract<StepRow, { kind: "skill" }>>();
  let joining: Extract<StepRow, { kind: "search" }> | null = null;
  let calculated = 0;
  for (const call of answer.toolCalls) {
    if (call.approval === "waiting" || unansweredQuestion(call)) continue;
    if (isCalculated(call)) {
      calculated = call.resultCount ?? 0;
      continue;
    }
    if (isSearch(call)) {
      if (call.status === "failed") {
        // Stopping an Answer ends a search that was running; only a search that gave an error failed.
        const stopped = answer.status === "stopped" && call.error === undefined;
        const failure = stopped
          ? "stopped-search"
          : call.tool === "read_document"
            ? "failed-read"
            : "failed-search";
        rows.push({ kind: failure, call });
        joining = null;
        continue;
      }
      if (!joining) {
        joining = { kind: "search", calls: [], found: 0, used: 0, sources: [] };
        rows.push(joining);
        searches.push(joining);
      }
      joining.calls.push(call);
      joining.found += call.resultCount ?? 0;
      if (call.status === "running") joining.running = true;
      continue;
    }
    joining = null;
    if (call.source === "skill" && call.tool !== RUN_SCRIPT) {
      const name = call.tool === "use_skill" ? field(call, "name") : field(call, "skill");
      let skill = skills.get(name);
      if (!skill) {
        skill = { kind: "skill", name, use: null, reads: [] };
        skills.set(name, skill);
        rows.push(skill);
      }
      if (call.tool === "use_skill") skill.use ??= call;
      else skill.reads.push(call);
      continue;
    }
    rows.push({ kind: "call", call });
  }

  // Each Citation goes under the first search that found its Passage.
  const used = new Map<Extract<StepRow, { kind: "search" }>, Set<string>>();
  for (const citation of answer.citations) {
    const call = searchBehind(answer.toolCalls, citation);
    const search = call && searches.find((each) => each.calls.includes(call));
    if (!search) continue;
    const passages = used.get(search) ?? new Set<string>();
    passages.add(citation.passageId);
    used.set(search, passages);
    if (!search.sources.some((source) => placeOf(source) === placeOf(citation))) {
      search.sources.push(citation);
    }
  }
  for (const [search, passages] of used) search.used = passages.size;

  const askedAgainFor = answer.steps?.askedAgainFor ?? [];
  if (askedAgainFor.length > 0) rows.push({ kind: "asked-again", tools: askedAgainFor });
  if (calculated > 0) rows.push({ kind: "calculated", count: calculated });
  const shown = shownCitations(answer);
  if (live) {
    const count = live.kind === "checking" ? live.count : checking;
    if (count !== null) rows.push({ kind: "check", count, notFound: 0, running: true });
  } else if (shown.length > 0) {
    const needALook = shown.filter(
      (citation) => citation.check === "unsupported" || citation.check === "contradicted",
    ).length;
    rows.push({
      kind: "check",
      count: shown.length,
      notFound: shown.filter((citation) => citation.check === "not-found").length,
      ...(needALook > 0 && { needALook }),
    });
  }
  return rows;
}

/** How many Documents the Answer cites. */
const sourceCount = (citations: readonly MarkedCitation[]) =>
  new Set(citations.map((citation) => citation.documentId)).size;

/** How many Passages the Answer's searches read: each once, when the searches kept which. */
function passagesRead(calls: readonly AnswerToolCall[]): number {
  const done = calls.filter((call) => isSearch(call) && call.status === "done");
  if (done.some((call) => call.passages)) {
    return new Set(done.flatMap((call) => call.passages ?? [])).size;
  }
  return done.reduce((sum, call) => sum + (call.resultCount ?? 0), 0);
}

/**
 * Further scopes the Answer searched beside its Question's: each Connector
 * whose Tools it called, Find sources, and the web.
 */
function extraScopes(calls: readonly AnswerToolCall[]): number {
  const ran = calls.filter((call) => call.status === "done" && !call.signInRequired);
  const connectors = new Set(
    ran.flatMap((call) =>
      call.source === "connector" && call.connector ? [call.connector.id] : [],
    ),
  );
  const also = (source: AnswerToolCall["source"]) =>
    ran.some((call) => call.source === source) ? 1 : 0;
  return connectors.size + also("sources") + also("web");
}

/**
 * The folded line: what was searched (the Documents, or else the web) and
 * how many Documents the Answer cites; with no search, the Documents whose
 * whole text went with the Question, with the Mind it read beside them; else
 * the Mind it read (or was asked from), or the model that answered. Null for
 * an Answer no model wrote, asked from no Mind.
 */
export function foldedLine(input: StepsInput): FoldedLine | null {
  const { answer, meeting } = input;
  const sources = sourceCount(answer.citations);
  if (meeting) return { kind: "listened", sources };
  if (answer.toolCalls.some((call) => isSearch(call) && call.status === "done")) {
    // Never "no sources" once Passages were read: when the model cited nothing itself, what
    // was read, and what came of checking the Answer against it.
    const passages = passagesRead(answer.toolCalls);
    const citedAfterChecking = answer.steps?.citedAfterChecking ?? 0;
    if (passages > 0 && answer.citations.length <= citedAfterChecking) {
      return { kind: "read-passages", passages, citedAfterChecking };
    }
    return { kind: "searched", sources, extraScopes: extraScopes(answer.toolCalls) };
  }
  if (answer.toolCalls.some((call) => call.source === "web" && call.status === "done")) {
    return { kind: "searched-web", sources };
  }
  const read = readDocuments(answer);
  if (read.length > 0) {
    const mind = mindRow(input);
    return { kind: "read-documents", documents: read, read: mind?.kind === "read" ? mind : null };
  }
  return (
    mindRow(input) ?? (answer.model ? { kind: "answered", model: answer.model.modelId } : null)
  );
}

/**
 * The step an Answer being written is on, from its phase, its calls, its
 * text and its Citations: waiting for the User first; then loading,
 * checking quotes or figures, searching or another call running; then writing, which
 * becomes checking once every marker in the text has its Citation; before
 * any text, thinking once the model has been asked, else reading the Mind it
 * reads, else searching.
 */
export function liveStep({
  answer,
  phase,
  waitingForApproval,
}: Pick<StepsInput, "answer"> & {
  phase: AnswerPhase | undefined;
  waitingForApproval: boolean;
}): LiveStep {
  if (waitingForApproval) return { kind: "waiting" };
  if (phase === "waiting-for-consent") return { kind: "consent" };
  if (phase === "loading") return { kind: "loading" };
  if (phase === "checking-quotes") {
    return { kind: "checking", count: shownCitations(answer).length };
  }
  if (phase === "checking-figures") return { kind: "checking-figures" };
  if (phase === "checking-claims") return { kind: "checking-claims" };
  const running = answer.toolCalls.filter(
    (call) => call.status === "running" && !isCalculated(call),
  );
  if (phase === "searching" || running.some(isSearch)) return { kind: "searching" };
  const call = running.find((each) => !isSearch(each));
  if (call) return { kind: "call", call };
  if (answer.text.trim()) {
    const markers = markersIn(answer.text);
    const cited = new Set(answer.citations.map((citation) => citation.marker));
    return markers.length > 0 && markers.every((marker) => cited.has(marker))
      ? { kind: "checking", count: markers.length }
      : { kind: "writing" };
  }
  if (phase === "writing") {
    return { kind: "thinking", summary: latestReasoning(answer.steps?.reasoning?.summary) };
  }
  if (answer.read && !answer.toolCalls.some(isSearch))
    return { kind: "reading", mind: answer.read };
  return { kind: "searching" };
}

/** Steps that stand for the same thing: a new count of Citations is the same step. */
export const liveStepKey = (step: LiveStep): string =>
  step.kind === "call" ? `call:${step.call.id}` : step.kind;
