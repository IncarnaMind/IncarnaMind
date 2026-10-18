/**
 * Asking Questions (ADR-0007): the core builds the Question context, has the
 * Answer engine stream an Answer, and writes it as it arrives, right after its
 * Question, so every window sees it grow: its text, its Citations (see
 * ./citations), and the Tools it called (searches, and the Skills it used). An
 * Answer has one of two homes: its Mind's Yjs document, or one of the
 * assistant's conversations (../conversations, ADR-0017), whose rows keep its
 * Markdown and Citations. It also pushes the Answer event stream for UI state
 * and the evaluation.
 *
 * Skills: the instructions list the enabled Skills' names and descriptions,
 * and the model loads one with `use_skill` when it needs it. A Skill the
 * Question forces is loaded up front, and shown as a Tool call too.
 *
 * Connector Tools and Skill scripts (`run_skill_script`, see
 * ../skills/scripts) go through one gate, which the Run engine awaits before
 * each call (see ../runs/engine): approvals decide from the call's Effects
 * whether it asks first (see ../approvals). One that asks pauses the Answer
 * there until the User decides; the call's card records the decision. A
 * denied call isn't made: the model is told so, and the Answer carries on. A
 * script's card also keeps how the run ended and what it wrote. Stopping the
 * Answer stops a running script.
 *
 * A Question in a conversation reads the Mind it was asked from (#544), as
 * it is when the Answer is written, where the User was in it first (./context,
 * `readMind`); the Answer records which Mind it read, and its version.
 *
 * Third-party text (CONTEXT.md, #78): an Answer whose Question context holds
 * text someone else wrote (Blocks, or earlier Answers, with a third-party
 * origin), or whose Run reads a saved web page, asks before a call that writes
 * or sends data, even where the User chose "always"; its approval request
 * says why. The Answer keeps where that text came from (beside a Mind's
 * Blocks, `MIND_TEXT_ORIGINS_FIELD`, or on a conversation's Answer), so a
 * later Question with the Answer in its context counts as having read it too.
 *
 * A Question with a Search scope searches only the Documents it covers,
 * resolved when the Question is asked (or its Answer regenerated), and the
 * instructions name only those. When the scope covers no Document with
 * Passages, the Answer says so, and nothing is searched or sent.
 *
 * Everything here depends on the `AnswerEngine` port, not on the AI SDK.
 */
import { randomUUID } from "node:crypto";
import type * as Y from "yjs";
import { asGenerated } from "../../shared/aiText";
import { answerBlocks } from "../../shared/answerBlocks";
import { runsByDefault } from "../../shared/approvalRules";
import { citationNode, withCitations } from "../../shared/blockJson";
import type { LiveDocument } from "../../shared/citations";
import { withFigures, withFigureText } from "../../shared/figureMarkers";
import { linkTableSources } from "../../shared/markdownTables";
import type { MeetingHelpKind } from "../../shared/meetingHelp";
import {
  linkKnownSources,
  type NamedSource,
  namesOneOf,
  sourcesAsText,
} from "../../shared/namedSources";
import { withoutFraming } from "../../shared/noteBlocks";
import {
  decisionsOn,
  pendingProposals,
  recordProposalRequest,
  resolveProposals,
} from "../../shared/proposals";
import { hasSearchScope, searchScopeOf } from "../../shared/searchScope";
import { setTextOrigin } from "../../shared/textOrigins";
import {
  ANSWER_BLOCK,
  type AnswerAttributes,
  type AnswerPhase,
  type AnswerPlace,
  type AnswerSteps,
  type AnswerToolCall,
  type AnswerUsage,
  type AskResult,
  BLOCK_ID_ATTRIBUTE,
  type ChatModelChoice,
  type ChatReadiness,
  type CitationSupport,
  type ClaimedChange,
  type ConversationAnswer,
  type ConversationAskResult,
  type ConversationMessage,
  type ConversationQuestion,
  type CoreEventName,
  type CoreEvents,
  type Effect,
  type ExternalService,
  type FigureRetry,
  type MarkedCitation,
  type MarkedFigure,
  MIND_CONTENT_FIELD,
  type MindChange,
  type MindFocus,
  type MindProblem,
  type ProviderError,
  QUESTION_BLOCK,
  type QuoteRetry,
  type SearchScope,
  type SkillAvailability,
  type SkillScriptRun,
  type ThirdPartyReason,
  type ThirdPartySource,
  type ToolCallApproval,
  type UnreadFile,
  type WebPageCall,
} from "../api";
import type { CallToDecide, ToolCallToApprove } from "../approvals";
import type { AnswerRead, AnswerWrite, QuestionInput, Turn } from "../conversations";
import type { WindowedPassage } from "../documents/search";
import { ChatNotReadyError, InvalidInputError, isRecord, NotFoundError } from "../errors";
import type { createEventHub } from "../events";
import type { ExecAccess } from "../execution";
import type { Language } from "../language";
import type { MindContent } from "../mindContent";
import { plainText } from "../mindText";
import { docOf } from "../proposals/merge";
import { proposeBlocks } from "../proposals/write";
import { givesStructuredOutput, calculates as offersCalculate } from "../providers/capabilities";
import type { PreparedChatModel } from "../providers/chat";
import { classifyProviderError } from "../providers/providerErrors";
import type { WebResult } from "../providers/webSearch";
import { messageReference } from "../references";
import type { GateDecision } from "../runs/engine";
import type { SkillScript, SkillSession } from "../skills";
import {
  parseScriptArgs,
  type ScriptToRun,
  scriptNotRun,
  scriptResultText,
} from "../skills/scripts";
import { scriptCallInput, skillTools } from "../skills/tools";
import { asksForSources } from "../sources/intent";
import {
  DOCUMENT_TOOLS,
  SKILL_TOOLS,
  type Tool,
  type ToolCallContext,
  type ToolProvider,
  type ToolProviderKind,
} from "../tools";
import { type MindsForTools, type MindToolsOptions, mindTools } from "../tools/minds/tools";
import { asksForWeb } from "../tools/web/intent";
import { type SavedPage, webTools } from "../tools/web/tools";
import {
  contentHash,
  createElement,
  findBlock,
  isEdited,
  type NodeJSON,
  syncContent,
  textAttribute,
  topLevelBlocks,
} from "./blocks";
import { answerLanguage, createCalculationSession } from "./calculations";
import { asksToCheckOrCalculate } from "./carefulIntent";
import {
  type AnswerDocuments,
  createCitationSession,
  withoutFootnoteDefinitions,
} from "./citations";
import {
  askAgainNote,
  askToWriteNote,
  unbackedClaims as claimsNoCallMade,
  holdBack,
} from "./claimedChanges";
import {
  conversationContext,
  conversationContextOf,
  estimateTokens,
  MIND_TOKEN_LIMIT,
  type MindCut,
  type MindReading,
  type MindSection,
  QUESTION_CONTEXT_TOKEN_BUDGET,
  type QuestionContext,
  questionContextOf,
  type RequestMind,
  readMind,
} from "./context";
import { coverageInstructions, coverageOf, documentsAsked, type SizedDocument } from "./coverage";
import {
  documentTextBlock,
  givenUpFront,
  OPENING_TOKEN_LIMIT,
  openingWithin,
  SMALL_SCOPE_DOCUMENTS,
  upFrontTokens,
} from "./documentText";
import type {
  AnswerEngine,
  AnswerSearchOptions,
  AnswerTools,
  CiteOptions,
  DocumentLanguage,
  GatedCall,
  ToolSet,
} from "./engine";
import { listenedTokens, newestWithin, withBeforeQuestion, withTranscript } from "./liveTranscript";
import { markdownToBlocks } from "./markdown";
import {
  FOUND_TOKEN_LIMIT,
  foundWithin,
  languageSaid,
  meetingHelpInstructions,
  newestSaid,
  withFound,
} from "./meetingHelp";
import { paragraphAsked } from "./paragraphAsked";
import {
  answerInstructions,
  connectorInstructions,
  documentInstructions,
  LISTED_DOCUMENTS,
  type ListedDocuments,
  languageInstruction,
  loadedSkillText,
  meetingInstructions,
  mindInstructions,
  signInNeededInstructions,
  skillInstructions,
  sourcesInstructions,
  webInstructions,
  withPassageNotes,
  workingCopyNote,
} from "./prompt";
import { quotedWordsIn, withoutQuotationMarks } from "./quotedWords";
import { type RequestContext, routeRequest } from "./routeRequest";
import { withoutSearchTalk } from "./searchTalk";
import type { ChangeStates } from "./toolRecord";
import type { TurnCheck } from "./turnChecks";

export type { AnswerDocuments } from "./citations";
export { createAiSdkAnswerEngine } from "./engine";

/**
 * How often a streaming Answer is written into its Mind: often enough to look
 * live, seldom enough not to store one Yjs update per token.
 */
const ANSWER_WRITE_INTERVAL_MS = 50;

type Outcome = { status: "done" | "stopped" } | { status: "failed"; error: ProviderError };

interface Generation {
  home: AnswerHome;
  /** The model writing it. */
  model: ChatModelChoice;
  /** Writes what has arrived with the final status, now. Later calls do nothing. */
  finish(outcome: Outcome): void;
  /** A Task's work (a comparison table's cell): its Task, not the Answer, holds background work back. */
  task: boolean;
}

/**
 * Where an Answer is written as it streams: into its Mind's Yjs document, or into
 * a conversation's rows (ADR-0017). `place` is what its events and approval
 * requests say.
 */
interface AnswerHome {
  place: AnswerPlace;
  /** Writes the Answer as it stands; false when it is gone (or its Mind or conversation is). */
  write(answer: WrittenAnswer, outcome?: Outcome): boolean;
}

/** An Answer as it stands, for its home to write. */
interface WrittenAnswer {
  /** What the model wrote: Markdown, with Citation markers, its footnote definitions left out. */
  markdown: string;
  /** Its Blocks, each marker a Citation node, its words AI text: the final ones once it has ended. */
  blocks(): NodeJSON[];
  /** Its Citations, in the order of their markers in the text: the final ones once it has ended. */
  citations(): MarkedCitation[];
  /** Its calculated figures, in the order of their markers in the text, each once. */
  figures(): MarkedFigure[];
  toolCalls: AnswerToolCall[];
  support: CitationSupport | null;
  /** Where the third-party text its Run had read came from (#78); null: none. */
  textOrigin: ThirdPartySource | null;
  /** The Mind it read, for an Answer in a conversation (#544); null: none. */
  read: AnswerRead | null;
  /** How it was reached: what an Answer in a conversation shows above its text (#391). */
  steps: AnswerSteps;
}

/** The Mind a Question in a conversation reads, as read when it was asked (or its Answer regenerated). */
interface MindToRead {
  mindId: string;
  reading: MindReading;
  /** What of it the Question context holds, before the model is known: at most `MIND_TOKEN_LIMIT` tokens. */
  section: MindSection;
}

/**
 * How much of a Mind a Question in the assistant reads whole (#564): a
 * quarter of a cloud model's window, at most `MIND_TOKEN_LIMIT` tokens; for a
 * model in Ollama, as much as its own window holds once the rest of the
 * request is in (see ./window); the old Question context budget when the
 * model's window isn't known.
 */
function mindLimit(prepared: PreparedChatModel): number {
  if (!prepared.window) return QUESTION_CONTEXT_TOKEN_BUDGET;
  if (prepared.provider.kind === "ollama") return MIND_TOKEN_LIMIT;
  return Math.min(MIND_TOKEN_LIMIT, Math.floor(prepared.window.tokens / 4));
}

/** What Answers need of the assistant's conversations (see ../conversations). */
export interface AnswerConversations {
  /**
   * Adds a Question, and its conversation with its first one, and its Answer, being
   * written, which reads `read`.
   */
  add(input: QuestionInput, answerModel: ChatModelChoice | null, read: AnswerRead | null): Turn;
  /** The Question of an Answer, and the Tool calls it made, to write the Answer again. */
  questionOf(input: unknown): {
    answerId: string;
    question: ConversationQuestion;
    toolCalls: AnswerToolCall[];
  };
  /** Takes the Search scope off a Question: its Answers search every Document (#748). */
  clearScope(questionId: string): ConversationQuestion | null;
  /** Empties an Answer, where it is, to write it again, reading `read`. */
  restartAnswer(
    answerId: string,
    answerModel: ChatModelChoice | null,
    read: AnswerRead | null,
  ): Turn;
  /** Writes an Answer as it stands; false when it is gone: its conversation was deleted. */
  writeAnswer(answerId: string, write: AnswerWrite): boolean;
}

/** Why a Question wasn't asked, before anything was kept or sent. */
type NotAsked = Extract<AskResult, { reason: "not-ready" | "skill-unavailable" }>;

/**
 * An Answer written for an outside agent (see `answerOutside`): its Markdown
 * with Citation markers and its Citations, each checked; or why it wasn't
 * asked: the default chat model isn't ready, Local mode keeps the Question
 * from a model off this computer, or the User has yet to allow the model.
 */
export type OutsideAnswer =
  | { asked: false; reason: "not-ready" | "consent-needed" | "local-mode" }
  | {
      asked: true;
      status: "done" | "stopped" | "failed";
      /** With its calculated figures written in as their shown text. */
      markdown: string;
      citations: MarkedCitation[];
      error: ProviderError | null;
      /** Where the Question went: the chat model's service; null for a model on this computer. */
      service: ExternalService | null;
    };

/** A comparison table's cell as written (see `answerCell`). */
export interface CellAnswer {
  status: "done" | "stopped" | "failed";
  markdown: string;
  /** Its Blocks, each marker a Citation node, its words AI text (`GENERATED_MARK`). */
  blocks: NodeJSON[];
  citations: MarkedCitation[];
  error: ProviderError | null;
}

/** No Search scope: every Document. */
/** Tells the model its Question's Search scope holds no Documents, so it answers from what it has (#748). */
const EMPTY_SCOPE_NOTE =
  "The User limited this Question to a Search scope (Folders, Tags or Documents) that holds no Documents, so there is nothing to search. Answer from the Mind you read, the conversation and the request itself. If the Answer needs the User's Documents, say so plainly in one sentence: do not guess what they hold.";

const NO_DOCUMENTS_NOTE =
  "The User has added no Documents of their own (the examples IncarnaMind made aren't theirs), so there is nothing to search. Answer from the Mind you read, the conversation and the request itself. If the Answer needs the User's Documents, say so plainly in one sentence: do not guess what they hold.";

const NO_SCOPE: SearchScope = { folderIds: [], tagIds: [], documentIds: [] };

const changesAMind = (change: MindChange) =>
  change.created || change.revised === true || change.proposals > 0;

function lastAnswerOf(
  conversationId: string,
  earlier: readonly ConversationMessage[],
): MindToolsOptions["lastAnswer"] {
  const at = earlier.findLastIndex((message) => message.kind === "answer");
  const answer = earlier[at];
  if (answer?.kind !== "answer") return null;
  const blocks = withoutFraming(answerBlocks({ ...answer, status: "done" }));
  if (blocks.length === 0) return null;
  const question = earlier.slice(0, at).findLast((message) => message.kind === "question");
  return {
    blocks,
    origin: { from: messageReference(conversationId, answer.id), question: question?.text ?? "" },
  };
}

const followsAChange = (answer: ConversationAnswer | undefined) =>
  answer !== undefined &&
  (answer.steps?.withoutMindTools === true ||
    answer.toolCalls.some((call) => call.mindChange && changesAMind(call.mindChange)));

/** The Folder a Search scope is, when it is one Folder alone; null otherwise. */
const oneFolderOf = (scope: SearchScope | null): string | null =>
  scope && scope.folderIds.length === 1 && scope.tagIds.length + scope.documentIds.length === 0
    ? (scope.folderIds[0] ?? null)
    : null;

export interface AnswersOptions {
  content: MindContent;
  events: ReturnType<typeof createEventHub>;
  engine: AnswerEngine;
  /** Throws `NotFoundError` unless the Mind exists; returns its id. */
  requireMind(mindId: unknown): string;
  mindExists(mindId: string): boolean;
  /**
   * The name of a Mind a Question in a conversation can read: one that isn't
   * deleted, of a kind this version knows; null for any other.
   */
  readableMindName(mindId: string): string | null;
  /**
   * The live Transcript of the Meeting a Mind records now (#144), indexed up to now: its
   * Passages in reading order; null when the Mind's Meeting isn't recording or has no lines yet.
   */
  liveTranscript(mindId: string): Promise<WindowedPassage[] | null>;
  /**
   * The help button a Question in a conversation is, asked from a Mind whose Meeting
   * records or is paused: its text is the button's name. Null for any other Question.
   */
  meetingHelp?(mindId: string, question: string): MeetingHelpKind | null;
  providerExists(providerId: string): boolean;
  /** Whether Questions can be asked with this model (the default one when undefined). */
  readiness(choice: ChatModelChoice | undefined): Promise<ChatReadiness>;
  /** The model, once the User has accepted its data flow (see `Core.prepareChatModel`). */
  prepareModel(
    choice: ChatModelChoice,
    thinking: "off" | "summary" | "answer" | "careful",
  ): Promise<PreparedChatModel>;
  /**
   * The quick-tasks model for an Answer asked with `answers`, prepared as
   * `answers` was: for the calls that don't write the Answer.
   */
  prepareQuickModel?(
    answers: ChatModelChoice,
    prepared: PreparedChatModel,
  ): Promise<PreparedChatModel["model"]>;
  /** Searching the User's Documents, and what Citations point to. */
  documents: DocumentsForAnswers;
  /** What an Answer is written in when its Question has no language of its own. */
  interfaceLanguage(): Language;
  /** The ids of the live Documents a Search scope covers; null with no Search scope (every Document). */
  resolveScope(scope: SearchScope): string[] | null;
  /**
   * With no Search scope, what an Answer asked from `mindId` in the assistant
   * searches: every Document but the examples', unless it is an example's
   * Mind; null: every Document.
   */
  unscopedDocuments?(mindId: string | null): string[] | null;
  /** The Document a Mind imported from Word was also added as (#720); null for none. */
  workingCopyOf?(mindId: string): string | null;
  /** What an Answer says when its Question's Search scope has no Documents to search. */
  emptyScopeAnswer(): string;
  /** The User's Skills. */
  skills: AnswerSkills;
  /** The assistant's conversations, which Answers are written into too. */
  conversations: AnswerConversations;
  /**
   * The Tool providers the core registers beside the Documents and the
   * Skills: the User's Connectors, offering the Tools of every Connector that
   * is on and ready. Their Tools are offered to every Answer.
   */
  toolProviders: readonly ToolProvider[];
  /** The Connectors that are on but wait for the User to sign in: their Tools are skipped. */
  connectorsNeedingSignIn?(): { id: string; name: string }[];
  /** Searching the web and saving its pages (#128); absent: no web search. */
  web?: AnswerWeb;
  /**
   * The Minds an Answer in the assistant reads, changes and makes, as
   * Proposals (#202, ../tools/minds); absent: it changes none.
   */
  minds?: MindsForTools;
  /**
   * Takes back the changes an Answer proposed in Minds, before it is written
   * again (#202): those still waiting are rejected, and a Mind it made goes
   * once nothing else is in it.
   */
  withdrawChanges?(changes: readonly MindChange[]): void;
  /** Asking the User before a Connector Tool or a Skill script runs. */
  approvals: AnswerApprovals;
  /** Running Skill scripts. */
  scripts: AnswerScripts;
  /**
   * Hears whether any Answer is being written, each time that changes: from
   * when the first one starts until none is left. Background model work and
   * Tasks give way to Answers (see ../backgroundQueue, ../runs/tasks); a
   * Task's own cells don't count.
   */
  onWritingChange?(writing: boolean): void;
  reportError(error: unknown): void;
}

/** What Answers need of approvals (see ../approvals). */
export interface AnswerApprovals {
  /** Whether a call runs or asks the User first: from its Effects and the User's policy for it. */
  decide(call: CallToDecide): "run" | "ask";
  /** Asks and waits: true if allowed, false if denied. Rejects if `signal` aborts first, withdrawing the request. */
  request(call: ToolCallToApprove, signal: AbortSignal): Promise<boolean>;
}

/** What Answers need of web search (#128, see ../tools/web/tools). */
export interface AnswerWeb {
  /**
   * Where an Answer asked with this model searches the web: its provider's
   * service, when the User has web search on, Local mode is off and the
   * provider has a web search of its own. Null otherwise: no web search.
   */
  service(model: ChatModelChoice): Promise<ExternalService | null>;
  /** Searches with the model's provider, asking the User to allow it first. */
  search(model: ChatModelChoice, query: string, signal: AbortSignal): Promise<WebResult[]>;
  /** Saves a page into the Folder of the place the Question was asked in; resolves once it can be searched. */
  save(address: string, place: AnswerPlace, signal: AbortSignal): Promise<SavedPage>;
}

/** What Answers need to run Skill scripts (see ../skills/scripts). */
export interface AnswerScripts {
  /** Whether Skill scripts may run: the User's switch in Settings. */
  enabled(): boolean;
  /** How long a script may run now, in seconds. */
  timeoutSeconds(): number;
  /** Throws, saying why, for a script that can't run here (its kind), before the User is asked. */
  check(script: string): void;
  /** What a run of a script of the Skill in `skillDir` can reach: from the Executor's sandbox level. */
  access(skillDir: string): ExecAccess;
  /** Runs it; rejects, saying why, when it can't start (e.g. its interpreter isn't installed). */
  run(request: ScriptToRun): Promise<SkillScriptRun>;
}

/** What Answers need of Skills (see ../skills). */
export interface AnswerSkills {
  /** Whether the Skill named `name` can be forced now. */
  availability(name: string): SkillAvailability;
  /** The Skills one Answer may use, with the forced one loaded. Throws if it can't be used. */
  openSession(forced: string | null): Promise<SkillSession>;
}

/** The Tool call that shows a forced Skill: loaded by the core, up front. */
const FORCED_SKILL_CALL = "forced-skill";

/** The one Tool call that sums up an Answer's `calculate` calls: the figures it shows, and those it couldn't. */
const calculatedCall = (): AnswerToolCall => ({
  id: "calculated-figures",
  tool: DOCUMENT_TOOLS.calculate,
  source: "documents",
  input: {},
  status: "running",
  resultCount: 0,
});

/** What the model is told when the User denies a call: a Tool result, so the Answer carries on. */
const deniedResult = (call: ToolCallToApprove) =>
  "script" in call
    ? `The User denied running ${call.script} of the Skill "${call.skill.name}", so it didn't run. Carry on without it, don't run it again, and say what wasn't done.`
    : `The User denied this call of ${call.tool} (from the Connector "${call.connector.name}"), so it wasn't made and nothing was sent. Carry on without it, don't call it again, and say what wasn't done.`;

/**
 * What the model reads for a call of a Tool whose side effect nothing can
 * approve yet: a later provider's (a Files Tool, say), before it can ask.
 */
const UNAPPROVED =
  "This call wasn't made: IncarnaMind can't ask the User about it yet, so nothing was changed or sent. Carry on without it and say what wasn't done.";

/** Why a call's Run counts as having read third-party text, for its approval request: absent when it doesn't. */
const readReasons = (
  thirdParty: readonly ThirdPartyReason[],
): { thirdParty?: ThirdPartyReason[] } =>
  thirdParty.length > 0 ? { thirdParty: [...thirdParty] } : {};

/** Where a Tool-call card says a call's Tool comes from: its provider's kind, as Minds store it. */
const CARD_SOURCES: Record<ToolProviderKind, AnswerToolCall["source"]> = {
  documents: "documents",
  skills: "skill",
  connector: "connector",
  sources: "sources",
  web: "web",
  minds: "minds",
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * What the core gives Answers from Documents: `AnswerDocuments`, counting,
 * listing and searching only the Documents of a Search scope when given their
 * ids (null: every Document).
 */
export interface DocumentsForAnswers
  extends Pick<AnswerDocuments, "citationSource" | "pageTexts" | "documentDate"> {
  searchableCount(documentIds: readonly string[] | null): number;
  /** Every live Document's names: what a Citation in the Question context names its Document by. */
  names(): readonly LiveDocument[];
  /** How many Documents there are to search, and the names of the `limit` most recently added, newest first. */
  searchableNames(documentIds: readonly string[] | null, limit: number): ListedDocuments;
  /** The Documents to search, the most text first. */
  searchableBySize(documentIds: readonly string[] | null): SizedDocument[];
  /** The live Passages of a live Document at positions `from` to `to`, in reading order. */
  passagesBetween(documentId: string, from: number, to: number): WindowedPassage[];
  /** The languages the Documents to search are in, the most common first, with how many are in each. */
  searchableLanguages(documentIds: readonly string[] | null): DocumentLanguage[];
  /** The Documents among these (null: every Document) whose text couldn't be read, or some of it. */
  unread(documentIds: readonly string[] | null): UnreadFile[];
  search(
    query: string,
    documentIds: readonly string[] | null,
    signal?: AbortSignal,
    options?: AnswerSearchOptions,
  ): Promise<WindowedPassage[]>;
}

/** The Documents one Answer searches: those of its Question's Search scope, or all of them (null). */
function inScope(
  documents: DocumentsForAnswers,
  documentIds: readonly string[] | null,
): AnswerDocuments {
  return {
    searchableCount: () => documents.searchableCount(documentIds),
    search: (query, signal, within, options) =>
      documents.search(query, within ?? documentIds, signal, options),
    citationSource: (passageId) => documents.citationSource(passageId),
    pageTexts: (documentId, contentHash, from, to) =>
      documents.pageTexts(documentId, contentHash, from, to),
    documentDate: (documentId) => documents.documentDate(documentId),
    documentNamed: (name) => {
      const key = (text: string) => text.replace(/\s+/g, " ").trim().toLocaleLowerCase();
      const wanted = key(name.replace(/\s*\(“[^”]*”\)\s*$/, ""));
      const all = documents.searchableBySize(documentIds);
      return (
        all.find((each) => key(each.name) === wanted)?.id ??
        all.find((each) => key(each.name).includes(wanted) || wanted.includes(key(each.name)))
          ?.id ??
        null
      );
    },
  };
}

function parseId(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "")
    throw new InvalidInputError(`${what} must be text.`);
  return value;
}

/** The Answer to a Question, wherever it is in the Mind. */
function answerFor(blocks: Y.XmlFragment, questionId: string): Y.XmlElement | null {
  return (
    topLevelBlocks(blocks).find(
      (block) => block.nodeName === ANSWER_BLOCK && block.getAttribute("questionId") === questionId,
    ) ?? null
  );
}

/** The model picked on a Question, if any. */
function pickedModel(question: Y.XmlElement): ChatModelChoice | null {
  const providerId = textAttribute(question, "providerId");
  const modelId = textAttribute(question, "modelId");
  return providerId && modelId ? { providerId, modelId } : null;
}

/** The Skill forced on a Question, if any. */
const forcedSkillOf = (question: Y.XmlElement): string | null =>
  textAttribute(question, "forcedSkill") || null;

function setAttributes(element: Y.XmlElement, attributes: Partial<AnswerAttributes>): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) element.removeAttribute(key);
    // biome-ignore lint/suspicious/noExplicitAny: Yjs types attribute values loosely.
    else element.setAttribute(key, value as any);
  }
}

/** How often, while a local model loads, Ollama is asked whether it is ready. */
const LOAD_POLL_MS = 1_000;

const CITING_ORDER: readonly CitationSupport[] = ["tools", "structured-output", "none"];

/**
 * How to start citing: what the model's capabilities say, unless an earlier
 * Answer found its provider refuses that (the engine stepped down), which wins.
 */
function startingSupport(
  known: CitationSupport | undefined,
  learnt: CitationSupport | undefined,
): CitationSupport | undefined {
  if (!known || !learnt) return learnt ?? known;
  return CITING_ORDER.indexOf(learnt) > CITING_ORDER.indexOf(known) ? learnt : known;
}

/** Why a model couldn't be prepared, as the kind of error the Answer shows. */
function failureOf(error: unknown): ProviderError {
  if (error instanceof ChatNotReadyError) {
    const { reason } = error.readiness;
    const kind =
      reason === "consent-declined" || reason === "local-mode"
        ? reason
        : reason === "missing-api-key"
          ? "auth"
          : "model";
    return { kind, message: error.message };
  }
  return classifyProviderError(error);
}

export function createAnswers(options: AnswersOptions) {
  const { content, events, engine } = options;
  /** Answers being written, by id. */
  const active = new Map<string, Generation>();
  /** Whether an Answer not written for a Task is being written. */
  let writing = false;
  const writingChanged = () => {
    const now = [...active.values()].some((generation) => !generation.task);
    if (now === writing) return;
    writing = now;
    options.onWritingChange?.(now);
  };

  /** Marks Answers left "streaming" by an earlier run of the app as stopped: nothing writes them any more. */
  const settleOrphans = (mindId: string) => {
    const orphans = content.read(mindId, (blocks) =>
      topLevelBlocks(blocks).some(
        (block) =>
          block.nodeName === ANSWER_BLOCK &&
          block.getAttribute("status") === "streaming" &&
          !active.has(textAttribute(block, BLOCK_ID_ATTRIBUTE) ?? ""),
      ),
    );
    if (!orphans) return;
    content.edit(mindId, (blocks) => {
      for (const block of topLevelBlocks(blocks)) {
        const id = textAttribute(block, BLOCK_ID_ATTRIBUTE) ?? "";
        if (
          block.nodeName === ANSWER_BLOCK &&
          block.getAttribute("status") === "streaming" &&
          !active.has(id)
        ) {
          setAttributes(block, { status: "stopped", generatedHash: contentHash(block) });
        }
      }
    });
  };

  /**
   * How each model gives Citations, learnt from its earlier Answers: by
   * provider, model and, for a local model, its build (a model pulled again may do more).
   */
  const supportByModel = new Map<string, CitationSupport>();
  const modelKey = (model: ChatModelChoice, prepared: PreparedChatModel) =>
    `${model.providerId}\n${model.modelId}\n${prepared.revision ?? ""}`;

  function start(input: {
    home: AnswerHome;
    answerId: string;
    questionId: string;
    model: ChatModelChoice;
    context: QuestionContext;
    /** The Documents of the Question's Search scope; null with no Search scope (every Document). */
    documentIds: string[] | null;
    /** The User limited the Question to some Documents. Absent: `documentIds` names some. */
    scoped?: boolean;
    /**
     * The Search scope has no Documents to search. An outside agent's or a task's Answer says so
     * and nothing is sent; the assistant's Question goes on to the model, which is told, and
     * answers from the Mind it reads and the conversation (#748).
     */
    emptyScope: boolean;
    /** The Skill the Question forces, loaded up front; null if none. */
    forcedSkill: string | null;
    /** The User has yet to allow the chat flow to the model's service: they are asked first. */
    consentNeeded: boolean;
    /** Why its Question context counts as third-party text (#78), from where it came; empty: none. */
    contextReasons: readonly ThirdPartyReason[];
    /**
     * The Mind a Question in a conversation reads (#544): what the Answer records of it,
     * what its request holds of it and what share of it that is, and the same Question
     * with no more of it than `tokens` tokens (null when it already holds no more), for
     * a model that reads less of it (`mindLimit`). Absent: none.
     */
    mind?: {
      read: AnswerRead | null;
      request: RequestMind;
      share: number;
      within(
        tokens: number,
      ): { context: QuestionContext; request: RequestMind; share: number } | null;
    } | null;
    /**
     * An Answer for an outside agent (#351), or a comparison table's cell
     * (#98): no window hears of it (it is in no Mind or conversation), and it
     * uses the Documents and Skills only: no Connector, and no Skill script,
     * so nothing it does waits for the User.
     */
    outside?: boolean;
    /** Which Tools its Run is offered (see `ToolSet`); absent: every Tool. */
    toolSet?: ToolSet;
    /**
     * Asked from a Mind whose Meeting may be recording (#144): its live Transcript, indexed up
     * to now, to go with the Question. Absent: none.
     */
    listening?: () => Promise<WindowedPassage[] | null>;
    /**
     * One-click help during the call: the button pressed. Its Answer is laid out as
     * the panel reads it, and is offered the Documents' Tools only.
     */
    help?: MeetingHelpKind;
    /** Written for a Task (#126), which gives way to Answers itself (see ../runs/tasks). */
    task?: boolean;
    /** Offers web search's Tools whatever the Question says: a Research Task's Web source (#130). */
    web?: boolean;
    /** Hears each Tool call as it ends. */
    onCall?(call: AnswerToolCall): void;
    /**
     * An Answer in the assistant (#202): the Mind it was asked from and the
     * Blocks the User selected there, where a Mind it makes goes, and what
     * Blocks it adds link back to. It is offered the Minds' Tools. Absent: none.
     */
    assistant?: Pick<MindToolsOptions, "focused" | "folderId" | "origin" | "lastAnswer"> &
      RequestContext;
  }): void {
    const { home, answerId, model, context, forcedSkill } = input;
    const scoped = input.scoped ?? input.documentIds !== null;
    const asked =
      input.outside === true
        ? { each: false, main: null }
        : documentsAsked(context.question, () =>
            options.documents.searchableBySize(input.documentIds).map((each) => each.name),
          );
    const coverage =
      asked.each || asked.main !== null
        ? coverageOf(asked, options.documents.searchableBySize(input.documentIds))
        : null;
    const documentIds = coverage ? coverage.used.map((each) => each.id) : input.documentIds;
    const outside = input.outside === true;
    const { place } = home;
    const announce = <E extends CoreEventName>(event: E, payload: CoreEvents[E]) => {
      if (!outside) events.emit(event, payload);
    };
    const controller = new AbortController();
    /** What the model wrote: Markdown, with Citation markers. */
    let markdown = "";
    /**
     * Why its Run counts as having read third-party text, from its start: its
     * Question context holds some. The Run adds what its Tools read (see the
     * gate's `thirdParty`).
     */
    const contextReasons: ThirdPartyReason[] = [...input.contextReasons];
    /**
     * Where the third-party text the Run had read came from: what its Question
     * context holds, else what it read first. Kept with the Answer, so a later
     * Question that has the Answer in its context counts as having read it too.
     * None for the Answer that says the Search scope is empty: no model wrote it.
     */
    let textOrigin: ThirdPartySource | null =
      input.emptyScope && outside ? null : (contextReasons[0]?.source ?? null);
    /** What the Answer records of the Mind it read: less once the model's window cut it. */
    let read = input.mind?.read ?? null;
    /** How much of the Mind its request holds, from 0 to 1. */
    let readShare = input.mind?.share ?? 1;
    let { messages } = context;
    let mindRequest = input.mind?.request;
    /** It listened to a meeting's live transcript: the Question went with it. */
    let listening = false;
    const { help } = input;
    let foundAhead = false;
    /** The language the call's newest lines are in, which a help Answer is written in. */
    let callLanguage: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let finished = false;
    let support: CitationSupport | null = null;
    /** Markers the engine put in for records the model gave without them. */
    let placedMarkers = 0;
    const citedAfterChecking = { count: 0, asked: false };
    /** The one request for exact quotes, if the engine made it (see ./quoteRetry). */
    let quoteRetry: QuoteRetry | null = null;
    /** The one request to fix figures, if the engine made it (see ./figureRetry). */
    let figureRetry: FigureRetry | null = null;
    let unbackedClaims: ClaimedChange[] = [];
    let withoutMindTools = false;
    /** What the model calls counted, the cached input tokens too. */
    const usage: AnswerUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    };
    const toolCalls: AnswerToolCall[] = [];
    /** When the Question went to the model, and when the Answer ended, in ms since the epoch. */
    let sentAt: number | null = null;
    const waitsForUser: [from: number, to: number][] = [];
    let finishedAt: number | null = null;
    const phases: AnswerSteps["phases"] = [];
    /** The model's reasoning summary, kept only from a provider that summarizes it. */
    let reasoning = "";
    let reasoningStartedAt: number | null = null;
    let lastReasoningAt: number | null = null;
    /** When the text the Answer keeps began: a preamble taken back doesn't count. */
    let firstTextAt: number | null = null;
    let firstMindWordAt: number | null = null;
    const careful = asksToCheckOrCalculate(context.question);
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    const steps = (): AnswerSteps => {
      const summary = reasoning.trim();
      const thoughtUntil =
        firstTextAt !== null && reasoningStartedAt !== null && firstTextAt > reasoningStartedAt
          ? firstTextAt
          : (lastReasoningAt ?? Date.now());
      const firstWordAt = Math.min(firstTextAt ?? Infinity, firstMindWordAt ?? Infinity);
      const wordAfter = (from: number, to: number) =>
        Math.max(
          0,
          to -
            from -
            waitsForUser.reduce(
              (sum, [began, ended]) =>
                sum + Math.max(0, Math.min(ended, to) - Math.max(began, from)),
              0,
            ),
        );
      return {
        sentAt: iso(sentAt),
        finishedAt: iso(finishedAt),
        phases: [...phases],
        reasoning:
          summary && reasoningStartedAt !== null
            ? { summary, ms: Math.max(0, thoughtUntil - reasoningStartedAt) }
            : null,
        ...(read?.partial && { readShare }),
        ...(citedAfterChecking.count > 0 && { citedAfterChecking: citedAfterChecking.count }),
        ...(sentAt !== null &&
          firstWordAt !== Infinity && { firstWordMs: wordAfter(sentAt, firstWordAt) }),
        ...(careful && { careful: true as const }),
        ...(unbackedClaims.length > 0 && { unbackedClaims: [...unbackedClaims] }),
        ...(withoutMindTools && { withoutMindTools: true as const }),
        ...(coverage && { coverage }),
      };
    };
    let skills: SkillSession | null = null;
    const searched = inScope(options.documents, documentIds);
    const inAssistant = !outside && input.assistant !== undefined;
    const mindIn = input.assistant?.focused?.mindId ?? null;
    const originalId =
      inAssistant && mindIn !== null ? (options.workingCopyOf?.(mindIn) ?? null) : null;
    const [original = null] =
      originalId !== null && (documentIds === null || documentIds.includes(originalId))
        ? options.documents.searchableBySize([originalId])
        : [];
    const passagesOf = (documentId: string) =>
      options.documents.passagesBetween(documentId, 0, Number.MAX_SAFE_INTEGER);
    const session = createCitationSession(
      searched,
      {
        onRecord: (marker, citation) =>
          announce("answer.citationAdded", { ...place, answerId, marker, citation }),
      },
      original
        ? {
            documentId: original.id,
            name: original.name,
            passages: () => openingWithin(passagesOf(original.id), OPENING_TOKEN_LIMIT),
          }
        : undefined,
    );
    /**
     * Whether its model is offered `calculate` and its steer: a fact of the
     * model, once prepared (ADR-0021). Off, the Answer is as it was before them.
     */
    let calculating = false;
    /** Its `calculate` calls, as one Tool call (see `calculatedCall`), once a figure is recorded. */
    let calculated: AnswerToolCall | null = null;
    const recordedFigures = new Set<number>();
    const figures = createCalculationSession({
      documents: searched,
      quotes: session.quotes,
      language: answerLanguage(context.question),
      onRecord: (marker) => {
        recordedFigures.add(marker);
        if (!calculated) {
          calculated = calculatedCall();
          toolCalls.push(calculated);
        }
        calculated.resultCount = recordedFigures.size;
        writeSoon();
      },
    });
    /** A Citation marker's node as the text around a figure sees it: none for a marker with no record. */
    const citedNode = (marker: number) =>
      session.streamingCitation(marker) ? citationNode(null) : null;
    /**
     * The figures its text shows, each once, with what it wrote right before
     * each marker; and how many figure markers had no figure.
     */
    const placedFigures = (text: string, final: boolean) => {
      const placed: MarkedFigure[] = [];
      const missing = new Set<number>();
      if (!calculating) return { figures: placed, missing: 0 };
      withFigures(
        withCitations(markdownToBlocks(text, { streaming: !final }), citedNode),
        (marker) => {
          const figure = figures.figure(marker);
          if (!figure) missing.add(marker);
          return figure;
        },
        (figure, marker, written) => {
          if (!placed.some((each) => each.marker === marker))
            placed.push({ marker, ...figure, written });
          return "";
        },
      );
      return { figures: placed, missing: missing.size };
    };

    /** Writes the Answer as it stands into its home; false if it is gone. */
    const write = (outcome?: Outcome): boolean => {
      const final = outcome !== undefined;
      const text = withoutFootnoteDefinitions(markdown);
      // Final: a marker with no record is removed, and each is counted for the summary.
      const citationOf = (marker: number) =>
        final ? session.finalCitation(marker) : session.streamingCitation(marker);
      try {
        return home.write(
          {
            markdown: text,
            // A figure reads as its shown text until a Mind has a node of its own for one (#439).
            blocks: () => {
              const blocks = withCitations(
                markdownToBlocks(text, { streaming: !final }),
                final
                  ? (marker) => session.finalNode(marker)
                  : (marker) => session.streamingNode(marker),
              );
              return asGenerated(
                calculating
                  ? withFigures(
                      blocks,
                      (marker) => figures.figure(marker),
                      (figure) => figure.shown,
                    )
                  : blocks,
              );
            },
            citations: () => {
              const found: MarkedCitation[] = [];
              // The markers the Blocks would show, so none in code is taken for one.
              withCitations(markdownToBlocks(text, { streaming: !final }), (marker) => {
                const citation = citationOf(marker);
                if (citation && !found.some((each) => each.marker === marker)) {
                  found.push({ marker, ...citation });
                }
                return null;
              });
              return found;
            },
            figures: () => placedFigures(text, final).figures,
            toolCalls,
            support,
            textOrigin,
            read,
            steps: steps(),
          },
          outcome,
        );
      } catch (error) {
        options.reportError(error);
        return false;
      }
    };

    const finish = (outcome: Outcome) => {
      if (finished) return;
      finished = true;
      finishedAt = Date.now();
      if (timer) clearTimeout(timer);
      active.delete(answerId);
      writingChanged();
      controller.abort();
      skills?.release();
      // A Tool call still running when the Answer stopped didn't finish; one still waiting for
      // the User never ran (aborting above withdrew its request).
      for (const call of toolCalls) {
        if (call.status === "running") call.status = "failed";
        if (call.approval === "waiting") call.approval = "denied";
      }
      // The check runs once, now; its results are stored with each Citation, and each figure's input.
      try {
        session.check();
        figures.check();
        const translated = session.checkQuotedWords(
          quotedWordsIn(withoutFootnoteDefinitions(markdown)),
        );
        if (translated.length > 0) markdown = withoutQuotationMarks(markdown, new Set(translated));
      } catch (error) {
        options.reportError(error);
      }
      // Its steps say how many figures it shows, and its end how many it couldn't calculate.
      const placed = placedFigures(withoutFootnoteDefinitions(markdown), true);
      if (placed.figures.length > 0 || placed.missing > 0) {
        const call = calculated ?? calculatedCall();
        if (!calculated) toolCalls.push(call);
        call.status = "done";
        call.resultCount = placed.figures.length;
        if (placed.missing > 0) call.uncalculated = placed.missing;
      } else if (calculated) {
        toolCalls.splice(toolCalls.indexOf(calculated), 1);
      }
      const written = write(outcome);
      if (outcome.status === "failed") {
        announce("answer.failed", { ...place, answerId, error: outcome.error });
      } else {
        announce("answer.finished", {
          ...place,
          answerId,
          status: written ? outcome.status : "stopped",
          ...session.summary(),
          placedMarkers,
          citedAfterChecking: { ...citedAfterChecking },
          citationSupport: support,
          quoteRetry,
          figures: placed.figures,
          uncalculated: placed.missing,
          figureRetry,
          usage,
        });
      }
    };

    const writeSoon = () => {
      if (timer || finished) return;
      timer = setTimeout(() => {
        timer = null;
        if (!finished && !write()) finish({ status: "stopped" });
      }, ANSWER_WRITE_INTERVAL_MS);
    };

    active.set(answerId, { home, model, finish, task: input.task === true });
    writingChanged();
    announce("answer.started", { ...place, answerId, questionId: input.questionId, model });

    const base = answerInstructions();
    const language = languageInstruction(
      context.question,
      options.interfaceLanguage(),
      options.documents
        .names()
        .flatMap((document) =>
          [document.name, document.title].filter((each) => typeof each === "string"),
        ),
    );
    const callStarted = (call: AnswerToolCall) => {
      // A call that asks the User first may already be there (see `ask`), and one whose input
      // streams in is there from its start (#202): it now has all of its input.
      const there = toolCalls.find((each) => each.id === call.id);
      if (there) {
        if (Object.keys(there.input).length === 0) {
          there.input = call.input;
          writeSoon();
        }
        return;
      }
      toolCalls.push(call);
      announce("answer.toolCallStarted", { ...place, answerId, call: { ...call } });
      writeSoon();
    };
    const callFinished = (
      id: string,
      ok: boolean,
      resultCount: number | null,
      found: Pick<
        AnswerToolCall,
        "passages" | "error" | "webPage" | "mindChange" | "mindProblem"
      > = {},
    ) => {
      const call = toolCalls.find((each) => each.id === id);
      if (!call) return;
      // A denied call returned the model a result, but never ran; a script that didn't exit with 0 failed.
      const ran = call.script === undefined || call.script.exitCode === 0;
      call.status = ok && call.approval !== "denied" && ran ? "done" : "failed";
      call.resultCount = resultCount;
      if (found.passages) call.passages = found.passages;
      if (found.error) call.error = found.error;
      if (found.webPage) call.webPage = found.webPage;
      if (found.mindChange) call.mindChange = found.mindChange;
      if (found.mindProblem) call.mindProblem = found.mindProblem;
      announce("answer.toolCallFinished", { ...place, answerId, call: { ...call } });
      input.onCall?.({ ...call });
      writeSoon();
    };
    const setApproval = (id: string, approval: ToolCallApproval) => {
      const call = toolCalls.find((each) => each.id === id);
      if (finished || !call) return;
      call.approval = approval;
      writeSoon();
    };
    /** What each call of `read_web_page` came to, by call, for its card when it finishes. */
    const webPages = new Map<string, WebPageCall>();
    /** What each call of a Minds' Tool changed, by call, for its card when it finishes (#202). */
    const mindChanges = new Map<string, MindChange>();
    const mindProblems = new Map<string, MindProblem>();
    /** Keeps how a script's run went on its card. */
    const setScriptRun = (id: string, run: SkillScriptRun) => {
      const call = toolCalls.find((each) => each.id === id);
      if (finished || !call) return;
      call.script = run;
      writeSoon();
    };

    /**
     * Asks the User about a call that may need it: approvals decide from the
     * call's Effects and the User's policy (see ../approvals). The wait races
     * the Answer's own signal: stopping the Answer ends it at once. The
     * model's call reaches here before the engine reports it, so its `card`
     * is recorded here, waiting, if it isn't already; the engine's report of
     * it then changes nothing. Resolves with null when the call may go ahead,
     * or with what the model reads when the User denied it.
     */
    const ask = async (call: ToolCallToApprove, card: AnswerToolCall): Promise<string | null> => {
      if (options.approvals.decide(call) === "run") return null;
      callStarted({ ...card, approval: "waiting" });
      // Already reported by the engine, after all: it waits too.
      setApproval(call.toolCallId, "waiting");
      const asked = Date.now();
      const allowed = await options.approvals.request(call, controller.signal);
      waitsForUser.push([asked, Date.now()]);
      setApproval(call.toolCallId, allowed ? "allowed" : "denied");
      return allowed ? null : deniedResult(call);
    };

    /** A Skill script that can't run: its card and the model say why. */
    const cantRun = (toolCallId: string, error: unknown): never => {
      const message = messageOf(error);
      setScriptRun(toolCallId, scriptNotRun(message));
      throw new Error(message);
    };

    /** Skill scripts the gate checked and let through, by call: their call runs what was checked. */
    const allowedScripts = new Map<string, { script: SkillScript; args: string[] }>();

    /**
     * `run_skill_script` at the gate: records its card, which shows the Skill,
     * the script and the arguments; checks the script (a script file of a
     * Skill this Answer may use, of a kind that can run here), so one that
     * can't run is refused without asking; then asks about the call's
     * `effects`, unless the Skill's scripts always run.
     */
    const scriptGate = async (
      session: SkillSession,
      { id: toolCallId, input, tainted, thirdParty }: GatedCall,
      effects: Effect[],
    ): Promise<string | null> => {
      const shown = scriptCallInput(input);
      const card: AnswerToolCall = {
        id: toolCallId,
        tool: SKILL_TOOLS.runScript,
        source: "skill",
        input: shown,
        status: "running",
        resultCount: null,
      };
      callStarted(card);
      let script: SkillScript;
      let args: string[];
      try {
        args = parseScriptArgs(input.args);
        script = await session.script(shown.skill, shown.script);
        options.scripts.check(script.path);
      } catch (error) {
        return cantRun(toolCallId, error);
      }
      const denied = await ask(
        {
          ...place,
          answerId,
          toolCallId,
          subject: { kind: "skill-script", skillId: script.skillId },
          skill: { id: script.skillId, name: script.skillName },
          tool: SKILL_TOOLS.runScript,
          script: script.path,
          args,
          effects,
          tainted,
          ...readReasons(thirdParty),
        },
        card,
      );
      if (denied === null) allowedScripts.set(toolCallId, { script, args });
      return denied;
    };

    /**
     * The gate the engine awaits before each Tool call (see `RunRequest.gate`):
     * a Connector's Tool asks first unless the User or its Effects say it
     * needn't; a Skill script is checked, then asks unless the Skill's scripts
     * always run (see `scriptGate`). Whether the Answer had read untrusted
     * content first (`tainted`), and third-party text (`thirdParty`), goes to
     * approvals with the call. Every other Tool runs if each of its Effects
     * runs without asking; a side effect of a provider whose calls nothing can
     * approve yet is refused (see `UNAPPROVED`).
     */
    const gate = async (tool: Tool, call: GatedCall): Promise<GateDecision> => {
      const { id, input, tainted, thirdParty } = call;
      let denied: string | null = null;
      if (tool.provider.kind === "connector") {
        const connector = { id: tool.provider.id, name: tool.provider.name };
        const name = tool.providerTool;
        const effects = tool.effects(input);
        denied = await ask(
          {
            ...place,
            answerId,
            toolCallId: id,
            subject: { kind: "tool", connectorId: connector.id, tool: name },
            connector,
            tool: name,
            title: tool.title ?? null,
            input,
            // Its Connector marks it read-only: it changes nothing.
            readOnly: effects.every((effect) => effect.action !== "write"),
            effects,
            tainted,
            ...readReasons(thirdParty),
          },
          {
            id,
            tool: name,
            source: "connector",
            connector,
            input,
            status: "running",
            resultCount: null,
          },
        );
      } else if (tool.name === SKILL_TOOLS.runScript && skills) {
        denied = await scriptGate(skills, call, tool.effects(input));
      } else if (!tool.effects(input).every(runsByDefault)) {
        // New side-effecting Tools ask unless a scope grant covers them (ADR-0013): until their
        // provider can ask, their side effects never run.
        options.reportError(
          new Error(`${tool.name} (${tool.provider.kind}) has a side effect nothing can approve.`),
        );
        denied = UNAPPROVED;
      }
      return denied === null ? { run: true } : { run: false, result: denied };
    };

    /**
     * Whether a Tool may act on a call's input as it comes, before the gate
     * (#202): only when the gate lets every call of it through. A Connector's
     * Tool and a Skill's scripts never do: the User's "ask" and "off" are
     * theirs, and they ask by default. Any other Tool does when each of its
     * Effects runs without asking, whatever the input: the Minds' Tools, whose
     * only write is a Proposal.
     */
    const streamsInput = (tool: Tool): boolean =>
      tool.provider.kind !== "connector" &&
      tool.name !== SKILL_TOOLS.runScript &&
      tool.effects({}).every(runsByDefault);

    /**
     * `run_skill_script`'s call, once the gate let it through: runs the script
     * it checked, stopping it if the Answer stops. Its card keeps how the run
     * went, or why it couldn't run. A script the gate didn't let through never runs.
     */
    const runScript = async ({ toolCallId, signal }: ToolCallContext): Promise<string> => {
      const allowed = allowedScripts.get(toolCallId);
      allowedScripts.delete(toolCallId);
      if (!allowed) return cantRun(toolCallId, "The script wasn't allowed to run.");
      const { script, args } = allowed;
      // Turned off since the Answer started.
      if (!options.scripts.enabled()) {
        return cantRun(
          toolCallId,
          "Skill scripts are turned off in Settings, so the script didn't run.",
        );
      }
      const timeoutSeconds = options.scripts.timeoutSeconds();
      let run: SkillScriptRun;
      try {
        run = await options.scripts.run({
          skillDir: script.skillDir,
          script: script.path,
          args,
          timeoutMs: timeoutSeconds * 1000,
          signal: AbortSignal.any([signal, controller.signal]),
        });
      } catch (error) {
        return cantRun(toolCallId, error);
      }
      setScriptRun(toolCallId, run);
      return scriptResultText(script.path, run, timeoutSeconds);
    };

    /** Opens the Answer's Skills, loading the forced one, shown as its Tool call; false if it failed. */
    const openSkills = async (): Promise<boolean> => {
      if (forcedSkill) {
        callStarted({
          id: FORCED_SKILL_CALL,
          tool: SKILL_TOOLS.use,
          source: "skill",
          input: { name: forcedSkill },
          status: "running",
          resultCount: null,
          forced: true,
        });
      }
      try {
        const session = await options.skills.openSession(forcedSkill);
        if (finished) {
          session.release();
          return false;
        }
        skills = session;
      } catch (error) {
        if (forcedSkill) callFinished(FORCED_SKILL_CALL, false, null);
        finish({
          status: "failed",
          error: {
            kind: "unknown",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return false;
      }
      if (forcedSkill) callFinished(FORCED_SKILL_CALL, true, null);
      return true;
    };

    let settleMinds = (): void => undefined;
    const run = async () => {
      // An outside agent's Question, or a table's cell, whose scope has no Documents has nothing to
      // answer from: it says so without asking the model.
      if (input.emptyScope && outside) {
        // On a later turn, as a model's Answer would arrive, so whoever asked hears every event.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (finished) return;
        const text = options.emptyScopeAnswer();
        markdown = text;
        announce("answer.delta", { ...place, answerId, text });
        finish({ status: "done" });
        return;
      }
      // The phase the meta line shows: waiting for the User to allow the Question to go to the
      // model's service, searching, the model loading (a local model, until Ollama has it
      // loaded or it starts to answer), writing, or checking quotes (asking a local model once
      // more for the quotes the check didn't find).
      let consenting = input.consentNeeded;
      let activity: Extract<
        AnswerPhase,
        "searching" | "writing" | "checking-quotes" | "checking-figures"
      > = "writing";
      let loading = false;
      let responded = false;
      let shown: AnswerPhase | null = null;
      const showPhase = () => {
        const phase: AnswerPhase = consenting
          ? "waiting-for-consent"
          : activity !== "writing"
            ? activity
            : loading && !responded
              ? "loading"
              : "writing";
        if (finished || phase === shown) return;
        shown = phase;
        phases.push({ phase, at: new Date().toISOString() });
        announce("answer.phase", { ...place, answerId, phase });
      };
      // Nothing is sent before the User says: the Answer waits for them.
      if (consenting) showPhase();
      let prepared: PreparedChatModel;
      try {
        prepared = await options.prepareModel(
          model,
          // Help during a call is read within seconds: the model answers without thinking first.
          help ? "off" : input.task ? "summary" : careful ? "careful" : "answer",
        );
      } catch (error) {
        finish({ status: "failed", error: failureOf(error) });
        return;
      }
      calculating = offersCalculate(prepared.capabilities);
      const within = input.mind?.within(mindLimit(prepared));
      if (within) {
        ({ messages } = within.context);
        mindRequest = within.request;
        readShare = within.share;
        if (read) read = within.request.text ? { ...read, partial: true } : null;
      }
      if (input.listening) {
        let heard: WindowedPassage[] | null = null;
        try {
          heard = await input.listening();
        } catch (error) {
          options.reportError(error);
        }
        if (finished) return;
        const kept = newestWithin(heard ?? [], listenedTokens(prepared.window));
        if (kept.length > 0) {
          messages = withTranscript(messages, session.show(kept));
          listening = true;
          if (help) callLanguage = languageSaid(kept);
        }
        // Help gets what the User's Documents say about the newest lines at once, with no search
        // the model has to call first.
        if (help && kept.length > 0) {
          const transcript = new Set(kept.map((passage) => passage.documentId));
          try {
            const found = await session.find(newestSaid(kept), controller.signal, {
              rerank: false,
            });
            const fitting = foundWithin(
              found.filter((passage) => !transcript.has(passage.documentId)),
              FOUND_TOKEN_LIMIT,
            );
            if (fitting.length > 0) {
              messages = withFound(messages, session.show(fitting));
              foundAhead = true;
            }
          } catch (error) {
            if (!controller.signal.aborted) options.reportError(error);
          }
          if (finished) return;
        }
      }
      if (inAssistant) {
        const unread = options.documents.unread(documentIds);
        const blockOf = (
          passages: readonly WindowedPassage[],
          show: (found: readonly WindowedPassage[]) => string,
        ) =>
          documentTextBlock(
            [...new Set(passages.map((passage) => passage.documentName))],
            withPassageNotes(show(passages), unread),
          );
        const scope =
          options.documents.searchableCount(documentIds) <= SMALL_SCOPE_DOCUMENTS
            ? options.documents.searchableBySize(documentIds)
            : [];
        const given = givenUpFront(
          [original ? [original] : [], scope],
          upFrontTokens(prepared.window),
          passagesOf,
          (passages) => blockOf(passages, session.measure),
        );
        if (given) {
          messages = withBeforeQuestion(messages, blockOf(given.passages, session.show));
          // Someone else wrote a saved web page: given up front, it is read as a search reads it (#78).
          if (given.passages.some((passage) => passage.documentKind === "web")) {
            contextReasons.push({ via: "read", source: "web-page" });
            textOrigin ??= "web-page";
          }
        }
      }
      // Stopped while waiting, e.g. for consent: send nothing.
      if (finished) return;
      if (consenting) {
        consenting = false;
        showPhase();
      }
      sentAt = Date.now();
      if (!(await openSkills()) || !skills) return;
      const { listed, forced } = skills;
      const opened: SkillSession = skills;
      // The Tools of the providers the core registered (the Connectors that are on), next to
      // the Documents' and the Skills'. A Connector's Tool asks the User first unless it needn't
      // (see `gate`).
      const provided: Tool[] = [];
      for (const provider of outside ? [] : options.toolProviders) {
        // Find sources' Tool only for a Question that asks for papers or other sources.
        if (provider.kind === "sources" && !asksForSources(context.question)) continue;
        try {
          provided.push(...(await provider.tools(controller.signal)));
        } catch (error) {
          if (finished) return;
          options.reportError(error);
        }
      }
      if (finished) return;
      const fromConnectors = provided.filter((tool) => tool.provider.kind === "connector");
      // Connectors waiting for a sign-in offer nothing. The Answer shows a card for each, which
      // didn't run, and the model is told, so the Answer can say why.
      const signInNeeded = outside ? [] : (options.connectorsNeedingSignIn?.() ?? []);
      for (const connector of signInNeeded) {
        const id = `sign-in:${connector.id}`;
        callStarted({
          id,
          tool: "sign_in",
          source: "connector",
          connector,
          input: {},
          status: "running",
          resultCount: null,
          signInRequired: true,
        });
        callFinished(id, false, null);
      }
      // Web search's Tools, only for a Question that asks for the web, with a model whose provider
      // searches it, while the User has it on (#128).
      const web = outside && !input.web ? undefined : options.web;
      let webService: ExternalService | null = null;
      if (web && (input.web || asksForWeb(context.question))) {
        try {
          webService = await web.service(model);
        } catch (error) {
          if (finished) return;
          options.reportError(error);
        }
      }
      if (finished) return;
      const fromWeb: Tool[] =
        web && webService
          ? webTools({
              service: webService,
              question: context.question,
              search: (query, signal) => web.search(model, query, signal),
              save: (address, signal) => web.save(address, place, signal),
              passages: (documentId, query, signal) =>
                session.searchDocument(documentId, query, signal),
              read: (toolCallId, call) => webPages.set(toolCallId, call),
            })
          : [];
      // The Minds' Tools, for an Answer in the assistant (#202).
      const minds = outside ? undefined : options.minds;
      const route =
        minds && input.assistant ? routeRequest(context.question, input.assistant) : null;
      const requested =
        route && (route.kind === "write" || route.kind === "edit")
          ? { change: route.kind, newMind: route.newMind }
          : null;
      let documentNames: string[] | undefined;
      const mindsTools =
        minds && input.assistant
          ? mindTools({
              minds,
              prepared,
              requested,
              paragraph: paragraphAsked(context.question),
              ...input.assistant,
              language: answerLanguage(context.question),
              blocksOf: (text) => {
                let found = 0;
                let notFound = 0;
                let unrecorded = 0;
                let firstUnrecorded = -1;
                const written = withoutSearchTalk(withoutFootnoteDefinitions(text));
                const link = (source: NamedSource) => {
                  const marker = session.markerFor(source);
                  return marker === null ? null : `[^${marker}]`;
                };
                documentNames ??= options.documents
                  .searchableBySize(input.documentIds)
                  .map((each) => each.name);
                const names = documentNames;
                const known = (source: NamedSource) =>
                  namesOneOf(source.name, names) || link({ ...source, location: null }) !== null;
                const asText = sourcesAsText(written.markdown, known);
                const sourced = linkKnownSources(written.markdown, known, link);
                const tables = linkTableSources(sourced.text, link);
                const cited = markdownToBlocks(tables.markdown).flatMap((block, index) =>
                  withCitations([block], (marker) => {
                    const node = session.checkedNode(marker);
                    if (!node) {
                      unrecorded++;
                      if (firstUnrecorded < 0) firstUnrecorded = index;
                    } else if (node.attrs?.check === "not-found") notFound++;
                    else found++;
                    return node;
                  }),
                );
                const blocks = asGenerated(
                  calculating
                    ? withFigures(
                        cited,
                        (marker) => figures.figure(marker),
                        (figure) => figure.shown,
                      )
                    : cited,
                );
                return {
                  blocks,
                  cited: found + notFound,
                  notFound,
                  unrecorded,
                  firstUnrecorded,
                  sourcesAsText: asText,
                  droppedSources: sourced.dropped,
                  unlinkedSources: tables.unlinked,
                  extraCells: tables.extraCells,
                  searchTalk: written.left,
                };
              },
              changed: (toolCallId, change) => {
                firstMindWordAt ??= Date.now();
                mindChanges.set(toolCallId, change);
                // On its card at once: a Mind changes while the call is still being written.
                const call = toolCalls.find((each) => each.id === toolCallId);
                if (call && !finished) {
                  call.mindChange = change;
                  writeSoon();
                }
              },
              failed: (toolCallId, problem) => {
                mindProblems.set(toolCallId, problem);
                // Whatever it wrote as its input came in was taken back: nothing of it counts.
                mindChanges.delete(toolCallId);
                const call = toolCalls.find((each) => each.id === toolCallId);
                if (call?.mindChange) {
                  delete call.mindChange;
                  writeSoon();
                }
              },
              signal: controller.signal,
              now: () => new Date(),
            })
          : null;
      if (mindsTools) settleMinds = () => mindsTools.settle();
      const documents: AnswerTools = {
        get documentCount() {
          return session.tools.documentCount;
        },
        // So the model can search again in the Documents' language (see the search Tool).
        documentLanguages: options.documents.searchableLanguages(documentIds),
        unreadDocuments: () => options.documents.unread(documentIds),
        searchDocuments: (query, signal, searchOptions) =>
          session.tools.searchDocuments(query, signal, searchOptions),
        cite: (records, citeOptions) => session.tools.cite(records, citeOptions),
        hasRecord: (marker) => session.tools.hasRecord?.(marker) ?? false,
        unfoundQuotes: () => session.tools.unfoundQuotes?.() ?? [],
        correctQuote: (marker, quote) => session.tools.correctQuote?.(marker, quote) ?? false,
        shownPassages: () => session.tools.shownPassages?.() ?? [],
        quoteFound: (passage, quote) => session.tools.quoteFound?.(passage, quote) ?? false,
        wroteIntoMind: () =>
          [...mindChanges.values()].some((change) => change.proposals > 0 || change.revised),
        ...(calculating && {
          calculate: (given: readonly unknown[], calculateOptions?: CiteOptions) =>
            figures.calculate(given, calculateOptions),
          figureProblems: () => figures.problems(),
        }),
      };
      // Scripts can run when a Skill has some, unless the User turned them off.
      const scripts = !outside && opened.hasScripts && options.scripts.enabled();
      const fromSkills: Tool[] =
        listed.length > 0 || (forced && forced.files.length > 1)
          ? skillTools({
              loadable: listed.length > 0,
              useSkill: async (name) =>
                loadedSkillText(await opened.load(name), { withFiles: true, scripts }),
              skill: (name) => opened.skill(name),
              readSkillFile: (skill, path) => opened.readFile(skill, path),
              ...(scripts && {
                scripts: {
                  access: (skillDir) => options.scripts.access(skillDir),
                  run: (_input, call) => runScript(call),
                },
              }),
            })
          : [];
      const watchLoading = async (loaded: () => Promise<boolean | null>) => {
        for (let first = true; !finished && !responded; first = false) {
          const ready = await loaded().catch(() => null);
          if (finished || responded) return;
          if (ready !== false) {
            loading = false;
            showPhase();
            return;
          }
          if (first) {
            loading = true;
            showPhase();
          }
          await new Promise((resolve) => setTimeout(resolve, LOAD_POLL_MS).unref?.());
        }
      };
      // Until a phase is known, the meta line says "Writing…". Without a model to load, it is known now.
      if (prepared.loaded) void watchLoading(prepared.loaded);
      else showPhase();

      const learntKey = modelKey(model, prepared);
      const prepareQuick = options.prepareQuickModel;
      let outcome: Outcome = { status: "stopped" };
      let mindsNow: { id: string; name: string }[] | null = null;
      const mindsListed = () => {
        mindsNow ??= minds?.list() ?? [];
        return mindsNow;
      };
      const changedAMind = () => [...mindChanges.values()].some(changesAMind);
      const owesAWrite = () => requested !== null && !changedAMind() && mindProblems.size === 0;
      const heldBack = holdBack(() => mindsListed().map((mind) => mind.name));
      const turnChecks: TurnCheck[] = [
        {
          name: "claimed-change",
          check: (text) => {
            mindsNow = null;
            const claims = claimsNoCallMade(text, toolCalls, mindsListed());
            return claims.length > 0
              ? { claims, note: askAgainNote(claims, toolCalls, options.readableMindName) }
              : null;
          },
        },
        {
          name: "owed-write",
          check: () =>
            owesAWrite()
              ? { claims: [], note: askToWriteNote(toolCalls, options.readableMindName) }
              : null,
        },
      ];
      for await (const event of engine.generate({
        instructions: (
          mode,
          {
            passages,
            skillTools: withSkillTools = false,
            connectorTools = false,
            sourceTools = false,
            webTools: withWebTools = false,
            mindTools: withMindTools = false,
          } = {},
        ) =>
          [
            base,
            mode === "no-documents"
              ? input.emptyScope
                ? scoped
                  ? EMPTY_SCOPE_NOTE
                  : NO_DOCUMENTS_NOTE
                : ""
              : documentInstructions(
                  mode,
                  options.documents.searchableNames(documentIds, LISTED_DOCUMENTS),
                  passages,
                  scoped,
                  calculating,
                ),
            coverageInstructions(
              coverage,
              asked.each,
              options.documents.searchableCount(documentIds),
            ),
            skillInstructions(listed, forced, withSkillTools, scripts),
            connectorTools ? connectorInstructions(fromConnectors, mode === "no-documents") : "",
            sourcesInstructions(sourceTools),
            webInstructions(withWebTools),
            workingCopyNote(original?.name ?? null),
            mindInstructions(withMindTools, route),
            meetingInstructions(listening),
            signInNeededInstructions(signInNeeded.map((connector) => connector.name)),
            help
              ? meetingHelpInstructions(help, {
                  found: foundAhead,
                  language: options.interfaceLanguage(),
                  callLanguage,
                })
              : language,
          ]
            .filter(Boolean)
            .join("\n\n"),
        messages,
        ...(mindRequest && { mind: mindRequest }),
        question: context.question,
        model: prepared.model,
        ...(prepareQuick && { quickModel: () => prepareQuick(model, prepared) }),
        documents,
        tools: [...provided, ...fromSkills, ...fromWeb, ...(mindsTools?.tools ?? [])],
        gate,
        streamsInput,
        toolSet: input.toolSet ?? (help ? "documents" : undefined),
        thirdParty: contextReasons,
        support: startingSupport(prepared.support, supportByModel.get(learntKey)),
        structuredOutput: givesStructuredOutput(prepared.capabilities),
        takesTemperature: prepared.capabilities.facts.temperature,
        window: prepared.window,
        retryQuotes: prepared.retryQuotes,
        cacheKey: place.conversationId ?? place.mindId ?? undefined,
        ...(input.assistant && {
          turnChecks,
          shownUpTo: (text: string) => (owesAWrite() ? 0 : heldBack(text)),
          mayEndBlank: changedAMind,
        }),
        signal: controller.signal,
      })) {
        if (finished) break;
        switch (event.type) {
          case "support":
            support = event.support;
            supportByModel.set(learntKey, event.support);
            // The model has begun to answer: it is loaded.
            responded = true;
            showPhase();
            writeSoon();
            break;
          case "phase":
            activity = event.phase;
            showPhase();
            break;
          case "markers-placed":
            placedMarkers += event.count;
            break;
          case "cited-after-checking":
            citedAfterChecking.count += event.count;
            citedAfterChecking.asked ||= event.asked;
            break;
          case "mind-cut":
            if (read) read = event.share === 0 ? null : { ...read, partial: true };
            readShare = event.share;
            writeSoon();
            break;
          case "quotes-retried":
            quoteRetry = event.retry;
            break;
          case "figures-retried":
            figureRetry = event.retry;
            break;
          case "claims-unbacked":
            unbackedClaims = event.claims;
            writeSoon();
            break;
          case "without-tools":
            withoutMindTools = requested !== null;
            break;
          case "usage":
            usage.inputTokens += event.usage.inputTokens ?? 0;
            usage.outputTokens += event.usage.outputTokens ?? 0;
            usage.cachedInputTokens += event.usage.cachedInputTokens ?? 0;
            usage.cacheWriteTokens += event.usage.cacheWriteTokens ?? 0;
            break;
          case "reasoning":
            // Raw chain of thought is dropped: only a provider's own summary is kept.
            if (!prepared.summarizesReasoning) break;
            reasoningStartedAt ??= Date.now();
            if (!event.text) break;
            lastReasoningAt = Date.now();
            reasoning += event.text;
            announce("answer.reasoning", { ...place, answerId, text: event.text });
            writeSoon();
            break;
          case "text-delta":
            responded = true;
            showPhase();
            firstTextAt ??= Date.now();
            markdown += event.text;
            announce("answer.delta", { ...place, answerId, text: event.text });
            writeSoon();
            break;
          case "text-retracted":
            markdown = markdown.slice(0, Math.max(0, markdown.length - event.length));
            if (markdown === "") firstTextAt = null;
            writeSoon();
            break;
          case "tool-call-started": {
            // The card says where the Tool comes from, from its provider, as Minds store it.
            const { provider } = event;
            callStarted({
              id: event.id,
              tool: event.tool,
              source: CARD_SOURCES[provider.kind],
              ...(provider.kind === "connector" && {
                connector: { id: provider.id, name: provider.name },
              }),
              input: event.input,
              status: "running",
              resultCount: null,
            });
            break;
          }
          case "tool-call-finished": {
            const webPage = webPages.get(event.id);
            const mindChange = mindChanges.get(event.id);
            const mindProblem = mindProblems.get(event.id);
            callFinished(event.id, event.ok, event.resultCount, {
              ...(event.passages && { passages: [...event.passages] }),
              ...(event.error && { error: event.error }),
              ...(webPage && { webPage }),
              ...(mindChange && { mindChange }),
              ...(mindProblem && { mindProblem }),
            });
            break;
          }
          case "read-third-party":
            if (textOrigin === null) {
              textOrigin = event.source;
              writeSoon();
            }
            break;
          case "finished":
            outcome = { status: "done" };
            break;
          case "failed":
            outcome = { status: "failed", error: event.error };
            break;
        }
      }
      settleMinds();
      finish(outcome);
    };
    run().catch((error: unknown) => {
      options.reportError(error);
      settleMinds();
      finish({ status: "failed", error: classifyProviderError(error) });
    });
  }

  /** An Answer in its Mind: a Block right after its Question in the Mind's Yjs document. */
  const mindHome = (mindId: string, answerId: string): AnswerHome => ({
    place: { mindId },
    write(answer, outcome) {
      if (!options.mindExists(mindId)) return false;
      return content.edit(mindId, (blocks) => {
        const found = findBlock(blocks, ANSWER_BLOCK, answerId);
        if (!found) return false;
        const { element } = found;
        syncContent(element, answer.blocks());
        const calls = answer.toolCalls.length > 0 ? JSON.stringify(answer.toolCalls) : null;
        if (textAttribute(element, "toolCalls") !== calls)
          setAttributes(element, { toolCalls: calls });
        if (answer.support && textAttribute(element, "citationSupport") !== answer.support) {
          setAttributes(element, { citationSupport: answer.support });
        }
        // Beside the Blocks, by the Answer's id: a later Question above which it stands reads it.
        if (blocks.doc) setTextOrigin(blocks.doc, [answerId], answer.textOrigin);
        if (outcome) {
          setAttributes(element, {
            status: outcome.status,
            errorKind: outcome.status === "failed" ? outcome.error.kind : null,
            errorMessage: outcome.status === "failed" ? outcome.error.message : null,
            errorResetsAt: (outcome.status === "failed" && outcome.error.resetsAt) || null,
            errorSignInRoute: (outcome.status === "failed" && outcome.error.signInRoute) || null,
            generatedHash: contentHash(element),
          });
        }
        return true;
      });
    },
  });

  /**
   * An Answer the User edited, written again (#94): nothing is written while
   * it streams, and once it is finished it goes over the User's version as
   * Proposals of one request (../proposals/write, `proposeBlocks`), replacing
   * any still waiting in it. Its model, searches and how it cited are the new
   * Answer's; it counts as unedited again once every change is accepted.
   * Stopped, it writes nothing; failed, the Answer says why, as it is.
   */
  const changesHome = (mindId: string, answerId: string, model: ChatModelChoice): AnswerHome => ({
    place: { mindId },
    write(answer, outcome) {
      if (!options.mindExists(mindId)) return false;
      const there = content.read(mindId, (blocks) => !!findBlock(blocks, ANSWER_BLOCK, answerId));
      if (!there || !outcome || outcome.status === "stopped") return there;
      if (outcome.status === "failed") {
        return content.edit(mindId, (blocks) => {
          const found = findBlock(blocks, ANSWER_BLOCK, answerId);
          if (found) {
            setAttributes(found.element, {
              status: "failed",
              errorKind: outcome.error.kind,
              errorMessage: outcome.error.message,
              errorSignInRoute: outcome.error.signInRoute ?? null,
            });
          }
          return !!found;
        });
      }
      const request = randomUUID();
      const wrote = content.edit(mindId, (blocks) => {
        const found = findBlock(blocks, ANSWER_BLOCK, answerId);
        if (!found) return false;
        const { element } = found;
        resolveProposals(element, () => true, "reject");
        const written = proposeBlocks(element, answer.blocks(), request, randomUUID);
        if (written.proposals.length > 0 && blocks.doc) {
          recordProposalRequest(blocks.doc, request, {
            source: "answer",
            providerId: model.providerId,
            modelId: model.modelId,
            createdAt: new Date().toISOString(),
            answerId,
          });
        }
        setAttributes(element, {
          status: "done",
          errorKind: null,
          errorMessage: null,
          errorSignInRoute: null,
          providerId: model.providerId,
          modelId: model.modelId,
          toolCalls: answer.toolCalls.length > 0 ? JSON.stringify(answer.toolCalls) : null,
          citationSupport: answer.support,
        });
        return true;
      });
      if (!wrote) return false;
      // What it holds once every change is accepted is what the model wrote.
      const generated = docOf(content.state(mindId));
      try {
        const blocks = generated.getXmlFragment(MIND_CONTENT_FIELD);
        generated.transact(() => {
          resolveProposals(blocks, (ref) => ref.request === request, "accept");
        });
        const found = findBlock(blocks, ANSWER_BLOCK, answerId);
        const generatedHash = found ? contentHash(found.element) : null;
        content.edit(mindId, (live) => {
          const element = findBlock(live, ANSWER_BLOCK, answerId)?.element;
          if (element) setAttributes(element, { generatedHash });
        });
      } finally {
        generated.destroy();
      }
      return true;
    },
  });

  /** An Answer in one of the assistant's conversations: its row, with its Markdown and Citations. */
  const conversationHome = (conversationId: string, answerId: string): AnswerHome => ({
    place: { mindId: null, conversationId },
    write: (answer, outcome) =>
      options.conversations.writeAnswer(answerId, {
        text: answer.markdown,
        citations: answer.citations(),
        figures: answer.figures(),
        toolCalls: answer.toolCalls,
        support: answer.support,
        textOrigin: answer.textOrigin,
        read: answer.read,
        steps: answer.steps,
        ...(outcome && {
          outcome: {
            status: outcome.status,
            error: outcome.status === "failed" ? outcome.error : null,
          },
        }),
      }),
  });

  /**
   * The model a Question is answered with, and whether the User has yet to allow its
   * data flow; or why it can't be asked now: Questions can't be asked yet, or the Skill
   * it forces is off or gone. A model picked on a provider since removed falls back to
   * the default.
   */
  async function readyModel(
    picked: ChatModelChoice | null,
    forcedSkill: string | null,
  ): Promise<{ model: ChatModelChoice; consentNeeded: boolean } | NotAsked> {
    const choice = picked && options.providerExists(picked.providerId) ? picked : undefined;
    const readiness = await options.readiness(choice);
    if (!readiness.ready) return { asked: false, reason: "not-ready", readiness };
    // A forced Skill that is off or gone: say so rather than answer without it.
    const skillState = forcedSkill ? options.skills.availability(forcedSkill) : "enabled";
    if (forcedSkill && skillState !== "enabled") {
      return { asked: false, reason: "skill-unavailable", skill: forcedSkill, state: skillState };
    }
    return {
      model: { providerId: readiness.provider.id, modelId: readiness.modelId },
      consentNeeded: readiness.consent === "needed",
    };
  }

  /**
   * The Mind a Question in a conversation reads (#544): the one it was asked from, as it
   * is now, where the User was in it first; null when there is none it can read.
   */
  function mindToRead(
    mindId: string | null,
    focus: MindFocus | null,
    question: string,
  ): MindToRead | null {
    if (mindId === null) return null;
    const name = options.readableMindName(mindId);
    if (name === null) return null;
    const documents = options.documents.names();
    const reading = content.peek(mindId, (blocks) => readMind(blocks, name, focus, documents));
    return { mindId, reading, section: reading.section(MIND_TOKEN_LIMIT, question) };
  }

  /** What an Answer records of the Mind it reads; null when none of it fits. */
  const readOf = (mind: MindToRead | null): AnswerRead | null =>
    mind?.section.text
      ? { mindId: mind.mindId, version: mind.reading.version, partial: mind.section.partial }
      : null;

  const changeStatesOf: ChangeStates = (change) => {
    if (options.readableMindName(change.mindId) === null) {
      return { waiting: 0, accepted: 0, rejected: 0, gone: true };
    }
    return options.content.read(change.mindId, (blocks) => ({
      waiting: pendingProposals(blocks).filter((each) => each.request === change.request).length,
      ...(blocks.doc ? decisionsOn(blocks.doc, change.request) : { accepted: 0, rejected: 0 }),
    }));
  };

  /**
   * Writes the Answer of a Question in a conversation, added or emptied in `turn`, from
   * the messages before it, the Mind it reads and its Search scope as it is now.
   */
  function startInConversation(
    turn: Turn,
    ready: { model: ChatModelChoice; consentNeeded: boolean },
    documentIds: string[] | null,
    emptyScope: boolean,
    mind: MindToRead | null,
  ): ConversationAskResult {
    const { conversation, question, answer } = turn;
    const help = mind ? (options.meetingHelp?.(mind.mindId, question.text) ?? null) : null;
    // Each press of a help button stands alone: an earlier suggestion would only steer this one.
    const earlier = help ? [] : turn.earlier;
    // A long Mind is cut to what the conversation's Questions are about, the earlier ones too: a
    // follow-up keeps the part the first one found, and so the same start for the prompt cache.
    const asking = [
      ...earlier.flatMap((message) => (message.kind === "question" ? [message.text] : [])),
      question.text,
    ].join("\n");
    const section =
      mind && earlier.length > 0 ? mind.reading.section(MIND_TOKEN_LIMIT, asking) : mind?.section;
    const documents = options.documents.names();
    const { context, origins } = conversationContextOf(earlier, question.text, {
      mind: section,
      documents,
      mindNames: options.readableMindName,
      changeStates: changeStatesOf,
    });
    const requestOf = (reading: MindReading, kept: MindCut): RequestMind => ({
      text: kept.text,
      selection: kept.selection,
      cut: (tokens) => reading.section(tokens, asking),
    });
    start({
      home: conversationHome(conversation.id, answer.id),
      answerId: answer.id,
      questionId: question.id,
      model: ready.model,
      context,
      contextReasons: [
        ...(section?.origins ?? []).map((source) => ({ via: "mind" as const, source })),
        ...origins.map((source) => ({ via: "context" as const, source })),
      ],
      ...(mind &&
        section && {
          mind: {
            read: readOf(mind),
            request: requestOf(mind.reading, section),
            share: section.share,
            within: (tokens: number) => {
              if (estimateTokens(section.text) + estimateTokens(section.selection) <= tokens)
                return null;
              const smaller = mind.reading.section(tokens, asking);
              return {
                context: conversationContextOf(earlier, question.text, {
                  mind: smaller,
                  documents,
                  mindNames: options.readableMindName,
                  changeStates: changeStatesOf,
                }).context,
                request: requestOf(mind.reading, smaller),
                share: smaller.share,
              };
            },
          },
        }),
      documentIds,
      scoped: question.scope !== null && hasSearchScope(question.scope),
      emptyScope,
      forcedSkill: question.forcedSkill,
      consentNeeded: ready.consentNeeded,
      ...(mind && { listening: () => options.liveTranscript(mind.mindId) }),
      ...(help && { help }),
      assistant: {
        focused: mind && {
          mindId: mind.mindId,
          // Where the cursor is counts only as a selection when text is selected.
          blockIds: question.focus?.selection ? question.focus.blockIds : [],
        },
        folderId: oneFolderOf(question.scope),
        origin: { from: messageReference(conversation.id, answer.id), question: question.text },
        lastAnswer: lastAnswerOf(conversation.id, turn.earlier),
        followsAChange: followsAChange(
          turn.earlier.findLast((message) => message.kind === "answer"),
        ),
        followsAnAnswer: turn.earlier.some((message) => message.kind === "answer"),
      },
    });
    return { asked: true, conversation, questionId: question.id, answerId: answer.id };
  }

  /** The Documents of a Search scope as it is now, and whether it covers none to search. */
  const scopeNow = (scope: SearchScope | null, mindId: string | null) => {
    const documentIds =
      options.resolveScope(scope ?? NO_SCOPE) ?? options.unscopedDocuments?.(mindId) ?? null;
    const emptyScope = documentIds !== null && options.documents.searchableCount(documentIds) === 0;
    return { documentIds, emptyScope };
  };

  /**
   * What an Answer to `question` is written from: its context, and its Search
   * scope as it is now, resolved to the Documents it covers now.
   */
  const askedWith = (context: QuestionContext, question: Y.XmlElement) => {
    const documentIds = options.resolveScope(searchScopeOf(question.getAttributes()));
    const emptyScope = documentIds !== null && options.documents.searchableCount(documentIds) === 0;
    return { context, documentIds, emptyScope };
  };

  async function ask(
    mindIdInput: unknown,
    questionIdInput: unknown,
    beforeWriting?: (mindId: string) => void,
  ): Promise<AskResult> {
    const mindId = options.requireMind(mindIdInput);
    const questionId = parseId(questionIdInput, "A Question id");

    const { picked, forcedSkill } = content.read(mindId, (blocks) => {
      const found = findBlock(blocks, QUESTION_BLOCK, questionId);
      if (!found) throw new NotFoundError({ key: "error.question.notInMind" });
      if (plainText(found.element).trim() === "") {
        throw new InvalidInputError({ key: "error.question.empty" });
      }
      return { picked: pickedModel(found.element), forcedSkill: forcedSkillOf(found.element) };
    });
    const ready = await readyModel(picked, forcedSkill);
    if ("asked" in ready) return ready;
    const { model } = ready;

    // From here on nothing awaits, so the Mind can't change underneath.
    const current = content.read(mindId, (blocks) => answerFor(blocks, questionId));
    const currentId = current && textAttribute(current, BLOCK_ID_ATTRIBUTE);
    if (currentId) active.get(currentId)?.finish({ status: "stopped" });
    beforeWriting?.(mindId);

    /** What the Answer is written from: its Question context and Search scope, as they are now. */
    type Asked = {
      context: QuestionContext;
      contextReasons: ThirdPartyReason[];
      documentIds: string[] | null;
      emptyScope: boolean;
    };
    const written = content.edit(
      mindId,
      (blocks): { answerId: string; edited: boolean } & Asked => {
        const question = findBlock(blocks, QUESTION_BLOCK, questionId);
        if (!question) throw new NotFoundError({ key: "error.question.notInMind" });
        const { context, origins } = questionContextOf(
          blocks,
          question.index,
          QUESTION_CONTEXT_TOKEN_BUDGET,
          options.documents.names(),
        );
        const asked = {
          ...askedWith(context, question.element),
          contextReasons: origins.map((source) => ({ via: "context" as const, source })),
        };
        const attributes: Partial<AnswerAttributes> = {
          questionId,
          providerId: model.providerId,
          modelId: model.modelId,
          status: "streaming",
          errorKind: null,
          errorMessage: null,
          errorResetsAt: null,
          errorSignInRoute: null,
          generatedHash: null,
          generatedMarks: true,
          citationSupport: null,
          toolCalls: null,
        };

        const answer = answerFor(blocks, questionId);
        const answerId = answer && textAttribute(answer, BLOCK_ID_ATTRIBUTE);
        if (answer && answerId) {
          // The User's edits stay: the new Answer comes, once written, as changes over them.
          if (isEdited(answer)) return { answerId, edited: true, ...asked };
          // Regenerating: the same Block, where it is, with new content.
          setAttributes(answer, attributes);
          syncContent(answer, [{ type: "paragraph" }]);
          return { answerId, edited: false, ...asked };
        }

        const id = randomUUID();
        const element = createElement({
          type: ANSWER_BLOCK,
          attrs: { [BLOCK_ID_ATTRIBUTE]: id, ...attributes },
          content: [{ type: "paragraph" }],
        });
        const at = question.index + 1;
        blocks.insert(at, [element]);
        // Somewhere to go on writing, or to ask the next Question.
        if (at + 1 === blocks.length) blocks.insert(at + 1, [createElement({ type: "paragraph" })]);
        return { answerId: id, edited: false, ...asked };
      },
    );

    const { consentNeeded } = ready;
    start({
      home: written.edited
        ? changesHome(mindId, written.answerId, model)
        : mindHome(mindId, written.answerId),
      questionId,
      model,
      ...written,
      forcedSkill,
      consentNeeded,
    });
    return { asked: true, answerId: written.answerId };
  }

  return {
    ask(input: unknown): Promise<AskResult> {
      if (!isRecord(input)) throw new InvalidInputError("askQuestion expects an object.");
      return ask(input.mindId, input.questionId);
    },

    /** `beforeWriting` runs once the Answer can be written again, just before it is. */
    regenerate(input: unknown, beforeWriting?: (mindId: string) => void): Promise<AskResult> {
      if (!isRecord(input)) throw new InvalidInputError("regenerateAnswer expects an object.");
      const mindId = options.requireMind(input.mindId);
      const answerId = parseId(input.answerId, "An Answer id");
      const questionId = content.read(mindId, (blocks) => {
        const found = findBlock(blocks, ANSWER_BLOCK, answerId);
        if (!found) throw new NotFoundError("That Answer isn't in this Mind.");
        const id = textAttribute(found.element, "questionId");
        if (!id || !findBlock(blocks, QUESTION_BLOCK, id)) {
          throw new NotFoundError({ key: "error.answer.questionGone" });
        }
        return id;
      });
      return ask(mindId, questionId, beforeWriting);
    },

    stop(input: unknown): void {
      if (!isRecord(input)) throw new InvalidInputError("stopAnswer expects an object.");
      const mindId = options.requireMind(input.mindId);
      const answerId = parseId(input.answerId, "An Answer id");
      const generation = active.get(answerId);
      if (generation?.home.place.mindId === mindId) generation.finish({ status: "stopped" });
      else settleOrphans(mindId);
    },

    /**
     * Asks a Question in a conversation (see `CoreApi.askInConversation`): nothing is
     * kept unless it can be asked.
     */
    async askInConversation(question: QuestionInput): Promise<ConversationAskResult> {
      const ready = await readyModel(question.model, question.forcedSkill);
      if ("asked" in ready) return ready;
      // From here on nothing awaits, so the conversation and the Mind can't change underneath.
      const { documentIds, emptyScope } = scopeNow(question.scope, question.mind?.id ?? null);
      const mind = mindToRead(question.mind?.id ?? null, question.focus, question.text);
      const turn = options.conversations.add(question, ready.model, readOf(mind));
      return startInConversation(turn, ready, documentIds, emptyScope, mind);
    },

    /** Writes an Answer of a conversation again, in place (see `CoreApi.regenerateConversationAnswer`). */
    async regenerateInConversation(input: unknown): Promise<ConversationAskResult> {
      const asked = options.conversations.questionOf(input);
      if (isRecord(input) && input.clearScope === true) {
        options.conversations.clearScope(asked.question.id);
      }
      const { answerId, question, toolCalls } = options.conversations.questionOf(input);
      const ready = await readyModel(question.model, question.forcedSkill);
      if ("asked" in ready) return ready;
      active.get(answerId)?.finish({ status: "stopped" });
      // Written again, it proposes its changes again: those still waiting from before go.
      options.withdrawChanges?.(toolCalls.flatMap((call) => call.mindChange ?? []));
      const from = question.askedFrom;
      const { documentIds, emptyScope } = scopeNow(
        question.scope,
        from && !from.deleted ? from.mindId : null,
      );
      const mind =
        !from || from.deleted ? null : mindToRead(from.mindId, question.focus, question.text);
      const turn = options.conversations.restartAnswer(answerId, ready.model, readOf(mind));
      return startInConversation(turn, ready, documentIds, emptyScope, mind);
    },

    /** Stops an Answer of a conversation being written, keeping what it has. */
    stopInConversation(input: unknown): void {
      if (!isRecord(input))
        throw new InvalidInputError("stopConversationAnswer expects an object.");
      const conversationId = parseId(input.conversationId, "A conversation id");
      const generation = active.get(parseId(input.answerId, "An Answer id"));
      if (generation?.home.place.conversationId === conversationId) {
        generation.finish({ status: "stopped" });
      }
    },

    /**
     * Answers a Question for an outside agent (#351) from these Documents, on
     * the default chat model, as the assistant would but kept nowhere: the
     * Answer comes back once written, its Citations checked. Asks nothing of
     * the User: if the chat model isn't ready, or its data flow not allowed
     * yet, it says so instead. `signal` stops it, keeping what was written.
     */
    async answerOutside(
      question: string,
      documentIds: string[],
      signal: AbortSignal,
    ): Promise<OutsideAnswer> {
      const readiness = await options.readiness(undefined);
      if (!readiness.ready) {
        return {
          asked: false,
          reason: readiness.reason === "local-mode" ? "local-mode" : "not-ready",
        };
      }
      if (readiness.consent === "needed") return { asked: false, reason: "consent-needed" };
      const model = { providerId: readiness.provider.id, modelId: readiness.modelId };
      const { service } = readiness.provider;
      const answerId = randomUUID();
      return new Promise<OutsideAnswer>((resolve) => {
        start({
          home: {
            place: { mindId: null },
            write(answer, outcome) {
              if (outcome) {
                const shown = new Map(answer.figures().map((figure) => [figure.marker, figure]));
                resolve({
                  asked: true,
                  status: outcome.status,
                  markdown: withFigureText(answer.markdown, (marker) => shown.get(marker) ?? null),
                  citations: answer.citations(),
                  error: outcome.status === "failed" ? outcome.error : null,
                  service,
                });
              }
              return true;
            },
          },
          answerId,
          questionId: answerId,
          model,
          context: conversationContext([], question),
          // The agent's Question is untrusted too, but nothing here can write or send (ADR-0013).
          contextReasons: [],
          documentIds,
          emptyScope: options.documents.searchableCount(documentIds) === 0,
          forcedSkill: null,
          consentNeeded: false,
          outside: true,
        });
        const stop = () => active.get(answerId)?.finish({ status: "stopped" });
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
      });
    },

    /**
     * Writes one cell of a comparison table (#98) from `documentIds` alone
     * (its row's Document: a one-Document Search scope), as a check Run,
     * offered the Documents' search and `cite` only, and kept nowhere: it
     * comes back once written, its Citations checked, as the Blocks a Mind
     * holds. The model is ready and allowed already. `signal` stops it.
     */
    answerCell(input: {
      context: QuestionContext;
      documentIds: string[];
      model: ChatModelChoice;
      signal: AbortSignal;
    }): Promise<CellAnswer> {
      const answerId = randomUUID();
      return new Promise<CellAnswer>((resolve) => {
        start({
          home: {
            place: { mindId: null },
            write(answer, outcome) {
              if (outcome) {
                resolve({
                  status: outcome.status,
                  markdown: answer.markdown,
                  blocks: answer.blocks(),
                  citations: answer.citations(),
                  error: outcome.status === "failed" ? outcome.error : null,
                });
              }
              return true;
            },
          },
          answerId,
          questionId: answerId,
          model: input.model,
          context: input.context,
          contextReasons: [],
          documentIds: input.documentIds,
          emptyScope: options.documents.searchableCount(input.documentIds) === 0,
          forcedSkill: null,
          consentNeeded: false,
          outside: true,
          toolSet: "check",
          task: true,
        });
        const stop = () => active.get(answerId)?.finish({ status: "stopped" });
        if (input.signal.aborted) stop();
        else input.signal.addEventListener("abort", stop, { once: true });
      });
    },

    /**
     * Does one step of a Research Task (#130) as an Answer kept nowhere, as a
     * cell is: from the Documents of `documentIds` (null: every Document)
     * and, with `web`, the web, whatever the step's words; a page it reads is
     * saved into the Folder of `mindId`. It uses no Connector and no Skill
     * script, so nothing it does waits for the User. The model is ready and
     * allowed already. `onCall` hears each Tool call as it ends.
     */
    answerResearch(input: {
      mindId: string;
      context: QuestionContext;
      documentIds: string[] | null;
      web: boolean;
      model: ChatModelChoice;
      signal: AbortSignal;
      onCall(call: AnswerToolCall): void;
    }): Promise<CellAnswer> {
      const answerId = randomUUID();
      return new Promise<CellAnswer>((resolve) => {
        start({
          home: {
            place: { mindId: input.mindId },
            write(answer, outcome) {
              if (outcome) {
                resolve({
                  status: outcome.status,
                  markdown: answer.markdown,
                  blocks: answer.blocks(),
                  citations: answer.citations(),
                  error: outcome.status === "failed" ? outcome.error : null,
                });
              }
              return true;
            },
          },
          answerId,
          questionId: answerId,
          model: input.model,
          context: input.context,
          contextReasons: [],
          documentIds: input.documentIds,
          emptyScope:
            !input.web &&
            input.documentIds !== null &&
            options.documents.searchableCount(input.documentIds) === 0,
          forcedSkill: null,
          consentNeeded: false,
          outside: true,
          task: true,
          web: input.web,
          onCall: input.onCall,
        });
        const stop = () => active.get(answerId)?.finish({ status: "stopped" });
        if (input.signal.aborted) stop();
        else input.signal.addEventListener("abort", stop, { once: true });
      });
    },

    /** Stops every Answer being written in a conversation, e.g. before it is deleted. */
    stopConversation(conversationId: string): void {
      for (const generation of [...active.values()]) {
        if (generation.home.place.conversationId === conversationId) {
          generation.finish({ status: "stopped" });
        }
      }
    },

    /** Call before a Mind is opened: Answers a quit or crash left "streaming" become "stopped". */
    settleOrphans,

    /**
     * Local mode just turned on: stops every Answer being written by a model that isn't on
     * this computer, keeping what was written. It ends as failed with the "local-mode"
     * reason, so the Answer says why.
     */
    async stopCloud(): Promise<void> {
      for (const generation of [...active.values()]) {
        const readiness = await options.readiness(generation.model);
        if (readiness.ready || readiness.reason !== "local-mode") continue;
        generation.finish({
          status: "failed",
          error: {
            kind: "local-mode",
            message: "Stopped: “Keep everything on this computer” is on.",
          },
        });
      }
    },

    /** Stops every Answer, keeping what was written, e.g. when the app quits. */
    stopAll(): void {
      for (const generation of [...active.values()]) generation.finish({ status: "stopped" });
    },
  };
}
