/**
 * Conversations (CONTEXT.md, ADR-0017): the assistant's own history, kept in
 * SQLite beside the Minds, never as Minds. A conversation is made with its first
 * Question and belongs to the Folder of the Mind that Question was asked from;
 * its messages, Questions and Answers, are rows in order. An Answer is the
 * Markdown the model wrote, with a marker where each Citation and each
 * calculated figure goes, and its Citations and figures (with their markers),
 * written as it streams by the Answer code (../answers). A Question keeps where
 * the User was in the Mind it was asked from, and its Answer the Mind it read
 * and its version (#544). Deleting marks the conversation deleted (ADR-0003);
 * deleting it permanently is Recently deleted's (../recentlyDeleted).
 */
import { randomUUID } from "node:crypto";
import { withFigureText } from "../../shared/figureMarkers";
import { parseLocation } from "../../shared/locations";
import { conversationName, cutTitle } from "../../shared/naming";
import { parseThirdPartySource } from "../../shared/textOrigins";
import { asksToCheckOrCalculate } from "../answers/carefulIntent";
import {
  addCitedUnit,
  addCitedVersion,
  type CitationFields,
  type CitedUnits,
  type CitedVersions,
} from "../answers/citedVersions";
import { usualWait } from "../answers/usualWait";
import type {
  AnswerAnalysis,
  AnswerCoverage,
  AnswerPhase,
  AnswerStatus,
  AnswerSteps,
  AnswerToolCall,
  AskedFrom,
  AskedQuote,
  ChatModelChoice,
  CitationSupport,
  ClaimCheckAttributes,
  ClaimedChange,
  ClaimedTool,
  Conversation,
  ConversationAnswer,
  ConversationContent,
  ConversationMatch,
  ConversationMessage,
  ConversationQuestion,
  FigureInput,
  MarkedCitation,
  MarkedFigure,
  MindFocus,
  MindRead,
  MovedItem,
  ProviderError,
  ProviderErrorKind,
  SearchScope,
  ThirdPartySource,
} from "../api";
import { CLAIMED_CHANGES, CLAIMED_TOOLS, MOST_ASKED_QUOTES } from "../api";
import { InvalidInputError, isRecord, NotFoundError } from "../errors";
import { isSignInRouteProblem } from "../providers/signInRoutes";
import { parseSearchScope } from "../scope";
import { isChatModelChoice } from "../settings";
import type { Database, SqlValue } from "../storage";
import { excerptOf, findTerms, searchTerms, termQuery } from "../wordSearch";
import { indexText, plainText } from "./search";

/** A Question to add, read from `askInConversation`'s input (see `parseQuestion`). */
export interface QuestionInput {
  /** The conversation to add it to; null starts one. */
  conversationId: string | null;
  text: string;
  /** The Mind in focus, and its Folder: a new conversation's. Null: none. */
  mind: { id: string; folderId: string | null } | null;
  /** Where the User was in that Mind; null with none. */
  focus: MindFocus | null;
  /** The Documents open on screen, by id, the focused group's first; not kept with the Question. */
  onScreen: string[];
  quotes: AskedQuote[];
  scope: SearchScope | null;
  model: ChatModelChoice | null;
  forcedSkill: string | null;
  /** Asked with "Analyse data…": its Answer may run an Analysis whatever its scope holds (#447). */
  analyse: boolean;
}

/** What an Answer records of the Mind it read (#544): which, its version, and whether only part of it. */
export type AnswerRead = Pick<MindRead, "mindId" | "version" | "partial">;

/** An Answer as it stands, to write (see `writeAnswer`); `outcome` once it has ended. */
export interface AnswerWrite {
  text: string;
  citations: MarkedCitation[];
  figures: MarkedFigure[];
  claimChecks?: ClaimCheckAttributes[];
  analyses: AnswerAnalysis[];
  toolCalls: AnswerToolCall[];
  support: CitationSupport | null;
  /** Where the third-party text its Run had read came from (#78); null: none. */
  textOrigin: ThirdPartySource | null;
  read: AnswerRead | null;
  steps: AnswerSteps;
  outcome?: { status: Exclude<AnswerStatus, "streaming">; error: ProviderError | null };
}

/** A Question with its Answer, being written, and the messages before them (its Question context). */
export interface Turn {
  conversation: Conversation;
  question: ConversationQuestion;
  answer: ConversationAnswer;
  earlier: ConversationMessage[];
}

/** A Turn as `add` made it, with its conversation's `updated_at` from before it. */
export interface AddedTurn {
  turn: Turn;
  previousConversationUpdatedAt: string | null;
}

interface ConversationRow {
  seq: number;
  id: string;
  title: string;
  auto_title: string;
  folder_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  seq: number;
  id: string;
  conversation_id: string;
  position: number;
  kind: string;
  question_id: string | null;
  text: string;
  asked_from_mind_id: string | null;
  scope: string | null;
  provider_id: string | null;
  model_id: string | null;
  forced_skill: string | null;
  analyse: number;
  status: string | null;
  error_kind: string | null;
  error_message: string | null;
  error_sign_in_route: string | null;
  citation_support: string | null;
  citations: string;
  figures: string;
  claim_checks: string;
  analyses: string;
  tool_calls: string;
  text_origin: string | null;
  steps: string | null;
  focus: string | null;
  read_mind_id: string | null;
  read_mind_version: string | null;
  read_partial: number;
  quotes: string | null;
  created_at: string;
  updated_at: string;
  /** Joined in: the asked-from Mind's name, and 1 if it is deleted or not on this computer. */
  mind_name: string | null;
  mind_gone: number | null;
  /** Joined in: the same of the Mind an Answer read. */
  read_mind_name: string | null;
  read_mind_gone: number | null;
}

const CONVERSATION_COLUMNS = "seq, id, title, auto_title, folder_id, created_at, updated_at";

/** A Mind's name as `mindName` gives it: its title, else its first line. */
const nameOfMind = (alias: string) =>
  `CASE WHEN ${alias}.title <> '' THEN ${alias}.title ELSE ${alias}.auto_title END`;
const goneMind = (alias: string) => `${alias}.id IS NULL OR ${alias}.deleted_at IS NOT NULL`;
const MIND_NAME = nameOfMind("mind");
const MIND_GONE = goneMind("mind");

const MESSAGE_SELECT = `
  SELECT msg.*, ${MIND_NAME} AS mind_name, ${MIND_GONE} AS mind_gone,
    ${nameOfMind("read_mind")} AS read_mind_name, ${goneMind("read_mind")} AS read_mind_gone
  FROM conversation_messages msg
  LEFT JOIN minds mind ON mind.id = msg.asked_from_mind_id
  LEFT JOIN minds read_mind ON read_mind.id = msg.read_mind_id`;

/** The order of a conversation's messages; a sync that brings two at one position orders them by time, then id. */
const MESSAGE_ORDER = "msg.position, msg.created_at, msg.id";

const IN = "IN (SELECT value FROM json_each(?))";

const STATUSES: readonly AnswerStatus[] = ["streaming", "done", "stopped", "failed"];
const SUPPORTS: readonly CitationSupport[] = ["tools", "structured-output", "none"];
const ERROR_KINDS: Record<ProviderErrorKind, true> = {
  auth: true,
  model: true,
  "rate-limit": true,
  network: true,
  provider: true,
  refused: true,
  "out-of-credit": true,
  region: true,
  "consent-declined": true,
  "consent-revoked": true,
  "local-mode": true,
  "ollama-not-running": true,
  "data-retention": true,
  "not-signed-in": true,
  "plan-limit": true,
  blocked: true,
  "too-long": true,
  "cost-cap": true,
  "no-answer": true,
  unknown: true,
};
const isErrorKind = (value: string | null): value is ProviderErrorKind =>
  value !== null && Object.hasOwn(ERROR_KINDS, value);

const PHASES: Record<AnswerPhase, true> = {
  "waiting-for-consent": true,
  loading: true,
  searching: true,
  writing: true,
  "checking-quotes": true,
  "checking-figures": true,
  "checking-claims": true,
};

const timeOrNull = (value: unknown): string | null =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;

/**
 * An Answer's steps as stored (JSON); null when there are none (an Answer
 * written before #391) or they can't be read. Phases a newer version writes are skipped.
 */
function storedSteps(value: string | null): AnswerSteps | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const phases = Array.isArray(parsed.phases) ? parsed.phases.filter(isRecord) : [];
  const {
    reasoning,
    readShare,
    citedAfterChecking,
    notCitedAfterAsking,
    firstWordMs,
    careful,
    smallModel,
    unbackedClaims,
    unrunTools,
    calculateUnavailable,
    askedAgainFor,
    example,
    coverage,
    writtenFrom,
    stillReading,
    sent,
    textBehind,
  } = parsed;
  const claimed = Array.isArray(unbackedClaims)
    ? unbackedClaims.filter((each): each is ClaimedChange =>
        CLAIMED_CHANGES.some((claim) => claim === each),
      )
    : [];
  const unrun = claimedTools(unrunTools);
  const askedAbout = claimedTools(askedAgainFor);
  return {
    sentAt: timeOrNull(parsed.sentAt),
    finishedAt: timeOrNull(parsed.finishedAt),
    phases: phases.flatMap((each) => {
      const at = timeOrNull(each.at);
      return typeof each.phase === "string" && Object.hasOwn(PHASES, each.phase) && at
        ? [{ phase: each.phase as AnswerPhase, at }]
        : [];
    }),
    reasoning:
      isRecord(reasoning) &&
      typeof reasoning.summary === "string" &&
      reasoning.summary !== "" &&
      typeof reasoning.ms === "number"
        ? { summary: reasoning.summary, ms: reasoning.ms }
        : null,
    ...(typeof readShare === "number" && readShare >= 0 && readShare <= 1 && { readShare }),
    ...(typeof citedAfterChecking === "number" &&
      Number.isInteger(citedAfterChecking) &&
      citedAfterChecking > 0 && { citedAfterChecking }),
    ...(notCitedAfterAsking === true && { notCitedAfterAsking }),
    ...(typeof firstWordMs === "number" && firstWordMs >= 0 && { firstWordMs }),
    ...(careful === true && { careful }),
    ...(smallModel === true && { smallModel }),
    ...(claimed.length > 0 && { unbackedClaims: claimed }),
    ...(unrun.length > 0 && {
      unrunTools: unrun,
      ...(calculateUnavailable === true && { calculateUnavailable }),
    }),
    ...(askedAbout.length > 0 && { askedAgainFor: askedAbout }),
    ...(example === true && { example }),
    ...(textBehind === true && { textBehind }),
    ...(storedCoverage(coverage) ?? {}),
    ...(isRecord(writtenFrom) &&
      isCount(writtenFrom.documents) &&
      isCount(writtenFrom.total) && {
        writtenFrom: { documents: writtenFrom.documents, total: writtenFrom.total },
      }),
    ...(isRecord(stillReading) &&
      isCount(stillReading.count) && {
        stillReading: {
          count: stillReading.count,
          ...(typeof stillReading.name === "string" &&
            stillReading.name !== "" && { name: stillReading.name }),
        },
      }),
    ...(isRecord(sent) &&
      Array.isArray(sent.documents) && {
        sent: {
          documents: sent.documents.filter((each): each is string => typeof each === "string"),
          ...(sent.transcript === true && { transcript: true as const }),
        },
      }),
  };
}

const claimedTools = (value: unknown): ClaimedTool[] =>
  Array.isArray(value)
    ? value.filter((each): each is ClaimedTool => CLAIMED_TOOLS.some((tool) => tool === each))
    : [];

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

function storedCoverage(value: unknown): { coverage: AnswerCoverage } | null {
  if (!isRecord(value) || (value.kind !== "main" && value.kind !== "largest")) return null;
  const used = Array.isArray(value.used)
    ? value.used.flatMap((each) =>
        isRecord(each) && typeof each.id === "string" && typeof each.name === "string"
          ? [{ id: each.id, name: each.name }]
          : [],
      )
    : [];
  const rest = Array.isArray(value.rest)
    ? value.rest.filter((each): each is string => typeof each === "string")
    : [];
  return used.length > 0 ? { coverage: { kind: value.kind, used, rest } } : null;
}

/** A conversation's name: the title the User typed, else its own. */
const nameOf = (row: { title: string; auto_title: string }) => row.title || row.auto_title;

/** The records in a list stored as JSON; none when it isn't one (written by a newer version, say). */
function storedList<T>(value: string): T[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed.filter(isRecord) as T[]) : [];
  } catch {
    return [];
  }
}

/** An Answer's text as words are read from it: each figure marker its figure's shown text. */
function shownText(text: string, figures: readonly MarkedFigure[]): string {
  if (figures.length === 0) return withFigureText(text, () => null);
  const byMarker = new Map(figures.map((figure) => [figure.marker, figure]));
  return withFigureText(text, (marker) => byMarker.get(marker) ?? null);
}

function storedScope(value: string | null): SearchScope | null {
  if (value === null) return null;
  try {
    return parseSearchScope(JSON.parse(value));
  } catch {
    return null;
  }
}

const modelOf = (row: Pick<MessageRow, "provider_id" | "model_id">): ChatModelChoice | null =>
  row.provider_id && row.model_id ? { providerId: row.provider_id, modelId: row.model_id } : null;

const askedFromOf = (row: MessageRow): AskedFrom | null =>
  row.asked_from_mind_id === null
    ? null
    : { mindId: row.asked_from_mind_id, name: row.mind_name ?? "", deleted: row.mind_gone !== 0 };

const readOf = (row: MessageRow): MindRead | null =>
  row.read_mind_id === null
    ? null
    : {
        mindId: row.read_mind_id,
        name: row.read_mind_name ?? "",
        deleted: row.read_mind_gone !== 0,
        version: row.read_mind_version ?? "",
        partial: row.read_partial === 1,
      };

/** Where the User was in a Mind, as stored (JSON); null when there is none or it can't be read. */
function storedFocus(value: string | null): MindFocus | null {
  if (value === null) return null;
  try {
    return parseFocus(JSON.parse(value));
  } catch {
    return null;
  }
}

/** The Documents open on screen, by id, in order, each once; throws for anything but a list of ids. */
export function parseOnScreen(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id !== "")) {
    throw new InvalidInputError({ key: "error.question.onScreen" });
  }
  return [...new Set(value as string[])];
}

// Two pages of dense text, the most a Citation covers, with room to spare.
const MOST_QUOTED_CHARACTERS = 50_000;

const pageOf = (value: unknown): number | null | undefined =>
  value === null
    ? null
    : typeof value === "number" && Number.isInteger(value) && value >= 1
      ? value
      : undefined;

function parseQuote(value: unknown): AskedQuote | null {
  if (!isRecord(value)) return null;
  const { documentId, documentName, quote } = value;
  const pageFrom = pageOf(value.pageFrom);
  const pageTo = pageOf(value.pageTo);
  const location = value.location === null ? null : parseLocation(value.location);
  if (
    typeof documentId !== "string" ||
    documentId === "" ||
    typeof documentName !== "string" ||
    typeof quote !== "string" ||
    quote.trim() === "" ||
    quote.length > MOST_QUOTED_CHARACTERS ||
    pageFrom === undefined ||
    pageTo === undefined ||
    (value.location !== null && location === null)
  ) {
    return null;
  }
  return { documentId, documentName, quote, pageFrom, pageTo, location };
}

function parseQuotes(value: unknown): AskedQuote[] {
  if (value === undefined || value === null) return [];
  const unreadable = () => new InvalidInputError({ key: "error.question.quotes" });
  if (!Array.isArray(value)) throw unreadable();
  if (value.length > MOST_ASKED_QUOTES) {
    throw new InvalidInputError({
      key: "error.question.quotes.tooMany",
      values: { count: MOST_ASKED_QUOTES },
    });
  }
  return value.map((each) => {
    const quote = parseQuote(each);
    if (!quote) throw unreadable();
    return quote;
  });
}

/** A `MindFocus`, or null for anything else. */
function parseFocus(value: unknown): MindFocus | null {
  if (!isRecord(value) || typeof value.selection !== "string" || !Array.isArray(value.blockIds)) {
    return null;
  }
  const blockIds = value.blockIds.filter((id): id is string => typeof id === "string" && id !== "");
  return { selection: value.selection, blockIds };
}

function toQuestion(row: MessageRow): ConversationQuestion {
  return {
    kind: "question",
    id: row.id,
    conversationId: row.conversation_id,
    text: row.text,
    askedFrom: askedFromOf(row),
    focus: storedFocus(row.focus),
    scope: storedScope(row.scope),
    model: modelOf(row),
    forcedSkill: row.forced_skill,
    analyse: row.analyse === 1,
    quotes: storedList<unknown>(row.quotes ?? "[]").flatMap((each) => parseQuote(each) ?? []),
    createdAt: row.created_at,
  };
}

function toAnswer(row: MessageRow): ConversationAnswer {
  const status = STATUSES.find((each) => each === row.status) ?? "stopped";
  return {
    kind: "answer",
    id: row.id,
    conversationId: row.conversation_id,
    questionId: row.question_id ?? "",
    text: row.text,
    citations: storedList<MarkedCitation>(row.citations),
    figures: storedList<MarkedFigure>(row.figures),
    claimChecks: storedList<ClaimCheckAttributes>(row.claim_checks),
    analyses: storedList<AnswerAnalysis>(row.analyses),
    model: modelOf(row),
    status,
    errorKind:
      status !== "failed" ? null : isErrorKind(row.error_kind) ? row.error_kind : "unknown",
    errorMessage: status === "failed" ? row.error_message : null,
    errorSignInRoute:
      status === "failed" && isSignInRouteProblem(row.error_sign_in_route)
        ? row.error_sign_in_route
        : null,
    citationSupport: SUPPORTS.find((each) => each === row.citation_support) ?? null,
    toolCalls: storedList<AnswerToolCall>(row.tool_calls),
    textOrigin: parseThirdPartySource(row.text_origin),
    read: readOf(row),
    steps: storedSteps(row.steps),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A stored message as the public interface gives it; null for a kind this version doesn't know. */
const toMessage = (row: MessageRow): ConversationMessage | null =>
  row.kind === "question" ? toQuestion(row) : row.kind === "answer" ? toAnswer(row) : null;

const messagesOf = (rows: readonly MessageRow[]) =>
  rows.map(toMessage).filter((message): message is ConversationMessage => message !== null);

/**
 * No model wrote the example's Answer, so it isn't the model's own earlier turn
 * for a Question asked from another Mind than the one the example was asked in.
 */
function withoutExample(
  messages: readonly ConversationMessage[],
  mindId: string | null,
): ConversationMessage[] {
  const left = new Set<string>();
  for (const answer of messages) {
    if (answer.kind !== "answer" || !answer.steps?.example) continue;
    const question = messages.find((each) => each.id === answer.questionId);
    if (question?.kind === "question" && question.askedFrom?.mindId !== mindId) {
      left.add(question.id).add(answer.id);
    }
  }
  return messages.filter((each) => !left.has(each.id));
}

/** An Answer's `read_mind_id`, `read_mind_version` and `read_partial`. */
const readColumns = (read: AnswerRead | null): [string | null, string | null, number] => [
  read?.mindId ?? null,
  read?.version ?? null,
  read?.partial ? 1 : 0,
];

export function createConversations(db: Database, now: () => string) {
  /** The state before each conversation's first unpublished turn, shared by overlapping turns. */
  const pendingTurns = new Map<string, { updatedAt: string; answerIds: Set<string> }>();

  /** Each conversation's Minds asked from, each once, in the order first asked from. */
  function askedFromIn(ids: readonly string[]): Map<string, AskedFrom[]> {
    const rows = db.all<{
      conversation_id: string;
      mind_id: string;
      name: string | null;
      gone: number;
    }>(
      `SELECT msg.conversation_id, msg.asked_from_mind_id AS mind_id, min(msg.position) AS first,
         ${MIND_NAME} AS name, ${MIND_GONE} AS gone
       FROM conversation_messages msg
       LEFT JOIN minds mind ON mind.id = msg.asked_from_mind_id
       WHERE msg.conversation_id ${IN} AND msg.kind = 'question'
         AND msg.asked_from_mind_id IS NOT NULL AND msg.deleted_at IS NULL
       GROUP BY msg.conversation_id, msg.asked_from_mind_id
       ORDER BY msg.conversation_id, first`,
      [JSON.stringify(ids)],
    );
    const minds = new Map<string, AskedFrom[]>();
    for (const row of rows) {
      const list = minds.get(row.conversation_id) ?? [];
      list.push({ mindId: row.mind_id, name: row.name ?? "", deleted: row.gone !== 0 });
      minds.set(row.conversation_id, list);
    }
    return minds;
  }

  function toConversations(rows: readonly ConversationRow[]): Conversation[] {
    const minds = askedFromIn(rows.map((row) => row.id));
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      autoTitle: row.auto_title,
      folderId: row.folder_id,
      askedFrom: minds.get(row.id) ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** A conversation that isn't deleted, by id; throws otherwise. */
  const liveRow = (conversationId: unknown): ConversationRow => {
    if (typeof conversationId !== "string" || conversationId === "") {
      throw new InvalidInputError("A conversation id must be a non-empty string.");
    }
    const row = db.get<ConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = ? AND deleted_at IS NULL`,
      [conversationId],
    );
    if (!row) throw new NotFoundError({ key: "error.conversation.notFound" });
    return row;
  };

  const get = (conversationId: unknown): Conversation => {
    const [conversation] = toConversations([liveRow(conversationId)]);
    if (!conversation) throw new NotFoundError({ key: "error.conversation.notFound" });
    return conversation;
  };

  const messageRows = (conversationId: string, where = "", params: readonly SqlValue[] = []) =>
    db.all<MessageRow>(
      `${MESSAGE_SELECT} WHERE msg.conversation_id = ? AND msg.deleted_at IS NULL ${where}
       ORDER BY ${MESSAGE_ORDER}`,
      [conversationId, ...params],
    );

  /** A message that isn't deleted, of a conversation that isn't, by id. */
  const liveMessage = (messageId: unknown) =>
    typeof messageId !== "string"
      ? undefined
      : db.get<MessageRow>(
          `${MESSAGE_SELECT} JOIN conversations c ON c.id = msg.conversation_id
           WHERE msg.id = ? AND msg.deleted_at IS NULL AND c.deleted_at IS NULL`,
          [messageId],
        );

  const storedMessage = (messageId: string): MessageRow => {
    const row = db.get<MessageRow>(`${MESSAGE_SELECT} WHERE msg.id = ?`, [messageId]);
    if (!row) throw new Error("The message wasn't saved.");
    return row;
  };

  /** Indexes a conversation's name (again). */
  const indexName = (seq: number, name: string) => {
    db.run("DELETE FROM conversations_fts WHERE rowid = ?", [BigInt(seq)]);
    db.run("INSERT INTO conversations_fts (rowid, text) VALUES (?, ?)", [
      BigInt(seq),
      indexText(name),
    ]);
  };

  /** Indexes a message's text (again): its plain text's words, its figures as they are shown. */
  const indexMessage = (seq: number, text: string, figures: readonly MarkedFigure[] = []) => {
    db.run("DELETE FROM conversation_messages_fts WHERE rowid = ?", [BigInt(seq)]);
    db.run("INSERT INTO conversation_messages_fts (rowid, text) VALUES (?, ?)", [
      BigInt(seq),
      indexText(plainText(shownText(text, figures))),
    ]);
  };

  /** Adds a message at the end of a conversation; returns its row. Run in a transaction. */
  function insertMessage(
    conversationId: string,
    fields: {
      kind: "question" | "answer";
      text: string;
      questionId?: string;
      askedFrom?: string | null;
      focus?: MindFocus | null;
      scope?: SearchScope | null;
      model: ChatModelChoice | null;
      forcedSkill?: string | null;
      analyse?: boolean;
      quotes?: readonly AskedQuote[];
      status?: AnswerStatus;
      read?: AnswerRead | null;
    },
    at: string,
  ): MessageRow {
    const id = randomUUID();
    db.run(
      `INSERT INTO conversation_messages (id, conversation_id, position, kind, question_id, text,
         asked_from_mind_id, focus, scope, provider_id, model_id, forced_skill, analyse, quotes, status,
         read_mind_id, read_mind_version, read_partial, created_at, updated_at)
       VALUES (?, ?, (SELECT coalesce(max(position), 0) + 1 FROM conversation_messages
                      WHERE conversation_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        conversationId,
        conversationId,
        fields.kind,
        fields.questionId ?? null,
        fields.text,
        fields.askedFrom ?? null,
        fields.focus ? JSON.stringify(fields.focus) : null,
        fields.scope ? JSON.stringify(fields.scope) : null,
        fields.model?.providerId ?? null,
        fields.model?.modelId ?? null,
        fields.forcedSkill ?? null,
        fields.analyse ? 1 : 0,
        fields.quotes?.length ? JSON.stringify(fields.quotes) : null,
        fields.status ?? null,
        ...readColumns(fields.read ?? null),
        at,
        at,
      ],
    );
    return storedMessage(id);
  }

  /** The Question, its Answer as stored now, and the messages before the Question. */
  const turnOf = (question: MessageRow, answerId: string): Turn => ({
    conversation: get(question.conversation_id),
    question: toQuestion(question),
    answer: toAnswer(storedMessage(answerId)),
    earlier: withoutExample(
      messagesOf(
        messageRows(question.conversation_id, "AND msg.position < ?", [BigInt(question.position)]),
      ),
      question.asked_from_mind_id,
    ),
  });

  /** Answers left being written by an earlier run of the app: nothing writes them any more. */
  db.transaction(() => {
    for (const row of db.all<{ seq: number; text: string; figures: string }>(
      `UPDATE conversation_messages SET status = 'stopped', updated_at = ?
       WHERE kind = 'answer' AND status = 'streaming' RETURNING seq, text, figures`,
      [now()],
    )) {
      indexMessage(row.seq, row.text, storedList<MarkedFigure>(row.figures));
    }
  });

  /**
   * Calls `add` with every Citation kept by an Answer of a conversation not
   * deleted permanently: its own, and those its calculated figures' inputs read.
   */
  function eachCitation(add: (citation: CitationFields) => void): void {
    const rows = db.all<{ citations: string; figures: string; analyses: string }>(
      `SELECT msg.citations, msg.figures, msg.analyses FROM conversation_messages msg
       JOIN conversations c ON c.id = msg.conversation_id
       WHERE msg.kind = 'answer' AND msg.deleted_at IS NULL AND c.purged_at IS NULL
         AND (msg.citations <> '[]' OR msg.figures <> '[]' OR msg.analyses <> '[]')`,
    );
    const addInput = (input: FigureInput) => {
      const unit = input.unitStatement?.citation;
      if (isRecord(input.citation)) add(input.citation);
      if (isRecord(unit)) add(unit);
    };
    for (const row of rows) {
      for (const citation of storedList<CitationFields>(row.citations)) add(citation);
      for (const figure of storedList<MarkedFigure>(row.figures)) {
        for (const input of Array.isArray(figure.inputs) ? figure.inputs : []) addInput(input);
      }
      // An Analysis's ranges and numbers keep the versions they were read from, to run it again.
      for (const analysis of storedList<AnswerAnalysis>(row.analyses)) {
        for (const input of Array.isArray(analysis.inputs) ? analysis.inputs : []) {
          if (input.kind === "range" && isRecord(input.citation)) add(input.citation);
          else if (input.kind === "figure" && isRecord(input.input)) addInput(input.input);
        }
      }
    }
  }

  return {
    get,

    /** See `CoreApi.listConversations`. */
    list(options: unknown): Conversation[] {
      if (options !== undefined && !isRecord(options)) {
        throw new InvalidInputError("listConversations expects an object.");
      }
      const folderId = options?.folderId;
      if (
        folderId !== undefined &&
        folderId !== null &&
        (typeof folderId !== "string" || folderId === "")
      ) {
        throw new InvalidInputError("A Folder id must be a non-empty string, or null for none.");
      }
      const where =
        folderId === undefined
          ? ""
          : folderId === null
            ? "AND folder_id IS NULL"
            : "AND folder_id = ?";
      return toConversations(
        db.all<ConversationRow>(
          `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE deleted_at IS NULL ${where}
           ORDER BY updated_at DESC, seq DESC`,
          typeof folderId === "string" ? [folderId] : [],
        ),
      );
    },

    /** See `CoreApi.getConversation`. */
    content(conversationId: unknown): ConversationContent {
      const conversation = get(conversationId);
      return { conversation, messages: messagesOf(messageRows(conversation.id)) };
    },

    usualWait(answerId: unknown): number | null {
      if (typeof answerId !== "string") return null;
      const asked = db.get<{ provider_id: string | null; model_id: string | null; text: string }>(
        `SELECT answer.provider_id, answer.model_id, question.text
         FROM conversation_messages answer
         JOIN conversation_messages question ON question.id = answer.question_id
         WHERE answer.id = ? AND answer.kind = 'answer' AND answer.deleted_at IS NULL`,
        [answerId],
      );
      if (!asked?.provider_id || !asked.model_id) return null;
      const careful = asksToCheckOrCalculate(asked.text);
      const rows = db.all<{ steps: string }>(
        `SELECT steps FROM conversation_messages
         WHERE kind = 'answer' AND status = 'done' AND provider_id = ? AND model_id = ?
           AND steps IS NOT NULL AND id != ? AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT ?`,
        [asked.provider_id, asked.model_id, answerId, 50],
      );
      return usualWait(
        rows.flatMap((row) => {
          const steps = storedSteps(row.steps);
          return steps?.firstWordMs !== undefined && (steps.careful === true) === careful
            ? [steps.firstWordMs]
            : [];
        }),
      );
    },

    /**
     * Reads `askInConversation`'s input: the Question's text, its conversation (not
     * deleted), the Mind in focus (not deleted, with its Folder), its Search scope, model
     * and forced Skill. Throws, keeping nothing, for anything else.
     */
    parseQuestion(input: unknown): QuestionInput {
      if (!isRecord(input)) throw new InvalidInputError("askInConversation expects an object.");
      const { text, conversationId, mindId, model, forcedSkill, focus, analyse } = input;
      if (typeof text !== "string" || text.trim() === "") {
        throw new InvalidInputError({ key: "error.question.empty" });
      }
      let mind: QuestionInput["mind"] = null;
      if (mindId !== undefined && mindId !== null) {
        if (typeof mindId !== "string" || mindId === "") {
          throw new InvalidInputError("A Mind id must be a non-empty string, or null for none.");
        }
        const row = db.get<{ folder_id: string | null }>(
          "SELECT folder_id FROM minds WHERE id = ? AND deleted_at IS NULL",
          [mindId],
        );
        if (!row) throw new NotFoundError({ key: "error.mind.notFound" });
        mind = { id: mindId, folderId: row.folder_id };
      }
      if (model !== undefined && model !== null && !isChatModelChoice(model)) {
        throw new InvalidInputError("A model must be { providerId, modelId }.");
      }
      const where = focus === undefined || focus === null ? null : parseFocus(focus);
      if (focus !== undefined && focus !== null && where === null) {
        throw new InvalidInputError("A focus must be { selection, blockIds }.");
      }
      if (
        forcedSkill !== undefined &&
        forcedSkill !== null &&
        (typeof forcedSkill !== "string" || forcedSkill === "")
      ) {
        throw new InvalidInputError("A forced Skill must be a Skill's name.");
      }
      if (analyse !== undefined && typeof analyse !== "boolean") {
        throw new InvalidInputError({ key: "error.question.analyseChoice" });
      }
      return {
        conversationId:
          conversationId === undefined || conversationId === null
            ? null
            : liveRow(conversationId).id,
        text: text.trim(),
        mind,
        focus: mind ? where : null,
        onScreen: parseOnScreen(input.onScreen),
        quotes: parseQuotes(input.quotes),
        scope: parseSearchScope(input.scope),
        model: model ?? null,
        forcedSkill: typeof forcedSkill === "string" ? forcedSkill : null,
        analyse: analyse === true,
      };
    },

    /**
     * Adds a Question, starting its conversation when it has none, and its Answer, being
     * written with `answerModel` from the Mind it reads (`read`), all in one go. A new
     * conversation is named by the Question and belongs to the Folder of the Mind in
     * focus, or to none.
     */
    add(
      input: Omit<QuestionInput, "onScreen">,
      answerModel: ChatModelChoice | null,
      read: AnswerRead | null,
    ): AddedTurn {
      const previousConversationUpdatedAt =
        input.conversationId === null
          ? null
          : (pendingTurns.get(input.conversationId)?.updatedAt ??
            liveRow(input.conversationId).updated_at);
      const added = db.transaction(() => {
        const at = now();
        let conversationId = input.conversationId;
        if (conversationId === null) {
          conversationId = randomUUID();
          const autoTitle = cutTitle(input.text);
          const created = db.get<{ seq: number }>(
            `INSERT INTO conversations (id, auto_title, folder_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?) RETURNING seq`,
            [conversationId, autoTitle, input.mind?.folderId ?? null, at, at],
          );
          if (!created) throw new Error("The conversation wasn't saved.");
          indexName(created.seq, autoTitle);
        } else {
          db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [
            at,
            liveRow(conversationId).id,
          ]);
        }
        const question = insertMessage(
          conversationId,
          {
            kind: "question",
            text: input.text,
            askedFrom: input.mind?.id ?? null,
            focus: input.focus,
            scope: input.scope,
            model: input.model,
            forcedSkill: input.forcedSkill,
            analyse: input.analyse,
            quotes: input.quotes,
          },
          at,
        );
        indexMessage(question.seq, question.text);
        const answer = insertMessage(
          conversationId,
          {
            kind: "answer",
            text: "",
            questionId: question.id,
            model: answerModel,
            status: "streaming",
            read,
          },
          at,
        );
        const turn = turnOf(question, answer.id);
        return { turn, previousConversationUpdatedAt };
      });
      if (previousConversationUpdatedAt !== null) {
        const id = added.turn.conversation.id;
        const pending = pendingTurns.get(id) ?? {
          updatedAt: previousConversationUpdatedAt,
          answerIds: new Set<string>(),
        };
        pending.answerIds.add(added.turn.answer.id);
        pendingTurns.set(id, pending);
      }
      return added;
    },

    publish(turn: Turn): void {
      const pending = pendingTurns.get(turn.conversation.id);
      if (!pending) return;
      pending.answerIds.delete(turn.answer.id);
      // The turn's own time, not the conversation's: another pending turn may have moved that on.
      if (pending.updatedAt < turn.question.createdAt) {
        pending.updatedAt = turn.question.createdAt;
      }
      if (pending.answerIds.size === 0) pendingTurns.delete(turn.conversation.id);
    },

    /** Removes an unpublished turn whose model or Skill couldn't be asked. */
    discard(added: AddedTurn): void {
      const { turn } = added;
      const questionId = turn.question.id;
      const answerId = turn.answer.id;
      const pending = pendingTurns.get(turn.conversation.id);
      const lastPending = pending
        ? pending.answerIds.size === 1 && pending.answerIds.has(answerId)
        : true;
      const previousConversationUpdatedAt =
        pending?.updatedAt ?? added.previousConversationUpdatedAt;
      const discarded = db.transaction(() => {
        const question = db.get<{ seq: number; conversation_id: string; position: number }>(
          `SELECT seq, conversation_id, position FROM conversation_messages
           WHERE id = ? AND kind = 'question' AND deleted_at IS NULL`,
          [questionId],
        );
        const answer = db.get<{ seq: number; conversation_id: string }>(
          `SELECT seq, conversation_id FROM conversation_messages
           WHERE id = ? AND kind = 'answer' AND question_id = ? AND status = 'streaming'
             AND text = '' AND deleted_at IS NULL`,
          [answerId, questionId],
        );
        if (!question || !answer || question.conversation_id !== answer.conversation_id)
          return false;
        db.run("DELETE FROM conversation_messages_fts WHERE rowid IN (?, ?)", [
          BigInt(question.seq),
          BigInt(answer.seq),
        ]);
        db.run("DELETE FROM conversation_messages WHERE id IN (?, ?)", [questionId, answerId]);
        const remaining = db.get<{ count: number }>(
          "SELECT count(*) AS count FROM conversation_messages WHERE conversation_id = ?",
          [question.conversation_id],
        );
        if (remaining?.count !== 0) {
          if (lastPending && previousConversationUpdatedAt !== null) {
            db.run(
              `UPDATE conversations SET updated_at = ?
               WHERE id = ? AND updated_at = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM conversation_messages
                   WHERE conversation_id = ? AND position > ? AND deleted_at IS NULL
                 )`,
              [
                previousConversationUpdatedAt,
                question.conversation_id,
                turn.conversation.updatedAt,
                question.conversation_id,
                question.position,
              ],
            );
          }
          return true;
        }
        db.run(
          "DELETE FROM conversations_fts WHERE rowid IN (SELECT seq FROM conversations WHERE id = ?)",
          [question.conversation_id],
        );
        db.run("DELETE FROM conversations WHERE id = ?", [question.conversation_id]);
        return true;
      });
      if (!discarded) return;
      pending?.answerIds.delete(answerId);
      if (lastPending) pendingTurns.delete(turn.conversation.id);
    },

    /**
     * The Questions asked from a Mind, in conversations not deleted, oldest
     * first, each with its Answer's text ("" while it has none written).
     */
    askedFromMind(mindId: string): { question: string; answer: string }[] {
      return db
        .all<{ question: string; answer: string | null }>(
          `SELECT q.text AS question, a.text AS answer
           FROM conversation_messages q
           JOIN conversations c ON c.id = q.conversation_id AND c.deleted_at IS NULL
           LEFT JOIN conversation_messages a ON a.question_id = q.id AND a.kind = 'answer'
             AND a.deleted_at IS NULL AND a.status IN ('done', 'stopped')
           WHERE q.kind = 'question' AND q.asked_from_mind_id = ? AND q.deleted_at IS NULL
           ORDER BY q.created_at, q.position`,
          [mindId],
        )
        .map((row) => ({ question: row.question, answer: row.answer ?? "" }));
    },

    /** The Question of an Answer, both live, to write the Answer again, and what is on screen now. */
    questionOf(input: unknown): {
      answerId: string;
      question: ConversationQuestion;
      /** The Tool calls the Answer made, as it stands before it is written again. */
      toolCalls: AnswerToolCall[];
      onScreen: string[];
    } {
      if (!isRecord(input)) {
        throw new InvalidInputError("Expected { conversationId, answerId }.");
      }
      const conversation = liveRow(input.conversationId);
      const answer = liveMessage(input.answerId);
      if (answer?.kind !== "answer" || answer.conversation_id !== conversation.id) {
        throw new NotFoundError({ key: "error.answer.notInConversation" });
      }
      const question = liveMessage(answer.question_id);
      if (question?.kind !== "question") {
        throw new NotFoundError({ key: "error.answer.questionGone" });
      }
      return {
        answerId: answer.id,
        question: toQuestion(question),
        toolCalls: storedList<AnswerToolCall>(answer.tool_calls),
        onScreen: parseOnScreen(input.onScreen),
      };
    },

    /** The Search scope an Answer's Question was asked with; null for none, or once either is gone. */
    askedScope(conversationId: string, answerId: string): SearchScope | null {
      const answer = liveMessage(answerId);
      if (answer?.kind !== "answer" || answer.conversation_id !== conversationId) return null;
      const question = liveMessage(answer.question_id);
      return question?.kind === "question" ? storedScope(question.scope) : null;
    },

    /** Takes the Search scope off a Question, so its Answers search every Document (#748). */
    clearScope(questionId: string): ConversationQuestion | null {
      db.run(
        "UPDATE conversation_messages SET scope = NULL, updated_at = ? WHERE id = ? AND kind = 'question'",
        [now(), questionId],
      );
      const row = liveMessage(questionId);
      return row?.kind === "question" ? toQuestion(row) : null;
    },

    /** Empties an Answer, where it is, to write it again with `answerModel` from the Mind it reads. */
    restartAnswer(
      answerId: string,
      answerModel: ChatModelChoice | null,
      read: AnswerRead | null,
    ): Turn {
      return db.transaction(() => {
        const answer = liveMessage(answerId);
        const question = liveMessage(answer?.question_id);
        if (!answer || !question)
          throw new NotFoundError({ key: "error.answer.notInConversation" });
        db.run(
          `UPDATE conversation_messages SET text = '', citations = '[]', figures = '[]', claim_checks = '[]', analyses = '[]', tool_calls = '[]',
             status = 'streaming', error_kind = NULL, error_message = NULL,
             error_sign_in_route = NULL, citation_support = NULL, text_origin = NULL, steps = NULL, provider_id = ?,
             model_id = ?, read_mind_id = ?, read_mind_version = ?, read_partial = ?,
             updated_at = ?
           WHERE id = ?`,
          [
            answerModel?.providerId ?? null,
            answerModel?.modelId ?? null,
            ...readColumns(read),
            now(),
            answerId,
          ],
        );
        db.run("DELETE FROM conversation_messages_fts WHERE rowid = ?", [BigInt(answer.seq)]);
        return turnOf(question, answerId);
      });
    },

    /**
     * Writes an Answer as it stands, and indexes it once it has ended. Returns it, or
     * null when it is gone: its conversation was deleted.
     */
    writeAnswer(answerId: string, write: AnswerWrite): ConversationAnswer | null {
      const row = liveMessage(answerId);
      if (row?.kind !== "answer") return null;
      const { outcome } = write;
      db.transaction(() => {
        db.run(
          `UPDATE conversation_messages SET text = ?, citations = ?, figures = ?, claim_checks = ?, analyses = ?,
             tool_calls = ?, citation_support = ?, text_origin = ?, read_mind_id = ?, read_mind_version = ?,
             read_partial = ?, steps = ?, status = ?, error_kind = ?, error_message = ?,
             error_sign_in_route = ?, updated_at = ?
           WHERE id = ?`,
          [
            write.text,
            JSON.stringify(write.citations),
            JSON.stringify(write.figures),
            JSON.stringify(write.claimChecks ?? []),
            JSON.stringify(write.analyses),
            JSON.stringify(write.toolCalls),
            write.support,
            write.textOrigin,
            ...readColumns(write.read),
            JSON.stringify(write.steps),
            outcome?.status ?? "streaming",
            outcome?.error?.kind ?? null,
            outcome?.error?.message ?? null,
            outcome?.error?.signInRoute ?? null,
            now(),
            answerId,
          ],
        );
        if (outcome) indexMessage(row.seq, write.text, write.figures);
      });
      return toAnswer(storedMessage(answerId));
    },

    /** Publishes the background checks finished so far, without touching the Answer's text. */
    writeClaimChecks(answerId: string, checks: readonly ClaimCheckAttributes[]): Turn | null {
      const row = liveMessage(answerId);
      if (row?.kind !== "answer") return null;
      db.run("UPDATE conversation_messages SET claim_checks = ?, updated_at = ? WHERE id = ?", [
        JSON.stringify(checks),
        now(),
        answerId,
      ]);
      const question = liveMessage(row.question_id);
      if (question?.kind !== "question") return null;
      return turnOf(question, answerId);
    },

    /** See `CoreApi.renameConversation`. */
    rename(conversationId: unknown, title: unknown): Conversation {
      const row = liveRow(conversationId);
      if (typeof title !== "string") {
        throw new InvalidInputError("A conversation's title must be text.");
      }
      const typed = title.trim();
      db.transaction(() => {
        db.run("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?", [
          typed,
          now(),
          row.id,
        ]);
        indexName(row.seq, nameOf({ title: typed, auto_title: row.auto_title }));
      });
      return get(row.id);
    },

    /** Puts these conversations in a Folder (checked by the caller), or in none; returns where each was. */
    move(conversationIds: readonly string[], folderId: string | null): MovedItem[] {
      return db.transaction(() => {
        const moved = conversationIds.map((id) => ({ id, from: liveRow(id).folder_id }));
        const at = now();
        for (const item of moved) {
          if (item.from === folderId) continue;
          db.run("UPDATE conversations SET folder_id = ?, updated_at = ? WHERE id = ?", [
            folderId,
            at,
            item.id,
          ]);
        }
        return moved;
      });
    },

    /** Marks a conversation deleted at `at`; its messages stay as they are, for `restore`. */
    delete(conversationId: unknown, at: string): Conversation {
      const conversation = get(conversationId);
      db.run("UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE id = ?", [
        at,
        at,
        conversation.id,
      ]);
      return conversation;
    },

    /** Brings back a deleted conversation with its messages (the caller checks it may). */
    restore(conversationId: string): void {
      db.run("UPDATE conversations SET deleted_at = NULL, updated_at = ? WHERE id = ?", [
        now(),
        conversationId,
      ]);
    },

    /** A Folder was deleted: its conversations go to Not in a Folder, deleted ones too. Returns them. */
    leaveFolder(folderId: string): { id: string; live: boolean }[] {
      return db
        .all<{ id: string; live: number }>(
          `UPDATE conversations SET folder_id = NULL, updated_at = ? WHERE folder_id = ?
           RETURNING id, deleted_at IS NULL AS live`,
          [now(), folderId],
        )
        .map((row) => ({ id: row.id, live: row.live === 1 }));
    },

    /** A deleted Folder was restored: these go back into it, those still in none. Returns whether a live one did. */
    returnToFolder(conversationIds: readonly string[], folderId: string): boolean {
      return db
        .all<{ live: number }>(
          `UPDATE conversations SET folder_id = ?, updated_at = ?
           WHERE folder_id IS NULL AND id ${IN}
           RETURNING deleted_at IS NULL AS live`,
          [folderId, now(), JSON.stringify(conversationIds)],
        )
        .some((row) => row.live === 1);
    },

    /** See `CoreApi.searchConversations`. */
    search(query: unknown): ConversationMatch[] {
      if (typeof query !== "string") throw new InvalidInputError("A search must be text.");
      const terms = searchTerms(query);
      if (terms.length === 0) return [];
      // Every word somewhere in the conversation: in its name, or in one of its messages.
      const withEach = terms.map((term) => {
        const match = termQuery(term);
        return db
          .all<{ id: string }>(
            `SELECT c.id FROM conversations c
             WHERE c.deleted_at IS NULL AND (
               c.seq IN (SELECT rowid FROM conversations_fts WHERE conversations_fts MATCH ?)
               OR c.id IN (
                 SELECT msg.conversation_id FROM conversation_messages msg
                 WHERE msg.deleted_at IS NULL AND msg.seq IN (
                   SELECT rowid FROM conversation_messages_fts
                   WHERE conversation_messages_fts MATCH ?)))`,
            [match, match],
          )
          .map((row) => row.id);
      });
      const found = (withEach[0] ?? []).filter((id) => withEach.every((list) => list.includes(id)));
      if (found.length === 0) return [];
      const ids = JSON.stringify(found);
      const messages = db.all<MessageRow>(
        `${MESSAGE_SELECT}
         WHERE msg.conversation_id ${IN} AND msg.deleted_at IS NULL AND msg.seq IN (
           SELECT rowid FROM conversation_messages_fts WHERE conversation_messages_fts MATCH ?)
         ORDER BY ${MESSAGE_ORDER}`,
        [ids, terms.map(termQuery).join(" OR ")],
      );
      const rows = db.all<ConversationRow>(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id ${IN}
         ORDER BY updated_at DESC, seq DESC`,
        [ids],
      );
      return toConversations(rows).map((conversation) => ({
        conversation,
        titleHighlights: findTerms(conversationName(conversation), terms),
        messages: messages
          .filter((row) => row.conversation_id === conversation.id)
          .flatMap((row) => {
            const message = toMessage(row);
            if (!message) return [];
            return [
              {
                messageId: message.id,
                kind: message.kind,
                ...excerptOf(
                  plainText(shownText(row.text, storedList<MarkedFigure>(row.figures))),
                  terms,
                ),
              },
            ];
          }),
      }));
    },

    /**
     * Where a message of a conversation is now: there, or in a conversation in Recently
     * deleted (with its name); null when it is gone (deleted permanently, the message
     * removed, or never here).
     */
    locate(
      conversationId: string,
      messageId: string,
    ): { name: string; deletedAt: string | null } | null {
      const row = db.get<{
        title: string;
        auto_title: string;
        deleted_at: string | null;
        purged_at: string | null;
      }>("SELECT title, auto_title, deleted_at, purged_at FROM conversations WHERE id = ?", [
        conversationId,
      ]);
      const message = db.get(
        "SELECT 1 FROM conversation_messages WHERE id = ? AND conversation_id = ? AND deleted_at IS NULL",
        [messageId, conversationId],
      );
      if (!row || row.purged_at !== null || !message) return null;
      return { name: nameOf(row), deletedAt: row.deleted_at };
    },

    /**
     * Adds the versions the Citations of conversations quote to `cited`: those in Recently
     * deleted too, so a conversation restored keeps Citations that can be checked.
     */
    addCitedVersions(cited: CitedVersions): void {
      eachCitation((citation) => addCitedVersion(citation, cited));
    },

    /** Adds the Units the Citations of conversations point to in these Documents to `cited`. */
    addCitedUnits(documentIds: ReadonlySet<string>, cited: CitedUnits[]): void {
      eachCitation((citation) => addCitedUnit(citation, documentIds, cited));
    },

    /** Calls `visit` with the attributes of each Citation in the Answers of conversations. */
    eachCitation,
  };
}

export type Conversations = ReturnType<typeof createConversations>;
