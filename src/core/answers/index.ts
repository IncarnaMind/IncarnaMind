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
import { hasText, markersIn, pageBlocks, withCalculatedFigures } from "../../shared/answerBlocks";
import { runsByDefault } from "../../shared/approvalRules";
import { appliedAsAsked } from "../../shared/askedChanges";
import { citationNode, withCitations } from "../../shared/blockJson";
import { type LiveDocument, shownDocumentName } from "../../shared/citations";
import { yoursLine } from "../../shared/commands";
import { withFigures, withFigureText } from "../../shared/figureMarkers";
import { figureRunsOfAnswer, installFigureRuns } from "../../shared/figureRuns";
import { translate } from "../../shared/i18n";
import { englishPlace } from "../../shared/locations";
import { holdsNothing, madeByAnswer } from "../../shared/madeMind";
import { linkTableSources } from "../../shared/markdownTables";
import type { MeetingHelpKind } from "../../shared/meetingHelp";
import {
  linkKnownSources,
  type NamedSource,
  namesOneOf,
  sourcesAsText,
} from "../../shared/namedSources";
import {
  decisionsOn,
  recordProposalRequest,
  resolveProposals,
  waitingChanges,
} from "../../shared/proposals";
import {
  filingFolder,
  folderScope,
  hasSearchScope,
  NO_SCOPE,
  searchScopeOf,
} from "../../shared/searchScope";
import { normaliseText } from "../../shared/text";
import { setTextOrigin } from "../../shared/textOrigins";
import { unrunToolNotes } from "../../shared/unrunTools";
import type { AnalysisRuntime } from "../adapters";
import { withAnalysisResults } from "../analysis/markers";
import { analysisTool } from "../analysis/tool";
import {
  ANSWER_BLOCK,
  type AnalysisCall,
  type AnswerAnalysis,
  type AnswerAttributes,
  type AnswerPhase,
  type AnswerPlace,
  type AnswerSteps,
  type AnswerToolCall,
  type AnswerUsage,
  type ApprovalReadText,
  type AskedFrom,
  type AskedQuote,
  type AskResult,
  BLOCK_ID_ATTRIBUTE,
  type ChatModelChoice,
  type ChatReadiness,
  type CitationRecheck,
  type CitationSupport,
  type CitedSelection,
  type ClaimedChange,
  type ClaimedTool,
  type CommandDone,
  type CommandProblem,
  type CommandsFound,
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
  type UserAnswer,
  type UserQuestion,
  type UserQuestionRequest,
  type WebPageCall,
} from "../api";
import type { CallToDecide, ToolCallToApprove } from "../approvals";
import type { AddedTurn, AnswerRead, AnswerWrite, QuestionInput, Turn } from "../conversations";
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
import type { AnswerFlow } from "../providers/catalog/answerPaths";
import type { PreparedChatModel } from "../providers/chat";
import type { ModelCallKind } from "../providers/outputLimits";
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
import { inFlow, inStep } from "../timing/flows";
import {
  ASK_TOOLS,
  COMMAND_TOOLS,
  DOCUMENT_TOOLS,
  MIND_TOOLS,
  SKILL_TOOLS,
  type Tool,
  type ToolCallContext,
  type ToolProvider,
  type ToolProviderKind,
} from "../tools";
import { askTool } from "../tools/asks";
import type { Findable } from "../tools/commands/find";
import type { CommandWindow } from "../tools/commands/offered";
import { type CommandRename, renamesIn } from "../tools/commands/policy";
import type { CommandsHost } from "../tools/commands/run";
import type { CommandSteps } from "../tools/commands/steps";
import { commandTools } from "../tools/commands/tools";
import { type MindsForTools, type MindToolsOptions, mindTools } from "../tools/minds/tools";
import { asksForWeb } from "../tools/web/intent";
import { type SavedPage, webTools } from "../tools/web/tools";
import {
  contentHash,
  createElement,
  findBlock,
  isEdited,
  type NodeJSON,
  nodeOf,
  syncContent,
  textAttribute,
  topLevelBlocks,
} from "./blocks";
import { answerLanguage, createCalculationSession, whole } from "./calculations";
import { asksToCheckOrCalculate } from "./carefulIntent";
import { type ChangedScale, changedScale, changedScaleNote } from "./changedScale";
import {
  type AnswerDocuments,
  createCitationSession,
  documentNamedAmong,
  type QuoteInput,
  withoutDeadMarkers,
  withoutFootnoteDefinitions,
} from "./citations";
import {
  askAgainNote,
  unbackedClaims as claimsNoCallMade,
  unmadeFixesNote,
} from "./claimedChanges";
import { unmadeFixesIn } from "./claimedFixes";
import { unrunToolClaims, unrunToolsNote } from "./claimedTools";
import { holdBack } from "./claimStream";
import {
  askedText,
  conversationContext,
  conversationContextOf,
  earlierReplyLabel,
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
import {
  type ContextCitations,
  createContextCitations,
  withoutWrittenIds,
} from "./contextCitations";
import {
  coverageInstructions,
  coverageOf,
  documentsAsked,
  namedCoverage,
  type SizedDocument,
} from "./coverage";
import {
  documentSkimBlock,
  documentTextBlock,
  givenUpFront,
  OPENING_TOKEN_LIMIT,
  openingWithin,
  SMALL_SCOPE_DOCUMENTS,
  skimTokens,
  skimWithin,
  upFrontTokens,
  withoutOverlap,
} from "./documentText";
import type {
  AnswerEngine,
  AnswerSearchOptions,
  AnswerTools,
  CitationRecordInput,
  CiteOptions,
  DocumentLanguage,
  GatedCall,
  ToolSet,
} from "./engine";
import {
  type LiveTranscript,
  listenedTokens,
  newestWithin,
  withBeforeQuestion,
  withTranscript,
} from "./liveTranscript";
import { markdownToBlocks } from "./markdown";
import { withFigureCitations } from "./markerPlacement";
import {
  FOUND_TOKEN_LIMIT,
  foundWithin,
  HELP_DOCUMENTS,
  LIVE_TEXT_BEHIND_NOTE,
  languageSaid,
  meetingHelpInstructions,
  newestSaid,
  withFound,
  withHelp,
} from "./meetingHelp";
import { paragraphAsked } from "./paragraphAsked";
import {
  analysisInstructions,
  answerInstructions,
  commandInstructions,
  connectorInstructions,
  documentInstructions,
  emptyMindNote,
  exampleNote,
  LISTED_DOCUMENTS,
  LISTED_MINDS,
  type LibraryDocuments,
  type ListedDocuments,
  languageInstruction,
  loadedSkillText,
  meetingInstructions,
  mindInstructions,
  mindsLine,
  selectedTextBlock,
  signInNeededInstructions,
  skillInstructions,
  skillLanguageNote,
  skillSetsLanguage,
  sourcesInstructions,
  stillReadingNote,
  THIS_DOCUMENT_RULE,
  unrecordedMarkersNote,
  webInstructions,
  withPassageNotes,
  workingCopyNote,
} from "./prompt";
import { quotedWordsIn, withoutQuotationMarks } from "./quotedWords";
import { readKinds } from "./readKinds";
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
  /** The Analyses it ran, in order (#447). */
  analyses: AnswerAnalysis[];
  /** An amount it writes at another scale than its Citations give it (see ./changedScale). */
  changedScale(): ChangedScale | null;
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
  /** The ids its Citations read with, which the Answer's `cite` takes (#1800). */
  ids: ContextCitations;
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
  /** Writes an ended Answer's Tool calls again, one updated since; false if it is gone. */
  writeToolCalls(answerId: string, toolCalls: readonly AnswerToolCall[]): boolean;
  /**
   * Adds a Question, and its conversation with its first one, and its Answer, being
   * written, which reads `read`.
   */
  add(
    input: Omit<QuestionInput, "onScreen" | "commands">,
    answerModel: ChatModelChoice | null,
    read: AnswerRead | null,
    emit?: boolean,
    askedIn?: (conversationFolderId: string | null) => string,
  ): AddedTurn;
  /** Emits a turn added with `emit: false`, once its Question can be asked. */
  publish(turn: Turn): void;
  /** Discards a turn added with `emit: false` when its Question can't be asked. */
  discard(added: AddedTurn): void;
  /** The Question of an Answer, and the Tool calls it made, to write the Answer again; what is on screen now. */
  questionOf(input: unknown): {
    answerId: string;
    question: ConversationQuestion;
    toolCalls: AnswerToolCall[];
    onScreen: string[];
    commands: CommandWindow | null;
    /** The model the caller chose to write it with instead of the Question's own (#1848). */
    model: ChatModelChoice | null;
  };
  /** Keeps a Question on the model its Answer is written with now, so Regenerate goes on with it. */
  setQuestionModel(questionId: string, model: ChatModelChoice): ConversationQuestion | null;
  /** Takes the Search scope off a Question: its Answers search every Document (#748). */
  clearScope(questionId: string): ConversationQuestion | null;
  /** Empties an Answer, where it is, to write it again, reading `read`. */
  restartAnswer(
    answerId: string,
    answerModel: ChatModelChoice | null,
    read: AnswerRead | null,
    emit?: boolean,
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
  /** An amount it writes at another scale than its Citations give it. */
  changedScale: ChangedScale | null;
  error: ProviderError | null;
}

const FIGURE_CITATIONS_FROM = 9000;

// With nothing to search, a model wrote what a Document says, uncited, into the User's Mind and
// blamed its Tools (#1359).
const NOTHING_TO_CITE =
  "That is why no Tool searches or cites Documents in this Answer; none failed, so never say a Tool is unavailable. Answer from the Note you read, the conversation and the request itself. When the request needs what a Document says (to quote, cite, summarise or compare it), write nothing into a Note and never state what a Document says: answer in one sentence, in the User's language, giving that reason.";

/** Tells the model its Question's Search scope holds no Documents, so it answers from what it has (#748). */
const EMPTY_SCOPE_NOTE = `The User limited this Question to a Search scope (Folders, Tags or Documents) that holds no Documents, so there is nothing to search. ${NOTHING_TO_CITE} The line under your Answer offers to search all their Documents instead.`;

// Told only this, models took a Mind the User named for a Document and wrote nothing (#1790).
const MINDS_ARE_NOT_DOCUMENTS = "Their Notes aren't Documents: read_mind reads one they name.";

const noDocumentsNote = (examples: boolean, library: number) =>
  `None of the User's own Documents can be searched yet${examples ? " (the examples IncarnaMind made aren't theirs)" : ""}, so there is nothing to search.${library > 0 ? ` The User's Library holds ${library} Document${library === 1 ? "" : "s"} in all: never say it holds fewer than ${library}.` : ""} ${NOTHING_TO_CITE} They can add Documents to the Library.`;

const changesAMind = (change: MindChange) =>
  change.created || change.revised === true || change.proposals > 0;

const touchedIn = (messages: readonly ConversationMessage[]): string[] =>
  messages.flatMap((message) =>
    message.kind === "answer"
      ? message.toolCalls.flatMap((call) =>
          call.mindChange && changesAMind(call.mindChange) ? [call.mindChange.mindId] : [],
        )
      : [],
  );

function lastAnswerOf(
  conversationId: string,
  earlier: readonly ConversationMessage[],
  filedIn: (scope: SearchScope | null, askedFrom: AskedFrom | null) => string | null,
  language: Language,
): MindToolsOptions["lastAnswer"] {
  const at = earlier.findLastIndex((message) => message.kind === "answer");
  const answer = earlier[at];
  if (answer?.kind !== "answer") return null;
  const question = earlier.slice(0, at).findLast((message) => message.kind === "question");
  // Put into a Note as it is, a claim of a Tool that didn't run keeps its line (#1796).
  const blocks = [
    ...pageBlocks(answer, question?.text ?? ""),
    ...unrunToolNotes((key, params) => translate(language, key, params), answer.steps),
  ];
  if (!hasText(blocks)) return null;
  return {
    blocks,
    origin: { from: messageReference(conversationId, answer.id), question: question?.text ?? "" },
    folderId: question?.kind === "question" ? filedIn(question.scope, question.askedFrom) : null,
    answer: { id: answer.id, analyses: answer.analyses },
  };
}

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
   * Passages in reading order, none while it has no line, and whether it is behind; null when the
   * Mind's Meeting isn't recording.
   */
  liveTranscript(mindId: string): Promise<LiveTranscript | null>;
  /**
   * The help button a Question in a conversation is, asked from a Mind whose Meeting
   * records or is paused: its text is the button's name. Null for any other Question.
   */
  meetingHelp?(mindId: string, question: string): MeetingHelpKind | null;
  /** Whether the Mind's Meeting records or is paused now; its earlier replies are labeled as such (#1319). */
  liveMeeting?(mindId: string): boolean;
  providerExists(providerId: string): boolean;
  /** The default model, before its readiness is checked. */
  defaultModel(): ChatModelChoice | null;
  /** Whether this model reads pictures: one that can't is sent none, even one the User selected (#1937). */
  readsImages?(choice: ChatModelChoice): boolean;
  /** Whether Questions can be asked with this model (the default one when undefined). */
  readiness(choice: ChatModelChoice | undefined): Promise<ChatReadiness>;
  /** The model, once the User has accepted its data flow (see `Core.prepareChatModel`). */
  prepareModel(
    choice: ChatModelChoice,
    thinking: "off" | "summary" | "answer" | "careful",
  ): Promise<PreparedChatModel>;
  /**
   * The model for the calls that don't write the Answer, asked to skip thinking:
   * the quick-tasks model for an Answer asked with `answers`, which may be
   * `answers` itself.
   */
  prepareQuickModel?(
    answers: ChatModelChoice,
    prepared: PreparedChatModel,
  ): Promise<PreparedChatModel["model"]>;
  /** Whether this model writes the Answer, then cites it, in the Tool loop, in this flow (#489). */
  writesThenCites?(prepared: PreparedChatModel, flow: AnswerFlow): boolean;
  /** Whether an Answer on this model, in this flow, searches its Question before the first call (#1633). */
  retrievesFirst?(prepared: PreparedChatModel, flow: AnswerFlow): boolean;
  /** Searching the User's Documents, and what Citations point to. */
  documents: DocumentsForAnswers;
  /** Runs Analyses (#447, ADR-0023); absent: no Answer is offered `run_analysis`. */
  analysisRuntime?: AnalysisRuntime;
  /** What an Answer is written in when its Question has no language of its own. */
  interfaceLanguage(): Language;
  /** The ids of the live Documents a Search scope covers; null with no Search scope (every Document). */
  resolveScope(scope: SearchScope, mindId?: string | null): string[] | null;
  /**
   * With no Search scope, what an Answer asked from `mindId` in the assistant
   * searches: the examples until the User has a Document of their own, theirs
   * alone from then on (#1942); an example's Mind searches every Document.
   * Null: every Document.
   */
  unscopedDocuments?(mindId: string | null): string[] | null;
  /** What a Question from a Mind searches, by the one rule (`mindSearchScope`); null: every Document. */
  searchedScope(scope: SearchScope | null, mindId: string | null): SearchScope | null;
  mindFolder(mindId: string): string | null;
  /** The walled Folder a Mind is in; null when it is in none. */
  walledFolder(mindId: string | null): string | null;
  /** The Folder itself when it is walled now; null for any other, or none. */
  walledFolderId(folderId: string | null): string | null;
  /** The Documents filed in a walled Folder, by any filing. */
  walledDocuments(): string[];
  /**
   * Where something an Answer makes is filed, behind the wall `wallId` or outside every wall
   * (null), when `asked` is the Folder it would go in; null: it can't be filed, so isn't made.
   */
  filedWithin(wallId: string | null, asked: string | null): { folderId: string | null } | null;
  /** The Document a Mind imported from Word was also added as (#720); null for none. */
  workingCopyOf?(mindId: string): string | null;
  /** An example Mind's own Documents, by id; null for a Mind that isn't an example's. */
  exampleDocuments?(mindId: string): string[] | null;
  /** What an Answer says when its Question's Search scope has no Documents to search. */
  emptyScopeAnswer(): string;
  /**
   * The line a help button's Answer starts with while its Meeting's live text is behind (#1366),
   * in the User's language: that none of the call is written yet, or, with `lines`, that it rests
   * on the lines so far. With no line there is nothing to answer from, so it is the whole Answer
   * and the model isn't asked.
   */
  liveTextBehind(lines: boolean): string;
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
   * The app's commands an Answer in the assistant runs for the User (#1110, ../tools/commands):
   * what they act on, and the Undo of each Run's changes; absent: it runs none.
   */
  commands?: {
    host: CommandsHost;
    findable(mindId: string | null, wallId?: string | null): Promise<Findable>;
    steps: CommandSteps;
  };
  /**
   * Takes back the changes an Answer proposed in Minds, before it is written
   * again (#202): those still waiting are rejected, and a Mind it made goes
   * once nothing else is in it.
   */
  withdrawChanges?(changes: readonly MindChange[]): void;
  /** Asking the User before a Connector Tool or a Skill script runs. */
  approvals: AnswerApprovals;
  /** The assistant's questions to the User, in the tray (#1374). Without it, an Answer never asks. */
  questions?: {
    ask(request: Omit<UserQuestionRequest, "requestId">, signal: AbortSignal): Promise<UserAnswer>;
  };
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
  /**
   * Saves a page into the Folder `filedWithin` gives the turn's wall `wallId` for the place the
   * Question was asked in, or not at all when it gives none; resolves once it can be searched.
   */
  save(
    address: string,
    place: AnswerPlace,
    signal: AbortSignal,
    wallId: string | null,
  ): Promise<SavedPage>;
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
    : "ask" in call
      ? `The User didn't allow ${call.subject.command}, so it didn't run and nothing changed. Carry on without it, don't run it again, and say what wasn't done.`
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
  analysis: "analysis",
  commands: "commands",
  asks: "asks",
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
  /** The Library's count as its page shows it: the examples' until the User has one, then theirs. */
  libraryCount(): number;
  /** Every live Document's names: what a Citation in the Question context names its Document by. */
  names(): readonly LiveDocument[];
  /**
   * How many Documents there are to search, and the names of the `limit` most recently added,
   * newest first; `webPages`: the saved web pages among them, by id, each named by its own title.
   */
  searchableNames(
    documentIds: readonly string[] | null,
    limit: number,
  ): ListedDocuments & { webPages: string[] };
  /** The Documents to search, the most text first. */
  searchableBySize(documentIds: readonly string[] | null): SizedDocument[];
  /** Whether a Document to search is a workbook or a CSV file: what an Analysis reads (#447). */
  searchableHasSheets(documentIds: readonly string[] | null): boolean;
  passage(passageId: string): WindowedPassage | null;
  /** The live Passages of a live Document at positions `from` to `to`, in reading order. */
  passagesBetween(documentId: string, from: number, to: number): WindowedPassage[];
  /** Live Passages covering pages `from` to `to`, or intersecting them when `overlapping`. */
  passagesCovering(
    documentId: string,
    from: number | null,
    to: number | null,
    overlapping?: boolean,
  ): WindowedPassage[];
  /** Words the User selected to ask about, checked where they were selected (`recheckWhereSelected`). */
  recheckWhereSelected(quote: AskedQuote): CitedSelection;
  /** The languages the Documents to search are in, the most common first, with how many are in each. */
  searchableLanguages(documentIds: readonly string[] | null): DocumentLanguage[];
  /** The Documents among these (null: every Document) whose text couldn't be read, or some of it. */
  unread(documentIds: readonly string[] | null): UnreadFile[];
  /** The Documents among these (null: every Document) whose text is still being read: nothing a search finds is from them yet. */
  reading(documentIds: readonly string[] | null): { name: string }[];
  search(
    query: string,
    documentIds: readonly string[] | null,
    signal?: AbortSignal,
    options?: AnswerSearchOptions,
  ): Promise<WindowedPassage[]>;
  /** A saved web page's address, as it was read; null for a file, or a Document unknown here. */
  webAddress(documentId: string): string | null;
}

interface Quoted {
  quote: AskedQuote;
  passages: WindowedPassage[];
}

const holdsUnitsOf = (passage: WindowedPassage, cited: CitationRecheck) =>
  cited.pageFrom === null || cited.pageTo === null
    ? passage.passageId === cited.passageId
    : passage.pageFrom !== null &&
      passage.pageTo !== null &&
      passage.pageFrom <= cited.pageTo &&
      passage.pageTo >= cited.pageFrom;

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
    passage: (passageId) => documents.passage(passageId),
    passagesBetween: (documentId, from, to) => documents.passagesBetween(documentId, from, to),
    passagesCovering: (documentId, from, to, overlapping) =>
      documents.passagesCovering(documentId, from, to, overlapping),
    documentNamed: (name) => documentNamedAmong(documents.searchableBySize(documentIds), name),
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

  // A turn whose Folder wasn't recorded may be on either side of a wall: it reads nothing (#1934).
  const UNKNOWN_WALL = "unknown";
  const wallOfTurn = (question: { folderAskedIn?: string }): string | null =>
    question.folderAskedIn === undefined
      ? UNKNOWN_WALL
      : options.walledFolderId(question.folderAskedIn);

  /**
   * The Documents work on one side of the Folder walls may read: the wall's own, else every one
   * outside a wall, whatever its Search scope (#1934). Null: every Document, with no wall at all.
   */
  const readableAcrossWalls = (mindId: string | null, wallId?: string | null): string[] | null =>
    wallId === UNKNOWN_WALL
      ? []
      : wallId
        ? options.resolveScope(folderScope(wallId))
        : options.resolveScope(NO_SCOPE, mindId);

  const contextCitationsFor = (mindId: string | null, wallId?: string | null): ContextCitations => {
    const allowed = readableAcrossWalls(mindId, wallId);
    return createContextCitations((documentId) => allowed === null || allowed.includes(documentId));
  };

  function start(input: {
    home: AnswerHome;
    answerId: string;
    questionId: string;
    model: ChatModelChoice;
    context: QuestionContext;
    /** The ids the Citations in `context` read with; absent: it shows none. */
    ids?: ContextCitations;
    /** The line naming the User's Minds, for a pass that offers the Minds' Tools (see `AnswerRequest`). */
    mindsLine?: { line: string; asked: string };
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
    /** The output limit of its replies, when it writes more than an Answer (see `AnswerRequest`). */
    outputKind?: ModelCallKind;
    /**
     * How much it thinks first, when not as its kind does. A Meeting's notes think as an Answer
     * does: at a Task's effort the thinking alone filled their replies' limits (#2306).
     */
    thinking?: "answer";
    /** A comparison table's cell (#1798): an amount it writes at another scale than its Citations give is asked about once. */
    checkScales?: boolean;
    /**
     * Asked from a Mind whose Meeting may be recording (#144): its live Transcript, indexed up
     * to now, to go with the Question. Absent: none.
     */
    listening?: () => Promise<LiveTranscript | null>;
    /**
     * A Meeting's saved Transcript to fill its notes in from (#142): shown with the Question as
     * `listening` is, as much of it as fits half the model's window.
     */
    transcript?: WindowedPassage[];
    /** Words the User selected in Documents to ask about (#101), right before the Question. */
    quoted?: readonly Quoted[];
    /**
     * One-click help during the call: the button pressed. Its Answer is laid out as
     * the panel reads it, and is offered the Documents' Tools only.
     */
    help?: MeetingHelpKind;
    /** Written for a Task (#126), which gives way to Answers itself (see ../runs/tasks). */
    task?: boolean;
    /** Offers web search's Tools whatever the Question says: a Research Task's Web source (#130). */
    web?: boolean;
    /** "Analyse data…" was chosen (#447): `run_analysis` is offered whatever the Search scope holds. */
    analyse?: boolean;
    /** Hears each Tool call as it ends. */
    onCall?(call: AnswerToolCall): void;
    /**
     * An Answer in the assistant (#202): the Mind it was asked from and the
     * Blocks the User selected there, where a Mind it makes goes, and what
     * Blocks it adds link back to. It is offered the Minds' Tools. Absent: none.
     */
    assistant?: Pick<
      MindToolsOptions,
      "focused" | "folderId" | "origin" | "lastAnswer" | "remake" | "touched"
    > & {
      /** What the commands of the Conversation's earlier Answers renamed, oldest first. */
      renames: readonly CommandRename[];
      /** The asking window and its commands, which it runs for the Answer (#1421). */
      commands?: CommandWindow | null;
      /** The calls of the Conversation's earlier Answers, oldest first: a follow-up may be answered from their searches (#1796). */
      earlierCalls?: readonly AnswerToolCall[];
      /** The Folder wall of this Conversation when no Note is open; null for ordinary scope. */
      wallId?: string | null;
    };
  }): void {
    const { home, answerId, model, context, forcedSkill, help } = input;
    const helpDocuments = help ? HELP_DOCUMENTS[help] : undefined;
    const callDocuments: string[] | null = helpDocuments === null ? [] : null;
    const scoped = callDocuments !== null || (input.scoped ?? input.documentIds !== null);
    const outside = input.outside === true;
    // Only an Answer the User reads is told the Library's whole count (#1333): a cell's or an agent's is its scope's alone.
    const library: LibraryDocuments | undefined = outside
      ? undefined
      : { total: options.documents.libraryCount() };
    const asked =
      input.outside === true || callDocuments !== null
        ? { each: false, main: null }
        : documentsAsked(context.question, () =>
            options.documents.searchableBySize(input.documentIds).map((each) => each.name),
          );
    const coverage =
      asked.each || asked.main !== null
        ? coverageOf(asked, options.documents.searchableBySize(input.documentIds))
        : null;
    const documentIds =
      callDocuments ?? (coverage ? coverage.used.map((each) => each.id) : input.documentIds);
    // Worked out now, shown only once the Answer has written into a Mind from new text.
    const writtenFrom =
      !outside && options.minds && input.assistant
        ? someOfTheDocuments(input.documentIds, input.assistant.focused?.mindId ?? null)
        : null;
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
    let heard: LiveTranscript | null = null;
    /** Help asked while its Meeting's live text was behind (#1366). */
    let textBehind = false;
    /** The Documents whose whole text went with the Question; null until the assistant's request is built. */
    let sentDocuments: Set<string> | null = null;
    /** The Documents the live transcript came from: the "listened" step names them. */
    const transcripts = new Set<string>();
    // An Answer inside another flow (a comparison's cell, a check's sentence) is that flow's step.
    const flow: AnswerFlow = help
      ? "call-help"
      : input.toolSet === "check"
        ? "check"
        : input.task
          ? "task-answer"
          : outside
            ? "outside-agent"
            : "question";
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
    let unrunTools: readonly ClaimedTool[] = [];
    let askedAgainFor: readonly ClaimedTool[] = [];
    /** What the model calls counted, the cached input tokens too. */
    const usage: AnswerUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    };
    const toolCalls: AnswerToolCall[] = [];
    // Its last Answer put in as it is ("make it a document") holds what that Answer covered.
    const wroteNewText = () =>
      toolCalls.some(
        (call) =>
          call.source === "minds" &&
          call.tool !== MIND_TOOLS.edit &&
          call.input.answer !== true &&
          call.mindChange !== undefined &&
          changesAMind(call.mindChange),
      );
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
    /** The Documents of the scope still being read, looked at once, when the Answer ends. */
    let stillReadingAtEnd: AnswerSteps["stillReading"] | null | undefined;
    const stillReading = () => {
      if (finishedAt === null) return null;
      if (stillReadingAtEnd === undefined) {
        const reading = options.documents.reading(documentIds);
        const [only] = reading;
        stillReadingAtEnd =
          reading.length === 0
            ? null
            : { count: reading.length, ...(reading.length === 1 && only && { name: only.name }) };
      }
      return stillReadingAtEnd;
    };
    let namedAtEnd: AnswerSteps["coverage"] | null | undefined;
    const covered = () => {
      if (coverage || outside || finishedAt === null) return coverage;
      if (namedAtEnd === undefined) {
        const { cited, passages, searched } = session.documentsRead();
        const titles = new Map(options.documents.names().map((each) => [each.id, each.title]));
        namedAtEnd = namedCoverage(
          context.question,
          cited.length > 0 ? cited : passages,
          [...new Set([...cited, ...passages, ...searched])],
          options.documents
            .searchableBySize(documentIds)
            .map((each) => ({ ...each, title: titles.get(each.id) })),
        );
      }
      return namedAtEnd;
    };
    const steps = (): AnswerSteps => {
      const summary = reasoning.trim();
      const reading = stillReading();
      const shownCoverage = covered();
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
        ...(citedAfterChecking.asked &&
          citedAfterChecking.count === 0 && { notCitedAfterAsking: true as const }),
        ...(sentAt !== null &&
          firstWordAt !== Infinity && { firstWordMs: wordAfter(sentAt, firstWordAt) }),
        ...(careful && { careful: true as const }),
        ...(unbackedClaims.length > 0 && { unbackedClaims: [...unbackedClaims] }),
        ...(unrunTools.length > 0 && {
          unrunTools: [...unrunTools],
          ...(!calculating && unrunTools.includes("calculate") && { calculateUnavailable: true }),
        }),
        ...(askedAgainFor.length > 0 && { askedAgainFor: [...askedAgainFor] }),
        ...(shownCoverage && { coverage: shownCoverage }),
        ...(writtenFrom && wroteNewText() && { writtenFrom }),
        ...(textBehind && { textBehind: true as const }),
        ...(reading && { stillReading: reading }),
        ...(sentDocuments && {
          sent: {
            documents: [...sentDocuments],
            ...(heard && transcripts.size > 0 && { transcript: true as const }),
          },
        }),
      };
    };
    let skills: SkillSession | null = null;
    const searched = inScope(options.documents, documentIds);
    const inAssistant = !outside && input.assistant !== undefined;
    const mindIn = input.assistant?.focused?.mindId ?? null;
    const turnWall = input.assistant?.wallId ?? options.walledFolder(mindIn ?? place.mindId);
    const filing = (asked: string | null) => options.filedWithin(turnWall, asked);
    /** Why a Tool refused across the Folder wall, said after the model's reply. */
    const wallRefusals = new Set<
      | "folder.wall.refusal"
      | "folder.wall.notFiled"
      | "folder.wall.pageNotFiled"
      | "folder.wall.pageNotFiledGone"
    >();
    const originalId =
      inAssistant && mindIn !== null ? (options.workingCopyOf?.(mindIn) ?? null) : null;
    const [original = null] =
      originalId !== null && (documentIds === null || documentIds.includes(originalId))
        ? options.documents.searchableBySize([originalId])
        : [];
    const exampleIds =
      inAssistant && mindIn !== null ? (options.exampleDocuments?.(mindIn) ?? null) : null;
    const exampleNames = exampleIds
      ? options.documents.searchableBySize(exampleIds).map((each) => each.name)
      : null;
    const passagesOf = (documentId: string) =>
      options.documents.passagesBetween(documentId, 0, Number.MAX_SAFE_INTEGER);
    const ids = input.ids ?? contextCitationsFor(mindIn, input.assistant?.wallId);
    const notKept = translate(answerLanguage(context.question), "answer.sourceNotKept");
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
      ids,
    );
    /**
     * Whether its model is offered `calculate` and its steer: a fact of the
     * model, once prepared (ADR-0021). Off, the Answer is as it was before them.
     */
    let calculating = false;
    /** Its `calculate` calls, as one Tool call (see `calculatedCall`), once a figure is recorded. */
    let calculated: AnswerToolCall | null = null;
    const recordedFigures = new Set<number>();
    const analyses: AnswerAnalysis[] = [];
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
    const scaleChangeIn = (text: string): ChangedScale | null =>
      changedScale(
        text,
        [...new Set(markersIn(text))].flatMap((marker) => session.quotes.recorded(marker) ?? []),
        answerLanguage(context.question),
      );
    // A figure's Citations are its inputs', which the model may leave out of its sentence or write
    // only as footnote definitions (#1831). An input quoted directly is recorded when calculate
    // takes it, numbered far above the model's own, which count from [^1]: a Citation the model
    // writes later never takes a figure's quote.
    const quoteKey = (quote: QuoteInput) =>
      [quote.passage, quote.location, quote.pageFrom, quote.pageTo, quote.quote].join("\n");
    const recordedQuotes = new Map<string, number>();
    const quotesRecorded = new Map<number, QuoteInput>();
    let figureMarker = FIGURE_CITATIONS_FROM;
    const nextMarker = (): number => {
      do figureMarker++;
      while (session.tools.hasRecord?.(figureMarker));
      return figureMarker;
    };
    const recordQuote = (quote: QuoteInput, marker: number) => {
      session.tools.cite([{ ...quote, marker }], { structured: true });
      if (!session.tools.hasRecord?.(marker)) return false;
      recordedQuotes.set(quoteKey(quote), marker);
      quotesRecorded.set(marker, quote);
      return true;
    };
    const calculateFigures = (given: readonly unknown[], calculateOptions?: CiteOptions) => {
      const told = figures.calculate(given, calculateOptions);
      for (const raw of given) {
        const marker = whole((raw as { marker?: unknown } | null)?.marker);
        for (const source of marker === null ? [] : figures.inputSources(marker)) {
          if (typeof source !== "number" && !recordedQuotes.has(quoteKey(source)))
            recordQuote(source, nextMarker());
        }
      }
      return told;
    };
    const citeRecords = (records: readonly CitationRecordInput[], citeOptions?: CiteOptions) => {
      for (const record of records) {
        const quote = quotesRecorded.get(record.marker);
        // The model numbered a Citation of its own with a figure's: the figure's record moves.
        if (quote && quoteKey(quote) !== quoteKey(record)) {
          quotesRecorded.delete(record.marker);
          recordQuote(quote, nextMarker());
        }
      }
      for (const record of records) recordedQuotes.set(quoteKey(record), record.marker);
      return session.tools.cite(records, citeOptions);
    };
    const wordsOf = (marker: number) => {
      const citation = session.quotes.recorded(marker)?.citation;
      return citation && { passage: citation.passageId, quote: normaliseText(citation.quote) };
    };
    // A Citation that quotes an input's words cites that input; another claim's beside the figure,
    // though from the same Passage, doesn't (#1831).
    const covers = (cited: number, marker: number) => {
      const [shown, input] = [wordsOf(cited), wordsOf(marker)];
      return (
        cited === marker ||
        (!!shown &&
          !!input &&
          input.quote !== "" &&
          shown.passage === input.passage &&
          shown.quote.includes(input.quote))
      );
    };
    // An id written as text is a Citation (#1800), made one first: a figure beside it isn't cited twice.
    const citeFigures = (text: string): string =>
      withFigureCitations(
        session.citeWrittenIds(text, notKept),
        (figure, cited) =>
          figures.inputSources(figure).flatMap((source) => {
            const marker =
              typeof source === "number" ? source : recordedQuotes.get(quoteKey(source));
            if (marker === undefined || !session.tools.hasRecord?.(marker)) return [];
            return cited.some((each) => covers(each, marker)) ? [] : [marker];
          }),
        (figure) => figures.figure(figure),
      );
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
      // Turned into their Citations when the Answer ends (`finish`): till then none shows.
      const text = withAnalysisResults(
        withoutFootnoteDefinitions(final ? markdown : withoutWrittenIds(markdown, ids)),
        analyses,
        answerLanguage(context.question),
      );
      // Final: a marker with no record is removed, and each is counted for the summary.
      const citationOf = (marker: number) =>
        final ? session.finalCitation(marker) : session.streamingCitation(marker);
      try {
        return home.write(
          {
            markdown: text,
            blocks: () => {
              const blocks = withCitations(
                markdownToBlocks(text, { streaming: !final }),
                final
                  ? (marker) => session.finalNode(marker)
                  : (marker) => session.streamingNode(marker),
              );
              return asGenerated(
                calculating
                  ? withCalculatedFigures(blocks, (marker) => figures.figure(marker), {
                      id: answerId,
                      analyses,
                    })
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
            analyses,
            changedScale: () => scaleChangeIn(text),
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
        // What a call was given is kept with the conversation, where no id may be stored (#1800).
        call.input = Object.fromEntries(
          Object.entries(call.input).map(([key, value]) => [
            key,
            typeof value === "string" ? withoutWrittenIds(value, ids) : value,
          ]),
        );
      }
      markdown = session.citeWrittenIds(markdown, notKept);
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
      // A marker no Citation backs is not kept in the text, and each is counted for the summary.
      markdown = withoutDeadMarkers(markdown, (marker) => session.finalCitation(marker) !== null);
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
          analyses,
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
        | "passages"
        | "error"
        | "webPage"
        | "mindChange"
        | "mindProblem"
        | "found"
        | "command"
        | "commandProblem"
        | "asked"
        | "analysis"
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
      if (found.analysis) call.analysis = found.analysis;
      if (found.found) call.found = found.found;
      if (found.command) call.command = found.command;
      if (found.commandProblem) call.commandProblem = found.commandProblem;
      if (found.asked) call.asked = found.asked;
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
    /** What each call of `run_analysis` ran, by call, for its card when it finishes (#447). */
    const analysisCalls = new Map<string, AnalysisCall>();
    const commandsFound = new Map<string, CommandsFound>();
    const commandsDone = new Map<string, CommandDone>();
    const commandProblems = new Map<string, CommandProblem>();
    /** The questions `ask_user` asked, by call, as they stand: for its card while it waits, and once it ends. */
    const userQuestions = new Map<string, UserQuestion>();
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
    let commandsOffered: ReturnType<typeof commandTools> | null = null;

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
     * Commands are checked one at a time, each after the User answered the one before, so a call
     * that would take the Answer past its limit is counted after those before it.
     */
    /** A command's call says what it did once it no longer can through the engine: after its call. */
    const laterCall = (
      toolCallId: string,
      end: { done: CommandDone } | { problem: CommandProblem },
    ) => {
      const call = toolCalls.find((each) => each.id === toolCallId);
      if (!call) return;
      if ("done" in end) {
        call.status = "done";
        call.command = end.done;
        delete call.commandProblem;
        commandsDone.set(toolCallId, end.done);
      } else {
        call.status = "failed";
        delete call.command;
        call.commandProblem = end.problem;
        commandsDone.delete(toolCallId);
      }
      if (!finished) {
        announce("answer.toolCallFinished", { ...place, answerId, call: { ...call } });
        writeSoon();
        return;
      }
      options.conversations.writeToolCalls(answerId, toolCalls);
    };
    let commandTurn: Promise<unknown> = Promise.resolve();
    /**
     * What the Answer read that the User didn't write, by the kinds the card names (#2240). A web
     * page is never named by its title here: a page writes its own title, so an injected one could
     * pass for the User's file on this card; its host is the part it can't write. `titlesRead`: the
     * saved pages whose titles reached the Run, by id, named by their hosts as a read page is.
     */
    const readText = (
      thirdParty: readonly ThirdPartyReason[],
      titlesRead: readonly string[],
    ): { readText?: ApprovalReadText } => {
      const kinds = readKinds({
        reads: session.passagesRead(),
        transcripts,
        calls: toolCalls,
        reasons: thirdParty,
        titlesRead,
        webAddress: (documentId) => options.documents.webAddress(documentId),
      });
      const read =
        kinds.documents.length > 0 ||
        kinds.webPages.length > 0 ||
        kinds.webPageTitles.length > 0 ||
        kinds.webSearchResults ||
        kinds.connectors.length > 0 ||
        kinds.scriptOutput ||
        kinds.transcript ||
        kinds.otherText;
      return read ? { readText: kinds } : {};
    };
    // Whether it asks is the commands' policy's (../tools/commands/policy, #1110).
    const commandGate = (
      commands: ReturnType<typeof commandTools>,
      { id: toolCallId, input, tainted, thirdParty }: GatedCall,
    ): Promise<string | null> => {
      const card: AnswerToolCall = {
        id: toolCallId,
        tool: COMMAND_TOOLS.run,
        source: "commands",
        input,
        status: "running",
        resultCount: null,
      };
      callStarted(card);
      const gated = async (): Promise<string | null> => {
        const {
          checked,
          ask: asked,
          readTitles,
        } = await commands.check(toolCallId, input, tainted || transcripts.size > 0);
        if (!asked) return null;
        const denied = await ask(
          {
            ...place,
            answerId,
            toolCallId,
            subject: { kind: "command", command: checked.command },
            tool: COMMAND_TOOLS.run,
            ask: asked,
            effects: checked.effects,
            tainted: tainted || readTitles.length > 0,
            ...readReasons(thirdParty),
            ...readText(thirdParty, readTitles),
          },
          card,
        );
        if (denied === null) commands.allowed(toolCallId);
        else commands.drop(toolCallId);
        return denied;
      };
      const next = commandTurn.then(gated, gated);
      commandTurn = next.catch(() => undefined);
      return next;
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
      } else if (tool.name === COMMAND_TOOLS.run && commandsOffered) {
        denied = await commandGate(commandsOffered, call);
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

    let settleMinds = (_failed: boolean): void => undefined;
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
        "searching" | "writing" | "checking-quotes" | "checking-figures" | "checking-claims"
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
          help
            ? "off"
            : (input.thinking ?? (input.task ? "summary" : careful ? "careful" : "answer")),
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
      if (input.quoted && input.quoted.length > 0) {
        messages = withBeforeQuestion(
          messages,
          selectedTextBlock(
            input.quoted.map(({ quote, passages }) => ({
              ...quote,
              place: englishPlace(quote.location),
              shown: session.show(passages),
            })),
          ),
        );
        // Someone else wrote a saved web page: quoted, it is read as a search reads it (#78).
        if (
          input.quoted.some(({ passages }) => passages.some((each) => each.documentKind === "web"))
        ) {
          contextReasons.push({ via: "read", source: "web-page" });
          textOrigin ??= "web-page";
        }
      }
      if (input.listening) {
        try {
          heard = await input.listening();
        } catch (error) {
          options.reportError(error);
        }
        if (finished) return;
        const kept = newestWithin(heard?.passages ?? [], listenedTokens(prepared.window));
        if (heard) messages = withTranscript(messages, session.show(kept));
        if (help && heard?.behind) {
          textBehind = true;
          const text = options.liveTextBehind(kept.length > 0);
          if (kept.length === 0) {
            markdown = text;
            announce("answer.delta", { ...place, answerId, text });
            finish({ status: "done" });
            return;
          }
          markdown = `${text}\n\n`;
          announce("answer.delta", { ...place, answerId, text: markdown });
        }
        if (kept.length > 0) {
          for (const passage of kept) transcripts.add(passage.documentId);
          callDocuments?.push(...transcripts);
          if (help) callLanguage = languageSaid(kept);
        }
        if (help && helpDocuments !== null && kept.length > 0) {
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
      if (input.transcript) {
        const kept = newestWithin(
          input.transcript,
          prepared.window ? Math.floor(prepared.window.tokens / 2) : Number.MAX_SAFE_INTEGER,
        );
        if (kept.length > 0) {
          messages = withTranscript(messages, session.show(kept));
          for (const passage of kept) transcripts.add(passage.documentId);
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
          (heard === null || help !== undefined || asked.each || asked.main !== null) &&
          callDocuments === null &&
          options.documents.searchableCount(documentIds) <= SMALL_SCOPE_DOCUMENTS
            ? options.documents.searchableBySize(documentIds)
            : [];
        const given = givenUpFront(
          [original ? [original] : [], scope],
          upFrontTokens(prepared.window),
          passagesOf,
          (passages) => blockOf(passages, session.measure),
        );
        // A summary of each Document too long to give whole reads each one's skim (#894).
        const share = Math.floor(skimTokens(prepared.window) / Math.max(1, scope.length));
        const skims =
          !given && asked.each
            ? scope.flatMap((document) => skimWithin(passagesOf(document.id), share))
            : [];
        // Only Documents given whole count as sent: a skim is a part of each.
        sentDocuments = new Set(
          given?.passages.flatMap((passage) =>
            transcripts.has(passage.documentId) ? [] : [passage.documentId],
          ),
        );
        const shown = given?.passages ?? skims;
        if (shown.length > 0) {
          messages = withBeforeQuestion(
            messages,
            given
              ? blockOf(given.passages, session.show)
              : documentSkimBlock(
                  [...new Set(skims.map((passage) => passage.documentName))],
                  withPassageNotes(session.show(skims), unread),
                ),
          );
          // Someone else wrote a saved web page: given up front, it is read as a search reads it (#78).
          if (shown.some((passage) => passage.documentKind === "web")) {
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
      // The Question's language stays the Answer's while the Skill it follows names none; a help
      // button and a check have their own rules for it (#1273).
      const keepsQuestionsLanguage = !help && input.toolSet !== "check";
      let skillNamesNoLanguage = false;
      const followed = <T extends { instructions: string }>(skill: T): T => {
        skillNamesNoLanguage = !skillSetsLanguage(skill.instructions);
        return skill;
      };
      if (forced) followed(forced);
      let readable: { ids: string[] | null } | undefined;
      const turn = {
        readable: (documentId: string) => {
          readable ??= { ids: readableAcrossWalls(mindIn ?? place.mindId, turnWall) };
          return readable.ids === null || readable.ids.includes(documentId);
        },
      };
      for (const provider of outside ? [] : options.toolProviders) {
        // Find sources' Tool only for a Question that asks for papers or other sources.
        if (provider.kind === "sources" && !asksForSources(context.question)) continue;
        try {
          provided.push(...(await provider.tools(controller.signal, turn)));
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
              save: (address, signal) => web.save(address, place, signal, turnWall),
              passages: (documentId, query, signal) =>
                session.searchDocument(documentId, query, signal),
              read: (toolCallId, call) => webPages.set(toolCallId, call),
              notFiled: (reason) => {
                wallRefusals.add(
                  reason === "walled" ? "folder.wall.pageNotFiled" : "folder.wall.pageNotFiledGone",
                );
              },
            })
          : [];
      const questions = outside ? undefined : options.questions;
      const asksUser =
        questions && input.assistant
          ? {
              ask: (toolCallId: string, question: UserQuestion, signal: AbortSignal) =>
                questions.ask({ ...place, answerId, toolCallId, question }, signal),
              started: (toolCallId: string) => {
                if (finished || toolCalls.some((each) => each.id === toolCallId)) return;
                // The question reaches the User before the Run's card of its call can: the
                // Answer keeps it, so it is still there when the Answer stops at the question.
                callStarted({
                  id: toolCallId,
                  tool: ASK_TOOLS.ask,
                  source: "asks",
                  input: {},
                  status: "running",
                  resultCount: null,
                });
              },
              recorded: (toolCallId: string, question: UserQuestion) => {
                userQuestions.set(toolCallId, question);
                const call = toolCalls.find((each) => each.id === toolCallId);
                if (finished || !call) return;
                call.asked = question;
                writeSoon();
              },
            }
          : null;
      // The question and the User's answer stay in the thread on the call that asked.
      const askInTray =
        asksUser &&
        (async (toolCallId: string, question: UserQuestion, signal: AbortSignal) => {
          asksUser.recorded(toolCallId, question);
          const answer = await asksUser.ask(toolCallId, question, signal);
          asksUser.recorded(toolCallId, { ...question, answer });
          return answer;
        });
      // The Minds' Tools, for an Answer in the assistant (#202). A calculated figure it writes
      // into a Note brings the Analysis run it was worked out by, as Add to note does (#439):
      // this Answer's, or the last Answer's that `answer: true` writes.
      const given = outside ? undefined : options.minds;
      const answersWithRuns = [
        { id: answerId, analyses },
        ...(input.assistant?.lastAnswer ? [input.assistant.lastAnswer.answer] : []),
      ];
      const focusedId = input.assistant?.focused?.mindId ?? null;
      const wallId = turnWall;
      const allMinds = given;
      const minds: MindsForTools | undefined = given && {
        ...given,
        list: () =>
          given
            .list()
            .filter((mind) =>
              wallId ? mind.folderId === wallId : options.walledFolder(mind.id) === null,
            ),
        edit: (mindId, change) =>
          given.edit(mindId, (blocks) => {
            const result = change(blocks);
            if (blocks.doc) {
              const nodes = topLevelBlocks(blocks).map(nodeOf);
              const runs = answersWithRuns.flatMap((each) => figureRunsOfAnswer(each, nodes));
              if (runs.length > 0) installFigureRuns(blocks.doc, runs);
            }
            return result;
          }),
      };
      // A new piece fills the empty Mind the User is in rather than making another (#1109).
      const focusedEmpty =
        minds !== undefined && focusedId !== null && minds.read(focusedId, holdsNothing);
      let documentNames: string[] | undefined;
      let rewriting: Promise<PreparedChatModel> | undefined;
      const mindsTools =
        minds && input.assistant
          ? mindTools({
              minds,
              ids,
              prepared,
              rewriting: () => {
                rewriting ??= options.prepareModel(model, "off").catch((error: unknown) => {
                  console.warn(
                    `edit_mind's rewrite couldn't be asked of ${prepared.provider.kind}/${prepared.modelId} without thinking, so it thinks:`,
                    error,
                  );
                  return prepared;
                });
                return rewriting;
              },
              paragraph: paragraphAsked(context.question),
              ...input.assistant,
              ...(askInTray && { ask: askInTray }),
              language: answerLanguage(context.question),
              filing,
              notFiled: () => {
                wallRefusals.add("folder.wall.notFiled");
              },
              ...(wallId && {
                wallMessage: translate(options.interfaceLanguage(), "folder.wall.refusal"),
                wallRefused: () => {
                  wallRefusals.add("folder.wall.refusal");
                },
                outsideMind: (name) =>
                  (allMinds?.list() ?? []).some(
                    (mind) =>
                      mind.folderId !== wallId &&
                      (mind.id === name ||
                        mind.name.toLocaleLowerCase() === name.toLocaleLowerCase()),
                  ),
              }),
              searchedPassages: () =>
                toolCalls.some(
                  (call) =>
                    call.status === "done" &&
                    ((call.tool === DOCUMENT_TOOLS.search && (call.resultCount ?? 0) > 0) ||
                      (call.webPage !== undefined && "documentId" in call.webPage)),
                ),
              figure: (marker) => (calculating ? figures.figure(marker) : null),
              blocksOf: (text) => {
                let found = 0;
                let notFound = 0;
                let unrecorded = 0;
                let firstUnrecorded = -1;
                const written = withoutSearchTalk(
                  session.citeWrittenIds(withoutFootnoteDefinitions(text), notKept),
                );
                const markdown = calculating ? citeFigures(written.markdown) : written.markdown;
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
                const asText = sourcesAsText(markdown, known);
                const sourced = linkKnownSources(markdown, known, link);
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
                    ? withCalculatedFigures(cited, (marker) => figures.figure(marker), {
                        id: answerId,
                        analyses,
                      })
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
      if (mindsTools) settleMinds = (failed) => mindsTools.settle(failed);
      const commands = outside ? undefined : options.commands;
      commandsOffered =
        commands && input.assistant
          ? commandTools({
              host: commands.host,
              findable: (mindId, wall) => commands.findable(mindId, wall),
              focusedMindId: focusedId,
              wallId,
              filing,
              titledPages: options.documents.searchableNames(documentIds, LISTED_DOCUMENTS)
                .webPages,
              renames: input.assistant.renames,
              answerId,
              runId: randomUUID(),
              offered: input.assistant.commands?.offered ?? [],
              clientId: input.assistant.commands?.clientId ?? null,
              language: answerLanguage(context.question),
              steps: commands.steps,
              ...(askInTray && { ask: askInTray }),
              found: (toolCallId, found) => commandsFound.set(toolCallId, found),
              ran: (toolCallId, done) => {
                commandsDone.set(toolCallId, done);
                // Stopped while its window's command started, the call returns after the Answer.
                if (finished) laterCall(toolCallId, { done });
              },
              failed: (toolCallId, problem) => commandProblems.set(toolCallId, problem),
              // A window's command that went on, a Check for one, ends after its call: its card
              // says so then, while the Answer is written or after it.
              ended: laterCall,
              signal: controller.signal,
            })
          : null;
      const asking = asksUser ? askTool(asksUser) : null;
      const documents: AnswerTools = {
        get documentCount() {
          return session.tools.documentCount;
        },
        // So the model can search again in the Documents' language (see the search Tool).
        documentLanguages: options.documents.searchableLanguages(documentIds),
        unreadDocuments: () => options.documents.unread(documentIds),
        readingDocuments: () => options.documents.reading(documentIds),
        searchDocuments: (query, signal, searchOptions) =>
          session.tools.searchDocuments(query, signal, searchOptions),
        readDocument: (request) =>
          session.tools.readDocument?.(request) ??
          Promise.resolve({
            text: "Document reads are unavailable for this Answer.",
            passageCount: 0,
          }),
        cite: (records, citeOptions) =>
          calculating
            ? citeRecords(records, citeOptions)
            : session.tools.cite(records, citeOptions),
        hasRecord: (marker) => session.tools.hasRecord?.(marker) ?? false,
        owed: (text) =>
          session.tools.owed?.(
            text,
            calculating ? (marker) => figures.figure(marker) !== null : undefined,
          ) ?? { citations: [], figures: [] },
        unfoundQuotes: () => session.tools.unfoundQuotes?.() ?? [],
        correctQuote: (marker, quote) => session.tools.correctQuote?.(marker, quote) ?? false,
        shownPassages: () => session.tools.shownPassages?.() ?? [],
        quoteFound: (passage, quote) => session.tools.quoteFound?.(passage, quote) ?? false,
        wroteIntoMind: () =>
          [...mindChanges.values()].some((change) => change.proposals > 0 || change.revised),
        ...(calculating && {
          calculate: calculateFigures,
          figureProblems: () => figures.problems(),
          citeFigures,
        }),
      };
      const runtime = outside ? undefined : options.analysisRuntime;
      const fromAnalysis: Tool[] =
        runtime?.languages.some((each) => each.language === "python") &&
        calculating &&
        input.toolSet === undefined &&
        !help &&
        (input.analyse === true || options.documents.searchableHasSheets(documentIds))
          ? [
              analysisTool({
                runtime,
                passage: (id) => {
                  const named = id.trim().toLowerCase();
                  const shown = session
                    .shownPassages()
                    .find((each) => each.id.toLowerCase() === named);
                  const source = shown ? searched.citationSource(shown.passageId) : null;
                  if (!source || source.documentDeleted) return null;
                  return {
                    source,
                    units: searched.pageTexts(source.documentId, source.contentHash, null, null),
                  };
                },
                number: (given) => figures.number(given),
                figure: (figure) => figures.record(figure),
                language: answerLanguage(context.question),
                now: () => new Date(),
                ran: (toolCallId, analysis) => {
                  analyses.push(analysis);
                  analysisCalls.set(toolCallId, {
                    number: analysis.number,
                    title: analysis.title,
                    documents: [
                      ...new Set(
                        analysis.inputs.map((each) =>
                          each.kind === "range"
                            ? each.citation.documentName
                            : each.input.citation.documentName,
                        ),
                      ),
                    ],
                    end: analysis.end.kind,
                    ...(analysis.end.kind === "unavailable" && { reason: analysis.end.reason }),
                    ...(analysis.end.kind === "timed-out" && { limitMs: analysis.end.limitMs }),
                  });
                  writeSoon();
                },
              }),
            ]
          : [];
      // Scripts can run when a Skill has some, unless the User turned them off.
      const scripts = !outside && opened.hasScripts && options.scripts.enabled();
      const fromSkills: Tool[] =
        listed.length > 0 || (forced && forced.files.length > 1)
          ? skillTools({
              loadable: listed.length > 0,
              useSkill: async (name) =>
                loadedSkillText(followed(await opened.load(name)), { withFiles: true, scripts }),
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
      const missingMindNames = () => [
        ...new Set(
          [...mindProblems.values()].flatMap((problem) =>
            problem.kind === "not-found" && problem.name !== "" ? [problem.name] : [],
          ),
        ),
      ];
      const endedAfterRefusal = () => !changedAMind() && missingMindNames().length > 0;
      /** What the turn asked for that is the User's alone, each once (#2252). */
      const refusedCommands = () => [
        ...new Map(
          [...commandsDone.values()].flatMap(({ yours, folder }) =>
            yours ? [[`${yours} ${folder?.id ?? ""}`, { yours, folder }] as const] : [],
          ),
        ).values(),
      ];
      const heldBack = holdBack(() => mindsListed().map((mind) => mind.name));
      // Asked again inside the turn, the model reads what applied as applied: the window may not
      // have taken it in yet, and told it waits, the model tells the User so.
      const appliedInTurn: ChangeStates = (change) =>
        minds?.read(change.mindId, (blocks) => {
          const doc = blocks.doc;
          return doc !== null && appliedAsAsked(doc, change, toolCalls)
            ? { waiting: 0, accepted: 0, rejected: 0, applied: true }
            : null;
        }) ?? null;
      const claimedTools: TurnCheck = {
        name: "claimed-tool",
        check: (text) => {
          const tools = unrunToolClaims(text, toolCalls, input.assistant?.earlierCalls ?? []);
          return tools.length > 0
            ? {
                claims: [],
                tools,
                note: unrunToolsNote(
                  tools,
                  toolCalls,
                  options.readableMindName,
                  calculating,
                  appliedInTurn,
                ),
              }
            : null;
        },
      };
      // An Answer the User reads holds its claims of Tools to its calls; a check's, a cell's or a
      // call's help is read by its own flow, which offers no calculate to call.
      const readByUser = !outside && !help && !input.task && input.toolSet !== "check";
      const turnChecks: TurnCheck[] = [
        ...(mindsTools
          ? [
              {
                name: "claimed-change",
                check: async (text: string) => {
                  if (text.trim() === "") return null;
                  activity = "checking-claims";
                  showPhase();
                  try {
                    let judgeModel = prepared.model;
                    if (prepareQuick) {
                      try {
                        judgeModel = await prepareQuick(model, prepared);
                      } catch (error) {
                        console.error(
                          `The quick-tasks model couldn't be used for the change-claim check: ${messageOf(error)}`,
                        );
                      }
                    }
                    mindsNow = null;
                    const checked = await inStep("change-claim-check", () =>
                      claimsNoCallMade(text, toolCalls, mindsListed(), focusedId, {
                        model: judgeModel,
                        names: options.readableMindName,
                        states: appliedInTurn,
                        signal: controller.signal,
                      }),
                    );
                    if (checked.usage) {
                      usage.inputTokens += checked.usage.inputTokens ?? 0;
                      usage.outputTokens += checked.usage.outputTokens ?? 0;
                      usage.cachedInputTokens += checked.usage.cachedInputTokens ?? 0;
                      usage.cacheWriteTokens += checked.usage.cacheWriteTokens ?? 0;
                    }
                    return checked.claims.length > 0
                      ? {
                          claims: checked.claims,
                          note: askAgainNote(
                            checked.claims,
                            toolCalls,
                            options.readableMindName,
                            appliedInTurn,
                          ),
                        }
                      : null;
                  } finally {
                    activity = "writing";
                    showPhase();
                  }
                },
              },
            ]
          : []),
        {
          name: "refused-no-reply",
          check: (text) => {
            if (text.trim() !== "") return null;
            const missing = endedAfterRefusal() ? missingMindNames() : [];
            const refused = refusedCommands().length > 0;
            if (missing.length === 0 && !refused) return null;
            const named =
              missing.length === 1
                ? `there is no note called “${missing[0]}”`
                : `there are no notes called ${missing.map((name) => `“${name}”`).join(", ")}`;
            const notThere =
              missing.length > 0 ? `that ${named}, and that the change wasn't made` : "";
            return {
              claims: [],
              writeOnly: true,
              note: refused
                ? `Your reply is empty. Say in the User's language ${notThere ? `${notThere}; ` : ""}that what run_command said is the User's to do wasn't done, and where they do it; then what the other calls did.`
                : `Your reply is empty. Say in the User's language ${notThere}. Don't say that you changed anything.`,
            };
          },
        },
        {
          name: "claimed-fixes",
          check: (text) => {
            const unmade = minds
              ? unmadeFixesIn(
                  text,
                  toolCalls,
                  minds,
                  mindsListed().map((mind) => mind.name),
                )
              : null;
            return unmade
              ? {
                  claims: ["changed"],
                  note: unmadeFixesNote(unmade, toolCalls, options.readableMindName, appliedInTurn),
                }
              : null;
          },
        },
        {
          name: "unrecorded-markers",
          check: (text) => {
            if (ids.size() === 0) return null;
            const unrecorded = [...new Set(markersIn(text))].filter(
              (marker) => !session.tools.hasRecord?.(marker),
            );
            return unrecorded.length > 0
              ? { claims: [], note: unrecordedMarkersNote(unrecorded) }
              : null;
          },
        },
        ...(readByUser ? [claimedTools] : []),
      ];
      // The search made first takes the User's words as the query before the model has read them,
      // which is right only for a Question about the Documents. So it is made only on a turn that is
      // one by construction, offered no Tool that writes a Mind (a Question asked in a Mind, or an
      // outside agent's), in a flow the list admits the model to. A request in the assistant may be
      // a write, a follow-up or anything else, and keeps the loop. Call help already searches
      // first; a check or a Task's Run keeps its loop.
      const writesMinds = mindsTools?.tools.some((tool) => tool.name !== MIND_TOOLS.read) ?? false;
      const retrieveFirst =
        !help &&
        !input.task &&
        (input.toolSet ?? "answer") === "answer" &&
        !writesMinds &&
        (options.retrievesFirst?.(prepared, flow) ?? false);
      // Its one call writes the Answer and then cites it (#1633 on #489's contract).
      const writeFirst = retrieveFirst || (options.writesThenCites?.(prepared, flow) ?? false);
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
            analysisTools: withAnalysisTools = false,
            commandTools: withCommandTools = false,
          } = {},
        ) =>
          [
            base,
            mode === "no-documents"
              ? [
                  scoped && input.emptyScope
                    ? EMPTY_SCOPE_NOTE
                    : noDocumentsNote(input.emptyScope, library?.total ?? 0),
                  ...(withMindTools ? [MINDS_ARE_NOT_DOCUMENTS] : []),
                ].join(" ")
              : documentInstructions(
                  mode,
                  options.documents.searchableNames(documentIds, LISTED_DOCUMENTS),
                  passages,
                  scoped,
                  calculating,
                  withMindTools || ids.size() > 0,
                  { writeFirst, minds: withMindTools, library },
                ),
            stillReadingNote(options.documents.reading(documentIds)),
            coverageInstructions(
              coverage,
              asked.each,
              options.documents.searchableBySize(input.documentIds),
            ),
            skillInstructions(listed, forced, withSkillTools, scripts),
            connectorTools ? connectorInstructions(fromConnectors, mode === "no-documents") : "",
            sourcesInstructions(sourceTools),
            webInstructions(withWebTools),
            workingCopyNote(original?.name ?? null),
            exampleNote(exampleNames),
            mindInstructions(withMindTools, {
              inAssistant: mindsTools !== null && !help,
              lastAnswer: input.assistant?.lastAnswer != null,
            }),
            commandInstructions(withCommandTools),
            input.assistant && !help ? THIS_DOCUMENT_RULE : "",
            emptyMindNote(withMindTools, focusedEmpty),
            analysisInstructions(withAnalysisTools),
            meetingInstructions(heard !== null),
            signInNeededInstructions(signInNeeded.map((connector) => connector.name)),
            help ? "" : language,
          ]
            .filter(Boolean)
            .join("\n\n"),
        // Button instructions stay with the Question so presses with the same Search scope share
        // the provider's cache (#1634).
        messages: help
          ? withHelp(
              messages,
              [
                meetingHelpInstructions(help, {
                  found: foundAhead,
                  language: options.interfaceLanguage(),
                  callLanguage,
                }),
                ...(textBehind ? [LIVE_TEXT_BEHIND_NOTE] : []),
              ].join("\n\n"),
            )
          : messages,
        ...(mindRequest && { mind: mindRequest }),
        question: context.question,
        ...(input.mindsLine && { mindsLine: input.mindsLine }),
        model: prepared.model,
        ...(prepareQuick && { quickModel: () => prepareQuick(model, prepared) }),
        documents,
        tools: [
          ...provided,
          ...fromSkills,
          ...fromWeb,
          ...(mindsTools?.tools ?? []),
          ...fromAnalysis,
          ...(commandsOffered?.tools ?? []),
          ...(asking ? [asking] : []),
        ],
        gate,
        streamsInput,
        toolSet: input.toolSet ?? (help ? "documents" : undefined),
        ...(input.outputKind && { outputKind: input.outputKind }),
        ...(keepsQuestionsLanguage && {
          languageNote: () => (skillNamesNoLanguage ? skillLanguageNote(language) : null),
        }),
        thirdParty: contextReasons,
        support: startingSupport(prepared.support, supportByModel.get(learntKey)),
        writeThenCite: writeFirst,
        retrieveFirst,
        structuredOutput: givesStructuredOutput(prepared.capabilities),
        takesTemperature: prepared.capabilities.facts.temperature,
        window: prepared.window,
        ...(prepared.capabilities.facts.maxOutput !== undefined && {
          maxOutput: prepared.capabilities.facts.maxOutput,
        }),
        ...(prepared.capabilities.facts.toolsEveryRequest && { toolsEveryRequest: true }),
        ...(prepared.provider.kind === "openrouter" && {
          forcedToolChoice: prepared.capabilities.facts.forcedToolChoice,
        }),
        retryQuotes: prepared.retryQuotes,
        cacheKey: place.conversationId ?? place.mindId ?? undefined,
        ...(input.assistant
          ? {
              turnChecks,
              shownUpTo: heldBack,
              // A command that only acted on the window, or that is the User's alone, ends the
              // turn: its card is the reply (#1421).
              mayEndBlank: () =>
                changedAMind() ||
                [...commandsDone.values()].some((done) => done.window !== undefined || done.yours),
              blankReply: () => {
                const language = answerLanguage(context.question);
                const missing = endedAfterRefusal() ? missingMindNames() : [];
                const [only] = missing;
                const quoted = missing.map((name) => `“${name}”`);
                const lines = [
                  ...(missing.length === 1 && only !== undefined
                    ? [translate(language, "answer.refused.noSuchMind", { name: only })]
                    : missing.length > 1
                      ? [
                          translate(language, "answer.refused.noSuchMind.many", {
                            names:
                              language === "zh-CN"
                                ? quoted.join("、")
                                : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1) ?? ""}`,
                          }),
                        ]
                      : []),
                  ...refusedCommands().map(({ yours, folder }) =>
                    yoursLine(language, yours, folder),
                  ),
                ];
                return lines.length === 0 ? null : lines.join(language === "zh-CN" ? "" : " ");
              },
            }
          : input.checkScales
            ? {
                turnChecks: [
                  {
                    name: "changed-scale",
                    check: (text: string) => {
                      const found = scaleChangeIn(text);
                      return found
                        ? { note: changedScaleNote(found, calculating), claims: [] }
                        : null;
                    },
                  },
                ],
              }
            : readByUser && { turnChecks: [claimedTools] }),
        // Every Answer, in the assistant or a Note, says why work of its stayed out of a Folder,
        // worded by the wall as it is now: a wall lifted meanwhile is no wall (#2250).
        refusalSuffix: () => {
          if (wallRefusals.size === 0) return null;
          const lifted = turnWall !== null && options.walledFolderId(turnWall) === null;
          return [...wallRefusals]
            .map((key) => (key === "folder.wall.refusal" && lifted ? "folder.wall.changed" : key))
            .map((key) => translate(answerLanguage(context.question), key))
            .join(" ");
        },
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
          case "documents-dropped":
            sentDocuments?.clear();
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
            unrunTools = event.tools ?? [];
            writeSoon();
            break;
          case "asked-again":
            askedAgainFor = event.tools;
            writeSoon();
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
            const analysis = analysisCalls.get(event.id);
            const found = commandsFound.get(event.id);
            const command = commandsDone.get(event.id);
            const commandProblem = commandProblems.get(event.id);
            const question = userQuestions.get(event.id);
            callFinished(event.id, event.ok, event.resultCount, {
              ...(analysis && { analysis }),
              ...(event.passages && { passages: [...event.passages] }),
              ...(event.error && { error: event.error }),
              ...(webPage && { webPage }),
              ...(mindChange && { mindChange }),
              ...(mindProblem && { mindProblem }),
              ...(found && { found }),
              ...(command && { command }),
              ...(commandProblem && { commandProblem }),
              ...(question && { asked: question }),
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
      settleMinds(outcome.status === "failed");
      finish(outcome);
    };
    inFlow(flow, run).catch((error: unknown) => {
      options.reportError(error);
      settleMinds(true);
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
        const nodes = answer.blocks();
        if (blocks.doc)
          installFigureRuns(
            blocks.doc,
            figureRunsOfAnswer({ id: answerId, analyses: answer.analyses }, nodes),
          );
        syncContent(element, nodes);
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
        const nodes = answer.blocks();
        if (blocks.doc)
          installFigureRuns(
            blocks.doc,
            figureRunsOfAnswer({ id: answerId, analyses: answer.analyses }, nodes),
          );
        const written = proposeBlocks(element, nodes, request, randomUUID);
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
        analyses: answer.analyses,
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
    model: ChatModelChoice | null = null,
  ): MindToRead | null {
    if (mindId === null) return null;
    const name = options.readableMindName(mindId);
    if (name === null) return null;
    const documents = options.documents.names();
    const ids = contextCitationsFor(mindId);
    const readsPictures = model === null || options.readsImages?.(model) !== false;
    const reading = content.peek(mindId, (blocks) =>
      readMind(blocks, name, focus, documents, ids, readsPictures),
    );
    return { mindId, reading, ids, section: reading.section(MIND_TOKEN_LIMIT, question) };
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
      waiting: waitingChanges(blocks, (each) => each.request === change.request),
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
    onScreen: readonly string[],
    { quoted, leftOut }: { quoted: Quoted[]; leftOut: AskedQuote[] },
    commands: CommandWindow | null,
    remake: string | null = null,
  ): ConversationAskResult {
    const { conversation, question, answer } = turn;
    const help = mind ? (options.meetingHelp?.(mind.mindId, question.text) ?? null) : null;
    const callOnly = help !== null && HELP_DOCUMENTS[help] === null;
    // A live call's earlier replies are labeled: the model decides whether the Question is a recap (#1319).
    const replyLabel =
      mind !== null && help === null && (options.liveMeeting?.(mind.mindId) ?? false)
        ? earlierReplyLabel(options.interfaceLanguage())
        : undefined;
    // Each press of a help button stands alone: an earlier suggestion would only steer this one.
    const wallId = mind ? options.walledFolder(mind.mindId) : wallOfTurn(turn.question);
    // Earlier turns are judged by the wall alone: one outside this turn's Search scope still counts.
    const readable = readableAcrossWalls(mind?.mindId ?? null, wallId);
    const permitted = readable === null ? null : new Set(readable);
    let walled: Set<string> | undefined;
    const otherSide = (documentId: string) => {
      if (wallId !== null) return permitted?.has(documentId) === false;
      walled ??= new Set(options.walledDocuments());
      return walled.has(documentId);
    };
    const otherFolder = (folderId: string) =>
      wallId === null ? options.walledFolderId(folderId) !== null : folderId !== wallId;
    let turnWall: string | null = null;
    const outsideTurns = new Set<string>();
    const withWalls = turn.earlier.map((message) => {
      if (message.kind === "question") {
        turnWall = wallOfTurn(message);
        if (
          message.scope?.folderIds.some(otherFolder) ||
          message.scope?.documentIds.some(otherSide) ||
          message.quotes.some((quote) => otherSide(quote.documentId))
        ) {
          outsideTurns.add(message.id);
        }
      } else if (message.citations.some((citation) => otherSide(citation.documentId))) {
        outsideTurns.add(message.questionId);
      }
      return { message, wall: turnWall };
    });
    const earlier = help
      ? []
      : withWalls
          .filter(
            ({ message, wall }) =>
              wall !== UNKNOWN_WALL &&
              wall === wallId &&
              !outsideTurns.has(message.kind === "question" ? message.id : message.questionId),
          )
          .map((each) => each.message);
    // A long Mind is cut to what the conversation's Questions are about, the earlier ones too: a
    // follow-up keeps the part the first one found, and so the same start for the prompt cache.
    const asking = [
      ...earlier.flatMap((message) => (message.kind === "question" ? [message.text] : [])),
      question.text,
    ].join("\n");
    const section = callOnly
      ? undefined
      : mind && earlier.length > 0
        ? mind.reading.section(MIND_TOKEN_LIMIT, asking)
        : mind?.section;
    const documents = options.documents.names();
    const contextDocuments = documents.filter((document) => !otherSide(document.id));
    const shown = callOnly ? [] : namesOnScreen(onScreen, documentIds);
    const ids = (callOnly ? null : mind?.ids) ?? contextCitationsFor(mind?.mindId ?? null, wallId);
    const named = help ? [] : namedMinds(mind?.mindId ?? null, wallId);
    const { context, origins } = conversationContextOf(earlier, question.text, {
      mind: section,
      documents: contextDocuments,
      mindNames: options.readableMindName,
      changeStates: changeStatesOf,
      onScreen: shown,
      ids,
      ...(replyLabel && { earlierReplyLabel: replyLabel }),
    });
    const requestOf = (reading: MindReading, kept: MindCut): RequestMind => ({
      text: kept.text,
      selection: kept.selection,
      ...(kept.pictures?.length && { pictures: kept.pictures }),
      cut: (tokens) => reading.section(tokens, asking),
    });
    start({
      ...(named.length > 0 && {
        mindsLine: {
          line: mindsLine(named),
          asked: askedText(shown, section?.selection ?? "", question.text),
        },
      }),
      home: conversationHome(conversation.id, answer.id),
      answerId: answer.id,
      questionId: question.id,
      model: ready.model,
      context,
      ids,
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
                  documents: contextDocuments,
                  mindNames: options.readableMindName,
                  changeStates: changeStatesOf,
                  onScreen: shown,
                  ids,
                  ...(replyLabel && { earlierReplyLabel: replyLabel }),
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
      analyse: question.analyse,
      consentNeeded: ready.consentNeeded,
      ...(mind && { listening: () => options.liveTranscript(mind.mindId) }),
      ...(help && { help }),
      quoted: callOnly ? [] : quoted,
      assistant: {
        focused: mind && {
          mindId: mind.mindId,
          // Where the cursor is counts only as a selection when text is selected.
          blockIds: question.focus?.selection ? question.focus.blockIds : [],
        },
        folderId: filedIn(question.scope, question.askedFrom),
        origin: { from: messageReference(conversation.id, answer.id), question: question.text },
        wallId,
        lastAnswer: lastAnswerOf(conversation.id, earlier, filedIn, options.interfaceLanguage()),
        remake,
        renames: renamesIn(earlier),
        commands,
        touched: touchedIn(earlier),
        earlierCalls: earlier.flatMap((message) =>
          message.kind === "answer" ? message.toolCalls : [],
        ),
      },
    });
    return {
      asked: true,
      conversation,
      questionId: question.id,
      answerId: answer.id,
      ...(leftOut.length > 0 && { leftOut }),
    };
  }

  // Only the Document's own name and words are kept and sent: what the caller gave is only looked for.
  function checkQuotes(
    quotes: readonly AskedQuote[],
    mindId: string | null,
    wallId?: string | null,
  ): { quoted: Quoted[]; leftOut: AskedQuote[] } {
    const quoted: Quoted[] = [];
    const leftOut: AskedQuote[] = [];
    const allowed = readableAcrossWalls(mindId, wallId);
    const documents = options.documents.names();
    for (const asked of quotes) {
      if (allowed !== null && !allowed.includes(asked.documentId)) {
        leftOut.push(asked);
        continue;
      }
      const now = options.documents.recheckWhereSelected(asked);
      const name = shownDocumentName({ documentId: asked.documentId }, documents);
      const passages =
        now.check === "found" && name !== null
          ? withoutOverlap(
              options.documents
                .passagesBetween(asked.documentId, 0, Number.MAX_SAFE_INTEGER)
                .filter(
                  (passage) =>
                    passage.contentHash === now.contentHash && holdsUnitsOf(passage, now),
                ),
            )
          : [];
      if (name === null || passages.length === 0) {
        leftOut.push(asked);
        continue;
      }
      const quote: AskedQuote = {
        documentId: asked.documentId,
        documentName: name,
        quote: now.quote,
        pageFrom: now.pageFrom,
        pageTo: now.pageTo,
        location: now.location,
      };
      const same = (each: Quoted) =>
        each.quote.documentId === quote.documentId &&
        each.quote.quote === quote.quote &&
        JSON.stringify(each.quote.location) === JSON.stringify(quote.location);
      if (!quoted.some(same)) quoted.push({ quote, passages });
    }
    return { quoted, leftOut };
  }

  // Peeked, so Minds not open aren't loaded; and only so many, so a big Library doesn't slow a Question.
  const namedMinds = (
    mindId: string | null,
    conversationWall?: string | null,
  ): { name: string; fromAnswer: boolean }[] => {
    const wallId = conversationWall ?? options.walledFolder(mindId);
    const names: { name: string; fromAnswer: boolean }[] = [];
    for (const mind of options.minds?.list() ?? []) {
      if (wallId ? mind.folderId !== wallId : options.walledFolder(mind.id) !== null) continue;
      if (names.length >= LISTED_MINDS) break;
      if (names.some((each) => each.name === mind.name)) continue;
      names.push({ name: mind.name, fromAnswer: options.content.peek(mind.id, madeByAnswer) });
    }
    return names;
  };

  // One outside the Search scope can't be searched: naming it would point the model at nothing.
  const namesOnScreen = (onScreen: readonly string[], documentIds: readonly string[] | null) =>
    onScreen.flatMap((id) =>
      documentIds === null || documentIds.includes(id)
        ? options.documents.searchableNames([id], 1).names
        : [],
    );

  const filedIn = (scope: SearchScope | null, askedFrom: AskedFrom | null) =>
    filingFolder(
      scope,
      askedFrom && !askedFrom.deleted ? options.mindFolder(askedFrom.mindId) : null,
    );

  const someOfTheDocuments = (documentIds: string[] | null, mindId: string | null) => {
    if (documentIds === null) return null;
    const total = options.documents.searchableCount(options.unscopedDocuments?.(mindId) ?? null);
    const documents = options.documents.searchableCount(documentIds);
    return documents > 0 && documents < total ? { documents, total } : null;
  };

  /** The Documents of a Search scope as it is now, and whether it covers none to search. */
  const scopeNow = (scope: SearchScope | null, mindId: string | null, wallId?: string | null) => {
    let documentIds: string[] | null;
    if (wallId === UNKNOWN_WALL) documentIds = [];
    else if (wallId) documentIds = options.resolveScope(folderScope(wallId));
    else {
      const resolved = options.resolveScope(scope ?? NO_SCOPE, mindId);
      const unscoped =
        scope && hasSearchScope(scope) ? null : (options.unscopedDocuments?.(mindId) ?? null);
      documentIds =
        resolved === null
          ? unscoped
          : unscoped === null
            ? resolved
            : resolved.filter((id) => unscoped.includes(id));
    }
    const emptyScope = documentIds !== null && options.documents.searchableCount(documentIds) === 0;
    return { documentIds, emptyScope };
  };

  /**
   * What an Answer to `question` is written from: its context, and its Search
   * scope as it is now, resolved to the Documents it covers now. With no
   * scope it follows the one rule (#1942): the examples until the User has a
   * Document of their own, theirs alone from then on; an example's own Note
   * searches every Document.
   */
  const askedWith = (context: QuestionContext, question: Y.XmlElement, mindId: string) => {
    const chosen = searchScopeOf(question.getAttributes());
    const { documentIds, emptyScope } = scopeNow(chosen, mindId);
    return { context, documentIds, emptyScope, scoped: hasSearchScope(chosen) };
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
    const ids = contextCitationsFor(mindId);
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
          ids,
        );
        const asked = {
          ...askedWith(context, question.element, mindId),
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
      ids,
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
        if (!found) throw new NotFoundError("That Answer isn't in this Note.");
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
     * Asks a Question in a conversation (see `CoreApi.askInConversation`). Its turn is
     * committed before model readiness is awaited, so a quit can't lose it. A turn whose
     * model or Skill can't be asked is discarded without being published.
     */
    async askInConversation(question: QuestionInput): Promise<ConversationAskResult> {
      const scope = options.searchedScope(question.scope, question.mind?.id ?? null);
      const answerModel =
        question.model && options.providerExists(question.model.providerId)
          ? question.model
          : options.defaultModel();
      const mind = mindToRead(
        question.mind?.id ?? null,
        question.focus,
        question.text,
        answerModel,
      );
      const quotes = checkQuotes(question.quotes, question.mind?.id ?? null);
      const added = options.conversations.add(
        { ...question, scope, quotes: quotes.quoted.map((each) => each.quote) },
        answerModel,
        readOf(mind),
        false,
        (folderId) => {
          if (mind) return options.mindFolder(mind.mindId) ?? "";
          if (scope === null) return folderId ?? "";
          return scope.folderIds.length === 1 &&
            scope.tagIds.length === 0 &&
            scope.documentIds.length === 0
            ? (scope.folderIds[0] ?? "")
            : "";
        },
      );
      const { turn } = added;
      let published = false;
      try {
        const ready = await readyModel(question.model, question.forcedSkill);
        if ("asked" in ready) {
          options.conversations.discard(added);
          return ready;
        }
        const readyMind = mindToRead(
          question.mind?.id ?? null,
          question.focus,
          question.text,
          ready.model,
        );
        // The Documents can change while readiness waits: search and quote them as they are now.
        const { documentIds, emptyScope } = scopeNow(
          scope,
          question.mind?.id ?? null,
          readyMind ? null : wallOfTurn(added.turn.question),
        );
        const checked = checkQuotes(
          question.quotes,
          question.mind?.id ?? null,
          readyMind ? null : wallOfTurn(added.turn.question),
        );
        const readyTurn = options.conversations.restartAnswer(
          turn.answer.id,
          ready.model,
          readOf(readyMind),
          false,
        );
        options.conversations.publish(readyTurn);
        published = true;
        return startInConversation(
          readyTurn,
          ready,
          documentIds,
          emptyScope,
          readyMind,
          question.onScreen,
          checked,
          question.commands,
        );
      } catch (error) {
        if (!published) options.conversations.discard(added);
        throw error;
      }
    },

    /** Writes an Answer of a conversation again, in place (see `CoreApi.regenerateConversationAnswer`). */
    async regenerateInConversation(input: unknown): Promise<ConversationAskResult> {
      const asked = options.conversations.questionOf(input);
      const everyDocument = isRecord(input) && input.clearScope === true;
      if (everyDocument) options.conversations.clearScope(asked.question.id);
      const { answerId, question, toolCalls, onScreen, commands, model } =
        options.conversations.questionOf(input);
      const ready = await readyModel(model ?? question.model, question.forcedSkill);
      if ("asked" in ready) return ready;
      if (model) options.conversations.setQuestionModel(question.id, model);
      active.get(answerId)?.finish({ status: "stopped" });
      const changes = toolCalls.flatMap((call) => call.mindChange ?? []);
      // Written again, it proposes its changes again: those still waiting from before go.
      options.withdrawChanges?.(changes);
      // From every Document, the Mind it wrote keeps that text's place and takes the new text (#1149).
      const made = everyDocument
        ? (changes.find((change) => change.created) ?? changes[0])
        : undefined;
      const remake = made && options.readableMindName(made.mindId) !== null ? made.mindId : null;
      const from = question.askedFrom;
      const mind =
        !from || from.deleted
          ? null
          : mindToRead(from.mindId, question.focus, question.text, ready.model);
      const turn = options.conversations.restartAnswer(answerId, ready.model, readOf(mind));
      const { documentIds, emptyScope } = scopeNow(
        question.scope,
        from && !from.deleted ? from.mindId : null,
        mind ? null : wallOfTurn(question),
      );
      return startInConversation(
        turn,
        ready,
        documentIds,
        emptyScope,
        mind,
        onScreen,
        checkQuotes(question.quotes, from?.mindId ?? null, mind ? null : wallOfTurn(question)),
        commands,
        remake,
      );
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
     * `onText` hears the words as they stream, before the Citations are checked.
     */
    answerCell(input: {
      context: QuestionContext;
      documentIds: string[];
      model: ChatModelChoice;
      signal: AbortSignal;
      onText?(streamed: Pick<CellAnswer, "markdown" | "blocks">): void;
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
                  changedScale: outcome.status === "done" ? answer.changedScale() : null,
                  error: outcome.status === "failed" ? outcome.error : null,
                });
              } else if (answer.markdown !== "") {
                input.onText?.({ markdown: answer.markdown, blocks: answer.blocks() });
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
          checkScales: true,
          task: true,
        });
        const stop = () => active.get(answerId)?.finish({ status: "stopped" });
        if (input.signal.aborted) stop();
        else input.signal.addEventListener("abort", stop, { once: true });
      });
    },

    /**
     * Fills a Meeting's notes in (#142) as a check Run kept nowhere, as a cell is: from the
     * Transcript's `passages`, shown with the Question, its Search scope `documentIds`. Its
     * Citations are checked as any Answer's. The model is ready and allowed already.
     */
    answerMeetingFill(input: {
      context: QuestionContext;
      passages: WindowedPassage[];
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
                  changedScale: null,
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
          emptyScope: false,
          forcedSkill: null,
          consentNeeded: false,
          outside: true,
          toolSet: "check",
          outputKind: "meeting-fill",
          thinking: "answer",
          task: true,
          transcript: input.passages,
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
                  changedScale: null,
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
            message: "Stopped: everything stays on this computer.",
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
