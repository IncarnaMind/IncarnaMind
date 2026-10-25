import { mkdirSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { cleanApiKey } from "../shared/apiKey";
import { isCitationStyleId, withRecentStyle } from "../shared/citationStyles";
import type { DrawnPage } from "../shared/citedPage";
import { hasCitationPlace, optionsFor } from "../shared/exportOptions";
import { translate } from "../shared/i18n";
import { organizeModelOf, supportsLibraryImages } from "../shared/libraryModels";
import { holdsOnlyItsTitle } from "../shared/madeMind";
import {
  HEARD_FROM,
  helpKindsFor,
  helpLabel,
  isMeetingHelpKind,
  isMeetingTemplate,
} from "../shared/meetingHelp";
import { bibliographyShown } from "../shared/mindBibliography";
import {
  chosenCitationStyle,
  citationStyleIn,
  setCitationStyle,
} from "../shared/mindCitationStyle";
import { mindModelOf } from "../shared/mindModel";
import {
  DEFAULT_MIND_STYLE,
  exportedFamily,
  isMindStyle,
  lineSpacingOf,
  mindStyleOf,
  sameStyle,
  writeMindStyle,
} from "../shared/mindStyle";
import { mindName } from "../shared/naming";
import { paperFor } from "../shared/printDocument";
import { resolveProposals, restoreRevised } from "../shared/proposals";
import { isPaperOrBook } from "../shared/references";
import { RESEARCH_TASK } from "../shared/research";
import { hasSearchScope, holdsText, mindSearchScope, type ScopeKind } from "../shared/searchScope";
import { SPEAKER_ME, SPEAKER_THEM } from "../shared/speakers";
import { wordFileOf } from "../shared/wordFiles";
import { logActivity, silentLogger } from "./activityLog";
import type { CoreAdapters } from "./adapters";
import { agentSocketPath, createAgents } from "./agents";
import { createAgentSetup, skillInstalled } from "./agents/setup";
import { createAiUse } from "./aiUse";
import { createAiUseStatement } from "./aiUseStatement";
import { createAiSdkAnswerEngine, createAnswers } from "./answers";
import { createChecks } from "./answers/checks";
import { AFTER_NEW_VERSION_MS, CLAIM_TIME_LIMIT_MS } from "./answers/checks/watch";
import {
  citeSelection,
  recheckCitation,
  recheckKept,
  recheckWhereSelected,
} from "./answers/citations";
import {
  addCitedUnits,
  addCitedVersions,
  type CitedUnits,
  type CitedVersions,
  eachCitation,
  isCited,
} from "./answers/citedVersions";
import { createCiting } from "./answers/citing";
import { readMind } from "./answers/context";
import type { AnswerSearchOptions } from "./answers/engine";
import type { LiveTranscript } from "./answers/liveTranscript";
import {
  type AddDocumentsResult,
  type ChatModelChoice,
  type ChatProviderKind,
  type CheckRecordFailure,
  type CheckRecordFormat,
  type ConversationAskResult,
  type CoreApi,
  type CoreEventSource,
  DEFAULT_MIND_KIND,
  type Document,
  type DocumentStatus,
  type EmbeddingModelStatus,
  type EmbeddingSettings,
  type ExportMindOptions,
  type ExternalService,
  type Meeting,
  type MeetingHelpKind,
  type Mind,
  type MindCitationStyle,
  type NetworkTrafficId,
  NOT_IN_A_FOLDER_ID,
  type OwnFileKind,
  type ProviderError,
  type SavedExport,
  type SavedFile,
  type ScannedQuoteInput,
  type SearchScope,
  type SelectedPart,
  type Task,
  type UnlockDocumentInput,
  type UnreadFile,
  type Unsubscribe,
} from "./api";
import { createApprovals } from "./approvals";
import { createBackgroundQueue } from "./backgroundQueue";
import { createCheckpoints } from "./checkpoints";
import { createCheckRecord } from "./checkRecord";
import { createCitationStyles } from "./citationStyles";
import { type CitedPages, type CitedPlace, createCitedPages } from "./citedPages";
import { COMPARISON_TASK, createComparisons } from "./comparisons";
import { createConnectors } from "./connectors";
import { connectorDirectory } from "./connectors/directory";
import { createConnectorRegistry, REGISTRY, REGISTRY_SENDS } from "./connectors/registry";
import { createConsent, type DataFlowRegistry } from "./consent";
import { createConversations, type QuestionInput, type Turn } from "./conversations";
import { createMeter } from "./cost/meter";
import {
  createDocuments,
  type DocumentFile,
  type DocumentImage,
  parseListOptions,
} from "./documents";
import { createEvidence, parseCheckedDocument, passageResult } from "./documents/evidence";
import { pdfIsLocked, pdfOpensWith, pdfTablePages } from "./documents/extract";
import { statIdentity } from "./documents/files";
import { openWordPackage } from "./documents/formats/docxPackage";
import { readPageSetup } from "./documents/formats/docxPages";
import { createOwnFiles } from "./documents/ownFiles";
import { createPdfPasswords } from "./documents/pdfPasswords";
import { READING_SPEED } from "./documents/readingSpeed";
import { createVersionRetention, type VersionRetention } from "./documents/retention";
import {
  BUILT_IN_TEXT_RECOGNITION_MODEL,
  createTextRecognitionModel,
  type TextRecognitionModel,
} from "./documents/scan";
import type { Reranker } from "./documents/searchTool";
import { tunedSearch } from "./documents/searchTuning";
import { LANGUAGE_SAMPLE, writtenInChinese } from "./documents/textLanguage";
import { findUnreadDocuments } from "./documents/unread";
import { createViewing } from "./documents/viewing";
import { fsWatchFolder } from "./documents/watcher";
import { createWebPages } from "./documents/web";
import { createEdits, editText } from "./edits";
import { BUILT_IN_EMBEDDING_MODEL, createEmbeddingModel } from "./embedding";
import { createActiveEmbedding } from "./embedding/active";
import { createModelSources, MODEL_COPIES } from "./embedding/modelSources";
import {
  FileWriteCancelledError,
  InvalidInputError,
  isRecord,
  LinkedFolderWritesDeclinedError,
  LocalModeError,
  MindReadOnlyError,
  NotFoundError,
  TaggingNotReadyError,
  TranslatableError,
} from "./errors";
import { type AnyEventListener, createEventHub } from "./events";
import { createExamples } from "./examples";
import { createLocalExecutor } from "./execution";
import { createExports, type ExportsDependencies } from "./exports";
import { citationPlaceQuestion } from "./exports/citationPlaceQuestion";
import { createComparisonExport } from "./exports/comparisonExport";
import { exportLabels } from "./exports/labels";
import { markAiTextQuestion } from "./exports/markAiTextQuestion";
import { renderMarkdown } from "./exports/markdown";
import { setTextOnlyDocuments, textOnlyDocuments } from "./exports/sharedPictures";
import { createFileLock } from "./fileLock";
import { safeFileName, writeNewFile } from "./fileNames";
import { createFolders } from "./folders";
import { LANGUAGES, systemRegion } from "./language";
import { createLayouts } from "./layout";
import { CLASSIFICATION_FLOW_SENDS, createLibrary, SCAN_IMAGES_FLOW_SENDS } from "./library";
import { automaticGroupClassifier } from "./library/automatic";
import { createBatches } from "./library/batches";
import {
  chatGroupClassifier,
  decisionGroupClassifier,
  type GroupClassifier,
  pacedBy,
  withPageReader,
} from "./library/classifier";
import { documentCitedPages, documentPageImages } from "./library/pageImages";
import { createPlanPace, type Plan } from "./library/planPace";
import { createTagging } from "./library/tagging";
import type { TaggingClassifier } from "./library/types";
import { createMeetings } from "./meetings";
import { listParts, meetingFolder } from "./meetings/audioFiles";
import { createMeetingFill } from "./meetings/fill";
import { createCaptureHealth } from "./meetings/health";
import { createSpeakerPass } from "./meetings/speakerPass";
import { createTranscripts } from "./meetings/transcript";
import { accessFor, isKnownKind } from "./mindAccess";
import { createMindContent } from "./mindContent";
import { createMindIndex, lineUnderName } from "./mindIndex";
import {
  createMinds,
  type NewMind,
  parseCreateMindInput,
  parseFolderChoice,
  parseIds,
  parseMindId,
} from "./minds";
import { firstLineOf, readBlocks, textStart, theirChangesReading } from "./mindText";
import { createNoteAdding, insertBlocks } from "./noteAdding";
import { createNoteConversations } from "./noteConversations";
import { createOutputFiles } from "./outputFiles";
import { PAPER as PAGE_PAPER } from "./pageDefaults";
import { nativePageSetup } from "./pageSetup";
import { createPrivacy, type NetworkTrafficRegistry } from "./privacy";
import { KeyCharacterError, storedApiKey } from "./providers/apiKey";
import { readsImages } from "./providers/capabilities";
import { CHAT_FLOW_SENDS, createChat, type PreparedChatModel } from "./providers/chat";
import { CHATGPT_PLAN_ENDPOINTS, createChatGptPlan } from "./providers/chatgpt/plan";
import { createClaudeAccount } from "./providers/claudeAccount/account";
import { ANTHROPIC_OAUTH } from "./providers/claudeAccount/config";
import { createCopilotAccount } from "./providers/copilot/account";
import { COPILOT_PROFILES } from "./providers/copilot/config";
import { createAiSdkEmbeddingModel } from "./providers/embeddings";
import { defaultOllamaUrl, ollamaBaseUrl } from "./providers/kinds";
import { createLocalServers } from "./providers/localServers";
import { createAiSdkChatModel } from "./providers/models";
import {
  detectOllama,
  hasOllamaModel,
  installedOllamaModels,
  OLLAMA_REGISTRY,
  OLLAMA_START_TIMEOUT_MS,
  pullOllamaModel,
  RECOMMENDED_OLLAMA_MODEL,
  waitForOllama,
} from "./providers/ollama";
import { isCloudModelName } from "./providers/ollamaCloud";
import { createOllamaModels } from "./providers/ollamaModels";
import { createAiSdkRerankingModel, createRerank } from "./providers/rerank";
import { createQuestions } from "./questions";
import { createRecentlyDeleted } from "./recentlyDeleted";
import { createReferenceChecks } from "./referenceChecks";
import {
  createReferenceImport,
  createReferences,
  REFERENCE_LOOKUP_SENDS,
  REFERENCE_SERVICE_URLS,
} from "./referenceRecords";
import { parseReference } from "./references";
import { BUILT_IN_RERANKING_MODEL, createRerankingModel } from "./reranking";
import { createResearch } from "./research";
import { createTasks, type TaskKind, type TaskNotice } from "./runs/tasks";
import { parseSearchScope, resolveSearchScope } from "./scope";
import { createSecrets } from "./secrets";
import { createSettings, isChatModelChoice } from "./settings";
import { createSkills } from "./skills";
import { createSkillDrafts } from "./skills/draft";
import { createScriptRunner } from "./skills/scripts";
import { createSources, FIND_SOURCES_SENDS } from "./sources";
import { createSourceHttp, SourceError } from "./sources/http";
import { createPace, realTimers } from "./sources/pace";
import { createSourceProviders, sourceKeySecret } from "./sources/providers";
import { migrate, openDatabase } from "./storage";
import { createSuggestions } from "./suggestions";
import { createTags, tagsOfDocument } from "./tags";
import { chatClassifier } from "./tags/classify";
import { createJevTagging, decisionModelTagger } from "./tags/jev";
import { createRateLimitPause } from "./tags/rateLimit";
import { createTagger, TAGGING_FLOW_SENDS } from "./tags/tagger";
import { inFlow } from "./timing/flows";
import { createTimings } from "./timing/timings";
import type { CommandsHost, MarkingSettled } from "./tools/commands/run";
import { createCommandSteps } from "./tools/commands/steps";
import { createWebSearch, WEB_SEARCH_SENDS } from "./tools/web";
import { createPublicFetch } from "./tools/web/fetcher";
import { createCloudTranscription } from "./transcription/cloud/routes";
import {
  createTranscriptionModel,
  KEEPS_UP,
  QWEN3_ASR_0_6B,
  TRANSCRIPTION_SPEED,
} from "./transcription/model";
import { createSpeakerModel } from "./transcription/speakerModel";
import { createUnsavedChanges } from "./unsavedChanges";
import { createUsageData } from "./usageData";
import { addedCounts, trackUsage } from "./usageTracking";
import { createWordImports } from "./wordImports";
import { ensureWorkspace } from "./workspace";

export const DATABASE_FILE = "incarnamind.db";

/** The core as its host sees it: the public interface (methods and events) plus host-only hooks. */
export interface Core extends CoreApi, CoreEventSource {
  /**
   * Opens a Document's file where the User keeps it, for the host to serve
   * to the UI (the desktop app streams it over a custom protocol, so files
   * never cross IPC). The file is checked first, as any opened file is.
   * Only live Documents whose file is there: throws NotFoundError for an
   * unknown or deleted Document, or one whose file is missing or can't be
   * reached (the UI then shows `readDocumentText` instead).
   */
  openDocumentFile(documentId: string): Promise<DocumentFile>;
  /**
   * Opens a picture a live Markdown Document shows from beside it, by the
   * relative path written in the file ("figures/map.png"), or one a saved web
   * page shows, by its path in the snapshot ("pictures/<hash>.png", #756),
   * for the host to serve to the viewer: only images, only from the file's
   * folder or below it, only those the page's versions show. Throws
   * NotFoundError for anything else.
   */
  openDocumentImage(documentId: string, path: string): Promise<DocumentImage>;
  /**
   * The number a workbook's cell stores when its shown text isn't that
   * number written plainly (0.04213 for "4.2%"), from the Document's
   * current version; null when it shows its number plainly, isn't a number,
   * or isn't there, and for a CSV. `sheet` is the sheet's name (null for a
   * CSV). For the Tools that calculate over cells, so not on the bridge.
   * Throws NotFoundError for an unknown or deleted Document.
   */
  readCellNumber(documentId: string, sheet: string | null, ref: string): number | null;
  /**
   * Opens a live Document's file, where it is, in the default app for its
   * type, through the `shell` adapter; a web page opens live, at its
   * address, through the `browser` adapter. Throws NotFoundError as
   * `openDocumentFile` does.
   */
  openDocumentInApp(documentId: string): Promise<void>;
  /**
   * Shows a live Document's file selected in the system's file manager,
   * through the `shell` adapter. Throws NotFoundError as `openDocumentFile` does.
   */
  showDocumentInFolder(documentId: string): Promise<void>;
  /**
   * Shows a file IncarnaMind saved since it started (e.g. by
   * `saveMindExport`) selected in the system's file manager, through the
   * `shell` adapter. Throws NotFoundError for any other path.
   */
  showSavedFile(path: string): Promise<void>;
  /**
   * Opens a file IncarnaMind saved since it started in the default app for its
   * type, through the `shell` adapter. Throws NotFoundError for any other path.
   */
  openSavedFile(path: string): Promise<void>;
  /**
   * Reconciles every Linked folder and single file with the disk now, and
   * resolves once that, and any change already reported, has been taken in.
   */
  reconcileDocuments(): Promise<void>;
  /** The computer is about to sleep: a Meeting recording saves what it has and stops capturing. */
  systemSleeping(): void;
  /** The computer woke: a Meeting the sleep stopped records again, the sleep marked as a gap. */
  systemAwake(): void;
  /** Every event the core emits, for the host to forward to the UI. */
  onAnyEvent(listener: AnyEventListener): Unsubscribe;
  /** Every external data flow. Core modules register theirs here; consent covers each one. */
  readonly dataFlows: DataFlowRegistry;
  /**
   * Network traffic that carries no User content, for the Privacy page. Core
   * modules and the host (e.g. its update check) register theirs here.
   */
  readonly networkTraffic: NetworkTrafficRegistry;
  /**
   * The versions of Documents that core features other than Citations still
   * need (#79): a check result's evidence, a saved page, an unfinished Task's
   * sources, a Checkpoint's Citations. A retained version keeps its text when
   * its file changes, and its Units retained when its Linked folder is
   * unlinked, as a quoted one does. Once its last owner releases it, and no
   * Citation quotes it, it goes at the next start.
   */
  readonly retention: VersionRetention;
  /**
   * A Citation's cited page, saved when the Citation was made (#133): how its
   * Location looked in the version it quotes, with the text drawn on it, for
   * exports such as the source pack (#134). It is there after the file
   * changed or went. Null when none is saved: the Citation was made before
   * pages were saved, its page couldn't be drawn, or it waits to be.
   */
  citedPageImage(citation: CitedPlace): Promise<DrawnPage | null>;
  /**
   * Starts a Task of a kind the host registered (`CoreAdapters.taskKinds`).
   * Comparison tables start theirs through `compareDocuments`.
   */
  startTask(kind: string, mindId: string | null, input: unknown): Task;
  /**
   * For Answers (#29): the default chat model (or the one given), once Questions
   * can be asked and the User has accepted its data flow. Throws otherwise.
   */
  prepareChatModel(choice?: ChatModelChoice): Promise<PreparedChatModel>;
  /** Closes the database and drops all listeners. The core can't be used afterwards. Safe to call twice. */
  close(): void;
}

/** How long a Question asked during a call waits for the live transcript's newest lines to be indexed (#144). */
const LIVE_TRANSCRIPT_WAIT_MS = 3_000;

const isBehind = (meeting: Meeting) => meeting.transcript?.state === "behind";

/**
 * Opens (or creates) the data folder and its database, brings the schema up to
 * date, and returns the core. The host passes in every platform capability.
 */

/** The longest password a PDF is unlocked with: far beyond any real one, short enough to refuse junk. */
const MAX_PDF_PASSWORD = 1_024;

const parseDocumentId = (input: unknown): string => {
  if (typeof input !== "string" || input === "") {
    throw new InvalidInputError({ key: "error.document.notFound" });
  }
  return input;
};

/** `unlockDocument`'s input. Its errors never repeat the password. */
function parseUnlock(input: unknown): UnlockDocumentInput {
  if (!isRecord(input)) throw new InvalidInputError({ key: "error.document.passwordMissing" });
  const { password } = input;
  if (typeof password !== "string" || password === "" || password.length > MAX_PDF_PASSWORD) {
    throw new InvalidInputError({ key: "error.document.passwordMissing" });
  }
  return { documentId: parseDocumentId(input.documentId), password };
}

/** A Citation's Document, Units and quote, as `readScannedQuote` and `readableQuote` take them. */
function parseQuoted(input: unknown): ScannedQuoteInput {
  if (!isRecord(input) || typeof input.quote !== "string") {
    throw new InvalidInputError("A Citation's Document, Units and quote are needed.");
  }
  const unit = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
  return {
    documentId: typeof input.documentId === "string" ? input.documentId : "",
    contentHash: typeof input.contentHash === "string" ? input.contentHash : null,
    pageFrom: unit(input.pageFrom),
    pageTo: unit(input.pageTo),
    quote: input.quote,
  };
}

function parseSelectedPart(input: unknown): SelectedPart {
  if (!isRecord(input) || typeof input.text !== "string") {
    throw new InvalidInputError({ key: "error.selection.none" });
  }
  const count = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
  const unit = input.unit === null || input.unit === undefined ? null : count(input.unit);
  // A Unit that isn't one would read as no Unit, and widen the check to the whole Document.
  if (unit === undefined || unit === 0)
    throw new InvalidInputError({ key: "error.selection.none" });
  const linesBefore = count(input.linesBefore);
  const linesAfter = count(input.linesAfter);
  return {
    unit,
    text: input.text,
    ...(linesBefore !== undefined && { linesBefore }),
    ...(linesAfter !== undefined && { linesAfter }),
    ...(typeof input.before === "string" && { before: input.before }),
    ...(typeof input.after === "string" && { after: input.after }),
  };
}

const STILL_PROCESSING: ReadonlySet<DocumentStatus> = new Set([
  "queued",
  "waiting-for-model",
  "embedding",
]);

export function createCore(adapters: CoreAdapters): Core {
  const { dataDir } = adapters.paths;
  mkdirSync(dataDir, { recursive: true });

  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const now = () => (adapters.now?.() ?? new Date()).toISOString();
  const timings = createTimings({
    db,
    now: () => adapters.now?.() ?? new Date(),
    log: adapters.log ?? silentLogger,
  });
  timings.prune();
  const systemPaper = () =>
    paperFor(systemRegion(adapters.systemRegion?.(), adapters.systemLanguages()));
  try {
    ensureWorkspace(db, now);
  } catch (error) {
    db.close();
    throw error;
  }
  const events = createEventHub();
  const knownSecrets = new Set<string>();
  // Logs what happens from here on, from the events: never the User's content.
  const activity = logActivity(events, adapters.log ?? silentLogger, knownSecrets);
  /** Logs a failed test of a provider's settings, by the kind of error. */
  const loggingTest =
    (what: Parameters<typeof activity.testFailed>[0]) =>
    async <R extends { ok: true } | { ok: false; error: ProviderError }>(
      test: Promise<R>,
    ): Promise<R> => {
      const result = await test;
      if (!result.ok) activity.testFailed(what, result.error.kind);
      return result;
    };
  const minds = createMinds(db, now);
  /** The Mind, if this version may write to it: not one of a kind a newer version made. */
  const writableMind = (mindId: unknown): Mind => {
    const mind = minds.get(mindId);
    if (!isKnownKind(mind.kind)) {
      throw new MindReadOnlyError({ key: "error.mind.newerVersion" });
    }
    return mind;
  };
  const mindExists = (mindId: string) => {
    try {
      minds.get(mindId);
      return true;
    } catch {
      return false;
    }
  };
  const mindsChanged = () => events.emit("minds.changed", minds.list());
  // The assistant's conversations (ADR-0017); Answers a quit left being written are settled now.
  const conversations = createConversations(db, now);
  const conversationsChanged = () => events.emit("conversations.changed", null);
  const publishConversation = (turn: Turn) => {
    conversations.publish(turn);
    events.emit("conversation.message", turn.question);
    events.emit("conversation.message", turn.answer);
    conversationsChanged();
  };
  const unsaved = createUnsavedChanges({
    dataDir: adapters.paths.dataDir,
    tempDir: adapters.paths.tempDir ?? tmpdir(),
    changed: (state) => events.emit("minds.unsaved", state),
  });
  const content = createMindContent(
    db,
    now,
    (mindId, update, cause) => {
      events.emit("mind.update", { mindId, update, ...(cause && { cause }) });
      // Only notes the change; what became of AI text is worked out once the Mind is quiet.
      aiUse.contentStored(mindId);
      checkpoints.edited(mindId);
      mindIndex.contentStored(mindId);
      comparisons.mindChanged(mindId);
      noteConversations.changed(mindId);
      const renamed = minds.setAutoTitle(mindId, content.peek(mindId, firstLineOf));
      if (minds.markEdited(mindId) || renamed) mindsChanged();
    },
    { unsaved: unsaved.mindUnsaved },
  );
  const noteConversations = createNoteConversations({
    content,
    mindIds: () => minds.list().map((mind) => mind.id),
  });
  // A Mind waiting in Recently deleted comes back with its Citations, so it counts until it is purged.
  const eachCitingMind = (visit: (blocks: Y.XmlFragment) => void, exceptMindId?: string) => {
    for (const mind of db.all<{ id: string; deleted_at: string | null }>(
      "SELECT id, deleted_at FROM minds WHERE purged_at IS NULL",
    )) {
      if (mind.id === exceptMindId) continue;
      if (mind.deleted_at === null) content.peek(mind.id, visit);
      else content.peekDeleted(mind.id, visit);
    }
  };
  const mindIndex = createMindIndex({
    db,
    now,
    content,
    reportError: (error) => console.error(error),
  });
  // The record of AI use stays on this computer: it takes nothing from the network or the usage-data catalog.
  const aiUse = createAiUse({
    db,
    now,
    content,
    requireMind: (mindId) => void minds.get(mindId),
    changed: (status) => events.emit("aiUse.changed", status),
    reportError: (error) => console.error(error),
  });
  // A writing suggestion the User accepted (#282). It holds no Block ids: the words went into
  // the paragraph being written, so there is nothing to follow, only the use to record.
  events.on("suggestion.accepted", (accepted) => {
    aiUse.record([
      {
        mindId: accepted.mindId,
        kind: "suggestion-accepted",
        providerId: accepted.providerId,
        modelId: accepted.modelId,
        characters: accepted.characters,
        occurredAt: accepted.acceptedAt,
      },
    ]);
  });
  // The level Skill scripts run at: the given Executor's, else the local one's below ("none").
  const scriptSandbox = adapters.executor?.level ?? "none";
  const capture = adapters.audioCapture;
  const settings = createSettings(
    db,
    now,
    adapters.systemLanguages,
    scriptSandbox,
    !capture ? "none" : capture.systemAudio ? "both" : "microphone",
    () => adapters.systemUserName?.() || accountName(),
  );
  const folders = createFolders(db, now);
  const foldersChanged = () => events.emit("folders.changed", folders.list());
  const tags = createTags(db, now);
  // First run: the preset Tags, in the interface language of the time.
  tags.seedPresets(settings.get().language);
  const tagsChanged = () => {
    events.emit("tags.changed", tags.list());
    tagger.tagsDefined();
  };
  /** Set once automatic tagging exists: it hears about every Document that becomes ready. */
  let documentReady = (_documentId: string) => {};
  /** Set once rerank exists: a Document became ready, so the built-in reranking model is needed. */
  let prepareRerank = () => {};
  let libraryDocumentChanged = (_documentId: string) => {};
  const batches = createBatches({
    db,
    emit: (batch) => events.emit("documents.batch", batch),
    file: (documentId, groupId) => library.file(documentId, groupId),
  });
  const rememberSecret = (secret: string) => {
    knownSecrets.add(secret);
  };
  const secrets = createSecrets(adapters.keychain, settings, rememberSecret);
  const pdfPasswords = createPdfPasswords(secrets, settings);
  const viewing = createViewing();
  /** Forgets the passwords of Documents gone from the Library (#763), and says which are kept. */
  const forgetPasswords = async (ids: readonly string[]) => {
    const kept = pdfPasswords.kept();
    const gone = ids.filter((id) => kept.includes(id));
    if (gone.length === 0) return;
    for (const id of gone) await pdfPasswords.forget(id);
    events.emit("documentPasswords.changed", pdfPasswords.kept());
  };
  const consent = createConsent(db, events, now);
  /** Aborts work still running (model downloads, a ChatGPT sign-in, provider requests) when the core closes. */
  const lifetime = new AbortController();
  const downloads = adapters.modelDownloads;
  const modelCopies = downloads?.copies ?? MODEL_COPIES;
  const modelSources = createModelSources({
    fetch: downloads?.fetch ?? fetch,
    now: () => (adapters.now?.() ?? new Date()).getTime(),
    language: () => settings.get().language,
    choice: () => settings.get().device.modelSource,
    ...(downloads?.proxy && { proxy: downloads.proxy }),
    copies: modelCopies,
    ...(downloads?.stallMs !== undefined && { stallMs: downloads.stallMs }),
    log: adapters.log ?? silentLogger,
  });
  const embeddingModel = createEmbeddingModel({
    definition: BUILT_IN_EMBEDDING_MODEL,
    source: adapters.embeddingModelSource,
    sources: modelSources,
    dataDir,
    embedder: adapters.embedder,
    emitStatus: (status) => events.emit("embeddingModel.status", status),
  });
  // Reads scanned pages (#397), when this copy has a recognizer to read them with.
  const textRecognitionModel = adapters.textRecognizer
    ? createTextRecognitionModel({
        definition: BUILT_IN_TEXT_RECOGNITION_MODEL,
        source: adapters.textRecognitionModelSource,
        sources: modelSources,
        dataDir,
        recognizer: adapters.textRecognizer,
        emitStatus: (status) => events.emit("textRecognitionModel.status", status),
      })
    : undefined;
  // A Document waiting for its password counts as indexing until it is read.
  const indexingSince = new Map<string, number>();
  const timeIndexing = (document: Document) => {
    const since = indexingSince.get(document.id);
    if (document.status === "extracting") {
      if (since === undefined) indexingSince.set(document.id, performance.now());
      return;
    }
    if (since === undefined || STILL_PROCESSING.has(document.status)) return;
    indexingSince.delete(document.id);
    if (document.status !== "ready") return;
    timings.step("index-document", document.kind, performance.now() - since, document.pageCount);
  };
  const timedRecognition = (model: TextRecognitionModel): TextRecognitionModel => ({
    get reader() {
      return model.reader;
    },
    status: () => model.status(),
    retry: () => model.retry(),
    onReady: (listener) => model.onReady(listener),
    read: (picture, page) =>
      timings.local(
        "ocr-page",
        model.reader,
        () => model.read(picture, page),
        (lines) => lines.length,
      ),
    readFile: (file, page) =>
      timings.local("ocr-page", model.reader, () => model.readFile(file, page)),
    close: () => model.close(),
  });
  /** What `getTextRecognitionModel` says in a copy that has no recognizer: nothing to download. */
  const textRecognitionUnavailable: EmbeddingModelStatus = {
    name: BUILT_IN_TEXT_RECOGNITION_MODEL.name,
    host: new URL(BUILT_IN_TEXT_RECOGNITION_MODEL.source.baseUrl).host,
    state: "not-downloaded",
    downloadedBytes: 0,
    totalBytes: 0,
    error: null,
  };
  /** Reports the embedding settings again; set once Documents exist. */
  let embeddingChanged = () => {};
  /** A Document's status changed: during a rebuild, its progress may have too. */
  let rebuildMayHaveProgressed = () => {};
  // The embedding model search uses: the built-in one, or the provider the User chose.
  const embedding = createActiveEmbedding({
    builtIn: embeddingModel,
    settings,
    secrets,
    consent,
    createModel: adapters.createEmbeddingModel ?? createAiSdkEmbeddingModel,
    signal: lifetime.signal,
    onChange: () => embeddingChanged(),
  });
  // Usage data: only from a copy built to send it, only while the User agrees, never in local mode.
  const usageData = createUsageData({
    settings,
    sender: adapters.usageData,
    localOnly: () => embedding.localOnly(),
  });
  const privacy = createPrivacy({ settings, crashReporter: adapters.crashReporter, usageData });
  const privacyChanged = () => events.emit("privacy.changed", privacy.status());
  const platform = process.platform;
  const retention = createVersionRetention(db, now);
  const checkpoints = createCheckpoints({
    db,
    now,
    content,
    retention,
    requireMind: (mindId) => writableMind(mindId).id,
    changed: (mindId) => events.emit("checkpoints.changed", { mindId }),
    stopAnswer: (mindId, answerId) => answers.stop({ mindId, answerId }),
    settleAnswers: (mindId) => answers.settleOrphans(mindId),
    reportError: (error) => console.error(error),
  });
  // Background work (automatic tagging, Organize's classification, saving cited pages): one
  // job at a time, giving way to Answers.
  const background = createBackgroundQueue({ reportError: (error) => console.error(error) });
  let documents: ReturnType<typeof createDocuments>;
  let citedPages: CitedPages;
  /** Set once created, so a failure after it can close it. */
  let createdDocuments: ReturnType<typeof createDocuments> | undefined;
  try {
    documents = createdDocuments = createDocuments({
      db,
      dataDir,
      now,
      log: adapters.log ?? silentLogger,
      model: embedding.model,
      textRecognition: textRecognitionModel && timedRecognition(textRecognitionModel),
      ...(adapters.scansAtOnce !== undefined && { scansAtOnce: adapters.scansAtOnce }),
      pdfPassword: (id) => pdfPasswords.of(id),
      readingSpeed: {
        read: () => settings.readDeviceValue(READING_SPEED),
        write: (speed) => settings.writeDeviceValue(READING_SPEED, speed),
      },
      folders,
      emitStatus: (document) => {
        timeIndexing(document);
        events.emit("document.status", document);
        libraryDocumentChanged(document.id);
        batches.changed([document.id]);
        rebuildMayHaveProgressed();
      },
      emitMoved: (moved) => events.emit("documents.moved", moved),
      emitRemoved: (ids) => {
        events.emit("documents.removed", ids);
        batches.changed(ids);
        forgetPasswords(ids).catch((error: unknown) =>
          console.error("A removed Document's PDF password couldn't be forgotten.", error),
        );
      },
      emitKept: (kept) => events.emit("keptCitationTexts.changed", kept),
      foldersChanged,
      linkedFoldersChanged: (list) => {
        events.emit("linkedFolders.changed", list);
        batches.linkedFoldersChanged(list);
      },
      onFound: (documentId) => batches.found(documentId),
      onReady: (documentId) => {
        // There is something to search now: the built-in reranking model downloads, if it reranks.
        prepareRerank();
        documentReady(documentId);
      },
      // Citations live in Minds, anywhere: in Answers, or copied into Notes; and in
      // conversations. Features other than Citations retain what they need too.
      citedUnits: (documentIds) => {
        const wanted = new Set(documentIds);
        const cited: CitedUnits[] = [];
        eachCitingMind((fragment) => addCitedUnits(fragment, wanted, cited));
        conversations.addCitedUnits(wanted, cited);
        retention.addRetainedUnits(wanted, cited);
        return cited;
      },
      // iCloud Drive before macOS 14 downloads a stub's file when asked by its command-line tool.
      ...(platform === "darwin" && {
        downloadStub: async (path: string) => {
          const child = await adapters.processes.spawn("brctl", ["download", path]);
          await new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
            child.once("error", () => resolve());
          });
        },
      }),
      linkedFolders: {
        watch:
          adapters.linkedFolders?.watch ?? fsWatchFolder(adapters.linkedFolders?.settleMs ?? 300),
        stat: adapters.linkedFolders?.stat ?? statIdentity,
        retryMs: adapters.linkedFolders?.retryMs ?? 30_000,
        detectDataless: adapters.linkedFolders?.detectDatalessFiles ?? platform === "darwin",
      },
    });
    citedPages = createCitedPages({
      db,
      dataDir,
      now,
      retention,
      background,
      document: (id) => documents.getMany([id])[0] ?? null,
      filePath: (id) => documents.filePath(id),
      drawPdf: async (documentId, file, contentHash, pages, signal) =>
        documentCitedPages(file, contentHash, pages, signal, await pdfPasswords.of(documentId)),
      capturePage: adapters.capturePage,
      log: adapters.log ?? silentLogger,
    });
    // Old versions' text, the text kept of unlinked Documents, and the cited pages, that no
    // Citation quotes and no feature retains any more go, at startup only: nothing is being
    // written or undone then, so no Citation is in flight. The retained versions are one
    // query, whatever their kind, and one walk over the Minds serves both.
    const collectVersions = documents.hasOldVersions() || documents.keptCitationTexts().length > 0;
    const pagesCited = citedPages.collector();
    if (collectVersions || pagesCited) {
      const cited: CitedVersions = new Map();
      eachCitingMind((fragment) => {
        if (collectVersions) addCitedVersions(fragment, cited);
        if (pagesCited) eachCitation(fragment, pagesCited.cite);
      });
      // First, so a version only a page that went retained goes now too.
      if (pagesCited) {
        conversations.eachCitation(pagesCited.cite);
        pagesCited.collect();
      }
      if (collectVersions) {
        conversations.addCitedVersions(cited);
        retention.addRetainedVersions(cited);
        const quoted = (documentId: string, contentHash: string) =>
          isCited(cited, documentId, contentHash);
        documents.collectOldVersions(quoted);
        documents.releaseKeptText(quoted);
      }
    }
    citedPages.sweep();
    retention.forgetReleased();
    citedPages.forgetGone();
  } catch (error) {
    lifetime.abort();
    // Created, but collecting old versions failed.
    createdDocuments?.close();
    embeddingModel.close();
    db.close();
    throw error;
  }
  // A saved page's pictures may come from any host: only the public internet is reached (#756).
  const pictureFetcher = createPublicFetch(adapters.web);
  const webPages = createWebPages({
    db,
    dataDir,
    now,
    documents,
    languages: () =>
      settings.get().language === "zh-CN" ? ["zh-CN", "zh;q=0.9", "en;q=0.8"] : ["en", "*;q=0.5"],
    pictureFetch: pictureFetcher.fetch,
    ...(adapters.pageLook ? { look: adapters.pageLook } : {}),
    keepLookByDefault: () => settings.get().user.keepWebPageLook,
    localOnly: () => embedding.localOnly(),
    signal: lifetime.signal,
    reportError: (error) => console.error("A web page's picture or look couldn't be kept:", error),
    ...adapters.webPages,
  });
  webPages.dropPurged().catch((error: unknown) => console.error(error));
  // A Citation was made, in an Answer (in a Mind or a conversation) or with a suggestion the
  // User accepted: its page is saved in the background.
  events.on("answer.finished", (finished) => citedPages.citationsMade(finished.citations));
  events.on("suggestion.accepted", (accepted) => citedPages.citationsMade([accepted.citation]));
  citedPages.start();
  let skills: ReturnType<typeof createSkills>;
  try {
    skills = createSkills({
      db,
      dataDir,
      now,
      reportError: (error) => console.error(error),
      builtInSkills: adapters.paths.builtInSkills,
    });
  } catch (error) {
    lifetime.abort();
    documents.close();
    embeddingModel.close();
    db.close();
    throw error;
  }
  /** Skills changed: say so; whether scripts can run, and so what chat sends, may have too. */
  const skillsChanged = () => {
    events.emit("skills.changed", skills.list());
    if (syncChatFlow()) readinessChanged().catch((error: unknown) => console.error(error));
  };

  /** The embedding settings, with the rebuild's progress; a rebuild that has finished ends here. */
  const embeddingSettings = async (): Promise<EmbeddingSettings> => {
    const reason = embedding.rebuildReason();
    let rebuild: EmbeddingSettings["rebuild"] = null;
    if (reason) {
      const progress = documents.embeddingProgress();
      if (progress.done >= progress.total) embedding.endRebuild();
      else rebuild = { reason, ...progress };
    }
    return {
      provider: await embedding.provider(),
      localOnly: embedding.localOnly(),
      rebuild,
      error: embedding.error(),
    };
  };
  embeddingChanged = () => {
    embeddingSettings().then(
      (current) => {
        if (!lifetime.signal.aborted) events.emit("embedding.changed", current);
      },
      (error: unknown) => {
        // Reading the keychain is async, so the core may have closed meanwhile.
        if (!lifetime.signal.aborted) console.error(error);
      },
    );
  };
  /** The rebuild's progress last reported, so each Document finishing is reported once. */
  let reportedProgress = "";
  rebuildMayHaveProgressed = () => {
    if (!embedding.rebuildReason()) return;
    const { total, done } = documents.embeddingProgress();
    const progress = `${done}/${total}`;
    if (progress === reportedProgress) return;
    reportedProgress = progress;
    embeddingChanged();
  };

  /** Reports rerank's settings again; set once rerank exists. */
  let reportRerank = () => {};
  // The built-in reranking model, the default: downloaded once there are Documents to search.
  const rerankingModel = createRerankingModel({
    definition: BUILT_IN_RERANKING_MODEL,
    source: adapters.rerankingModelSource,
    sources: modelSources,
    dataDir,
    crossEncoder: adapters.crossEncoder,
    emitStatus: () => reportRerank(),
    log: adapters.log ?? silentLogger,
  });
  // Rerank: the built-in model by default, a Cohere or Voyage key (paused in local mode), or off.
  const rerank = createRerank({
    settings,
    secrets,
    consent,
    createModel: adapters.createRerankingModel ?? createAiSdkRerankingModel,
    builtIn: rerankingModel,
    localOnly: () => embedding.localOnly(),
    signal: lifetime.signal,
  });
  const rerankChanged = async () => {
    const status = await rerank.status();
    if (!lifetime.signal.aborted) events.emit("rerank.changed", status);
    return status;
  };
  reportRerank = () => {
    if (!rerank.usesBuiltIn()) return;
    rerankChanged().catch((error: unknown) => {
      // Reading the keychain is async, so the core may have closed meanwhile.
      if (!lifetime.signal.aborted) console.error(error);
    });
  };
  prepareRerank = () => rerank.prepare();
  // Documents to search from an earlier run: the built-in reranking model downloads now, or
  // carries on from where the app quit, if it reranks them.
  if (documents.searchableCount() > 0) rerank.prepare();
  /** Set once outside agents exist: Local mode pauses them. */
  let agentsLocalModeChanged = () => {};
  /** Where meeting audio may go changed: a live cloud stream whose gate closed stops now (#141). */
  let transcriptionGateChanged = () => {};
  /** Set once Connectors exist: Local mode pauses those on other computers. */
  let connectorsLocalModeChanged = () => {};
  /**
   * Local mode on or off: embeddings may switch back to the built-in model,
   * rerank pauses, usage data stops, and outside agents pause.
   */
  const setLocalOnly = async (enabled: unknown) => {
    const wasLocal = embedding.localOnly();
    await embedding.setLocalOnly(enabled);
    library.resume();
    if (embedding.localOnly()) {
      // A prompt still open for a cloud service closes: whatever the User answers, nothing goes (ADR-0022).
      consent.refuseWaiting(
        ({ flow }) => !consent.onThisComputer(flow.id, flow.service.id),
        () => new LocalModeError(),
      );
    }
    transcriptionGateChanged();
    if (wasLocal !== embedding.localOnly()) {
      usageData.localModeChanged();
      privacyChanged();
      agentsLocalModeChanged();
      connectorsLocalModeChanged();
      await rerankChanged();
      // Questions to a cloud model are refused now (or allowed again): the chat model's readiness changed.
      await readinessChanged();
      // An Answer on its way to a cloud model stops at once, with the reason.
      if (embedding.localOnly()) await answers.stopCloud();
    }
    return embeddingSettings();
  };

  // Sign-in changes can happen in the middle of a request (a refresh that fails), so they report through events.
  let chatGptChanged = () => {};
  let chatGptLimitsChanged = () => {};
  const chatGptStore = adapters.chatGptStore;
  const chatGpt = createChatGptPlan({
    endpoints: { ...CHATGPT_PLAN_ENDPOINTS, ...adapters.chatGptPlan },
    secrets,
    ...(chatGptStore && {
      sharedStore: {
        secrets: createSecrets(chatGptStore.keychain, settings, rememberSecret),
        refreshLock: createFileLock(chatGptStore.lockFile),
      },
    }),
    settings,
    browser: adapters.browser,
    now: () => (adapters.now?.() ?? new Date()).getTime(),
    onChange: () => chatGptChanged(),
    onLimitsChange: () => chatGptLimitsChanged(),
  });
  // What the experimental ChatGPT provider left on this device goes (see migration 53).
  chatGpt.forgetCodexSignIn().catch((error: unknown) => {
    console.error("The experimental ChatGPT provider's sign-in couldn't be removed.", error);
  });
  let claudeAccountChanged = () => {};
  const claudeProfile = adapters.claudeAccount ?? ANTHROPIC_OAUTH;
  const claudeAccount = createClaudeAccount({
    config: claudeProfile,
    secrets,
    language: () => settings.get().language,
    browser: adapters.browser,
    now: () => (adapters.now?.() ?? new Date()).getTime(),
    onChange: () => claudeAccountChanged(),
  });
  let copilotChanged = () => {};
  const copilotProfiles = adapters.copilotProfiles ?? COPILOT_PROFILES;
  const copilot = createCopilotAccount({
    profiles: copilotProfiles,
    secrets,
    browser: adapters.browser,
    now: () => (adapters.now?.() ?? new Date()).getTime(),
    onChange: () => copilotChanged(),
  });
  const meter = createMeter({
    db,
    now: () => adapters.now?.() ?? new Date(),
    cap: () => settings.get().user.monthlyCap,
    timings,
  });
  // Nothing is in flight yet: what is still reserved was left by a crash.
  meter.settleOpen();
  const chat = createChat({
    db,
    now,
    settings,
    secrets,
    consent,
    createModel: adapters.createChatModel ?? createAiSdkChatModel,
    chatGpt,
    claudeAccount,
    copilot,
    ollamaModels: adapters.ollamaModels ?? createOllamaModels(),
    localOnly: () => embedding.localOnly(),
    meter,
  });

  /** Set once readiness can be reported: Connectors turned on or off change what chat sends. */
  let connectorsToggled = () => {};
  const connectors = createConnectors({
    db,
    now,
    clock: () => (adapters.now?.() ?? new Date()).getTime(),
    secrets,
    processes: adapters.processes,
    browser: adapters.browser,
    consent,
    localOnly: () => embedding.localOnly(),
    signInPages: (name) => {
      const { language } = settings.get();
      return {
        success: {
          title: translate(language, "remoteConnectors.page.success.title", { name }),
          body: translate(language, "remoteConnectors.page.success.body"),
        },
        failure: {
          title: translate(language, "remoteConnectors.page.failure.title", { name }),
          body: translate(language, "remoteConnectors.page.failure.body"),
        },
      };
    },
    onChange: (list) => events.emit("connectors.changed", list),
    onEnabledChange: () => connectorsToggled(),
    reportError: (error) => console.error(error),
    ...(adapters.connectorSignInTimeoutMs !== undefined && {
      timing: { signInTimeoutMs: adapters.connectorSignInTimeoutMs },
    }),
  });
  connectorsLocalModeChanged = () => connectors.localModeChanged();
  /** Skill scripts can run: the User hasn't turned them off, and a Skill that is on has some. */
  const scriptsOffered = () =>
    settings.get().device.skillScriptsEnabled && skills.anyEnabledWithScripts();
  /**
   * With a Connector on, Answers send the chat model what its Tools return,
   * so the chat flow sends "tool-results" too, and asks again for it. So do
   * Skill scripts that can run (#41): what they print could be anything.
   *
   * Skills alone don't: their Tools (`use_skill`, `read_skill_file`) return
   * only the text of Skills the User imported, which is sent like the system
   * prompt, not data fetched from another service.
   */
  const sendsToolResults = () => connectors.anyEnabled() || scriptsOffered();
  /** Whether the chat flow sends "tool-results", as last registered. */
  let toolResultsSent: boolean | null = null;
  /** Registers what the chat flow sends now; true if "tool-results" came or went. */
  const syncChatFlow = (): boolean => {
    const flow = consent.registry.get("chat");
    if (!flow) return false;
    const withResults = sendsToolResults();
    const sends = withResults ? [...CHAT_FLOW_SENDS, "tool-results" as const] : CHAT_FLOW_SENDS;
    consent.registry.register({ ...flow, sends });
    const changed = toolResultsSent !== null && toolResultsSent !== withResults;
    toolResultsSent = withResults;
    return changed;
  };
  syncChatFlow();

  // The programs Tools start go through one Executor (#61): by default the local one, at
  // sandbox level "none".
  const executor =
    adapters.executor ??
    createLocalExecutor({
      processes: adapters.processes,
      tempDir: adapters.paths.tempDir ?? tmpdir(),
      reportError: (error) => console.error(error),
    });
  // Running Skill scripts (#41), each in its own temporary folder.
  const scriptRunner = createScriptRunner({ executor, runtimes: adapters.scriptRuntimes });

  // Asking the User before a Connector Tool that may change something runs (#38).
  const approvals = createApprovals({
    db,
    events,
    now,
    owners: {
      connectors: () => new Map(connectors.list().map((each) => [each.id, each.name])),
      skills: () => new Map(skills.list().map((each) => [each.id, each.name])),
    },
  });

  const questions = createQuestions(events);

  // Requests to one service kept apart, as its operator asks: Look up and Find sources share them.
  const paceTimers = adapters.paceTimers ?? realTimers;
  const pace = createPace(paceTimers);
  // Find sources (#296): searches Source providers with consent, never in local mode, and adds
  // what the User chooses to the Library, as Documents (open copies) or reference records.
  const sources = createSources({
    db,
    now,
    clock: () => paceTimers.now(),
    consent,
    localOnly: () => embedding.localOnly(),
    secrets,
    providers: createSourceProviders(adapters.sourceProviders, async (id) => {
      try {
        return storedApiKey(await secrets.tryGet(sourceKeySecret(id)));
      } catch (error) {
        if (error instanceof KeyCharacterError)
          throw new SourceError("key-rejected", error.message);
        throw error;
      }
    }),
    http: createSourceHttp(pace, paceTimers),
    folder: join(dataDir, "Sources"),
    checkFolder: (folderId) => {
      library.target({ groupId: folderId });
    },
    async addFile(path, folderId, added) {
      const batchId = batches.begin(folderId);
      try {
        const result = await documents.add([path], (documentId) => {
          batches.added(batchId, documentId);
          added(documentId);
        });
        return result.documents[0] ?? null;
      } finally {
        batches.done(batchId);
      }
    },
    async savePage(address, folderId, added) {
      // A found source's copy is the text the User asked for, not how its page looks.
      const result = await webPages.save({ address, keepLook: false }, added);
      if (result.outcome === "failed") return null;
      if (!result.existing && folderId !== null) library.assign(result.document.id, folderId);
      return { document: documents.get(result.document.id), existing: result.existing };
    },
    document: (id) => documents.get(id),
    signal: lifetime.signal,
    reportError: (error) => console.error(error),
  });
  // A provider is asked only once the User searches it, as Look up's services are: the Privacy
  // page lists each one the User has decided on, to revoke.
  consent.registry.register({
    id: "find-sources",
    sends: FIND_SOURCES_SENDS,
    sendsTo: (serviceId) => sources.sendsTo(serviceId),
    services: async () => [],
  });
  sources.dropPurged().catch((error: unknown) => console.error(error));
  /** The User's Documents searched as an Answer searches them: the search Tool, reranked as the User chose unless `rerank` is false. */
  const timedRerank = (reranker: Reranker | undefined): Reranker | undefined =>
    reranker &&
    ((query, candidates, signal) =>
      timings.local(
        "rerank",
        rerank.usesBuiltIn() ? BUILT_IN_RERANKING_MODEL.name : "rerank service",
        () => reranker(query, candidates, signal),
        () => candidates.length,
      ));
  const searchDocuments = (
    query: string,
    documentIds: readonly string[] | null,
    signal?: AbortSignal,
    { rerank: reranking = true, parameters }: AnswerSearchOptions = {},
  ) => {
    const options = {
      signal,
      rerank: reranking ? timedRerank(adapters.reranker ?? rerank.active()) : undefined,
      documentIds: documentIds ?? undefined,
      ...(parameters && { parameters }),
    };
    const tuning = adapters.answerSearch;
    return tuning
      ? tunedSearch(tuning, query, options, (tuned) => documents.searchTool(query, tuned))
      : documents.searchTool(query, options);
  };
  const resolveScope = (scope: SearchScope) =>
    resolveSearchScope(scope, {
      folderTree: (folderId) => folders.subtree(folderId),
      organizedFolderDocuments: (folderId) => library.documentIds(folderId),
      documentIds: (filter) => documents.ids(filter),
    });
  const searchedScope = (scope: SearchScope | null, mindId: string | null) => {
    const folderId = mindId !== null && mindExists(mindId) ? minds.get(mindId).folderId : null;
    const holds =
      folderId !== null &&
      documents
        .getMany(resolveScope({ folderIds: [folderId], tagIds: [], documentIds: [] }) ?? [])
        .some(holdsText);
    const searched = mindSearchScope(
      scope ?? { folderIds: [], tagIds: [], documentIds: [] },
      folderId,
      holds,
    );
    return hasSearchScope(searched) ? searched : null;
  };
  // A scope's Folder is a Library Folder, or one of a Linked folder's (the "@" picker offers both).
  const scopeItemName = (kind: ScopeKind, id: string): string | null =>
    kind === "folder"
      ? ([...library.folders(), ...folders.list()].find((folder) => folder.id === id)?.name ?? null)
      : kind === "tag"
        ? (tags.list().find((tag) => tag.id === id)?.name ?? null)
        : (documents.getMany([id])[0]?.name ?? null);
  // A Folder of the Library holds no file that isn't a Document, so it names the folders on disk
  // its Documents are in: a Linked folder filed into it whole names the Linked folder.
  const foldersOnDisk = (folderIds: readonly string[]) => {
    const all = folders.list();
    const named = all.filter((folder) => folderIds.includes(folder.id));
    const filed = new Set(
      folderIds
        .filter((id) => !named.some((folder) => folder.id === id))
        .flatMap((id) => documents.getMany(library.documentIds(id)))
        .map((document) => document.folderId),
    );
    return [...named, ...all.filter((folder) => filed.has(folder.id))];
  };
  const unreadIn = (wanted: SearchScope | null): UnreadFile[] => {
    const inScope = wanted ? resolveScope(wanted) : null;
    const unread = findUnreadDocuments(documents.unread(inScope ?? undefined));
    // Files in a format not read belong to folders on disk only: a Tag or a Document can't name
    // them. A folder holds those in it and under it, even where no Document is.
    const named = wanted ? foldersOnDisk(wanted.folderIds) : null;
    const files = documents.linkedFolders
      .unsupportedFiles()
      .filter(
        (file) =>
          named === null ||
          named.some(
            (folder) =>
              folder.linkedFolderId === file.linkedFolderId &&
              (folder.relativePath === "" ||
                file.relativeFolder === folder.relativePath ||
                file.relativeFolder.startsWith(`${folder.relativePath}/`)),
          ),
      )
      .map(
        (file): UnreadFile => ({
          id: file.path,
          name: file.name,
          reason: "format",
          extension: file.extension,
          documentId: null,
          pages: [],
        }),
      );
    // By name, the same in every interface language: the order they were added in can tie.
    return [...unread, ...files].sort(
      (a, b) => a.name.localeCompare(b.name, "en", { numeric: true }) || a.id.localeCompare(b.id),
    );
  };
  // What checks and comparison tables search (#80): as Answers do, without IncarnaMind's own
  // files and the document being checked. Answers themselves search everything, as before.
  const evidence = createEvidence({
    db,
    leaveOutOwnFiles: () => settings.get().user.leaveOutOwnFiles,
    search: (query, options) =>
      documents.searchTool(query, {
        ...options,
        rerank: timedRerank(adapters.reranker ?? rerank.active()),
      }),
  });

  // Web search through the Answer's model's provider (#128): asked for once per provider, as
  // Find sources' are, so the Privacy page lists each one the User has decided on.
  consent.registry.register({
    id: "web-search",
    sends: WEB_SEARCH_SENDS,
    services: async () => [],
  });
  const webSearch = createWebSearch({
    enabled: () => settings.get().user.webSearch && !embedding.localOnly(),
    readiness: (model) => chat.readiness(model),
    prepare: (model) => chat.prepareModel(model, "web-search", "off"),
    // A page an Answer saves is never loaded whole: that is for the User to ask for, page by page.
    savePage: (address, fetch) =>
      webPages.save({ address, keepLook: false }, undefined, fetch, "search"),
    folderOf: (place) => {
      try {
        if (place.mindId !== null) return minds.get(place.mindId).folderId;
        return place.conversationId ? conversations.get(place.conversationId).folderId : null;
      } catch (error) {
        // Deleted while the Answer was written: the page stays in no Folder.
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
    file: (documentId, folderId) => library.assign(documentId, folderId),
    document: (id) => documents.get(id),
    onStatus: (listener) => events.on("document.status", listener),
    ...(adapters.web && { fetch: adapters.web }),
  });

  const answerEngine =
    adapters.answerEngine ?? createAiSdkAnswerEngine({ runEngine: adapters.runEngine });
  // The assistant's commands go through the core's own interface, as the window's clicks do (#1110).
  let api: Core | null = null;
  const commandSteps = createCommandSteps();
  const commandsHost: CommandsHost = {
    get core() {
      if (!api) throw new Error("The core isn't ready for commands yet.");
      return api;
    },
    outputFolder: async () => outputs.settings().location,
    exportMind: async (mindId, format, folder, approved, marking) => {
      let options = optionsFor(format, settings.get().user.exportOptions);
      let settled: MarkingSettled | null = null;
      if (format === "docx") {
        const { docx } = settings.get().user.exportOptions;
        if (docx.markAiText === null) {
          const ask = markAiTextQuestion(settings.get().language);
          const asked =
            marking.named === null && marking.asking ? await marking.asking(ask.question) : null;
          const choice = marking.named ?? ask.choiceOf(asked);
          if (choice === null) {
            throw new InvalidInputError({
              key: marking.asking
                ? "error.commands.markAiTextClosed"
                : "error.commands.markAiTextAsk",
            });
          }
          const preferences = settings.get().user.exportOptions;
          await api?.updateSettings({
            user: {
              exportOptions: { ...preferences, docx: { ...preferences.docx, markAiText: choice } },
            },
          });
          settled = { choice, how: "kept" };
          options = optionsFor(format, settings.get().user.exportOptions);
        } else if (marking.named !== null && marking.named !== docx.markAiText && options) {
          options = { ...options, markAiText: marking.named === "mark" };
          settled = { choice: marking.named, how: "this-file" };
        } else {
          settled = { choice: docx.markAiText, how: "earlier" };
        }
      }
      if (!options) throw new InvalidInputError({ key: "error.commands.markAiTextAsk" });
      if (
        hasCitationPlace(format) &&
        settings.get().user.exportOptions.citationPlace === undefined
      ) {
        const { numbered, citations, citedDocuments } = mindExports.preview(mindId, { format });
        if (numbered && citations > 0 && marking.asking) {
          const ask = citationPlaceQuestion(settings.get().language, {
            citations,
            documents: citedDocuments,
          });
          const choice = ask.choiceOf(await marking.asking(ask.question));
          if (choice === null)
            throw new InvalidInputError({ key: "error.commands.citationPlaceClosed" });
          const preferences = settings.get().user.exportOptions;
          await api?.updateSettings({
            user: { exportOptions: { ...preferences, citationPlace: choice } },
          });
          options = { ...options, citationPlace: choice };
        }
      }
      const { fileName, data, word } = await mindExports.export(mindId, options);
      // The window shows first what a Word file can't keep (#105); the assistant can't.
      if (word && word.notKept.length > 0) {
        throw new InvalidInputError({ key: "error.commands.wordLoses" });
      }
      const file = await outputs.save({
        name: fileName,
        data,
        ownFile: ownFileOf(options),
        ...(folder !== null && { folder, approved }),
      });
      recordExport(options);
      return { file, marking: settled };
    },
  };

  const answers = createAnswers({
    content,
    events,
    engine: answerEngine,
    requireMind: (mindId) => writableMind(mindId).id,
    mindExists,
    readableMindName: (mindId) => {
      const found = minds.locate(mindId);
      if (!found || found.deletedAt !== null) return null;
      if (!isKnownKind(minds.get(mindId).kind)) return null;
      return found.name || translate(settings.get().language, "mind.untitled");
    },
    liveTranscript: (mindId) => liveTranscriptOf(mindId),
    meetingHelp: (mindId, question) => meetingHelpOf(mindId, question),
    providerExists: (providerId) => chat.exists(providerId),
    defaultModel: () => settings.get().user.chatModel,
    readiness: async (choice) => chat.readiness(await chat.answeringModel(choice)),
    prepareModel: (choice, thinking) => chat.prepareModel(choice, "chat", thinking),
    async prepareQuickModel(answers, prepared) {
      const quick = chat.quickTasksModel(answers);
      // An Answer on this computer keeps its small calls there too.
      const stayHere =
        !quick ||
        (prepared.provider.service === null && chat.describeModel(quick)?.service !== null);
      // Even the Answers model is prepared again: as the Answer's it thinks, and that fills a small call.
      return (await chat.prepareModel(stayHere ? answers : quick, "chat", "off")).model;
    },
    documents: {
      searchableCount: (documentIds) => documents.searchableCount(documentIds ?? undefined),
      names: () => documents.names(),
      searchableNames: (documentIds, limit) =>
        documents.searchableNames(documentIds ?? undefined, limit),
      searchableBySize: (documentIds) => documents.searchableBySize(documentIds ?? undefined),
      passagesBetween: (documentId, from, to) => documents.passagesBetween(documentId, from, to),
      recheckWhereSelected: (quote) => recheckWhereSelected(documents, quote),
      searchableLanguages: (documentIds) => documents.searchableLanguages(documentIds ?? undefined),
      unread: (documentIds) => findUnreadDocuments(documents.unread(documentIds ?? undefined)),
      reading: (documentIds) =>
        documents.reading(documentIds ?? undefined).map((each) => ({ name: each.name })),
      search: searchDocuments,
      citationSource: (passageId) => documents.citationSource(passageId),
      pageTexts: (documentId, contentHash, from, to) =>
        documents.pageTexts(documentId, contentHash, from, to),
      documentDate: (documentId) => documents.documentDate(documentId),
    },
    toolProviders: [
      {
        kind: "connector",
        tools: async (signal) =>
          (await connectors.tools(signal)).filter(
            (tool) =>
              tool.provider.kind !== "connector" ||
              !approvals.turnedOff({
                kind: "tool",
                connectorId: tool.provider.id,
                tool: tool.providerTool,
              }),
          ),
      },
      { kind: "sources", tools: async () => sources.tools() },
    ],
    connectorsNeedingSignIn: () => connectors.needingSignIn(),
    web: webSearch,
    commands: {
      host: commandsHost,
      findable: async () => {
        const { core } = commandsHost;
        const [listed, mindsNow, libraryNow, tagsNow] = await Promise.all([
          core.listDocuments(),
          core.listMinds(),
          core.getLibrary(),
          core.listTags(),
        ]);
        return { documents: listed, minds: mindsNow, library: libraryNow, tags: tagsNow };
      },
      steps: commandSteps,
    },
    // The assistant changes Minds and makes them, as Proposals (#202).
    minds: {
      list: () =>
        minds.list().flatMap((mind) =>
          isKnownKind(mind.kind)
            ? [
                {
                  id: mind.id,
                  name: mindName(mind) || translate(settings.get().language, "mind.untitled"),
                  folderId: mind.folderId,
                  changedAt: mind.updatedAt,
                },
              ]
            : [],
        ),
      read: (mindId, look) => content.read(mindId, look),
      edit: (mindId, change) => content.edit(mindId, change),
      text: (mindId, name, tokens, ids) => {
        const section = content
          .peek(mindId, (blocks) => readMind(blocks, name, null, null, ids))
          .section(tokens);
        return { text: section.text, origins: section.origins };
      },
      checkpoint: (mindId) => {
        checkpoints.save(mindId, "accept");
      },
      create: (title, folderId, headed) => {
        const mind = makeMind({ title, kind: DEFAULT_MIND_KIND, folderId }, { headed });
        return { id: mind.id, name: mindName(mind) || title };
      },
      discard: (mindId) => {
        if (!mindExists(mindId)) return;
        const { title } = minds.get(mindId);
        if (content.read(mindId, (blocks) => holdsOnlyItsTitle(blocks, title))) removeMind(mindId);
      },
      folderName: (folderId) =>
        library.folders().find((folder) => folder.id === folderId)?.name ?? null,
      writing: (mindId, place) => events.emit("mind.writing", { mindId, place }),
      proposeInMind: (input) => edits.proposeInMind(input),
      checkWritten: (input) => checks.checkWritten(input),
    },
    withdrawChanges: (changes) => {
      // Last first: a revision taken back brings back what it replaced, which an earlier call of
      // the same Answer may have written, and a Mind its first call made is empty only once the
      // calls after it are taken back.
      for (const change of [...changes].reverse()) {
        if (!mindExists(change.mindId)) continue;
        const { title } = minds.get(change.mindId);
        const emptied = content.edit(change.mindId, (blocks) => {
          resolveProposals(blocks, (ref) => ref.request === change.request, "reject");
          if (change.revised) restoreRevised(blocks, change.request);
          return holdsOnlyItsTitle(blocks, title);
        });
        if (change.created && emptied) removeMind(change.mindId);
      }
    },
    approvals: {
      decide: (call) => approvals.decide(call),
      request: (call, signal) => approvals.request(call, signal),
    },
    questions: { ask: (request, signal) => questions.ask(request, signal) },
    scripts: {
      enabled: () => settings.get().device.skillScriptsEnabled,
      timeoutSeconds: () => settings.get().device.skillScriptTimeoutSeconds,
      check: (script) => scriptRunner.check(script),
      access: (skillDir) => scriptRunner.access(skillDir),
      run: (request) => scriptRunner.run(request),
    },
    skills: {
      availability: (name) => skills.availability(name),
      openSession: (forced) => skills.openSession(forced),
    },
    // Every window hears of each message as it is added or written.
    conversations: {
      add: (input, answerModel, read, emit = true) => {
        const added = conversations.add(input, answerModel, read);
        if (emit) publishConversation(added.turn);
        return added;
      },
      publish: publishConversation,
      discard: (added) => conversations.discard(added),
      questionOf: (input) => conversations.questionOf(input),
      clearScope: (questionId) => {
        const question = conversations.clearScope(questionId);
        if (question) events.emit("conversation.message", question);
        return question;
      },
      restartAnswer: (answerId, answerModel, read, emit = true) => {
        const turn = conversations.restartAnswer(answerId, answerModel, read);
        if (emit) events.emit("conversation.message", turn.answer);
        return turn;
      },
      writeAnswer: (answerId, write) => {
        const answer = conversations.writeAnswer(answerId, write);
        if (answer) events.emit("conversation.message", answer);
        return answer !== null;
      },
    },
    resolveScope,
    workingCopyOf: (mindId) => wordImports.originalOf(mindId)?.documentIds?.[0] ?? null,
    searchedScope,
    mindFolder: (mindId) => (mindExists(mindId) ? minds.get(mindId).folderId : null),
    exampleDocuments: (mindId) => examples.documentsOf(mindId),
    unscopedDocuments: (mindId) => {
      const made = examples.made();
      if (made.documentIds.length === 0 || (mindId && made.mindIds.includes(mindId))) return null;
      const left = new Set(made.documentIds);
      return documents.ids({}).filter((id) => !left.has(id));
    },
    interfaceLanguage: () => settings.get().language,
    emptyScopeAnswer: () => translate(settings.get().language, "scope.answer.empty"),
    liveTextBehind: (lines) =>
      translate(
        settings.get().language,
        lines ? "meetings.help.textBehind.some" : "meetings.help.textBehind",
      ),
    onWritingChange: (writing) => {
      background.setAnswering(writing);
      tasks.setAnswering(writing);
    },
    reportError: (error) => console.error(error),
  });

  // Compare Documents (#98): each cell an Answer from one Document, its evidence as a check's.
  const comparisons = createComparisons({
    content,
    requireMind: (mindId) => writableMind(mindId).id,
    mindExists,
    answers,
    chat: {
      providerExists: (providerId) => chat.exists(providerId),
      readiness: (choice) => chat.readiness(choice),
      prepareModel: (choice) => chat.prepareModel(choice),
      runsLocally: (choice) => chat.metered(choice)?.billing === "free",
    },
    documents: {
      live: (ids) => documents.getMany(ids),
      searchableCount: (ids) => documents.searchableCount(ids),
    },
    evidence: (ids) => evidence.scope(ids).documentIds ?? [...ids],
    checkpoint: (mindId) => checkpoints.save(mindId, "compare"),
    tasks: {
      start: (kind, mindId, input) => tasks.start(kind, mindId, input),
      unfinished: () => tasks.unfinished(),
      isLive: (taskId) => tasks.isLive(taskId),
      updateInput: (taskId, input) => tasks.updateInput(taskId, input),
      resume: (taskId) => tasks.resume(taskId),
      stop: (taskId) => tasks.stop(taskId),
    },
    emit: (event, payload) => events.emit(event, payload),
    reportError: (error) => console.error(error),
  });

  /** A Task's name, as its notification says it. */
  const taskName = (kind: string) =>
    translate(
      settings.get().language,
      kind === COMPARISON_TASK
        ? "task.kind.comparison"
        : kind === RESEARCH_TASK
          ? "task.kind.research"
          : "task.kind.other",
    );
  /** Whether a Mind is the tab shown in a group of one of these windows. */
  const mindShown = (mindId: string | null, windowIds: readonly string[]) =>
    mindId !== null &&
    windowIds.some((windowId) =>
      layouts
        .get(windowId)
        .groups.some((group) =>
          group.tabs.some(
            (tab) =>
              tab.id === group.activeTabId &&
              tab.item.kind === "mind" &&
              tab.item.mindId === mindId,
          ),
        ),
    );
  const notifyTask = ({ task, what }: TaskNotice) => {
    const notifications = adapters.notifications;
    if (!notifications) return;
    const language = settings.get().language;
    const name = taskName(task.kind);
    const title = translate(
      language,
      what === "needs-you"
        ? "task.notify.needsYou"
        : task.status === "failed"
          ? "task.notify.failed"
          : "task.notify.finished",
      { task: name },
    );
    let mind = "";
    try {
      mind = task.mindId ? mindName(minds.get(task.mindId)) : "";
    } catch {
      mind = "";
    }
    const body = [mind, what === "finished" ? task.summary : null].filter(Boolean).join(" · ");
    notifications.show(
      { title, body: body || translate(language, "task.notify.body") },
      (windowIds) => mindShown(task.mindId, windowIds),
      () =>
        events.emit("task.shown", { taskId: task.id, mindId: task.mindId, blockId: task.blockId }),
    );
  };
  const research = createResearch({
    requireMind: (mindId) => writableMind(mindId).id,
    searchedScope,
    mindExists,
    mindName: (mindId) => (mindExists(mindId) ? mindName(minds.get(mindId)) || null : null),
    folderOfMind: (mindId) => (mindExists(mindId) ? minds.get(mindId).folderId : null),
    createMind: (title, folderId) => makeMind({ title, kind: DEFAULT_MIND_KIND, folderId }).id,
    documents: {
      webPagesSince: (ids, since) =>
        documents
          .getMany(ids)
          .filter((document) => document.kind === "web" && document.createdAt >= since)
          .map((document) => ({ id: document.id, name: document.name })),
      live: (ids) => documents.getMany(ids).map((document) => document.id),
    },
    library: {
      folderExists: (folderId) => library.folders().some((folder) => folder.id === folderId),
      folderNames: () => library.folders().map((folder) => folder.name),
      createFolder: (name, description) => library.create({ name, description }).id,
      file: (documentIds, folderId) => {
        db.transaction(() => library.move(documentIds, folderId));
        library.moved([...documentIds]);
      },
    },
    tags: {
      list: () => tags.list().map((tag) => ({ id: tag.id, name: tag.name })),
      create: (name, description) => {
        const tag = tags.create({ name, description });
        tagsChanged();
        return tag.id;
      },
      apply: (documentId, tagIds) => {
        const kept = tagsOfDocument(db, documentId)
          .filter((link) => link.source === "automatic")
          .map((link) => link.tagId);
        const decided = [...new Set([...kept, ...tagIds])].map((tagId) => ({
          tagId,
          confidence: null,
          needsReview: false,
        }));
        if (tags.applyAutomatic(documentId, decided)) announceTagged([documentId]);
      },
    },
    notes: {
      proposed: (mindId, request) => noteAdding.proposed(mindId, request),
      propose: (mindId, blocks, request, made) => noteAdding.propose(mindId, blocks, request, made),
    },
    now: () => adapters.now?.() ?? new Date(),
    reportError: (error) => console.error(error),
    chat: {
      providerExists: (providerId) => chat.exists(providerId),
      readiness: (choice) => chat.readiness(choice),
      prepareModel: (choice, thinking) => chat.prepareModel(choice, "chat", thinking),
      runsLocally: (choice) => chat.metered(choice)?.billing === "free",
    },
    answers,
    resolveScope,
    tasks: {
      start: (kind, mindId, input) => tasks.start(kind, mindId, input),
      get: (taskId) => tasks.record(taskId),
      steps: (taskId) => tasks.steps(taskId),
    },
    say: (key, params) => translate(settings.get().language, key, params),
  });
  // Tasks (#126): their journal survives a force-quit; comparison tables fill as one, and Research is one.
  const taskKinds: TaskKind[] = [
    comparisons.taskKind,
    research.taskKind,
    ...(adapters.taskKinds ?? []),
  ];
  const tasks = createTasks({
    db,
    now,
    kinds: taskKinds,
    approvals: {
      decide: (call) => approvals.decide(call),
      request: (call, signal) => approvals.request(call, signal),
    },
    retention,
    cost: (taskId) => meter.taskCost(taskId),
    changed: (task) => events.emit("task.changed", task),
    notify: notifyTask,
    stepsRunning: (running) => background.setTasksRunning(running),
    reportError: (error) => console.error(error),
  });

  // Suggest as I write (#282): Passages found and quotes checked as Answers do (see ./answers/citing).
  const citing = createCiting({
    search: searchDocuments,
    citationSource: (passageId) => documents.citationSource(passageId),
    pageTexts: (documentId, contentHash, from, to) =>
      documents.pageTexts(documentId, contentHash, from, to),
  });
  const suggestions = createSuggestions({
    enabled: () => settings.get().user.suggestWhileWriting,
    model: () => settings.get().user.chatModel,
    chat,
    consent,
    citing,
    requireMind: (mindId) => {
      writableMind(mindId);
    },
    resolveScope,
    searchedScope,
    searchableCount: (documentIds) => documents.searchableCount(documentIds ?? undefined),
    localOnly: () => embedding.localOnly(),
    events,
    readValue: (key) => settings.readDeviceValue(key),
    writeValue: (key, value) => settings.writeDeviceValue(key, value),
    now: () => adapters.now?.() ?? new Date(),
    reportError: (error) => console.error(error),
  });

  const liveDocument = (id: string): Document | undefined => {
    try {
      return documents.get(id);
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  };
  // Citation styles (#289): formatted on their own thread, from the Documents' reference records.
  const citationStyles = createCitationStyles({
    folder: adapters.paths.citationStyles,
    document: liveDocument,
  });
  const mindStyleAndText = (mindId: string) => {
    const { folderId } = minds.get(mindId);
    const { chineseText, cited } = content.read(mindId, (blocks) => {
      const versions: CitedVersions = new Map();
      addCitedVersions(blocks, versions);
      return {
        chineseText: writtenInChinese(textStart(blocks, LANGUAGE_SAMPLE)),
        cited: [...versions.keys()],
      };
    });
    const citesWorks = cited.some((id) => isPaperOrBook(liveDocument(id)?.reference ?? null));
    const context = { language: settings.get().language, chineseText, citesWorks };
    const style: MindCitationStyle = content.readSettings(mindId, (mindSettings) => ({
      style: citationStyleIn(mindSettings, context),
      chosen: chosenCitationStyle(mindSettings) !== null,
      folderDefault: folderId === null ? null : library.citationStyle(folderId),
    }));
    return { style, textLanguage: chineseText ? ("zh-CN" as const) : ("en" as const) };
  };
  const mindCitationStyle = (mindId: string): MindCitationStyle => mindStyleAndText(mindId).style;
  /** Sends a Mind to Recently deleted; its tabs close. */
  const removeMind = (mindId: unknown) => {
    const at = now();
    const deleted = db.transaction(() => {
      const mind = minds.delete(mindId, at);
      content.remove(mind.id, at);
      return mind;
    });
    content.removed(deleted.id, at);
    meetings.mindDeleted(deleted.id);
    mindsChanged();
    layouts.forgetDeletedMinds();
  };

  // Edit with AI (#93): the change comes back as Proposals; Citations it keeps are checked again.
  const edits = createEdits({
    content,
    requireMind: (mindId) => {
      writableMind(mindId);
    },
    defaultModel: () => settings.get().user.chatModel,
    chat,
    consent,
    localOnly: () => embedding.localOnly(),
    recheck: (attributes) => recheckKept(documents, attributes),
    writing: (mindId, place) => events.emit("mind.writing", { mindId, place }),
    checkpoint: (mindId) => {
      checkpoints.save(mindId, "accept");
    },
    now: () => adapters.now?.() ?? new Date(),
  });

  // Check against Documents (#96): check Runs that can only search and cite.
  const startInWritingStyle = (mindId: string) => {
    const style = settings.get().user.newMindStyle;
    if (sameStyle(style, DEFAULT_MIND_STYLE)) return;
    content.editSettings(mindId, (mindSettings) => writeMindStyle(mindSettings, style));
  };
  /** A new Mind, in the citation style last chosen for a Mind in its Folder, as its own choice (#289). */
  /**
   * With `headed`, the Mind's text starts with its title as a Heading 1 and an
   * empty line under it: a page has no title field (#908), and a Mind made with
   * its name reads as it did with one.
   */
  const makeMind = (input: NewMind, { headed = false } = {}): Mind => {
    if (input.folderId !== null) library.folder(input.folderId);
    const mind = minds.create(input);
    if (headed) {
      content.edit(mind.id, (note) =>
        insertBlocks(
          note,
          mind.title === ""
            ? [{ type: "heading", attrs: { level: 1 } }]
            : [
                {
                  type: "heading",
                  attrs: { level: 1 },
                  content: [{ type: "text", text: mind.title }],
                },
                { type: "paragraph" },
              ],
        ),
      );
    }
    const style = input.folderId === null ? null : library.citationStyle(input.folderId);
    if (style !== null) {
      content.editSettings(mind.id, (mindSettings) => setCitationStyle(mindSettings, style));
    }
    startInWritingStyle(mind.id);
    mindsChanged();
    usageData.record({ event: "mind_created", fields: {} });
    return mind;
  };

  const checks = createChecks({
    language: () => settings.get().language,
    content,
    requireMind: (mindId) => {
      writableMind(mindId);
    },
    requireFolder: (folderId) => void library.folder(folderId),
    async addFile(path, folderId) {
      const fresh = new Set<string>();
      const added = await addDocuments(
        [path],
        folderId === null ? {} : { groupId: folderId },
        (documentId) => fresh.add(documentId),
      );
      const [document] = added.documents;
      // Someone else's file, checked: not proof of its own claims. One the Library already had keeps the User's choice.
      return document && fresh.has(document.id)
        ? documents.setNotCited(document.id, true)
        : (document ?? null);
    },
    document: (documentId) => documents.get(documentId),
    onStatus: (listener) => events.on("document.status", listener),
    readText: (documentId) => documents.readText(documentId),
    readScanned: (documentId) => documents.readScannedText(documentId),
    async readTables(documentId) {
      if (documents.get(documentId).kind !== "pdf") return new Map();
      try {
        const bytes = await readFile(await documents.filePath(documentId));
        return await pdfTablePages(bytes, await pdfPasswords.of(documentId));
      } catch (error) {
        // Its text, as read for the Library, still makes the Mind: only the tables' layout is lost.
        (adapters.log ?? silentLogger).warn("verify.tables_unread", {
          documentId,
          message: error instanceof Error ? error.message : String(error),
        });
        return new Map();
      }
    },
    // Named so it doesn't share its Document's name in ⌘K and the sidebar.
    createMind: (title, folderId) =>
      makeMind({
        title: translate(settings.get().language, "verify.mindTitle", { name: title }),
        kind: DEFAULT_MIND_KIND,
        folderId,
      }),
    watch: {
      minds: () => minds.list().map((mind) => ({ id: mind.id, folderId: mind.folderId })),
      documentVersions: () =>
        new Map(documents.list().map((document) => [document.id, document.contentHash])),
      background,
      runCost: (runId) => meter.taskCost(runId),
      delayMs: adapters.contradictionWatch?.delayMs ?? AFTER_NEW_VERSION_MS,
      claimTimeLimitMs: adapters.contradictionWatch?.claimTimeLimitMs ?? CLAIM_TIME_LIMIT_MS,
      log: adapters.log ?? silentLogger,
    },
    mindFolder: (mindId) => minds.get(mindId).folderId,
    searchedScope,
    originalOf: (mindId) => wordImports.originalOf(mindId),
    defaultModel: () => settings.get().user.chatModel,
    modelInUse: (own) => chat.modelInUse(own),
    recordAiUse: (inputs) => void aiUse.record(inputs),
    chat,
    consent,
    localOnly: () => embedding.localOnly(),
    resolveScope,
    unread: unreadIn,
    evidence,
    documents: {
      searchableCount: (documentIds) => documents.searchableCount(documentIds ?? undefined),
      joinedAfter: (documentIds, since, folderId) =>
        documents.searchableJoinedAfter(documentIds ?? undefined, since, folderId),
      names: () => documents.names(),
      searchableLanguages: (documentIds) => documents.searchableLanguages(documentIds ?? undefined),
      savedBySearch: (documentId) => documents.getMany([documentId])[0]?.web?.origin === "search",
      citationSource: (passageId) => documents.citationSource(passageId),
      pageTexts: (documentId, contentHash, from, to) =>
        documents.pageTexts(documentId, contentHash, from, to),
      documentDate: (documentId) => documents.documentDate(documentId),
    },
    engine: answerEngine,
    retention,
    editText,
    now: () => adapters.now?.() ?? new Date(),
  });

  // "Add to note" into a Mind that isn't open (#201), with its Citations checked where they land.
  const noteAdding = createNoteAdding({
    content,
    requireMind: (mindId) => writableMind(mindId).id,
    recheck: (input) => recheckCitation(documents, input),
    askedScope: ({ from }) =>
      from.artifactKind === "conversation"
        ? conversations.askedScope(from.artifactId, from.anchor.messageId)
        : null,
    mindFolder: (mindId) => minds.get(mindId).folderId,
    recordAiUse: (inputs) => void aiUse.record(inputs),
    now: () => adapters.now?.() ?? new Date(),
  });

  // The AI use statement (#739): a new Mind, made from what the Mind records.
  const aiUseStatement = createAiUseStatement({
    mind: (mindId) => minds.get(mindId),
    read: (mindId, look) => content.peek(mindId, look),
    entries: (mindId) => aiUse.list(mindId),
    providers: () => chat.list(),
    documents: () => documents.list(),
    keptCitationTexts: () => documents.keptCitationTexts(),
    language: () => settings.get().language,
    createMind: makeMind,
    write: (mindId, blocks) => content.edit(mindId, (note) => void insertBlocks(note, blocks)),
    now,
  });

  // The fingerprints of the files IncarnaMind writes (#80). A Document already indexed with
  // the same bytes is marked at once, and every window hears of it.
  const ownFiles = createOwnFiles(db, now);
  const recordOwnFile = (data: Uint8Array, kind: OwnFileKind) => {
    const marked = ownFiles.record(data, kind);
    for (const document of documents.getMany(marked)) events.emit("document.status", document);
  };
  const exportDependencies: ExportsDependencies = {
    mind: (mindId) => minds.get(mindId),
    read: (mindId, look) => content.read(mindId, look),
    liveDocuments: () => documents.list(),
    keptCitationTexts: () => documents.keptCitationTexts(),
    readableQuote: ({ documentId, contentHash, pageFrom, pageTo, quote }) =>
      documentId && quote
        ? documents.readableQuote({
            documentId,
            contentHash: contentHash ?? null,
            pageFrom: pageFrom ?? null,
            pageTo: pageTo ?? null,
            quote,
          })
        : null,
    language: () => settings.get().language,
    scopeItemName,
    citationStyle: (mindId) => {
      const { style, textLanguage } = mindStyleAndText(mindId);
      return { style: citationStyles.resolve(style.style, textLanguage), textLanguage };
    },
    font: (mindId) => exportedFamily(content.readSettings(mindId, mindStyleOf).font),
    lineSpacing: (mindId) => {
      const lineSpacing = lineSpacingOf(content.readSettings(mindId, mindStyleOf));
      return lineSpacing === "default" ? null : lineSpacing;
    },
    bibliography: (mindId) => content.readSettings(mindId, bibliographyShown),
    formatCitations: (request) => citationStyles.format(request),
    citedPage: (citation) => citedPages.image(citation),
    citedUnits: ({ documentId, contentHash, pageFrom, pageTo }) => {
      if (!documentId || !contentHash) return [];
      const from = typeof pageFrom === "number" ? pageFrom : null;
      const to = from === null ? null : Math.max(from, typeof pageTo === "number" ? pageTo : from);
      return documents.pageTexts(documentId, contentHash, from, to);
    },
    sharePageTextOnly: (mindId) => content.readSettings(mindId, textOnlyDocuments),
    printer: adapters.printer ?? null,
    paper: systemPaper,
    ...(adapters.pictures && { pictures: adapters.pictures }),
    wordPackage: (mindId) => wordImports.packageOf(mindId),
    author: () => settings.get().author,
    log: adapters.log ?? silentLogger,
    now,
  };
  const mindExports = createExports(exportDependencies);
  const comparisonExport = createComparisonExport(exportDependencies);
  const checkRecord = createCheckRecord({
    mind: (mindId) => minds.get(mindId),
    read: (mindId, look) => content.peek(mindId, look),
    providers: () => chat.list(),
    documents: () => documents.list(),
    keptCitationTexts: () => documents.keptCitationTexts(),
    readableQuote: ({ documentId, contentHash, pageFrom, pageTo, quote }) =>
      documentId && quote
        ? documents.readableQuote({
            documentId,
            contentHash: contentHash ?? null,
            pageFrom: pageFrom ?? null,
            pageTo: pageTo ?? null,
            quote,
          })
        : null,
    scopeItemName,
    localMode: () => embedding.localOnly(),
    language: () => settings.get().language,
    printer: adapters.printer ?? null,
    paper: systemPaper,
    now,
  });
  const ownFileOf = (options: ExportMindOptions): OwnFileKind =>
    options.format === "source-pack" ? "source-pack" : "export";
  /** Usage data: which format, and whether Questions went with it. */
  const recordExport = (options: ExportMindOptions) =>
    usageData.record({
      event: "mind_exported",
      fields: {
        format: options.format,
        // Questions are in a Markdown export unless left out, and in a .docx only if asked for.
        questions:
          typeof options.includeQuestions === "boolean"
            ? options.includeQuestions
            : options.format === "markdown",
      },
    });
  const modelInUseIn = (mindId: string) =>
    chat.modelInUse(
      content.readSettings(mindId, (mindSettings) =>
        mindSettings.doc ? mindModelOf(mindSettings.doc) : null,
      ),
    );
  // Make this a Skill: the chat model drafts it from the Mind, on the chat flow's consent.
  const skillDrafts = createSkillDrafts({
    mindMarkdown: async (mindId) => {
      const mind = new TextDecoder().decode(
        (await mindExports.export(mindId, { format: "markdown", includeQuestions: true })).data,
      );
      // Questions are asked in the assistant (#201): those asked from this Mind are its work too.
      const label = translate(settings.get().language, "export.question");
      const asked = conversations
        .askedFromMind(mindId)
        .map(({ question, answer }) => [`**${label}** ${question}`, answer].filter(Boolean));
      return [mind, ...asked.flat()].join("\n\n");
    },
    modelFor: modelInUseIn,
    chat,
  });
  // New files: in the Output location, or inside a Linked folder the User allowed.
  const outputs = createOutputFiles({
    db,
    events,
    now,
    settings,
    suggested: join(adapters.paths.documents, "IncarnaMind"),
    linkedFolders: () => documents.linkedFolders.list(),
    recordOwnFile,
  });
  /** Saves an export in the Output location, as the window's save: what went wrong is a result, not an error. */
  const saveExport = async (
    name: string,
    data: Uint8Array,
    after: () => void = () => undefined,
    ownFile: OwnFileKind = "export",
  ): Promise<SavedExport> => {
    try {
      const file = await outputs.save({ name, data, ownFile });
      after();
      return { status: "saved", file };
    } catch (error) {
      if (error instanceof FileWriteCancelledError) return { status: "cancelled" };
      if (error instanceof LinkedFolderWritesDeclinedError) {
        return {
          status: "not-allowed",
          linkedFolderId: error.linkedFolderId,
          linkedFolderPath: error.linkedFolderPath,
        };
      }
      throw error;
    }
  };
  const unlinkFolder = (linkedFolderId: string, keep: readonly string[] = []) => {
    documents.linkedFolders.remove(linkedFolderId, keep);
    outputs.forgetLinkedFolder(linkedFolderId);
  };

  // Automatic tagging: Jev when it is set up on this device, otherwise the
  // default chat model; either way its own data flow and consent.
  const jev = createJevTagging({
    settings,
    secrets,
    consent,
    hostedUrl: adapters.jevHostedUrl,
    signal: lifetime.signal,
    localOnly: () => embedding.localOnly(),
  });
  // Tagging on a plan goes gently, and waits while the plan's limit holds.
  const planPaceFor = (plan: Plan) =>
    createPlanPace({
      plan,
      pace,
      timers: paceTimers,
      resumed: () => {
        tagger.resume();
        library.resume();
      },
      signal: lifetime.signal,
    });
  const chatGptPace = planPaceFor("chatgpt");
  const claudePace = planPaceFor("claude-account");
  const planPaceOf = (kind: ChatProviderKind) =>
    kind === "chatgpt" ? chatGptPace : kind === "claude-account" ? claudePace : null;
  const rateLimit = createRateLimitPause({
    timers: paceTimers,
    resumed: () => {
      tagger.resume();
      library.resume();
    },
    signal: lifetime.signal,
  });
  // The one Tagging setting: the model automatic tagging uses, and Organize when picked by hand.
  const tagging = createTagging({
    setting: () => library.settings().classifier,
    chat: {
      list: () => chat.list(),
      defaultModel: () => settings.get().user.chatModel,
      describeModel: (choice) => chat.describeModel(choice),
      quickTasksModel: (answers) => chat.quickTasksModel(answers),
    },
    jev,
    localOnly: () => embedding.localOnly(),
    ollamaUrl: adapters.ollamaUrl ?? defaultOllamaUrl(),
    localModels: adapters.localModels ?? installedOllamaModels,
    planPausedUntil: () => chatGptPace.pausedUntil() ?? claudePace.pausedUntil(),
    now: () => paceTimers.now(),
  });
  const tagsWith = (): TaggingClassifier | null => {
    const setting = library.settings().classifier;
    return setting.kind === "automatic" ? tagging.lastResolved() : setting;
  };
  const taggingServices = async (): Promise<ExternalService[]> => {
    const classifier = await tagging.resolve();
    const service = classifier && tagging.service(classifier);
    return service ? [service] : [];
  };
  consent.registry.register({
    id: "tagging",
    sends: TAGGING_FLOW_SENDS,
    background: true,
    services: taggingServices,
  });
  /** Pushes "documents.tagged" for those of these Documents that still exist. */
  const announceTagged = (documentIds: readonly string[]) => {
    const live = documents.getMany(documentIds);
    if (live.length > 0) events.emit("documents.tagged", live);
  };
  /**
   * The User's change to one Tag on several Documents: all of it or nothing,
   * in one transaction, then one "documents.tagged" event for those that changed.
   */
  const tagMany = (documentIds: unknown, change: (documentId: string) => boolean) => {
    if (
      !Array.isArray(documentIds) ||
      !documentIds.every((id) => typeof id === "string" && id !== "")
    )
      throw new InvalidInputError("documentIds must be a list of Document ids.");
    const ids = [...new Set(documentIds as string[])];
    const changed = db.transaction(() => ids.filter((id) => change(documents.get(id).id)));
    if (changed.length > 0) events.emit("documents.tagged", documents.getMany(changed));
    return documents.getMany(ids);
  };
  const organizing = () =>
    organizeModelOf(library.settings()) !== null &&
    !!db.get("SELECT 1 FROM library_groups WHERE deleted_at IS NULL LIMIT 1");
  /**
   * Organize tags and files new Documents itself only while it does so automatically; otherwise
   * automatic tagging tags them, and they wait for Organize to be moved. Automatic covers tagging only.
   */
  const organizesNewDocuments = () => organizing() && library.settings().automatic;
  // Ollama's decision models run only on this computer, as when one is picked by hand: elsewhere
  // they would get Document text with no consent asked.
  const decisionModelElsewhere = (classifier: TaggingClassifier) =>
    (classifier.kind === "auto" || classifier.kind === "ollama") &&
    tagging.service(classifier) !== null;
  const notOnThisComputer = (classifier: TaggingClassifier) =>
    new TaggingNotReadyError({
      key:
        classifier.kind === "auto" ? "error.library.autoNotLocal" : "error.library.ollamaNotLocal",
    });
  const tagger = createTagger({
    db,
    now,
    tags,
    enabled: () => !organizesNewDocuments(),
    automatic: () => library.settings().automatic,
    organizing: (id) => organizing() && library.isOrganizing(id),
    stopped: (id) => library.taggingStoppedFor(id),
    canRun: async () => {
      const classifier = await tagging.resolve();
      if (!classifier) return false;
      if (classifier.kind === "jev") return jev.canRun();
      if (classifier.kind === "chat") {
        const readiness = await chat.readiness(classifier.choice, "tagging");
        return readiness.ready && readiness.consent !== "needed";
      }
      return !decisionModelElsewhere(classifier);
    },
    mightBeReady: () => {
      const classifier = tagsWith();
      if (!classifier || decisionModelElsewhere(classifier)) return false;
      if (embedding.localOnly() && tagging.service(classifier)) return false;
      if (classifier.kind === "jev") return jev.mightBeReady();
      if (classifier.kind === "chat") return chat.mightBeReady("tagging", classifier.choice);
      return true;
    },
    prepare: async () => {
      const classifier = await tagging.resolve();
      if (!classifier) throw new TaggingNotReadyError({ key: "error.tagging.noModel" });
      if (decisionModelElsewhere(classifier)) throw notOnThisComputer(classifier);
      if (embedding.localOnly() && tagging.service(classifier))
        throw new TaggingNotReadyError({ key: "error.tagging.cloudPaused" });
      switch (classifier.kind) {
        case "jev":
          return jev.prepare();
        case "auto": {
          const model = await tagging.textDecisionModel(classifier.baseUrl);
          if (!model)
            throw new TaggingNotReadyError({
              key: "error.tagging.installModel",
              values: { model: "tev1:4b" },
            });
          return decisionModelTagger({ baseUrl: classifier.baseUrl, model });
        }
        case "ollama":
          return decisionModelTagger({ baseUrl: classifier.baseUrl, model: classifier.modelId });
        case "chat": {
          const prepared = await chat.prepareModel(classifier.choice, "tagging");
          if (embedding.localOnly() && prepared.provider.service)
            throw new TaggingNotReadyError({ key: "error.tagging.cloudPaused" });
          // No service to send to: the model runs on a server on this computer.
          const chosen = chatClassifier(prepared.model, {
            local: prepared.provider.service === null,
          });
          const plan = planPaceOf(prepared.provider.kind);
          if (!plan) return chosen;
          return {
            ...chosen,
            decide: (input) => plan.run(() => chosen.decide(input), input.signal),
          };
        }
      }
    },
    announce: announceTagged,
    reportError: (error) => console.error(error),
    background,
    rateLimit,
    timers: paceTimers,
  });
  const automaticClassifiers = new Map<string, ReturnType<typeof automaticGroupClassifier>>();
  const library = createLibrary({
    db,
    tags,
    tagged: announceTagged,
    now,
    settings,
    background,
    changed: () => {
      events.emit("library.changed", null);
      batches.libraryChanged();
    },
    assigned: (assignments) => {
      events.emit("library.assignments", assignments);
      batches.changed(assignments.map((each) => each.documentId));
    },
    providerExists: (id) => chat.exists(id),
    rateLimit,
    readsPages: (classifier) => {
      switch (classifier.kind) {
        case "auto":
          return true;
        case "ollama":
          return supportsLibraryImages(classifier.modelId) && classifier.usePageImages === true;
        case "jev":
          return false;
        case "chat": {
          const reader = chat.imageModel(classifier.choice);
          return reader !== null && scanImagesAllowed(reader);
        }
      }
    },
    usesCloud: ({ classifier, organizeWith }) => {
      const sorts = classifier.kind === "automatic" ? organizeWith : classifier;
      if (sorts && tagging.service(sorts) !== null) return true;
      if (classifier.kind !== "automatic") return tagging.service(classifier) !== null;
      const picked = tagging.lastResolved();
      if (picked) return tagging.service(picked) !== null;
      // Not worked out yet: Jev, else the chat model, where Automatic looks first.
      if (jev.service()) return true;
      const chosen = settings.get().user.chatModel;
      return !!chosen && chat.describeModel(chosen)?.service !== null;
    },
    pagesWaitFor: (classifier) => {
      if (classifier.kind !== "chat") return null;
      const reader = chat.imageModel(classifier.choice);
      const service = reader && chat.describeModel(reader)?.service;
      return service && !scanImagesAllowed(reader) ? service : null;
    },
    async pageImages(id, contentHash, signal) {
      try {
        return await documentPageImages(
          await documents.filePath(id),
          contentHash,
          signal,
          await pdfPasswords.of(id),
        );
      } catch (error) {
        // A missing source file is a visible classification failure, not a retry loop.
        throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
      }
    },
    async prepare(settings) {
      const classifier = organizeModelOf(settings);
      if (!classifier) throw new TaggingNotReadyError({ key: "error.library.noClassifier" });
      if (decisionModelElsewhere(classifier)) throw notOnThisComputer(classifier);
      if (classifier.kind === "auto") {
        let automatic = automaticClassifiers.get(classifier.baseUrl);
        if (!automatic) {
          automatic = automaticGroupClassifier(classifier.baseUrl);
          automaticClassifiers.set(classifier.baseUrl, automatic);
        }
        return automatic;
      }
      if (classifier.kind === "ollama")
        return decisionGroupClassifier({
          baseUrl: classifier.baseUrl,
          model: classifier.modelId,
          apiKey: "ollama",
          local: true,
          usePageImages: classifier.usePageImages,
        });
      if (classifier.kind === "jev") {
        if (embedding.localOnly() && jev.service())
          throw new TaggingNotReadyError({ key: "error.tagging.cloudPaused" });
        const prepared = await jev.prepareGroups();
        if (embedding.localOnly() && !prepared.local)
          throw new TaggingNotReadyError({ key: "error.tagging.cloudPaused" });
        return prepared;
      }
      const { choice } = classifier;
      const ready = await chat.readiness(choice, "classification");
      if (embedding.localOnly() && "provider" in ready && ready.provider.service)
        throw new TaggingNotReadyError({ key: "error.tagging.cloudPaused" });
      const prepared = await chat.prepareModel(choice, "classification");
      if (embedding.localOnly() && prepared.provider.service)
        throw new TaggingNotReadyError({ key: "error.tagging.cloudPaused" });
      // A scan's page images go only where the User allowed them (the "scan-images" flow).
      const images = readsImages(prepared.capabilities) && scanImagesAllowed(choice);
      let chosen: GroupClassifier = {
        ...chatGroupClassifier(prepared.model, prepared.provider.service === null, images),
        model: { id: choice.modelId, images, reason: "selected" as const },
      };
      // A scan goes to the image model when this one can't read its pages.
      const imageModel = readsImages(prepared.capabilities) ? null : chat.imageModel(choice);
      if (imageModel && scanImagesAllowed(imageModel)) {
        chosen = withPageReader(chosen, async () => {
          const reader = await chat.prepareModel(imageModel, "classification");
          return {
            ...chatGroupClassifier(reader.model, reader.provider.service === null, true),
            model: { id: imageModel.modelId, images: true, reason: "selected" as const },
          };
        });
      }
      const plan = planPaceOf(prepared.provider.kind);
      return plan ? pacedBy(chosen, plan.run) : chosen;
    },
  });
  function scanImagesAllowed(reader: ChatModelChoice): boolean {
    const service = chat.describeModel(reader)?.service;
    return !service || consent.allows("scan-images", service);
  }
  /** The services Organize sends to: its model's, and the image model's for the scans it can't read. */
  const classificationServices = async (): Promise<ExternalService[]> => {
    const classifier = organizeModelOf(library.settings());
    const service = classifier && tagging.service(classifier);
    const reader =
      classifier?.kind === "chat" && !chat.readsImages(classifier.choice)
        ? chat.imageModel(classifier.choice)
        : null;
    const pages = reader && chat.describeModel(reader)?.service;
    return [...(service ? [service] : []), ...(pages && pages.id !== service?.id ? [pages] : [])];
  };
  consent.registry.register({
    id: "classification",
    sends: CLASSIFICATION_FLOW_SENDS,
    background: true,
    services: classificationServices,
  });
  // The page images of a scan with no text, a flow of their own that choosing a provider doesn't allow.
  consent.registry.register({
    id: "scan-images",
    sends: SCAN_IMAGES_FLOW_SENDS,
    background: true,
    services: async () => {
      const classifier = organizeModelOf(library.settings());
      const reader = classifier?.kind === "chat" ? chat.imageModel(classifier.choice) : null;
      const service = reader && chat.describeModel(reader)?.service;
      return service ? [service] : [];
    },
  });
  libraryDocumentChanged = (id) => library.documentChanged(id);
  library.start();

  // Reference records (#286): read from files as they're processed, edited by the User, and
  // filled by Look up, which sends a DOI or an arXiv id only, with consent, never in local mode.
  const references = createReferences({
    db,
    now,
    consent,
    localOnly: () => embedding.localOnly(),
    urls: { ...REFERENCE_SERVICE_URLS, ...adapters.referenceLookup },
    document: (id) => documents.get(id),
    changed: (list) => events.emit("references.changed", list),
    signal: lifetime.signal,
    pace,
  });
  // Checking a Mind's reference list sends each reference only, to Crossref, OpenAlex
  // and arXiv, once the User starts it where a line says so; never in local mode.
  const referenceChecks = createReferenceChecks({
    consent,
    localOnly: () => embedding.localOnly(),
    http: createSourceHttp(pace, paceTimers),
    urls: adapters.referenceLookup,
    content,
    db,
    now,
    progress: (event) => events.emit("referenceCheck.progress", event),
    signal: lifetime.signal,
  });
  // Importing references (#287) reads a file the User chose and sends nothing.
  const referenceImport = createReferenceImport({
    db,
    now,
    documents: () => documents.list({}),
    document: (id) => documents.get(id),
    addDocuments: (paths) => addDocuments(paths),
    changed: (list) => events.emit("references.changed", list),
    progress: (done, total) => events.emit("references.importProgress", { done, total }),
  });
  // Look up goes to Crossref or arXiv only when the User asks, so the flow goes nowhere until
  // then; the Privacy page lists each service once the User has decided on it.
  consent.registry.register({
    id: "reference-lookup",
    sends: REFERENCE_LOOKUP_SENDS,
    services: async () => [],
  });

  const wordImports = createWordImports({
    db,
    dataDir,
    content,
    minds,
    requireFolder: (folderId) => void library.folder(folderId),
    async addOriginal(path, folderId) {
      const added = await addDocuments([path], folderId === null ? {} : { groupId: folderId });
      const [document] = added.documents;
      if (!document) throw new Error(`The Library skipped it: ${added.skipped[0]?.reason}.`);
      return document.id;
    },
    newVersion: (documentId, path) => documents.newVersionFrom(documentId, path),
    documentChanged: (documentId) => events.emit("document.status", documents.get(documentId)),
    mindsChanged,
    now,
    log: adapters.log ?? silentLogger,
  });
  wordImports.resume();
  wordImports.dropPurged().catch((error: unknown) => console.error(error));
  wordImports.addLooks().catch((error: unknown) =>
    (adapters.log ?? silentLogger).error("word.look.failed", {
      error: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
    }),
  );

  const recentlyDeleted = createRecentlyDeleted({
    db,
    now,
    documentText: (documentIds) => {
      const wanted = new Set(documentIds);
      const cited: CitedUnits[] = [];
      eachCitingMind((fragment) => addCitedUnits(fragment, wanted, cited));
      conversations.addCitedUnits(wanted, cited);
      retention.addRetainedUnits(wanted, cited);
      documents.purgeText(documentIds, cited);
    },
    say: (key, params) => translate(settings.get().language, key, params),
    minds,
    content,
    conversations,
    documents,
    tags,
    library,
    mindsChanged,
    mindsRestored: (mindIds) => {
      // A Mind deleted before a restart has no lines in the index's memory, and a restore stores nothing.
      for (const mindId of mindIds) mindIndex.contentStored(mindId);
      wordImports.resume(mindIds);
    },
    conversationsChanged,
    tagsChanged,
    tagged: announceTagged,
  });
  try {
    recentlyDeleted.expire();
  } catch (error) {
    // The app still opens; what is due goes at the next start.
    console.error("Deleting what waited 30 days in Recently deleted failed.", error);
  }
  documents.dropPurged().catch((error: unknown) => console.error(error));

  /**
   * What tagging may use changed (a model, a key, local mode): Automatic picks
   * again, and Documents waiting may go on, a rate-limit pause ended too, unless
   * this is the start, which keeps the pause a quit interrupted.
   */
  const taggingChanged = async (endsPause = true) => {
    try {
      await tagging.resolve();
    } catch (error) {
      if (lifetime.signal.aborted) return;
      console.error("The model to tag with couldn't be worked out.", error);
    }
    if (lifetime.signal.aborted) return;
    if (endsPause) rateLimit.resumeNow();
    tagger.resume();
    library.resume();
    // The switch for tagging and sorting follows the model until the User sets it: say when it moved.
    const automatic = library.settings().automatic;
    if (automatic !== lastAutomatic) {
      lastAutomatic = automatic;
      events.emit("library.changed", null);
    }
  };
  let lastAutomatic = library.settings().automatic;

  /** Jev was set up, changed or removed: say so, and Documents waiting may go on. */
  const jevChanged = async () => {
    const status = await jev.status();
    if (lifetime.signal.aborted) return status;
    events.emit("jev.changed", status);
    await taggingChanged();
    return status;
  };
  /**
   * Automatic found no model to tag with: work it out again, asking Ollama afresh, so a model
   * installed since is picked up without a restart. Waiting Documents then go on. One Ollama list
   * call per lookup, never a model call. A lookup already under way may have asked before what
   * the caller knows changed, so one more follows it, and later callers share that one.
   */
  let lookingForModel: Promise<void> | null = null;
  let lookingAgain: Promise<void> | null = null;
  const lookForTaggingModel = (): Promise<void> => {
    if (tagsWith() !== null) return Promise.resolve();
    if (lookingForModel) {
      lookingAgain ??= lookingForModel.then(() => {
        lookingAgain = null;
        return lookForTaggingModel();
      });
      return lookingAgain;
    }
    lookingForModel = (async () => {
      try {
        await tagging.resolve(undefined, true);
      } catch (error) {
        if (!lifetime.signal.aborted) {
          console.error("The model to tag with couldn't be worked out.", error);
        }
        return;
      } finally {
        lookingForModel = null;
      }
      if (lifetime.signal.aborted || tagsWith() === null) return;
      tagger.resume();
      library.resume();
    })();
    return lookingForModel;
  };
  documentReady = (documentId) => {
    tagger.documentReady(documentId);
    void lookForTaggingModel();
  };

  const settingsChanged = () => events.emit("settings.changed", settings.get());
  const readinessChanged = async () => {
    try {
      const readiness = await chat.readiness();
      if (!lifetime.signal.aborted) events.emit("chatReadiness.changed", readiness);
    } catch (error) {
      // Reading the keychain is async, so the core may have closed meanwhile: nobody is listening.
      if (!lifetime.signal.aborted) throw error;
    }
    // Documents waiting for a chat model may be able to go on now.
    if (!lifetime.signal.aborted) await taggingChanged();
  };
  chatGptChanged = () => {
    const report = async () => {
      const status = await chatGpt.status();
      if (lifetime.signal.aborted) return;
      events.emit("chatGptPlan.changed", status);
      await readinessChanged();
    };
    report().catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.error(error);
    });
  };
  claudeAccountChanged = () => {
    const report = async () => {
      const status = await claudeAccount.status();
      if (lifetime.signal.aborted) return;
      events.emit("claudeAccount.changed", status);
      await readinessChanged();
    };
    report().catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.error(error);
    });
  };
  // Not a readiness change: the renderer keeps its model lists.
  chatGptLimitsChanged = () => {
    chatGpt.status().then(
      (status) => {
        if (!lifetime.signal.aborted) events.emit("chatGptPlan.changed", status);
      },
      (error: unknown) => {
        if (!lifetime.signal.aborted) console.error(error);
      },
    );
  };
  copilotChanged = () => {
    const report = async () => {
      const status = await copilot.status();
      if (lifetime.signal.aborted) return;
      events.emit("copilot.changed", status);
      await readinessChanged();
    };
    report().catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.error(error);
    });
  };

  // Tagging a quit interrupted starts again, once Automatic knows what it tags with;
  // Documents waiting for a model are checked.
  const stillLimited = db.get<{ ends: string | null }>(
    `SELECT max(tagging_error_resets_at) AS ends FROM documents
     WHERE deleted_at IS NULL AND tagging_status = 'waiting-for-provider'
       AND tagging_error_kind = 'rate-limit'`,
  )?.ends;
  if (stillLimited) rateLimit.restore(Date.parse(stillLimited));
  void taggingChanged(false).then(() => {
    if (!lifetime.signal.aborted) tagger.start();
  });

  // Traffic that carries nothing of the User's, for the Privacy page.
  const modelSource = adapters.embeddingModelSource ?? BUILT_IN_EMBEDDING_MODEL.source;
  const modelHost = new URL(modelSource.baseUrl);
  privacy.traffic.register({
    id: "embedding-model",
    service: {
      id: modelHost.origin,
      name: modelHost.host === "huggingface.co" ? "Hugging Face" : modelHost.host,
    },
    // A model with no files to download (the tests' fake) makes no traffic.
    listed: () => modelSource.files.length > 0,
  });
  const rerankingSource = adapters.rerankingModelSource ?? BUILT_IN_RERANKING_MODEL.source;
  const rerankingHost = new URL(rerankingSource.baseUrl);
  privacy.traffic.register({
    id: "reranking-model",
    service: {
      id: rerankingHost.origin,
      name: rerankingHost.host === "huggingface.co" ? "Hugging Face" : rerankingHost.host,
    },
    // While the built-in reranking model reranks: by default, unless the User chose otherwise.
    listed: () => rerankingSource.files.length > 0 && rerank.usesBuiltIn(),
  });
  const textRecognitionSource =
    adapters.textRecognitionModelSource ?? BUILT_IN_TEXT_RECOGNITION_MODEL.source;
  const textRecognitionHost = new URL(textRecognitionSource.baseUrl);
  privacy.traffic.register({
    id: "text-recognition-model",
    service: {
      id: textRecognitionHost.origin,
      name:
        textRecognitionHost.host === "huggingface.co" ? "Hugging Face" : textRecognitionHost.host,
    },
    // Only a copy that reads scans downloads it.
    listed: () => textRecognitionModel !== undefined && textRecognitionSource.files.length > 0,
  });
  const transcriptionSource = adapters.transcriptionModelSource?.model ?? QWEN3_ASR_0_6B.source;
  const transcriptionHost = new URL(transcriptionSource.baseUrl);
  privacy.traffic.register({
    id: "transcription-model",
    service: {
      id: transcriptionHost.origin,
      name: transcriptionHost.host === "huggingface.co" ? "Hugging Face" : transcriptionHost.host,
    },
    listed: () => transcriber !== undefined && transcriptionSource.files.length > 0,
  });
  // Any built-in model may come from these instead, and the probe asks ModelScope (#1578).
  const otherSources: { id: NetworkTrafficId; service: ExternalService }[] = [
    {
      id: "model-source-modelscope",
      service: {
        id: modelCopies.modelscope
          ? new URL(modelCopies.modelscope.url).origin
          : "https://www.modelscope.cn",
        name: "ModelScope",
      },
    },
    {
      id: "model-source-hf-mirror",
      service: { id: "https://hf-mirror.com", name: "hf-mirror.com" },
    },
    ...(modelCopies.r2
      ? [
          {
            id: "model-source-copy" as const,
            service: { id: new URL(modelCopies.r2.url).origin, name: "IncarnaMind" },
          },
        ]
      : []),
  ];
  for (const { id, service } of otherSources) {
    privacy.traffic.register({ id, service, listed: () => modelSource.files.length > 0 });
  }
  privacy.traffic.register({ id: "ollama-pull", service: OLLAMA_REGISTRY });
  const chatGptSignIn = new URL(
    adapters.chatGptPlan?.authorizeUrl ?? CHATGPT_PLAN_ENDPOINTS.authorizeUrl,
  );
  privacy.traffic.register({
    id: "chatgpt-sign-in",
    service: { id: chatGptSignIn.origin, name: "OpenAI" },
    listed: () => chatGpt.used(),
  });
  if (claudeProfile) {
    const { authorizeUrl, tokenUrl, revokeUrl } = claudeProfile;
    const signInHosts = new Map(
      [authorizeUrl, tokenUrl, revokeUrl]
        .filter((url): url is string => url !== undefined)
        .map((url) => new URL(url))
        .map((url) => [url.origin, url.host]),
    );
    privacy.traffic.register({
      id: "claude-sign-in",
      services: () => [...signInHosts].map(([id, name]) => ({ id, name })),
      listed: () => claudeAccount.used(),
    });
  }
  const copilotHosts = new Map(
    Object.values(copilotProfiles)
      .flatMap((profile) => [
        profile.deviceCodeUrl,
        profile.tokenUrl,
        profile.tokenExchange?.url,
        profile.apiBaseUrl,
        profile.accountUrl,
      ])
      .filter((url): url is string => url !== undefined)
      .map((url) => new URL(url))
      .map((url) => [url.origin, url.host]),
  );
  privacy.traffic.register({
    id: "copilot-sign-in",
    services: () => [...copilotHosts].map(([id, name]) => ({ id, name })),
    listed: () => copilot.used(),
  });
  privacy.traffic.register({
    id: "remote-connectors",
    services: () => connectors.remoteTraffic(),
  });
  const usageSender = adapters.usageData;
  if (usageSender) {
    privacy.traffic.register({
      id: "usage-data",
      service: usageSender.service,
      enabled: () => usageData.status().enabled,
    });
  }
  // Crash reports start now if the User opted in before; otherwise not at all.
  privacy.start();
  // So does usage data: if the User agreed before, or, in a test build, hasn't said no.
  usageData.start();
  const stopTrackingUsage = trackUsage(events, (event) => usageData.record(event), {
    chatProvider: (providerId) => chat.describe(providerId),
    connectorIsRemote: (connectorId) => {
      const connector = connectors.list().find((each) => each.id === connectorId);
      return connector ? connector.transport === "http" : null;
    },
    skillIsBuiltIn: (name) => skills.list().some((skill) => skill.name === name && skill.builtIn),
    now: () => (adapters.now?.() ?? new Date()).getTime(),
  });
  usageData.record({ event: "app_opened", fields: { language: settings.get().language } });
  /** After the User allows or revokes a flow: the flows as they are now, and what that changes. */
  const dataFlowsChanged = async () => {
    const flows = await consent.listRegistered();
    if (lifetime.signal.aborted) return;
    events.emit("dataFlows.changed", flows);
    await readinessChanged();
  };

  connectorsToggled = () => {
    syncChatFlow();
    readinessChanged().catch((error: unknown) => console.error(error));
  };
  // Connectors that are on start with the app.
  connectors.startAll();
  const directory = connectorDirectory(adapters.connectorDirectory);
  const registry = createConnectorRegistry({
    baseUrl: adapters.connectorRegistryUrl ?? REGISTRY.id,
    consent,
    localOnly: () => embedding.localOnly(),
  });
  // Asked only once the User searches, as Find sources' providers are.
  consent.registry.register({
    id: "connector-registry",
    sends: REGISTRY_SENDS,
    services: async () => [],
  });
  const layouts = createLayouts({
    readValue: (key) => settings.readDeviceValue(key),
    writeValue: (key, value) => settings.writeDeviceValue(key, value),
    mindExists: (mindId) => {
      try {
        minds.get(mindId);
        return true;
      } catch {
        return false;
      }
    },
    documentExists: (documentId) => documents.getMany([documentId]).length > 0,
    changed: (windowId, layout) => events.emit("layout.changed", { windowId, layout }),
  });
  // The example Mind: its Citations are checked once its Documents have been read.
  const examples = createExamples({
    source: adapters.paths.examples,
    dataDir,
    language: () => settings.get().language,
    readValue: (key) => settings.readDeviceValue(key),
    writeValue: (key, value) => settings.writeDeviceValue(key, value),
    createMind: (title) => {
      const mind = minds.create(parseCreateMindInput({ title }));
      mindsChanged();
      return mind;
    },
    renameMind: (mindId, title) => {
      minds.rename(mindId, title);
      mindsChanged();
    },
    mindTitle: (mindId) => minds.list().find((mind) => mind.id === mindId)?.title ?? "",
    mindExists: (mindId) => minds.list().some((mind) => mind.id === mindId),
    deleteMind: (mindId) => {
      const at = now();
      const deleted = db.transaction(() => {
        const mind = minds.delete(mindId, at);
        content.remove(mind.id, at);
        return mind;
      });
      content.removed(deleted.id, at);
      mindsChanged();
      layouts.forgetDeletedMinds();
    },
    restoreMind: (mindId) => recentlyDeleted.restore([{ kind: "mind", id: mindId }]),
    editMind: (mindId, change) => content.edit(mindId, change),
    linkFolder: (path) => documents.linkedFolders.add(path),
    unlinkFolder,
    restoreFolder: (linkedFolderId) => {
      db.transaction(() => {
        const { went } = documents.linkedFolders.restore(linkedFolderId);
        if (went.length > 0) {
          recentlyDeleted.restore(went.map((id) => ({ kind: "document" as const, id })));
        }
      });
    },
    linkedFolderExists: (linkedFolderId) =>
      documents.linkedFolders.list().some((folder) => folder.id === linkedFolderId),
    documentsIn: (linkedFolderId) => documents.list({ linkedFolderId }),
    mindFolder: (mindId) => minds.get(mindId).folderId,
    now,
    checksRelyOn: (documentIds) => retention.isRetained("check-result", documentIds),
    citationsRelyOn: (documentIds, exceptMindId) => {
      const wanted = new Set(documentIds);
      const cited: CitedUnits[] = [];
      eachCitingMind((fragment) => addCitedUnits(fragment, wanted, cited), exceptMindId);
      conversations.addCitedUnits(wanted, cited);
      return cited.length > 0;
    },
    recheck: (input) => recheckCitation(documents, input),
    changed: (value) => events.emit("examples.changed", value),
  });
  events.on("document.status", () => examples.documentChanged());
  // A new version of a Document in a Folder: its Minds' cited claims are checked for contradictions (#112).
  checks.startWatching();
  events.on("document.status", (document) => checks.documentChanged(document));
  // Linked folders and single files are compared with the disk, then watched.
  documents.start();

  const ollamaUrl = (input: unknown) => {
    if (input !== undefined && !isRecord(input)) throw new InvalidInputError("Expected an object.");
    return ollamaBaseUrl(input?.baseUrl);
  };
  const ollamaInstalled = async () => (await adapters.ollamaApp?.installed()) ?? false;
  const localServers = adapters.localServers ?? createLocalServers();

  // Transcripts (#136): a Meeting is transcribed on this computer as it records, where this copy can.
  let listMeetings: (() => Meeting[]) | undefined;
  /** See `AnswersOptions.meetingHelp`; set once Meetings are. */
  let meetingHelpOf = (_mindId: string, _question: string): MeetingHelpKind | null => null;
  /** See `AnswersOptions.liveTranscript`; set once Meetings are. */
  let liveTranscriptOf = async (_mindId: string): Promise<LiveTranscript | null> => null;
  let transcriptSaved = (_meetingId: string) => {};
  const meetingsChanged = () => {
    if (listMeetings) events.emit("meetings.changed", listMeetings());
  };
  const captureHealth = createCaptureHealth({
    dataDir,
    now,
    log: adapters.log ?? silentLogger,
    changed: meetingsChanged,
  });
  const transcriber = adapters.transcriber;
  const transcriptionModel =
    transcriber &&
    createTranscriptionModel({
      dataDir,
      transcriber,
      sources: modelSources,
      ...(adapters.transcriptionModelSource && { source: adapters.transcriptionModelSource }),
      speed: () => {
        const value = settings.readDeviceValue(TRANSCRIPTION_SPEED);
        return isRecord(value) ? (value as Record<string, number>) : {};
      },
      emitStatus: () => meetingsChanged(),
    });
  // Where meeting audio is transcribed (#141): this computer, or the cloud service the User chose.
  const cloudTranscription = createCloudTranscription({
    settings,
    secrets,
    consent,
    meter,
    localOnly: () => embedding.localOnly(),
    providerKey: (catalogId) => chat.apiKeyOf(catalogId),
    log: adapters.log ?? silentLogger,
    ...(adapters.transcriptionKeyFetch && { fetch: adapters.transcriptionKeyFetch }),
    vadFile: async () => {
      if (!transcriptionModel) throw new Error("This copy can't transcribe.");
      return transcriptionModel.vadFile();
    },
  });
  const speakerModel =
    adapters.speakerSeparator &&
    createSpeakerModel({
      dataDir,
      sources: modelSources,
      ...(adapters.speakerModelSource && { source: adapters.speakerModelSource }),
      log: adapters.log ?? silentLogger,
    });
  const speakerPass =
    adapters.speakerSeparator &&
    speakerModel &&
    createSpeakerPass({
      separator: adapters.speakerSeparator,
      model: speakerModel,
      partsOf: (meetingId) => listParts(meetingFolder(dataDir, meetingId)),
      log: adapters.log ?? silentLogger,
    });
  const transcripts =
    transcriber &&
    transcriptionModel &&
    createTranscripts({
      dataDir,
      transcriber,
      model: transcriptionModel,
      cloud: cloudTranscription,
      ...(speakerPass && { speakers: speakerPass }),
      documents: {
        add: (id, name, file) => documents.addSnapshot(id, name, file, () => {}, "transcript"),
        file: (documentId, folderId) => library.assign(documentId, folderId),
        check: (path) => documents.check(path),
        moveFile: (id, path) => documents.moveFile(id, path),
        find: (id) => {
          try {
            return documents.get(id);
          } catch {
            return null;
          }
        },
      },
      saveFile: (file) => outputs.save(file),
      name: (meetingId) => {
        const meeting = listMeetings?.().find((each) => each.id === meetingId);
        const mind = meeting ? minds.get(meeting.mindId) : null;
        const title = mind ? mind.title || mind.autoTitle : "";
        const language = settings.get().language;
        return title
          ? translate(language, "meetings.transcript.name", { meeting: title })
          : translate(language, "meetings.transcript.nameAlone");
      },
      folderOf: (meetingId) => {
        const meeting = listMeetings?.().find((each) => each.id === meetingId);
        return meeting ? minds.get(meeting.mindId).folderId : null;
      },
      partsOf: (meetingId) => listParts(meetingFolder(dataDir, meetingId)),
      audioDeleted: (meetingId) =>
        listMeetings?.().find((each) => each.id === meetingId)?.audio.deletedAt != null,
      decoded: (modelId, decodeMs, audioSeconds) =>
        timings.step("transcribe", modelId, decodeMs, audioSeconds),
      recordSpeed: (modelId, ratio) => {
        const value = settings.readDeviceValue(TRANSCRIPTION_SPEED);
        settings.writeDeviceValue(TRANSCRIPTION_SPEED, {
          ...(isRecord(value) ? value : {}),
          [modelId]: ratio,
        });
      },
      health: captureHealth,
      saved: (meetingId) => transcriptSaved(meetingId),
      changed: meetingsChanged,
      log: adapters.log ?? silentLogger,
    });

  // Meetings (#135): while audio is being captured, background model work holds back.
  const meetings = createMeetings({
    db,
    dataDir,
    now,
    capture: adapters.audioCapture,
    noticeAccepted: () => settings.get().device.meetingNoticeAccepted,
    systemAudioByDefault: () => settings.get().device.meetingSystemAudio,
    language: () => settings.get().language,
    createMind: (title, folderId) => {
      const mind = minds.create(parseCreateMindInput({ title, folderId }));
      startInWritingStyle(mind.id);
      mindsChanged();
      return mind;
    },
    mindExists: (mindId) => {
      try {
        minds.get(mindId);
        return true;
      } catch {
        return false;
      }
    },
    changed: (list) => events.emit("meetings.changed", list),
    level: (level) => events.emit("meetings.level", level),
    onCapturingChange: (capturing) => {
      background.setRecording(capturing);
      tasks.setRecording(capturing);
      documents.hold(capturing);
    },
    ...(transcripts && { transcripts }),
    health: captureHealth,
    log: adapters.log ?? silentLogger,
  });
  listMeetings = () => meetings.list();
  transcriptionGateChanged = () => transcripts?.recheckCloud();
  meetingHelpOf = (mindId, question) => {
    const meeting = meetings.liveOf(mindId);
    if (!meeting) return null;
    return (
      helpKindsFor(meeting.helpTemplate).find((kind) =>
        LANGUAGES.some((language) => translate(language, helpLabel(kind)) === question),
      ) ?? null
    );
  };
  /** The conversation each live Meeting's help went to last: the panel's goes on there. */
  const helpConversations = new Map<string, string>();
  const askMeetingHelp = async (given: unknown): Promise<ConversationAskResult> => {
    const input = isRecord(given) ? given : {};
    const meeting = meetings.get(input.meetingId);
    if (meeting.status !== "recording" && meeting.status !== "paused") {
      throw new InvalidInputError({ key: "error.meeting.notBeingRecorded" });
    }
    const { kind } = input;
    if (!isMeetingHelpKind(kind) || !helpKindsFor(meeting.helpTemplate).includes(kind)) {
      throw new InvalidInputError({ key: "error.meeting.helpButton" });
    }
    const { folderId } = minds.get(meeting.mindId);
    const question = (conversationId: unknown) =>
      conversations.parseQuestion({
        conversationId,
        text: translate(settings.get().language, helpLabel(kind)),
        mindId: meeting.mindId,
        scope: folderId ? { folderIds: [folderId], tagIds: [], documentIds: [] } : null,
        model: modelInUseIn(meeting.mindId),
      });
    let asked: QuestionInput;
    if (input.conversationId !== undefined) asked = question(input.conversationId);
    else {
      try {
        asked = question(helpConversations.get(meeting.id) ?? null);
      } catch (error) {
        // The conversation it went to last was deleted: a new one.
        if (!(error instanceof NotFoundError)) throw error;
        asked = question(null);
      }
    }
    const result = await answers.askInConversation(asked);
    if (result.asked) {
      helpConversations.set(meeting.id, result.conversation.id);
      const from = HEARD_FROM[kind];
      const newest = (speaker?: string) => transcripts?.newestLine(meeting.id, speaker) ?? null;
      meetings.helped(meeting.id, {
        kind,
        conversationId: result.conversation.id,
        answerId: result.answerId,
        heard:
          from === undefined
            ? null
            : from === "anyone"
              ? newest()
              : (newest(from === "me" ? SPEAKER_ME : SPEAKER_THEM) ?? newest()),
      });
    }
    return result;
  };
  /** Resolves once a Document's newest version has its Passages, or after `ms` with the last version's. */
  const extracted = (documentId: string, ms: number) =>
    new Promise<void>((resolve) => {
      const busy = (status: DocumentStatus | null) =>
        status === "queued" || status === "extracting";
      let status: DocumentStatus | null = null;
      try {
        status = documents.get(documentId).status;
      } catch {
        // Deleted meanwhile: there is nothing to wait for.
      }
      if (!busy(status)) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        stop();
        resolve();
      };
      const timer = setTimeout(done, ms);
      const stop = events.on("document.status", (document) => {
        if (document.id === documentId && !busy(document.status)) done();
      });
    });
  // After Stop, the notes filled in from the Transcript (#142), on the Answers route.
  const meetingFill = createMeetingFill({
    content,
    meetings,
    transcript: async (documentId) => {
      await extracted(documentId, LIVE_TRANSCRIPT_WAIT_MS);
      return documents.passagesBetween(documentId, 0, Number.MAX_SAFE_INTEGER);
    },
    async route(mindId) {
      const language = settings.get().language;
      const choice = await chat.answeringModel(modelInUseIn(mindId) ?? undefined);
      const readiness = await chat.readiness(choice);
      if (!readiness.ready) {
        return {
          problem:
            readiness.reason === "local-mode"
              ? {
                  kind: "local-mode",
                  message: translate(language, "meetings.fill.problem.localMode"),
                }
              : { kind: "no-model", message: translate(language, "meetings.fill.problem.noModel") },
        };
      }
      // Filling in never asks: a service the User hasn't allowed yet waits for an Answer to ask.
      if (readiness.consent === "needed") {
        const service = readiness.provider.service?.name ?? readiness.provider.kind;
        return {
          problem: {
            kind: "not-allowed",
            message: translate(language, "meetings.fill.problem.notAllowed", { service }),
            service,
          },
        };
      }
      const model = { providerId: readiness.provider.id, modelId: readiness.modelId };
      const prepared = await chat.prepareModel(model);
      return {
        model,
        local: chat.metered(model)?.billing === "free",
        windowTokens: prepared.window?.tokens ?? null,
      };
    },
    answers,
    async supports({ claim, mindId, transcriptId, model }) {
      const { folderId } = minds.get(mindId);
      const result = await checks.checkClaim({
        claim,
        scope: folderId ? { folderIds: [folderId], tagIds: [], documentIds: [] } : null,
        checked: { documentIds: [transcriptId] },
        model,
      });
      return result.verdict === "supported";
    },
    checkpoint: (mindId) => checkpoints.save(mindId, "enhance"),
    language: () => settings.get().language,
    filled(meeting) {
      const notifications = adapters.notifications;
      if (!notifications) return;
      let name = "";
      try {
        name = mindName(minds.get(meeting.mindId));
      } catch {
        name = "";
      }
      notifications.show(
        {
          title: translate(settings.get().language, "meetings.fill.notify", { meeting: name }),
          body: "",
        },
        (windowIds) => mindShown(meeting.mindId, windowIds),
        () => events.emit("meetings.notesShown", { mindId: meeting.mindId }),
      );
    },
    log: adapters.log ?? silentLogger,
  });
  transcriptSaved = (meetingId) => meetingFill.transcriptSaved(meetingId);
  meetingFill.resume();

  liveTranscriptOf = async (mindId) => {
    const meeting = meetings
      .list()
      .find(
        (each) =>
          each.mindId === mindId && (each.status === "recording" || each.status === "paused"),
      );
    if (!meeting) return null;
    const documentId = meeting.transcript?.documentId;
    if (!documentId || !transcripts) return { passages: [], behind: isBehind(meeting) };
    await transcripts.refresh(meeting.id);
    await extracted(documentId, LIVE_TRANSCRIPT_WAIT_MS);
    const now = meetings.list().find((each) => each.id === meeting.id) ?? meeting;
    return {
      passages: await documents.passagesBetween(documentId, 0, Number.MAX_SAFE_INTEGER),
      behind: isBehind(now),
    };
  };

  // Outside agents (#351): the User's own agent, paired in Settings, reads its Folders over the
  // socket and gets Citations IncarnaMind minted and checked. Off until the User turns it on.
  const { home } = adapters.paths;
  const agents = createAgents({
    offered: adapters.agents?.offered ?? true,
    log: adapters.log ?? silentLogger,
    db,
    now,
    clock: () => performance.now(),
    secrets,
    consent,
    readValue: (key) => settings.readDeviceValue(key),
    writeValue: (key, value) => settings.writeDeviceValue(key, value),
    localOnly: () => embedding.localOnly(),
    socketPath: adapters.agents?.socketPath ?? agentSocketPath(dataDir),
    // Without a host's launcher there is no shim to start; tests and the evaluation give theirs.
    launcher: adapters.agents?.launcher ?? { command: process.execPath, args: [] },
    version: adapters.agents?.version ?? "0.0.0",
    access: {
      say: (key, params) => translate(settings.get().language, key, params),
      folders: () => library.folders().map((folder) => ({ id: folder.id, name: folder.name })),
      documentsIn: (folderIds) => {
        const folders = folderIds.filter((id) => id !== NOT_IN_A_FOLDER_ID);
        const filed =
          folders.length === 0
            ? []
            : (resolveScope({ folderIds: folders, tagIds: [], documentIds: [] }) ?? []);
        return folders.length === folderIds.length
          ? filed
          : [...new Set([...filed, ...library.unfiledDocumentIds()])];
      },
      // Without the reranker: it costs about a second a search (ADR-0009), and an agent's
      // search must answer in well under 100 ms.
      search: (query, documentIds, parameters, signal) =>
        documents.searchTool(query, { documentIds, parameters, signal }),
      passage: (passageId) => documents.passage(passageId),
      passagesBetween: (documentId, from, to) => documents.passagesBetween(documentId, from, to),
      citing,
      notCited: (passageId) => documents.citationSource(passageId)?.notCited ?? false,
      recheck: (input) => recheckCitation(documents, input),
      minds: () => minds.list().filter((mind) => isKnownKind(mind.kind)),
      liveDocuments: () => documents.names(),
      mindMarkdown: (mindId, footnote) => {
        const mind = minds.get(mindId);
        const { language } = settings.get();
        // Someone's changes from a Word file read as changes, as the assistant reads them (#734).
        const blocks = content.peek(mind.id, (fragment) =>
          readBlocks(fragment, {
            includeQuestions: true,
            footnote,
            trimBeforeCitation: true,
            ...(fragment.doc && wordFileOf(fragment.doc)
              ? { review: theirChangesReading(fragment.doc) }
              : {}),
          }),
        );
        return renderMarkdown(mind.title || mind.autoTitle, blocks, exportLabels(language));
      },
      answer: (question, documentIds, signal) =>
        answers.answerOutside(question, documentIds, signal),
      show: (place) => events.emit("agents.citationShown", place),
    },
    skillInstalled: (client) => skillInstalled(home, client),
    changed: (value) => events.emit("agents.changed", value),
    called: (activity) => events.emit("agents.activity", activity),
    reportError: (error) => console.error(error),
  });
  agentsLocalModeChanged = () => agents.localModeChanged();
  agents.start().catch((error: unknown) => console.error(error));
  // Setting IncarnaMind up in the User's agent, from Settings → Agents.
  const agentSetup = createAgentSetup({
    agents,
    home,
    applications:
      adapters.agents?.applications ??
      (platform === "darwin" ? ["/Applications", join(home, "Applications")] : []),
    platform,
    tempDir: adapters.paths.tempDir ?? tmpdir(),
    shimScript: adapters.agents?.shimScript ?? null,
    version: adapters.agents?.version ?? "0.0.0",
    openLink: adapters.agents?.openLink ?? null,
    openPath: adapters.shell ? (path) => adapters.shell?.openPath(path) ?? Promise.resolve() : null,
    say: (key, params) => translate(settings.get().language, key, params),
    reportError: (error) => console.error(error),
  });

  const addDocuments = async (
    paths: string[],
    options?: Parameters<CoreApi["addDocuments"]>[1],
    onNew?: (documentId: string) => void,
  ): ReturnType<CoreApi["addDocuments"]> => {
    const batchId = batches.begin(library.target(options));
    const since = now();
    const result = await documents
      .add(paths, (documentId) => {
        batches.added(batchId, documentId);
        onNew?.(documentId);
      })
      .finally(() => batches.done(batchId));
    usageData.record({ event: "documents_added", fields: addedCounts(result, since) });
    return { ...result, batchId };
  };
  mindIndex.start();

  // Everything a Task needs is up: those a quit or a crash left go on, or wait for the User.
  tasks.settleOrphans();

  // Async on purpose: the renderer reaches these over IPC, and a future hosted core may be remote.
  api = {
    createMind: async (input) =>
      makeMind(parseCreateMindInput(input), { headed: isRecord(input) && input.headed === true }),
    checkWordFile: async (path, folderId) => wordImports.check(path, folderId),
    importWordFile: async (input) => wordImports.import(input),
    addWordOriginal: async (mindId, path) => {
      const mind = writableMind(mindId);
      return wordImports.addOriginal(mind.id, path);
    },
    listMinds: async () => minds.list(),
    renameMind: async (mindId, title) => {
      const mind = minds.rename(mindId, title);
      mindsChanged();
      return mind;
    },
    deleteMind: async (mindId) => removeMind(mindId),
    openMind: async (mindId) => {
      const mind = minds.get(mindId);
      // A Mind this version may only read is shown from what is stored: nothing is
      // settled, compacted or written, so its Yjs state stays exactly as it was.
      if (!isKnownKind(mind.kind)) {
        return { mind, access: "update-required", state: Y.encodeStateAsUpdate(new Y.Doc()) };
      }
      const access = accessFor(mind.kind, content.contentVersion(mind.id));
      if (access === "read-only") return { mind, access, state: content.storedState(mind.id) };
      answers.settleOrphans(mind.id);
      checks.settleStale(mind.id);
      return { mind, access, state: content.state(mind.id) };
    },
    applyMindUpdate: async (mindId, update) => {
      content.apply(writableMind(mindId).id, update);
    },
    unsavedChanges: async () => unsaved.summary(),
    saveChangesAgain: async () => {
      content.storeWaiting();
      return unsaved.summary();
    },
    takeLostChanges: async () => unsaved.takeLost(),
    closeMind: async (mindId) => {
      content.close(parseMindId(mindId));
    },
    saveCheckpoint: async (mindId, reason) => checkpoints.save(mindId, reason),
    listCheckpoints: async (mindId) => checkpoints.list(mindId),
    compareCheckpoints: async (input) => checkpoints.compare(input),
    restoreCheckpoint: async (mindId, checkpointId) => checkpoints.restore(mindId, checkpointId),
    askInConversation: async (input) =>
      answers.askInConversation(conversations.parseQuestion(input)),
    askReadyQuestion: async () => {
      const ready = examples.readyAnswer();
      if (!ready) {
        throw new InvalidInputError({ key: "error.examples.reading" });
      }
      const { turn } = conversations.add(
        {
          conversationId: null,
          text: ready.question,
          mind: { id: ready.mindId, folderId: minds.get(ready.mindId).folderId },
          focus: null,
          scope: null,
          model: null,
          forcedSkill: null,
          quotes: [],
        },
        null,
        null,
      );
      const answer = conversations.writeAnswer(turn.answer.id, {
        text: ready.answer,
        citations: ready.citations,
        figures: [],
        toolCalls: [],
        support: null,
        textOrigin: null,
        read: null,
        steps: { sentAt: null, finishedAt: now(), phases: [], reasoning: null, example: true },
        outcome: { status: "done", error: null },
      });
      events.emit("conversation.message", turn.question);
      events.emit("conversation.message", answer ?? turn.answer);
      conversationsChanged();
      return { conversationId: turn.conversation.id, answerId: turn.answer.id };
    },
    regenerateConversationAnswer: async (input) => answers.regenerateInConversation(input),
    countScopeDocuments: async (scope) => {
      const wanted = parseSearchScope(scope);
      return documents.searchableCount((wanted ? resolveScope(wanted) : null) ?? undefined);
    },
    stopConversationAnswer: async (input) => answers.stopInConversation(input),
    usualAnswerWait: async (answerId) => conversations.usualWait(answerId),
    listConversations: async (options) => conversations.list(options),
    getConversation: async (conversationId) => conversations.content(conversationId),
    searchConversations: async (query) => conversations.search(query),
    searchMinds: async (query) => mindIndex.search(query),
    listMindSnippets: async () => {
      const leading = mindIndex.leadingLines();
      return minds.list().flatMap((mind) => {
        const text = lineUnderName(leading.get(mind.id) ?? [], mindName(mind));
        return text ? [{ mindId: mind.id, text }] : [];
      });
    },
    searchDocumentText: async (query, options) => documents.searchText(query, options),
    renameConversation: async (conversationId, title) => {
      const conversation = conversations.rename(conversationId, title);
      conversationsChanged();
      return conversation;
    },
    deleteConversation: async (conversationId) => {
      // What an Answer being written has is kept, before the conversation goes.
      answers.stopConversation(conversations.get(conversationId).id);
      conversations.delete(conversationId, now());
      conversationsChanged();
    },
    resolveReference: async (input) => {
      const reference = parseReference(input);
      if (!reference) throw new InvalidInputError("That isn't a reference IncarnaMind can follow.");
      const found =
        reference.artifactKind === "mind"
          ? minds.locate(reference.artifactId)
          : conversations.locate(reference.artifactId, reference.anchor.messageId);
      if (!found) return { status: "gone", reference };
      return found.deletedAt === null
        ? { status: "available", reference, name: found.name }
        : { status: "deleted", reference, name: found.name, deletedAt: found.deletedAt };
    },
    addToNote: (input) => noteAdding.add(input),
    undoAddToNote: async (input) => noteAdding.undo(input),
    listNoteConversations: async () => noteConversations.list(),
    getSettings: async () => settings.get(),
    getLayout: async (windowId) => layouts.get(windowId),
    changeLayout: async (windowId, change) => layouts.change(windowId, change),
    updateSettings: async (patch) => {
      // Each chat model chosen (default, last, quick tasks, images) must be on a saved provider.
      const user = isRecord(patch) && isRecord(patch.user) ? patch.user : {};
      const device = isRecord(patch) && isRecord(patch.device) ? patch.device : {};
      const chatModel = user.chatModel;
      for (const choice of [
        chatModel,
        user.quickTasksModel,
        user.imageModel,
        device.lastChatModel,
      ]) {
        if (isChatModelChoice(choice) && !chat.exists(choice.providerId)) {
          throw new InvalidInputError("That chat provider doesn't exist.");
        }
      }
      const scriptsWere = settings.get().device.skillScriptsEnabled;
      let change = patch;
      // Suggestions turned on: the User allows what they send first. Declined, they stay as they were.
      if (isRecord(patch) && isRecord(patch.user) && patch.user.suggestWhileWriting === true) {
        if (!(await suggestions.allow())) {
          const { suggestWhileWriting: _declined, ...user } = patch.user;
          change = { ...patch, user };
        }
      }
      const route =
        isRecord(patch) && isRecord(patch.device) ? patch.device.transcriptionRoute : undefined;
      if (route !== undefined) await cloudTranscription.check(route);
      const languageWas = settings.get().language;
      const updated = settings.update(change);
      // Choosing a cloud service where its line says meeting audio goes to it is the consent (ADR-0022).
      if (route !== undefined) {
        cloudTranscription.chose(updated.device.transcriptionRoute);
        transcriptionGateChanged();
      }
      if (!updated.user.suggestWhileWriting) suggestions.stop();
      events.emit("settings.changed", updated);
      // Skill scripts turned off: none runs any more, and none waits to.
      if (scriptsWere && !updated.device.skillScriptsEnabled) {
        approvals.denyScripts();
        scriptRunner.stopAll();
      }
      const flowChanged = syncChatFlow();
      if (chatModel !== undefined || flowChanged) await readinessChanged();
      // Automatic may tag with another model now.
      else if (user.quickTasksModel !== undefined || user.imageModel !== undefined)
        await taggingChanged();
      // The examples follow the new language before this returns, so whoever awaits it can rely on it.
      if (updated.language !== languageWas) {
        await examples
          .followLanguage()
          .catch((error) => console.error("The example Minds didn't follow the language:", error));
      }
      return updated;
    },
    addDocuments,
    saveWebPage: async (input) => {
      const folderId = isRecord(input) ? input.folderId : undefined;
      if (
        folderId !== undefined &&
        folderId !== null &&
        !library.snapshot().groups.some((group) => group.id === folderId)
      ) {
        throw new NotFoundError({ key: "error.folder.notFound" });
      }
      const since = now();
      const result = await webPages.save(input);
      if (result.outcome === "saved" && !result.existing && typeof folderId === "string") {
        library.assign(result.document.id, folderId);
      }
      const added: Pick<AddDocumentsResult, "documents" | "skipped"> =
        result.outcome === "saved"
          ? { documents: [result.document], skipped: [] }
          : { documents: [], skipped: [{ path: result.address, reason: "unreadable" }] };
      usageData.record({ event: "documents_added", fields: addedCounts(added, since) });
      return result.outcome === "saved"
        ? { ...result, document: documents.get(result.document.id) }
        : result;
    },
    keepWebPageLook: async (documentId) => webPages.keepLook(documentId),
    fetchWebPageAgain: async (documentId, options) => webPages.fetchAgain(documentId, options),
    saveTextAsDocument: async (input) => {
      if (!isRecord(input) || typeof input.text !== "string" || input.text.trim() === "") {
        throw new InvalidInputError("There is no text to save.");
      }
      const title = typeof input.name === "string" ? input.name : "";
      const folder = join(dataDir, "Saved text");
      mkdirSync(folder, { recursive: true });
      const text = input.text.endsWith("\n") ? input.text : `${input.text}\n`;
      const name = await writeNewFile(
        folder,
        `${safeFileName(title, "Pasted text")}.md`,
        new TextEncoder().encode(text),
      );
      const { documents: added } = await documents.add([join(folder, name)]);
      const saved = added[0];
      if (!saved) throw new InvalidInputError("The text couldn't be saved.");
      return saved;
    },
    listDocuments: async (options) => {
      const { folderId, includeSubfolders, tagId, linkedFolderId } = parseListOptions(options);
      const folder = folderId === undefined ? undefined : folders.get(folderId);
      return documents.list({
        folderIds: folder && (includeSubfolders ? folders.subtree(folder.id) : [folder.id]),
        tagId: tagId === undefined ? undefined : tags.get(tagId).id,
        linkedFolderId,
      });
    },
    renameDocument: async (id, name) => {
      const renamed = documents.rename(id, name);
      events.emit("documents.renamed", [renamed]);
      return renamed;
    },
    deleteDocument: async (id) => {
      for (const deleted of documents.delete(id)) activity.documentDeleted(deleted);
    },
    deleteDocuments: async (ids) => {
      for (const deleted of documents.delete(ids)) activity.documentDeleted(deleted);
    },
    retryDocument: async (id) => documents.retry(id),
    unlockDocument: async (input) => {
      const { documentId, password } = parseUnlock(input);
      const document = documents.getMany([documentId])[0];
      if (!document) throw new NotFoundError({ key: "error.document.notFound" });
      if (document.kind !== "pdf") throw new InvalidInputError({ key: "error.document.notPdf" });
      const bytes = await readFile(await documents.filePath(documentId));
      if (!(await pdfIsLocked(bytes))) {
        throw new InvalidInputError({ key: "error.document.notLocked" });
      }
      if (!(await pdfOpensWith(bytes, password))) return { kind: "wrong-password" };
      await pdfPasswords.keep(documentId, password);
      events.emit("documentPasswords.changed", pdfPasswords.kept());
      const failed = document.status === "failed";
      return { kind: "unlocked", document: failed ? documents.retry(documentId) : document };
    },
    forgetDocumentPassword: async (id) => forgetPasswords([parseDocumentId(id)]),
    documentPasswordFor: async (id) => {
      const document = documents.getMany([parseDocumentId(id)])[0];
      if (document?.kind !== "pdf" || !viewing.isShown(document.id)) return null;
      return (await pdfPasswords.of(document.id)) ?? null;
    },
    listDocumentPasswords: async () => {
      const kept = pdfPasswords.kept();
      return documents.getMany(kept).map((each) => each.id);
    },
    readDocumentText: async (id) => documents.readText(id),
    readScannedText: async (id) => documents.readScannedText(id),
    readScannedQuote: async (input) => documents.readScannedQuote(parseQuoted(input)),
    readableQuote: async (input) => documents.readableQuote(parseQuoted(input)),
    previewLinkedFolder: (path) => documents.linkedFolders.preview(path),
    addLinkedFolder: async (path, options) => {
      const groupId = library.target(options);
      const known = new Set(documents.linkedFolders.list().map((each) => each.id));
      const linked = await documents.linkedFolders.add(path);
      // Its first scan only starts adding Documents once this has returned.
      const batchId = batches.begin(groupId);
      // A folder inside one already linked adds nothing: its scans aren't this batch.
      if (known.has(linked.id)) batches.done(batchId);
      else batches.linking(batchId, linked);
      usageData.record({ event: "folder_linked", fields: {} });
      return { ...linked, batchId };
    },
    listLinkedFolders: async () => documents.linkedFolders.list(),
    listUnreadFiles: async (scope) => unreadIn(parseSearchScope(scope)),
    locateLinkedFolder: (linkedFolderId, path) =>
      documents.linkedFolders.locate(linkedFolderId, path),
    removeLinkedFolder: async (linkedFolderId, options) =>
      unlinkFolder(linkedFolderId, options?.keep),
    listKeptCitationTexts: async () => documents.keptCitationTexts(),
    updateReference: async (documentId, patch) => references.update(documentId, patch),
    restoreReference: async (documentId, before, fields) =>
      references.restore(documentId, before, fields),
    confirmReference: async (documentId) => references.confirm(documentId),
    lookUpReference: (documentId) => references.lookUp(documentId),
    checkReferences: (mindId, options) =>
      referenceChecks.check(mindId, isRecord(options) && options.again === true),
    stopReferenceCheck: async (mindId) => referenceChecks.stop(mindId),
    listSourceProviders: () => sources.list(),
    setSourceProviderKey: (providerId, key) => sources.setKey(providerId, key),
    findSources: (input) => sources.search(input),
    addFoundSource: (input) => sources.add(input),
    importReferences: (path) => referenceImport.run(path),
    undoReferenceImport: async (importId) => {
      referenceImport.undo(importId);
    },
    addImportedReferenceFiles: (importId) => referenceImport.addFiles(importId),
    listUnmatchedReferences: async () => referenceImport.unmatched(),
    addReferenceFile: (recordId, path) => referenceImport.addFile(recordId, path),
    getExamples: async (group) => examples.status(group),
    offerExamples: async () => examples.offer(minds.list().length > 0),
    createExamples: async (group) => examples.create(group),
    removeExamples: async (group) => examples.remove(group),
    restoreExamples: async (group) => examples.restore(group),
    setLinkedFolderLayout: async (linkedFolderId, layout) =>
      documents.linkedFolders.setLayout(linkedFolderId, layout),
    setLinkedFolderPaused: async (linkedFolderId, paused) =>
      documents.linkedFolders.setPaused(linkedFolderId, paused),
    downloadOnlineOnlyFiles: async (linkedFolderId) =>
      documents.linkedFolders.downloadOnlineOnly(linkedFolderId),
    recheckCitation: async (input) => {
      if (!isRecord(input) || typeof input.documentId !== "string" || input.documentId === "") {
        throw new InvalidInputError("recheckCitation needs the Citation's Document id.");
      }
      const page = (value: unknown) =>
        typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
      return recheckCitation(documents, {
        documentId: input.documentId,
        quote: typeof input.quote === "string" ? input.quote : "",
        pageFrom: page(input.pageFrom),
        pageTo: page(input.pageTo) ?? page(input.pageFrom),
        contentHash: typeof input.contentHash === "string" ? input.contentHash : null,
      });
    },
    citeSelection: async (input) => {
      if (!isRecord(input) || !Array.isArray(input.parts)) {
        throw new InvalidInputError({ key: "error.selection.none" });
      }
      const parts = input.parts.map(parseSelectedPart);
      if (parts.every((part) => part.text.trim() === "")) {
        throw new InvalidInputError({ key: "error.selection.none" });
      }
      return citeSelection(documents, { documentId: parseDocumentId(input.documentId), parts });
    },
    searchPassages: (query, options) => documents.search(query, options),
    searchEvidence: async (query, options) => {
      if (typeof query !== "string") throw new InvalidInputError("A search query must be text.");
      if (options !== undefined && !isRecord(options)) {
        throw new InvalidInputError("searchEvidence's options must be an object.");
      }
      const scope = parseSearchScope(options?.scope);
      const found = await evidence.search(
        query,
        evidence.scope(scope ? resolveScope(scope) : null, parseCheckedDocument(options?.checked)),
      );
      return { passages: found.passages.map(passageResult), excluded: found.excluded };
    },
    setCountedAsEvidence: async (documentId, counted) =>
      documents.setCountedAsEvidence(documentId, counted),
    setNotCited: async (documentId, notCited) => documents.setNotCited(documentId, notCited),
    getEmbeddingModel: async () => embeddingModel.status(),
    downloadEmbeddingModel: async () => embeddingModel.retry(),
    getTextRecognitionModel: async () =>
      textRecognitionModel?.status() ?? textRecognitionUnavailable,
    downloadTextRecognitionModel: async () =>
      textRecognitionModel?.retry() ?? textRecognitionUnavailable,

    getEmbeddingSettings: () => embeddingSettings(),
    saveEmbeddingProvider: async (input) => {
      await embedding.save(input);
      return embeddingSettings();
    },
    testEmbeddingConnection: (input) => loggingTest("embedding")(embedding.test(input)),
    retryEmbedding: async () => {
      embedding.retry();
      return embeddingSettings();
    },
    setLocalOnly: (enabled) => setLocalOnly(enabled),

    getRerankSettings: () => rerank.status(),
    downloadRerankingModel: async () => {
      await rerank.download();
      return rerankChanged();
    },
    saveRerankSettings: async (input) => {
      await rerank.save(input);
      return rerankChanged();
    },
    removeRerankSettings: async () => {
      await rerank.remove();
      return rerankChanged();
    },
    testRerankConnection: (input) => loggingTest("rerank")(rerank.test(input)),

    listChatProviders: () => chat.list(),
    saveChatProvider: async (input) => {
      const provider = await chat.save(input);
      await cloudTranscription.refreshKeys();
      transcriptionGateChanged();
      settingsChanged();
      await dataFlowsChanged();
      return provider;
    },
    deleteChatProvider: async (id) => {
      await chat.delete(id);
      // A transcription route that used this provider's key has none now.
      await cloudTranscription.refreshKeys();
      transcriptionGateChanged();
      settingsChanged();
      await readinessChanged();
    },
    testChatConnection: (input) => loggingTest("chat")(chat.test(input)),
    testChatProvider: (providerId) => loggingTest("chat")(chat.testProvider(providerId)),
    getModelRoles: async () => ({ quickTasks: chat.quickTasksModel(), images: chat.imageModel() }),
    getChatReadiness: () => chat.readiness(),
    listChatModels: () => chat.listModels(),
    setChatModelInMenu: async (input) => chat.setInMenu(input),
    getCostSummary: async () => meter.summary(),
    estimateRun: async (input) => {
      if (!isRecord(input)) throw new InvalidInputError("estimateRun expects an object.");
      const { items, model, searches = 0, each = "answer" } = input;
      if (each !== "answer" && each !== "check") {
        throw new InvalidInputError({ key: "error.estimate.each" });
      }
      if (typeof items !== "number" || !Number.isInteger(items) || items < 0 || items > 100_000) {
        throw new InvalidInputError("items must be a whole number from 0 to 100,000.");
      }
      if (model !== undefined && !isChatModelChoice(model)) {
        throw new InvalidInputError("model must be a provider and a model.");
      }
      if (
        typeof searches !== "number" ||
        !Number.isInteger(searches) ||
        searches < 0 ||
        searches > 1_000
      ) {
        throw new InvalidInputError({ key: "error.estimate.searches", values: { max: 1_000 } });
      }
      const metered = chat.metered(model);
      if (!metered) throw new InvalidInputError("There is no model to estimate for.");
      return meter.estimate(metered, items, searches, each);
    },
    compareDocuments: (input) => inFlow("comparison", () => comparisons.compareDocuments(input)),
    fillComparisonTable: (input) =>
      inFlow("comparison", () => comparisons.fillComparisonTable(input)),
    stopComparisonTable: (input) => comparisons.stop(input),
    listFillingComparisons: async () => comparisons.filling(),
    listTasks: async () => tasks.list(),
    pauseTask: (taskId) => tasks.pause(taskId),
    resumeTask: (taskId) => tasks.resume(taskId),
    stopTask: (taskId) => tasks.stop(taskId),
    answerTaskAsk: (taskId, answer) => tasks.answer(taskId, answer),
    listTaskSteps: async (taskId) => tasks.listSteps(taskId),
    tellTask: async (taskId, text) => tasks.tell(taskId, text),
    untellTask: async (taskId, messageId) => tasks.untell(taskId, messageId),
    getResearchPlan: async (taskId) => research.planView(taskId),
    planResearch: (input) => inFlow("research", () => research.plan(input)),
    startResearch: (input) => inFlow("research", () => research.start(input)),

    askQuestion: async (input) => answers.ask(input),
    regenerateAnswer: async (input) =>
      answers.regenerate(input, (mindId) => checkpoints.save(mindId, "regenerate")),
    stopAnswer: async (input) => answers.stop(input),
    suggestNext: (request) => inFlow("suggestion", () => suggestions.suggest(request)),
    cancelSuggestion: async (requestId) => suggestions.cancel(requestId),
    acceptSuggestion: async (input) => suggestions.accept(input),
    getSuggestionStatus: () => suggestions.status(),
    editWithAi: (input) => edits.editWithAi(input),
    regenerateProposal: (input) => edits.regenerateProposal(input),
    cancelEdit: async (requestId) => edits.cancel(requestId),
    checkSentences: (input) => inFlow(input.action, () => checks.checkSentences(input)),
    cancelCheck: async (requestId) => checks.cancel(requestId),
    checkClaim: (input) => inFlow("check-claim", () => checks.checkClaim(input)),
    verifyDocument: (input) => inFlow("verify", () => checks.verifyDocument(input)),
    findClaims: (input) => inFlow("verify", () => checks.findClaims(input)),
    verifyClaims: (input) => inFlow("verify", () => checks.verifyClaims(input)),
    planContradictionCheck: (mindId) => checks.planContradictionCheck(mindId),
    checkContradictions: (input) =>
      inFlow("contradictions", () => checks.checkContradictions(input)),
    planMindCheck: (mindId, mode, allDocuments) => checks.planMindCheck(mindId, mode, allDocuments),
    findMindClaims: (input) => inFlow("check-mind", () => checks.findMindClaims(input)),
    checkMind: (input) => inFlow("check-mind", () => checks.checkMind(input)),
    documentsAddedSinceChecks: async (mindId) => checks.documentsAddedSinceChecks(mindId),

    getSecretStorage: async () => secrets.status(),
    acceptPlainTextSecretStorage: async () => secrets.acceptPlainText(),

    detectOllama: (input) => detectOllama(ollamaUrl(input), ollamaInstalled),
    detectLocalServer: async (input) => {
      if (!isRecord(input) || typeof input.catalogId !== "string") {
        throw new InvalidInputError({
          key: "error.provider.unknown",
          values: { provider: String(isRecord(input) ? input.catalogId : input) },
        });
      }
      const apiKey = (typeof input.apiKey === "string" && cleanApiKey(input.apiKey)) || null;
      return localServers.detect(
        input.catalogId,
        apiKey,
        typeof input.address === "string" ? input.address : null,
      );
    },
    openOllama: async (input) => {
      const baseUrl = ollamaUrl(input);
      if (!(await ollamaInstalled())) {
        throw new InvalidInputError({ key: "error.provider.ollamaCantOpen" });
      }
      await adapters.ollamaApp?.open();
      return waitForOllama(baseUrl, ollamaInstalled, {
        timeoutMs: adapters.ollamaStartTimeoutMs ?? OLLAMA_START_TIMEOUT_MS,
      });
    },
    selectOllama: async (input) => {
      const baseUrl = ollamaUrl(input);
      const model = input?.model ?? RECOMMENDED_OLLAMA_MODEL;
      if (typeof model !== "string" || model.trim() === "") {
        throw new InvalidInputError({ key: "error.provider.modelMissing" });
      }
      const status = await detectOllama(baseUrl);
      if (!status.running) throw new Error(`Ollama isn't running at ${baseUrl}.`);
      // One click means a model on this computer; a cloud model is chosen from the model menu.
      if (isCloudModelName(model) || hasOllamaModel(status.cloudModels, model)) {
        throw new InvalidInputError({ key: "error.provider.ollamaCloud", values: { model } });
      }
      if (!hasOllamaModel(status.models, model)) {
        await pullOllamaModel(
          baseUrl,
          model,
          (progress) => events.emit("ollama.pullProgress", progress),
          lifetime.signal,
        );
      }
      const provider = await chat.save({
        kind: "ollama",
        baseUrl,
        modelId: model,
        // Local mode leaves only a model on this computer to answer.
        keepDefault: input?.keepDefault === true && input.localOnly !== true,
      });
      settingsChanged();
      await readinessChanged();
      // Local mode is the User's choice here (#545), made in the box under the button.
      if (typeof input?.localOnly === "boolean") await setLocalOnly(input.localOnly);
      return provider;
    },

    getChatGptPlan: () => chatGpt.status(),
    answerWithPlanModel: async (input) => {
      const models = await chatGpt.models();
      if (
        !isRecord(input) ||
        typeof input.insteadOf !== "string" ||
        !models.some((model) => model.id === input.modelId)
      ) {
        throw new InvalidInputError({ key: "error.chatgpt.notPlanModel" });
      }
      chatGpt.limits.answerWith(input.insteadOf, input.modelId);
      return chatGpt.status();
    },
    endPlanStandIn: async () => {
      chatGpt.limits.endStandIn();
      return chatGpt.status();
    },
    signInToChatGpt: (input) =>
      chatGpt.signIn({ anotherAccount: isRecord(input) && input.anotherAccount === true }),
    cancelChatGptSignIn: () => chatGpt.cancelSignIn(),
    reopenChatGptSignIn: () => chatGpt.reopenSignInPage(),
    signOutOfChatGpt: () => chatGpt.signOut(),
    pasteChatGptSignInAddress: async (address) =>
      chatGpt.pasteSignInAddress(typeof address === "string" ? address : ""),
    getClaudeAccount: () => claudeAccount.status(),
    signInToClaude: () => claudeAccount.signIn(),
    cancelClaudeSignIn: () => claudeAccount.cancelSignIn(),
    reopenClaudeSignIn: () => claudeAccount.reopenSignInPage(),
    signOutOfClaude: () => claudeAccount.signOut(),
    pasteClaudeSignInAddress: async (address) =>
      claudeAccount.pasteSignInAddress(typeof address === "string" ? address : ""),
    getCopilot: () => copilot.status(),
    signInToCopilot: (input) =>
      copilot.signIn(
        isRecord(input) && (input.profile === "own" || input.profile === "editor")
          ? { profile: input.profile }
          : {},
      ),
    cancelCopilotSignIn: () => copilot.cancelSignIn(),
    signOutOfCopilot: () => copilot.signOut(),

    listDataFlows: () => consent.list(),
    listConsentRequests: async () => consent.requests(),
    respondToConsent: async (requestId, accept) => {
      consent.respond(requestId, accept);
      await readinessChanged();
    },
    revokeConsent: async (flowId, serviceId) => {
      const revokedAt = consent.revoke(flowId, serviceId);
      if (typeof flowId === "string" && typeof serviceId === "string") {
        cloudTranscription.revoked(flowId, serviceId);
      }
      transcriptionGateChanged();
      settingsChanged();
      await dataFlowsChanged();
      return revokedAt;
    },
    restoreConsent: async (flowId, serviceId, revokedAt) => {
      consent.restore(flowId, serviceId, revokedAt);
      transcriptionGateChanged();
      settingsChanged();
      await dataFlowsChanged();
    },
    listRegisteredDataFlows: () => consent.listRegistered(),
    allowDataFlow: async (flowId, serviceId) => {
      await consent.allow(flowId, serviceId);
      await dataFlowsChanged();
    },

    listNetworkTraffic: () => privacy.listTraffic(),
    getPrivacySettings: async () => privacy.status(),
    updatePrivacySettings: async (patch) => {
      const { changed, settings: updated } = privacy.update(patch);
      if (changed) privacyChanged();
      return updated;
    },
    recordUsage: async (event) => usageData.recordFromUi(event),
    resetUsageInstallId: async () => usageData.resetInstallId(),
    recordAiUse: async (inputs) => aiUse.record(inputs),
    listAiUse: async (mindId) => aiUse.list(mindId),
    getAiUseStatus: async () => aiUse.status(),
    clearAiUse: async () => aiUse.clear(),
    restoreAiUse: async (clearedAt) => aiUse.restore(clearedAt),
    createAiUseStatement: async (mindId) => aiUseStatement.create(mindId),

    listFolders: async () => folders.list(),

    getLibrary: async () => library.snapshot(),
    createLibraryGroup: async (input) => library.create(input),
    updateLibraryGroup: async (id, input) => library.update(id, input),
    deleteLibraryGroup: async (id) => {
      const deletion = db.transaction(() => {
        const folder = library.folder(id);
        const left = minds.leaveFolder(folder.id);
        const leftConversations = conversations.leaveFolder(folder.id);
        const { assignments } = library.delete(folder.id, {
          minds: left.map((mind) => mind.id),
          conversations: leftConversations.map((conversation) => conversation.id),
        });
        const live = (items: { id: string; live: boolean }[]) =>
          items.filter((item) => item.live).map((item) => item.id);
        return { assignments, mindIds: live(left), conversationIds: live(leftConversations) };
      });
      if (deletion.mindIds.length > 0) mindsChanged();
      if (deletion.conversationIds.length > 0) conversationsChanged();
      return deletion;
    },
    addLibraryStarterGroups: async (keys) => library.addStarters(keys),
    saveLibrarySettings: async (input) => {
      const before = library.settings();
      library.saveSettings(input);
      const after = library.settings();
      // Choosing the model that tags or organizes Documents, where a line says what goes,
      // allows it (ADR-0022). Saving the same one again, for another setting, isn't a new choice.
      const switchedOn = !before.automatic && after.automatic;
      const tagsAnew = JSON.stringify(after.classifier) !== JSON.stringify(before.classifier);
      const organizesAnew =
        JSON.stringify(organizeModelOf(after)) !== JSON.stringify(organizeModelOf(before));
      // Turning on tagging and sorting by themselves, where a line says what goes, is the consent too (#1617).
      if (tagsAnew || switchedOn) {
        for (const service of await taggingServices()) consent.choose(["tagging"], service);
      }
      if (organizesAnew || switchedOn) {
        for (const service of await classificationServices()) {
          consent.choose(["classification"], service);
        }
      }
      if (tagsAnew || organizesAnew || switchedOn) await dataFlowsChanged();
      await taggingChanged();
    },
    getTaggingModels: async () => {
      const hadModel = tagsWith() !== null;
      const models = await tagging.models();
      if (!hadModel && tagsWith() !== null && !lifetime.signal.aborted) {
        tagger.resume();
        library.resume();
      }
      return models;
    },
    classifyDocuments: async (ids) => {
      library.classify(ids);
      const classifier = organizeModelOf(library.settings());
      if (classifier) {
        usageData.record({
          event: "organize_run",
          fields: {
            documents: Array.isArray(ids) ? new Set(ids).size : documents.list().length,
            all: ids === undefined,
            model: classifier.kind,
          },
        });
      }
    },
    assignDocumentGroup: async (id, groupId) => library.assign(id, groupId),
    restoreAssignment: async (id, previous) => library.restoreAssignment(id, previous),
    restore: async (refs) => recentlyDeleted.restore(refs),
    undoCommands: async (run) => commandSteps.undo(run),
    redoCommands: async (run) => commandSteps.redo(run),
    listDeleted: async () => recentlyDeleted.list(),
    deletePermanently: async (refs) => {
      recentlyDeleted.deletePermanently(refs);
      await Promise.all([
        webPages.dropPurged(),
        sources.dropPurged(),
        wordImports.dropPurged(),
        documents.dropPurged(),
      ]);
    },
    acceptAssignments: async (ids) => library.accept(ids),
    rejectAssignments: async (ids) => library.reject(ids),
    moveToFolder: async (input) => {
      if (!isRecord(input)) throw new InvalidInputError("moveToFolder expects an object.");
      const folderId = parseFolderChoice(input.folderId);
      const mindIds = parseIds(input.mindIds, "The Minds to move");
      const documentIds = parseIds(input.documentIds, "The Documents to move");
      const conversationIds = parseIds(input.conversationIds, "The conversations to move");
      // All or none: every one is checked before anything moves.
      if (folderId !== null) library.folder(folderId);
      for (const id of mindIds) minds.get(id);
      for (const id of conversationIds) conversations.get(id);
      const move = db.transaction(() => ({
        folderId,
        minds: minds.move(mindIds, folderId),
        documents: library.move(documentIds, folderId),
        conversations: conversations.move(conversationIds, folderId),
      }));
      // Said once it is saved, so a move that rolled back says nothing.
      if (move.minds.some((item) => item.from !== folderId)) mindsChanged();
      if (move.conversations.some((item) => item.from !== folderId)) conversationsChanged();
      library.moved(move.documents.map((item) => item.id));
      return move;
    },

    listTags: async () => tags.list(),
    createTag: async (input) => {
      const tag = tags.create(input);
      tagsChanged();
      return tag;
    },
    updateTag: async (tagId, patch) => {
      const tag = tags.update(tagId, patch);
      tagsChanged();
      return tag;
    },
    deleteTag: async (tagId) => {
      const documentIds = tags.delete(tagId, now());
      // Tags first, so a listener filtering by the deleted Tag hears it's gone before it refreshes.
      tagsChanged();
      announceTagged(documentIds);
    },
    addDocumentTag: async (documentId, tagId) => {
      const { document, changed } = db.transaction(() => {
        const document = documents.get(documentId);
        return { document, changed: tags.addToDocument(document.id, tagId) };
      });
      if (!changed) return document;
      const updated = documents.get(document.id);
      events.emit("documents.tagged", [updated]);
      return updated;
    },
    removeDocumentTag: async (documentId, tagId) => {
      const { document, changed } = db.transaction(() => {
        const document = documents.get(documentId);
        return { document, changed: tags.removeFromDocument(document.id, tagId) };
      });
      if (!changed) return document;
      const updated = documents.get(document.id);
      events.emit("documents.tagged", [updated]);
      return updated;
    },
    addTagToDocuments: async (documentIds, tagId) =>
      tagMany(documentIds, (id) => tags.addToDocument(id, tagId)),
    removeTagFromDocuments: async (documentIds, tagId) =>
      tagMany(documentIds, (id) => tags.removeFromDocument(id, tagId)),
    revertDocumentTags: async (links) => {
      const changed = recentlyDeleted.revertTags(links);
      if (changed.length > 0) announceTagged(changed);
      return documents.getMany([...new Set(links.map((link) => link.documentId))]);
    },
    mergeTags: async (tagId, intoTagId) => {
      const { documentIds, links } = tags.merge(tagId, intoTagId, now());
      // Tags first, so a listener filtering by the merged Tag hears it's gone before it refreshes.
      tagsChanged();
      announceTagged(documentIds);
      return { tag: tags.get(intoTagId), merged: { kind: "tag", id: tagId, links } };
    },
    retagDocuments: async (documentIds) => {
      rateLimit.resumeNow();
      const byTagger = async (ids: unknown) => {
        await lookForTaggingModel();
        tagger.retag(ids);
      };
      if (!organizesNewDocuments()) return byTagger(documentIds);
      // Organize re-tags the Documents it holds, and the tagger the rest.
      if (!Array.isArray(documentIds)) return library.classify(documentIds);
      const held = documentIds.filter((id) => typeof id === "string" && library.isOrganizing(id));
      const rest = documentIds.filter((id) => !held.includes(id));
      if (rest.length > 0) await byTagger(rest);
      if (held.length > 0 || rest.length === 0) library.classify(held);
    },
    // Both mark them pending before anything is awaited, so saying it again finds none.
    backOnline: async () => {
      const ids = tagger.unreached();
      const held = organizesNewDocuments() ? ids.filter((id) => library.isOrganizing(id)) : [];
      if (held.length > 0) library.classify(held);
      const rest = ids.filter((id) => !held.includes(id));
      if (rest.length > 0) tagger.retag(rest);
    },
    stopTagging: async () => {
      const places = library.taggingPlaces();
      library.setTaggingStopped(places, true);
      tagger.resume();
      return places;
    },
    setTaggingWithAi: async (folderId, on) => {
      if ((folderId !== null && typeof folderId !== "string") || typeof on !== "boolean") {
        throw new InvalidInputError({ key: "error.tagging.place" });
      }
      library.setTaggingStopped([folderId], !on);
      tagger.resume();
    },
    dismissAutomaticOffNotice: async () => library.dismissAutomaticOffNotice(),

    getJevSettings: () => jev.status(),
    saveJevSettings: async (input) => {
      await jev.save(input);
      await dataFlowsChanged();
      return jevChanged();
    },
    removeJevSettings: async () => {
      await jev.remove();
      return jevChanged();
    },
    testJevConnection: (input) => loggingTest("jev")(jev.test(input)),

    listConnectors: async () => connectors.list(),
    addConnector: async (input) => {
      const connector = await connectors.add(input);
      await dataFlowsChanged();
      return connector;
    },
    editConnector: (connectorId, input) => connectors.edit(connectorId, input),
    setConnectorEnabled: async (connectorId, enabled) =>
      connectors.setEnabled(connectorId, enabled),
    restartConnector: (connectorId) => connectors.restart(connectorId),
    deleteConnector: async (connectorId) => {
      await connectors.delete(connectorId);
      // Its "always allow" and "ask" go with it: added again, it is a new Connector.
      approvals.forgetConnector(connectorId);
    },
    signInToConnector: (connectorId) => connectors.signIn(connectorId),
    cancelConnectorSignIn: (connectorId) => connectors.cancelSignIn(connectorId),
    signOutOfConnector: (connectorId) => connectors.signOut(connectorId),
    setConnectorClient: (connectorId, client) => connectors.setClient(connectorId, client),
    listConnectorDirectory: async () => directory,
    addConnectorFromDirectory: async (entryId, client) => {
      const entry = directory.find((each) => each.id === entryId);
      if (!entry) throw new NotFoundError({ key: "error.connector.notInDirectory" });
      const connector = await connectors.addFromDirectory(entry, client);
      await dataFlowsChanged();
      return connector;
    },
    searchConnectorRegistry: (query) => registry.search(query),
    previewConnectorImport: async (json) => connectors.previewImport(json),
    importConnectors: async (json) => {
      const imported = await connectors.import(json);
      await dataFlowsChanged();
      return imported;
    },

    listApprovalPolicies: async () => approvals.list(),
    setApprovalPolicy: async (input) => approvals.set(input),
    revokeApprovalPolicy: async (policyId) => approvals.revoke(policyId),
    listApprovalRequests: async () => approvals.requests(),
    listUserQuestions: async () => questions.list(),
    answerUserQuestion: async (requestId, answer) => questions.answer(requestId, answer),
    respondToApproval: async (requestId, decision, options) =>
      approvals.respond(requestId, decision, options),

    listSkills: async () => skills.list(),
    previewSkillImport: (path) => skills.preview(path),
    importSkill: async (importId) => {
      const skill = await skills.import(importId);
      skillsChanged();
      return skill;
    },
    cancelSkillImport: async (importId) => skills.cancel(importId),
    setSkillEnabled: async (skillId, enabled) => {
      const skill = skills.setEnabled(skillId, enabled);
      skillsChanged();
      return skill;
    },
    removeSkill: async (skillId) => {
      await skills.remove(skillId);
      skillsChanged();
      approvals.forgetSkill(skillId);
    },
    duplicateSkill: async (skillId) => {
      const skill = await skills.duplicate(skillId);
      skillsChanged();
      return skill;
    },
    getSkillDraft: async (skillId) => skills.draftOf(skillId),
    createSkill: async (draft) => {
      const result = await skills.create(draft);
      if (result.ok) skillsChanged();
      return result;
    },
    updateSkill: async (skillId, draft) => {
      const result = await skills.update(skillId, draft);
      if (result.ok) skillsChanged();
      return result;
    },
    draftSkillFromMind: (input) => inFlow("skill-draft", () => skillDrafts.draft(input)),
    cancelSkillDraft: async (requestId) => skillDrafts.cancel(requestId),
    listRemovedBuiltInSkills: async () => skills.removedBuiltIns(),
    restoreBuiltInSkills: async () => {
      const restored = await skills.restoreBuiltIns();
      if (restored.length > 0) skillsChanged();
      return restored;
    },

    previewMindExport: async (mindId, options) => mindExports.preview(mindId, options),
    previewSharePage: (mindId, options) => mindExports.previewSharePage(mindId, options),
    setSharePageTextOnly: async (mindId, documentIds) => {
      if (!Array.isArray(documentIds) || documentIds.some((each) => typeof each !== "string")) {
        throw new InvalidInputError({ key: "error.export.textOnly" });
      }
      const mind = writableMind(mindId);
      content.editSettings(mind.id, (mindSettings) =>
        setTextOnlyDocuments(mindSettings, documentIds),
      );
    },
    exportMind: async (mindId, options) => {
      const exported = await mindExports.export(mindId, options);
      // The host saves these bytes as a file: IncarnaMind's, wherever it goes. Noting so is
      // never needed for the file itself: a copy saved while storage refuses every write (#1119)
      // still goes out.
      try {
        recordOwnFile(exported.data, ownFileOf(options));
        recordExport(options);
      } catch (error) {
        console.error("export: the file couldn't be noted as IncarnaMind's", error);
      }
      return exported;
    },
    saveMindExport: async (mindId, options) => {
      const {
        fileName,
        fromWord: _,
        theirChanges: _waiting,
        citedDocuments: _cited,
        numbered: _numbered,
        data,
        word,
        ...counts
      } = await mindExports.export(mindId, options);
      // What a Word file can't keep is said before anything is saved (#105).
      const accepted = new Set(Array.isArray(options?.accept) ? options.accept : []);
      if (word?.notKept.some((loss) => !accepted.has(loss.key))) return { status: "review", word };
      const saved = await saveExport(
        fileName,
        data,
        () => recordExport(options),
        ownFileOf(options),
      );
      return saved.status === "saved" ? { ...saved, ...counts, word } : saved;
    },
    saveCheckRecord: async (mindId) => {
      const saved: { format: CheckRecordFormat; file: SavedFile }[] = [];
      const failures: CheckRecordFailure[] = [];
      let firstError: unknown;
      for (const { format, make } of await checkRecord.files(mindId)) {
        try {
          const { fileName, data } = await make();
          const result = await saveExport(fileName, data);
          if (result.status !== "saved") return result;
          saved.push({ format, file: result.file });
        } catch (error) {
          firstError ??= error;
          failures.push({
            format,
            message: error instanceof Error ? error.message : String(error),
            wording: error instanceof TranslatableError ? error.wording : null,
          });
        }
      }
      const [first] = saved;
      if (!first) throw firstError;
      return {
        status: "saved",
        file: first.file,
        withCsv: first.format === "pdf" && saved.some((each) => each.format === "csv"),
        failures,
      };
    },
    saveComparisonExport: async (input) => {
      const ref: Record<string, unknown> = isRecord(input) ? input : {};
      const { fileName, data, unverifiedCitations } = comparisonExport.workbook(
        ref.mindId,
        ref.tableId,
      );
      const saved = await saveExport(fileName, data);
      return saved.status === "saved" ? { ...saved, unverifiedCitations } : saved;
    },
    saveSkillExport: async (skillId) => {
      const { fileName, data } = await skills.exportZip(skillId);
      return saveExport(fileName, data);
    },
    formatCitations: (request) => citationStyles.format(request),
    getMindCitationStyle: async (mindId) => mindCitationStyle(minds.get(mindId).id),
    setMindCitationStyle: async (mindId, style, options) => {
      const notAStyle = (value: unknown) =>
        value !== null && value !== undefined && !isCitationStyleId(value);
      if (style === undefined || notAStyle(style)) {
        throw new InvalidInputError(`"${String(style)}" isn't a citation style.`);
      }
      const folderDefault = options?.folderDefault;
      if (notAStyle(folderDefault)) {
        throw new InvalidInputError(`"${String(folderDefault)}" isn't a citation style.`);
      }
      const mind = writableMind(mindId);
      content.editSettings(mind.id, (mindSettings) => setCitationStyle(mindSettings, style));
      // Undo passes the Folder's style back; what it puts back isn't a style the User chose.
      if (style !== null && folderDefault === undefined) {
        const recent = withRecentStyle(settings.get().user.recentCitationStyles, style);
        settings.update({ user: { recentCitationStyles: recent } });
        settingsChanged();
      }
      // The style chosen is the one new Minds in its Folder start in, as a document app keeps
      // the last template used; Undo puts back the one before.
      const { folderId } = minds.get(mind.id);
      if (folderId !== null) {
        if (folderDefault !== undefined) library.setCitationStyle(folderId, folderDefault);
        else if (style !== null) library.setCitationStyle(folderId, style);
      }
      return mindCitationStyle(mind.id);
    },
    listCitationStyles: async () => citationStyles.list(),
    openCitationStyleLicences: async () => {
      if (!adapters.shell)
        throw new Error("This copy of IncarnaMind can't open files in other apps.");
      // The notice is compressed in the pack, so it is written out, into a folder of its own.
      const folder = await mkdtemp(join(adapters.paths.tempDir ?? tmpdir(), "incarnamind-"));
      const path = join(folder, "IncarnaMind citation styles.txt");
      await writeFile(path, citationStyles.notice());
      await adapters.shell.openPath(path);
    },
    getMindStyle: async (mindId) => content.readSettings(minds.get(mindId).id, mindStyleOf),
    getPageSetup: async (mindId) => {
      const mind = minds.get(mindId);
      const paper = systemPaper();
      if (wordImports.originalOf(mind.id) === null) return nativePageSetup(paper);
      const pkg = await openWordPackage(await wordImports.packageOf(mind.id));
      return readPageSetup(pkg, PAGE_PAPER[paper]);
    },
    setMindStyle: async (mindId, style) => {
      if (!isMindStyle(style)) throw new InvalidInputError({ key: "error.mindStyle.invalid" });
      const mind = writableMind(mindId);
      content.editSettings(mind.id, (mindSettings) => writeMindStyle(mindSettings, style));
      return content.readSettings(mind.id, mindStyleOf);
    },
    getOutputSettings: async () => outputs.settings(),
    setOutputLocation: (path) => outputs.setLocation(path),
    setLinkedFolderWriting: async (linkedFolderId, allowed) =>
      outputs.setLinkedFolderWriting(linkedFolderId, allowed),
    listFileWriteRequests: async () => outputs.requests(),
    respondToFileWrite: (requestId, accept) => outputs.respond(requestId, accept),

    listMeetings: async () => meetings.list(),
    createMeeting: async (input) => meetings.create(input),
    discardMeeting: async (meetingId) => meetings.discard(meetingId),
    startMeeting: async (input) => meetings.start(input),
    pauseMeeting: async (meetingId) => meetings.pause(meetingId),
    resumeMeeting: async (meetingId) => meetings.resume(meetingId),
    stopMeeting: async (meetingId) => {
      const stopped = meetings.stop(meetingId);
      meetingFill.stopped(stopped.id);
      return meetings.get(stopped.id);
    },
    fillMeetingNotes: async (meetingId) => meetingFill.retry(meetings.get(meetingId).id),
    undoMeetingFill: async (meetingId) => meetingFill.undo(meetings.get(meetingId).id),
    deleteMeetingAudio: async (meetingId) => meetings.deleteAudio(meetingId),
    retryTranscript: async (meetingId) => meetings.retryTranscript(meetingId),
    listTranscriptionServices: () => cloudTranscription.list(),
    setTranscriptionKey: (input) => cloudTranscription.setKey(input),
    getTranscriptionSpeed: async () => {
      const speed = settings.readDeviceValue(TRANSCRIPTION_SPEED);
      const ratio =
        transcriptionModel && isRecord(speed) ? speed[transcriptionModel.definition.id] : undefined;
      return { keepsUp: typeof ratio === "number" ? ratio <= KEEPS_UP : null };
    },
    removeTranscriptionKey: async (route) => {
      const listed = await cloudTranscription.removeKey(route);
      transcriptionGateChanged();
      settingsChanged();
      return listed;
    },
    openAudioSettings: (source) => meetings.openSettings(source),
    askMeetingHelp,
    setMeetingTemplate: async (input) => {
      const { meetingId, template } = isRecord(input) ? input : {};
      if (template !== null && !isMeetingTemplate(template)) {
        throw new InvalidInputError({ key: "error.meeting.template" });
      }
      return meetings.setTemplate(meetingId, template);
    },
    setMeetingMicrophone: async (input) => meetings.setMicrophonePaused(input),

    openDocumentFile: async (documentId) => {
      const file = await documents.openFile(documentId);
      return { ...file, stream: viewing.watch(file.document.id, file.stream) };
    },
    openDocumentImage: (documentId, path) => documents.openImage(documentId, path),
    readCellNumber: (documentId, sheet, ref) => documents.cellNumber(documentId, sheet, ref),
    openDocumentInApp: async (documentId) => {
      const address = documents.get(documentId).web?.address;
      if (address) return adapters.browser.open(address);
      const path = await documents.filePath(documentId);
      if (!adapters.shell)
        throw new Error("This copy of IncarnaMind can't open files in other apps.");
      await adapters.shell.openPath(path);
    },
    showDocumentInFolder: async (documentId) => {
      const path = await documents.filePath(documentId);
      if (!adapters.shell) throw new Error("This copy of IncarnaMind can't show files.");
      adapters.shell.showItemInFolder(path);
    },
    showSavedFile: async (path) => {
      if (!outputs.saved(path)) throw new NotFoundError({ key: "error.files.notSaved.show" });
      if (!adapters.shell) throw new Error("This copy of IncarnaMind can't show files.");
      adapters.shell.showItemInFolder(path);
    },
    openSavedFile: async (path) => {
      if (!outputs.saved(path)) throw new NotFoundError({ key: "error.files.notSaved.open" });
      if (!adapters.shell)
        throw new Error("This copy of IncarnaMind can't open files in other apps.");
      await adapters.shell.openPath(path);
    },
    getAgents: async () => agents.settings(),
    setAgentsEnabled: (enabled) => agents.setEnabled(enabled),
    connectAgent: (input) => agents.connect(input),
    updateAgent: async (pairingId, input) => agents.update(pairingId, input),
    disconnectAgent: async (pairingId) => {
      await agentSetup.removeFromSettings(pairingId);
      await agents.disconnect(pairingId);
    },
    listAgentClients: async () => agentSetup.clients(),
    previewAgentSetup: async (client) => agentSetup.preview(client),
    setUpAgent: (input) => agentSetup.setUp(input),
    undoAgentSetup: (pairingId) => agentSetup.undo(pairingId),
    copyAgentSetup: (pairingId) => agentSetup.settingsFor(pairingId),
    getAgentLaunch: (pairingId) => agents.launch(pairingId),
    listAgentActivity: async (pairingId) => agents.activity(pairingId),
    reconcileDocuments: () => documents.linkedFolders.sync(),
    systemSleeping: () => meetings.sleeping(),
    systemAwake: () => meetings.awake(),
    on: (event, listener) => events.on(event, listener),
    onAnyEvent: (listener) => events.onAny(listener),
    dataFlows: consent.registry,
    networkTraffic: privacy.traffic,
    retention,
    citedPageImage: (citation) => citedPages.image(citation),
    startTask: (kind, mindId, input) => tasks.start(kind, mindId, input),
    prepareChatModel: (choice) => chat.prepareModel(choice),
    close: () => {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      // What a Meeting has captured is saved before anything else stops.
      meetings.close();
      transcripts?.close();
      speakerModel?.close();
      // Notes being filled in are left as they were: the next start says so.
      meetingFill.close();
      // Outside agents can't reach the core while it closes.
      void agents.close().catch((error: unknown) => console.error(error));
      // First, so stopping the Answers below starts no background work.
      citedPages.close();
      background.close();
      // An import goes on from where it got to at the next start.
      wordImports.close();
      void chatGpt.cancelSignIn();
      // Tasks stop where they are first, their journal as it was, so they go on at the next
      // start; what they wait for is withdrawn before approvals deny what is left.
      tasks.close();
      // Answers being written keep what they have, marked "stopped"; Tool calls waiting for
      // the User's approval are denied, and Skill scripts running are stopped.
      answers.stopAll();
      void webSearch.close().catch((error: unknown) => console.error(error));
      void pictureFetcher.close().catch((error: unknown) => console.error(error));
      suggestions.stop();
      edits.stopAll();
      checks.stopAll();
      skillDrafts.stopAll();
      scriptRunner.close();
      adapters.analysisRuntime?.close();
      approvals.close();
      connectors.close();
      tagger.close();
      library.close();
      batches.close();
      skills.close();
      stopTrackingUsage();
      consent.close();
      outputs.close();
      citationStyles.close();
      documents.close();
      embeddingModel.close();
      rerankingModel.close();
      textRecognitionModel?.close();
      activity.stop();
      checkpoints.close();
      aiUse.close();
      mindIndex.close();
      events.clear();
      content.closeAll();
      unsaved.quit();
      db.close();
    },
  };
  return api;
}

/** The account's name, or "" where the OS can't say (`userInfo` throws for a user without one). */
function accountName(): string {
  try {
    return userInfo().username;
  } catch (error) {
    console.warn("settings.accountName", error instanceof Error ? error.message : String(error));
    return "";
  }
}
