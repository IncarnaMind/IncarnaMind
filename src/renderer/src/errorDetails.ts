import type { Language } from "../../core/language";
import { gap, type MessageKey } from "../../shared/i18n";
import type { ErrorNotice } from "./notices";
import type { Translate } from "./objects";

/** What a core call does, by the first word of its name ("renameDocument" renames). */
const VERBS: Readonly<Record<string, MessageKey>> = {
  add: "error.doing.verb.add",
  create: "error.doing.verb.create",
  save: "error.doing.verb.save",
  rename: "error.doing.verb.rename",
  delete: "error.doing.verb.delete",
  discard: "error.doing.verb.delete",
  remove: "error.doing.verb.remove",
  forget: "error.doing.verb.remove",
  move: "error.doing.verb.move",
  open: "error.doing.verb.open",
  export: "error.doing.verb.export",
  print: "error.doing.verb.export",
  import: "error.doing.verb.import",
  check: "error.doing.verb.check",
  verify: "error.doing.verb.check",
  recheck: "error.doing.verb.check",
  get: "error.doing.verb.read",
  list: "error.doing.verb.read",
  read: "error.doing.verb.read",
  preview: "error.doing.verb.read",
  show: "error.doing.verb.read",
  fetch: "error.doing.verb.read",
  search: "error.doing.verb.search",
  find: "error.doing.verb.search",
  set: "error.doing.verb.change",
  update: "error.doing.verb.change",
  edit: "error.doing.verb.change",
  change: "error.doing.verb.change",
  apply: "error.doing.verb.change",
  resize: "error.doing.verb.change",
  insert: "error.doing.verb.add",
  restore: "error.doing.verb.restore",
  revert: "error.doing.verb.restore",
  undo: "error.doing.verb.undo",
  redo: "error.doing.verb.redo",
  duplicate: "error.doing.verb.duplicate",
  download: "error.doing.verb.download",
  ask: "error.doing.verb.ask",
  regenerate: "error.doing.verb.regenerate",
  test: "error.doing.verb.test",
  start: "error.doing.verb.start",
  stop: "error.doing.verb.stop",
  pause: "error.doing.verb.pause",
  resume: "error.doing.verb.resume",
  cancel: "error.doing.verb.cancel",
};

/** What a core call works on, by the words after its verb; a kind before the more general one it contains. */
const NOUNS: readonly (readonly [RegExp, MessageKey])[] = [
  [/Tag/, "error.doing.noun.tags"],
  [/LinkedFolder/, "error.doing.noun.linkedFolders"],
  [/LibraryGroup|Folder|Assignment/, "error.doing.noun.folders"],
  [/Examples?/, "error.doing.noun.examples"],
  [/Comparison/, "error.doing.noun.comparisons"],
  [/CitationStyle/, "error.doing.noun.citationStyle"],
  [/Mind|Note/, "error.doing.noun.notes"],
  [/Document|Passage|Evidence/, "error.doing.noun.documents"],
  [/Conversation/, "error.doing.noun.conversations"],
  [/Connector/, "error.doing.noun.connectors"],
  [/Skill/, "error.doing.noun.skills"],
  [/Meeting|Memo|Transcript/, "error.doing.noun.meetings"],
  [/Task|Research/, "error.doing.noun.tasks"],
  [/Checkpoint/, "error.doing.noun.checkpoints"],
  [/Annotation/, "error.doing.noun.highlights"],
  [/Citation/, "error.doing.noun.citations"],
  [/Reference/, "error.doing.noun.references"],
  [/Answer/, "error.doing.noun.answers"],
  [/Question/, "error.doing.noun.questions"],
  [/Settings|Layout|Output|PageSetup|ExportMarks/, "error.doing.noun.settings"],
  [/Chat|Ollama|Tagging|ModelRoles/, "error.doing.noun.aiModels"],
  [/Embedding|Rerank/, "error.doing.noun.searchModel"],
  [/WebPage/, "error.doing.noun.webPages"],
  [/Agent/, "error.doing.noun.agents"],
  [/Library/, "error.doing.noun.library"],
];

/** What to do about a failure of the system's, by its plain words; any other failure gets "Try again". */
const WHAT_TO_DO: Readonly<Partial<Record<MessageKey, MessageKey>>> = {
  "error.system.notAllowed": "error.details.todo.notAllowed",
  "error.system.full": "error.details.todo.full",
  "error.system.diskError": "error.details.todo.diskError",
  "error.system.busy": "error.details.todo.busy",
  "error.system.fileBusy": "error.details.todo.fileBusy",
  "error.system.gone": "error.details.todo.gone",
  "error.system.nameTooLong": "error.details.todo.nameTooLong",
  "error.system.exists": "error.details.todo.exists",
  "error.system.isFolder": "error.details.todo.exists",
  "error.system.tooManyFiles": "error.details.todo.tooManyFiles",
  "error.system.otherDevice": "error.details.todo.otherDevice",
  "error.system.tooBig": "error.details.todo.tooBig",
  "error.system.dataFolder": "error.details.todo.dataFolder",
  "error.system.corrupt": "error.details.todo.corrupt",
};

/**
 * What a core call was doing, in words: "renaming Documents". Null when its name says nothing
 * a person would use (no object it works on); the verb alone, such as "working with", is the
 * fallback for an object known and a verb not.
 */
export function errorDoing(t: Translate, language: Language, call: string): string | null {
  const verb = /^[a-z0-9]+/.exec(call)?.[0] ?? "";
  const rest = call.slice(verb.length);
  const noun = NOUNS.find(([pattern]) => pattern.test(rest))?.[1];
  if (!noun) return null;
  const action = t(VERBS[verb] ?? "error.doing.verb.work");
  const object = t(noun);
  return action + gap(language, action, object) + object;
}

/**
 * What a notice's line says, in the interface language: the sentence the failure carries, or the
 * plain Problem for one this window's own code raised, whose sentence names code (#2823).
 */
export function errorLine(
  t: Translate,
  notice: Pick<ErrorNotice, "message" | "wording" | "reason" | "programError">,
): string {
  if (notice.programError) return t("error.action.plain");
  const said = notice.wording
    ? t(notice.wording.key, notice.wording.values)
    : notice.reason
      ? t(notice.reason)
      : notice.message;
  return t("error.action", { message: said });
}

/**
 * A notice's Details, in plain words and never an internal name: what was said, what was being
 * done, and what to do. The method and the class that failed go to the log (`ErrorNotice.log`).
 */
export function errorDetails(
  t: Translate,
  language: Language,
  notice: Pick<ErrorNotice, "message" | "wording" | "reason" | "call" | "programError" | "stale">,
): string[] {
  const said = notice.programError
    ? t("error.details.internal")
    : notice.wording
      ? t(notice.wording.key, notice.wording.values)
      : notice.reason
        ? t(notice.reason)
        : notice.message;
  const doing = notice.call ? errorDoing(t, language, notice.call) : null;
  const tried = doing ? t("error.details.tried", { doing }) : t("error.details.tried.unknown");
  const todo = notice.programError
    ? notice.stale
      ? "error.details.todo.stale"
      : "error.details.todo"
    : (notice.reason && WHAT_TO_DO[notice.reason]) || "error.details.todo";
  return [said, tried, t(todo)];
}
