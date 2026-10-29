/**
 * The IncarnaMind core: all app logic, with no Electron imports (ADR-0004, ADR-0006).
 * Hosts construct it with `createCore`, passing platform capabilities as adapters.
 */

export type {
  AnalysisCell,
  AnalysisEnd,
  AnalysisInput,
  AnalysisJob,
  AnalysisLanguage,
  AnalysisOutput,
  AnalysisResult,
  AnalysisVersions,
} from "../shared/analysis";
export type {
  DrawnPage,
  PageArea,
  PageBox,
  PageCaptureRequest,
  PageText,
} from "../shared/citedPage";
export type {
  AnalysisRuntime,
  AudioCapture,
  AudioSink,
  Browser,
  CapturePage,
  CaptureSession,
  CaptureState,
  CloudLoss,
  CloudStream,
  CoreAdapters,
  CpuFallbackReason,
  CrashReporter,
  CrossEncoder,
  Embedder,
  EmbeddingModelFiles,
  EmbeddingModelSource,
  EngineSwitch,
  ExecAllow,
  ExecFolder,
  ExecRequest,
  ExecResult,
  Executor,
  FileShell,
  Keychain,
  LinkedFolderOptions,
  LogFields,
  Logger,
  LogValue,
  ModelFile,
  ModelRuntimeFolder,
  OllamaApp,
  PageLook,
  PagePicture,
  Paths,
  Pictures,
  Printer,
  ProcessLauncher,
  RecognizedLine,
  RerankingCheck,
  RerankingDevice,
  RerankingModelFiles,
  ScriptRuntimes,
  SpawnOptions,
  SpeakerModelFiles,
  SpeakerSeparator,
  SpeechSegment,
  SystemNotifications,
  TextRecognitionFiles,
  TextRecognizer,
  Transcriber,
  TranscriberListener,
  TranscriptionModelFiles,
  UsageDataSender,
  UsageEventMessage,
  VoiceTurn,
} from "./adapters";
export { MEETING_SAMPLE_RATE } from "./adapters";
export * from "./api";
export { CITED_PAGES_FOLDER, type CitedPlace } from "./citedPages";
export { type Core, createCore, DATABASE_FILE } from "./core";
export type { DocumentFile, DocumentImage } from "./documents";
export { ExtractionError } from "./documents/formats/errors";
export {
  RETENTION_KINDS,
  type RetainedVersion,
  type RetainVersion,
  type RetentionKind,
  type VersionRetention,
} from "./documents/retention";
export type { Reranker } from "./documents/searchTool";
export type { AnswerSearchTuning, ObservedSearch } from "./documents/searchTuning";
export type { FolderWatcher, WatchFolder, WatchListener } from "./documents/watcher";
export { BUILT_IN_EMBEDDING_MODEL } from "./embedding";
export {
  ChatNotReadyError,
  ConsentDeclinedError,
  ConsentNeededError,
  DataFromNewerVersionError,
  EmbeddingModelNotReadyError,
  FileWriteCancelledError,
  InvalidInputError,
  LinkedFolderWritesDeclinedError,
  MindReadOnlyError,
  NotFoundError,
  SecretStorageError,
} from "./errors";
export * from "./language";
export type { AnswerPathsOverride } from "./providers/catalog/answerPaths";
export type { ChatGptPlanEndpoints } from "./providers/chatgpt/plan";
export type { EmbeddingModelFactory, EmbeddingModelSpec } from "./providers/embeddings";
export {
  type ChatModelFactory,
  type ChatModelSpec,
  type ContextWindow,
  createAiSdkChatModel,
} from "./providers/models";
export { RECOMMENDED_OLLAMA_DOWNLOAD_GB, RECOMMENDED_OLLAMA_MODEL } from "./providers/ollama";
export {
  createOllamaModels,
  type OllamaModelProfile,
  type OllamaModelSettings,
  type OllamaModels,
} from "./providers/ollamaModels";
export type { RerankingModelFactory, RerankingModelSpec } from "./providers/rerank";
export { blockReference, messageReference, parseReference } from "./references";
export { BUILT_IN_RERANKING_MODEL, type RerankingModelDefinition } from "./reranking";
export { fileWrite } from "./runs/effects";
export type { TaskApprovalCall } from "./runs/journal";
export type { TaskEnd, TaskKind, TaskRun, TaskTurn } from "./runs/tasks";
export { BUILT_IN_SKILLS_PACKAGED, BUILT_IN_SKILLS_SOURCE } from "./skills/builtIn";
export {
  COMMON_FIELDS,
  SENDER_FIELDS,
  UI_USAGE_EVENTS,
  type UiUsageEvent,
  USAGE_EVENTS,
  type UsageEvent,
  type UsageEventFields,
  type UsageEventName,
  type UsageValue,
} from "./usageEvents";
