/**
 * What the assistant's commands did (#1110, #1421), in the words of their rows, their card and
 * the undo line: from what each call returned, never from the reply. Only data and words.
 */
import type {
  AnswerToolCall,
  ApprovalReadText,
  CommandDone,
  CommandsFound,
  ConversationAnswer,
} from "../../core/api";
import { LANGUAGES } from "../../core/language";
import {
  type CommandId,
  isCommandId,
  type Yours,
  yoursLine,
  yoursWordsOf,
} from "../../shared/commands";
import { isMessageKey, type MessageKey, type MessageParams } from "../../shared/i18n";
import { commands, labelOf } from "./commands/registry";
import { folderName } from "./linkedFolders";
import type { Translate } from "./objects";

/** The core's commands' words once done: for one thing, then for several. */
const DONE: Readonly<Partial<Record<CommandId, [MessageKey, MessageKey]>>> = {
  "document.rename": ["commands.done.rename.document.one", "commands.done.rename.document"],
  "mind.rename": ["commands.done.rename.mind.one", "commands.done.rename.mind"],
  "document.moveTo": ["commands.done.moveTo.document.one", "commands.done.moveTo.document"],
  "mind.moveTo": ["commands.done.moveTo.mind.one", "commands.done.moveTo.mind"],
  "document.tags": ["commands.done.tags.one", "commands.done.tags"],
  "document.delete": ["commands.done.delete.document.one", "commands.done.delete.document"],
  "mind.delete": ["commands.done.delete.mind.one", "commands.done.delete.mind"],
  "documents.addFromFolder": ["commands.done.add.one", "commands.done.add"],
  "documents.organize": ["commands.done.organize.one", "commands.done.organize"],
  "folder.rename": ["commands.done.rename.folder.one", "commands.done.rename.folder"],
  "folder.delete": ["commands.done.delete.folder.one", "commands.done.delete.folder"],
  "tag.rename": ["commands.done.rename.tag.one", "commands.done.rename.tag"],
  "tag.delete": ["commands.done.delete.tag.one", "commands.done.delete.tag"],
  "deleted.restore": ["commands.done.restore.one", "commands.done.restore"],
};

/** A move into a Folder the command made: "Made “Leases” and moved 3 Documents into it". */
const MADE_AND_MOVED: Readonly<Partial<Record<CommandId, [MessageKey, MessageKey]>>> = {
  "document.moveTo": ["commands.done.madeMoved.document.one", "commands.done.madeMoved.document"],
  "mind.moveTo": ["commands.done.madeMoved.mind.one", "commands.done.madeMoved.mind"],
};

const RUNNING: Readonly<Partial<Record<CommandId, MessageKey>>> = {
  "document.rename": "commands.running.rename",
  "mind.rename": "commands.running.rename",
  "folder.rename": "commands.running.rename",
  "tag.rename": "commands.running.rename",
  "document.moveTo": "commands.running.moveTo",
  "mind.moveTo": "commands.running.moveTo",
  "document.tags": "commands.running.tags",
  "document.delete": "commands.running.delete",
  "mind.delete": "commands.running.delete",
  "folder.delete": "commands.running.delete",
  "tag.delete": "commands.running.delete",
  "mind.export": "commands.running.export",
  "documents.addFromFolder": "commands.running.add",
  "documents.organize": "commands.running.organize",
  "deleted.restore": "commands.running.restore",
};

/** What an Answer asked for that is the User's alone, each once, in the order asked. */
export function refusalsOf(
  answer: Pick<ConversationAnswer, "toolCalls">,
): { what: Yours; folder: CommandDone["folder"] }[] {
  return [
    ...new Map(
      answer.toolCalls.flatMap((call) => {
        const done = call.command;
        return done?.yours
          ? [[`${done.yours} ${done.folder?.id ?? ""}`, { what: done.yours, folder: done.folder }]]
          : [];
      }),
    ).values(),
  ];
}

/**
 * Whether the reply already says this refusal's sentence, in either language, as the core writes
 * it when the model says nothing (#2252): the card then shows only its button.
 */
export const saidInReply = (text: string, what: Yours, folder: CommandDone["folder"]): boolean =>
  LANGUAGES.some((language) => text.includes(yoursLine(language, what, folder)));

/** Whether the reply is only its refusals' sentences: nothing in it to keep in a note. */
export function repliesOnlyRefusals(
  answer: Pick<ConversationAnswer, "text" | "toolCalls">,
): boolean {
  const lines = refusalsOf(answer).flatMap(({ what, folder }) =>
    LANGUAGES.map((language) => yoursLine(language, what, folder)),
  );
  if (lines.length === 0) return false;
  return lines.reduce((rest, line) => rest.split(line).join(""), answer.text).trim() === "";
}

/** How a window's command didn't do what it was asked, each said as the whole line, not "Didn't run: …". */
const WHOLE_LINES = new Set<MessageKey>([
  "commands.denied",
  "commands.window.unanswered",
  "commands.window.closed",
  "commands.window.unfinished",
  "commands.window.alreadyChecking",
  "mindCheck.nothingToCheck",
  "run.stopped.cancelled",
  "checks.problem.no-claims",
  "checks.problem.no-documents.all",
  "checks.problem.local-mode",
]);

type Gap = (before: string, after: string) => string;

/**
 * What an Answer read that the User didn't write, on the approval of a command it asks about, in
 * the order the card names them: Documents, web pages by host, pages whose title alone was seen
 * (never the title they write, #2240), web search's results, Connectors, a script's output, the
 * Transcript, and other text for anything the rest cannot name. Other text alone is the bare
 * sentence, with no list. Null when nothing is left to show.
 */
export function readTextLine(t: Translate, read: ApprovalReadText, gap: Gap): string | null {
  const [document] = read.documents;
  const [page] = read.webPages;
  const [pageTitle] = read.webPageTitles;
  const [connector] = read.connectors;
  const parts = [
    ...(read.documents.length === 1 && document !== undefined
      ? [t("commands.ask.readText.document", { name: document })]
      : read.documents.length > 1
        ? [t("commands.ask.readText.documents", { count: read.documents.length })]
        : []),
    ...(read.webPages.length === 1 && page !== undefined
      ? [t("commands.ask.readText.webPage", { host: page })]
      : read.webPages.length > 1
        ? [t("commands.ask.readText.webPages", { count: read.webPages.length })]
        : []),
    ...(read.webPageTitles.length === 1 && pageTitle !== undefined
      ? [t("commands.ask.readText.webPageTitle", { host: pageTitle })]
      : read.webPageTitles.length > 1
        ? [t("commands.ask.readText.webPageTitles", { count: read.webPageTitles.length })]
        : []),
    ...(read.webSearchResults ? [t("commands.ask.readText.webSearch")] : []),
    ...(read.connectors.length === 1 && connector !== undefined
      ? [t("commands.ask.readText.connector", { connector })]
      : read.connectors.length > 1
        ? [t("commands.ask.readText.connectors", { count: read.connectors.length })]
        : []),
    ...(read.scriptOutput ? [t("commands.ask.readText.script")] : []),
    ...(read.transcript ? [t("commands.ask.readText.transcript")] : []),
  ];
  if (read.otherText) {
    if (parts.length === 0) return t("commands.ask.readText.only");
    parts.push(t("commands.ask.readText.other"));
  }
  return parts.length === 0 ? null : t("commands.ask.readText", { what: joined(t, gap, parts) });
}

/** The kinds as one list: "A, B and C"; in Chinese "A、B和C". */
function joined(t: Translate, gap: Gap, parts: readonly string[]): string {
  const [first = "", ...rest] = parts;
  if (rest.length === 0) return first;
  const comma = t("commands.ask.readText.comma");
  const and = t("commands.ask.readText.and");
  const before = [first, ...rest.slice(0, -1)].reduce(
    (text, part) => text + comma + gap(comma, part) + part,
  );
  const last = rest.at(-1) ?? "";
  return `${before}${gap(before, and)}${and}${gap(and, last)}${last}`;
}

/** A setting's name as Settings shows it, by the name the assistant's command gives it. */
const SETTING_NAMES: Readonly<Record<string, MessageKey>> = {
  language: "settings.language",
  motion: "settings.motion",
  taskNotifications: "settings.taskNotifications",
  authorName: "settings.authorName",
  newNoteFont: "commands.setting.newNoteFont",
  newNoteTextSize: "commands.setting.newNoteTextSize",
  exportFormat: "commands.setting.exportFormat",
  leaveOutOwnFiles: "evidence.settings.switch",
  keepWebPageLook: "webPages.add.keepLook",
  meetingSystemAudio: "commands.setting.meetingSystemAudio",
  meetingPanel: "meetings.callHelp.show",
  meetingPanelHidden: "meetings.settings.hidden",
  model: "commands.setting.model",
  outputLocation: "outputLocation.title",
};

/** A setting's value in the interface's words, where it has them; a name or a folder as it is. */
const VALUE_WORDS: Readonly<Record<string, MessageKey>> = {
  on: "commands.value.on",
  off: "commands.value.off",
  none: "commands.value.none",
  system: "commands.value.system",
  default: "commands.value.default",
  reduced: "settings.motion.reduced",
  serif: "mindStyle.font.serif",
  mono: "mindStyle.font.mono",
  small: "mindStyle.size.small",
  large: "mindStyle.size.large",
  en: "commands.value.en",
  "zh-CN": "commands.value.zh",
};

const valueText = (t: Translate, value: string) => {
  const key = VALUE_WORDS[value] ?? `export.format.${value}`;
  return isMessageKey(key) ? t(key) : value;
};

/** A note's style as the core says it, "serif, large": its font, then its text size. */
const styleText = (t: Translate, style: string) =>
  style
    .split(", ")
    .map((part) => valueText(t, part))
    .join(t("commands.value.and"));

/** A command of the window's list by its name in the interface language; its id if it is gone. */
function windowLabel(t: Translate, id: CommandId): string {
  const command = commands.get(id);
  if (!command) return id;
  try {
    return labelOf(command, { selection: [], focus: null, surface: "palette" }, t);
  } catch (error) {
    console.error(`The command ${id} couldn't say its name.`, error);
    return id;
  }
}

/** "Found 3 Documents · named “Northwind”", or that none matched. */
export function foundText(t: Translate, found: CommandsFound): string {
  if (found.kind === "window") return t("commands.found.window");
  const head =
    found.count === 0
      ? t(`commands.found.none.${found.kind}`)
      : found.count === 1
        ? t(`commands.found.${found.kind}.one`)
        : t(`commands.found.${found.kind}`, { count: found.count });
  const by = [
    ...(found.by.name ? [t("commands.by.name", { value: found.by.name })] : []),
    ...(found.by.tag ? [t("commands.by.tag", { value: found.by.tag })] : []),
    ...(found.by.folder ? [t("commands.by.folder", { value: found.by.folder })] : []),
  ];
  return [head, ...by].join(" · ");
}

/** What one command did, `count` things: "Moved 2 Documents to “Real estate”". */
export function doneText(
  t: Translate,
  done: Pick<
    CommandDone,
    "command" | "items" | "into" | "file" | "window" | "yours" | "folder" | "setting"
  >,
  count = done.items.length,
): string {
  if (done.yours) {
    return t(yoursWordsOf(done.yours, done.folder).said, { folder: done.folder?.name ?? "" });
  }
  if (done.window) {
    if (done.window.running) {
      return t("commands.running.window", { command: windowLabel(t, done.command) });
    }
    const [first] = done.items;
    if ((done.command === "mind.openBeside" || done.command === "document.openBeside") && first) {
      return t("commands.done.openedBeside", { name: first.name });
    }
    return t("commands.done.window", { command: windowLabel(t, done.command) });
  }
  if (done.command === "mind.export") {
    return done.file
      ? t("commands.done.export", { file: done.file.name, folder: folderName(done.file.folder) })
      : t("commands.done.none");
  }
  if (done.setting) {
    const { name, to } = done.setting;
    if (done.command === "mind.citationStyle" || done.command === "mind.style") {
      return t(
        done.command === "mind.citationStyle"
          ? "commands.done.citationStyle"
          : "commands.done.style",
        {
          name: done.items[0]?.name ?? "",
          value: done.command === "mind.style" ? styleText(t, to) : to,
        },
      );
    }
    const setting = SETTING_NAMES[name];
    return t("commands.done.setting", {
      setting: setting ? t(setting) : name,
      value: name === "outputLocation" ? folderName(to) : valueText(t, to),
    });
  }
  if (done.command === "folder.new" || done.command === "tag.new") {
    const name = done.into?.name ?? done.items[0]?.name ?? "";
    return t(done.command === "folder.new" ? "commands.made.folder" : "commands.made.tag", {
      name,
    });
  }
  if (count === 0) return t("commands.done.none");
  const into = done.into?.name ?? "";
  const params: MessageParams = { count, folder: into, tag: into };
  const made =
    done.into?.made && done.into.kind === "folder" ? MADE_AND_MOVED[done.command] : undefined;
  const words = made ?? DONE[done.command];
  if (!words) return t("commands.done.window", { command: windowLabel(t, done.command) });
  const [one, many] = words;
  return t(count === 1 ? one : many, params);
}

/** The commands an Answer ran, by the Run they were part of: one step of Undo each. */
export function commandRuns(
  answer: Pick<ConversationAnswer, "toolCalls">,
): { run: string; done: CommandDone[] }[] {
  const runs = new Map<string, CommandDone[]>();
  for (const call of answer.toolCalls) {
    if (!call.command) continue;
    runs.set(call.command.run, [...(runs.get(call.command.run) ?? []), call.command]);
  }
  return [...runs].map(([run, done]) => ({ run, done }));
}

/** Whether Undo takes anything back: a file saved stays saved, and what only showed changes nothing. */
export const undoable = (done: readonly CommandDone[]): boolean =>
  done.some((each) => {
    if (each.yours) return false;
    if (each.window) return each.window.changed;
    if (each.setting) return true;
    return each.command !== "mind.export" && each.items.length > 0;
  });

const isMove = (done: CommandDone) =>
  done.command === "document.moveTo" || done.command === "mind.moveTo";

/**
 * A Folder made, then things moved into it, said as one: "Made “Leases” and moved 3 Documents
 * into it", as a move that makes its Folder says it.
 */
function madeThenMoved(done: readonly CommandDone[]): CommandDone[] {
  const made = new Set(
    done.flatMap((each) => (each.command === "folder.new" && each.into ? [each.into.id] : [])),
  );
  const movedInto = new Set(
    done.flatMap((each) => (isMove(each) && each.into ? [each.into.id] : [])),
  );
  return done
    .filter((each) => !(each.command === "folder.new" && each.into && movedInto.has(each.into.id)))
    .map((each) =>
      isMove(each) && each.into && made.has(each.into.id)
        ? { ...each, into: { ...each.into, made: true } }
        : each,
    );
}

/**
 * What a Run's commands did, those alike counted together:
 * "Renamed 3 Documents · Moved 2 Documents to “Real estate”".
 */
export function runText(t: Translate, done: readonly CommandDone[]): string {
  const groups = new Map<string, { done: CommandDone; count: number }>();
  for (const each of madeThenMoved(done)) {
    const key =
      each.command === "mind.export"
        ? `${each.command} ${each.file?.path ?? ""}`
        : each.window || each.setting || each.yours
          ? `${each.command} ${each.items.map((item) => item.id).join(" ")} ${each.setting?.name ?? ""} ${each.yours ?? ""}`
          : `${each.command} ${each.into?.id ?? ""}`;
    const group = groups.get(key);
    if (group) group.count += each.items.length;
    else groups.set(key, { done: each, count: each.items.length });
  }
  return [...groups.values()].map((group) => doneText(t, group.done, group.count)).join(" · ");
}

const field = (call: AnswerToolCall, name: string): string => {
  const value: unknown = call.input?.[name];
  return typeof value === "string" ? value : "";
};

/** What a call of a command's Tool is doing, or did, in its row's words. */
export function commandCallText(t: Translate, call: AnswerToolCall): string {
  if (call.tool === "list_commands") {
    if (call.found) return foundText(t, call.found);
    const kind = field(call, "kind");
    return t(
      kind === "mind"
        ? "commands.finding.mind"
        : kind === "folder"
          ? "commands.finding.folder"
          : kind === "tag"
            ? "commands.finding.tag"
            : kind === "deleted"
              ? "commands.finding.deleted"
              : kind === "window"
                ? "commands.finding.window"
                : "commands.finding.document",
    );
  }
  if (call.command) return doneText(t, call.command);
  if (call.approval === "denied") return t("commands.denied");
  if (call.status === "failed") {
    const problem = call.commandProblem;
    if (!problem) return t("commands.notRun");
    if (problem.wording && WHOLE_LINES.has(problem.wording.key)) {
      const values = problem.wording.values ?? {};
      return t(problem.wording.key, {
        ...values,
        ...(isCommandId(values.command) && { command: windowLabel(t, values.command) }),
      });
    }
    const reason = problem.wording
      ? t(problem.wording.key, problem.wording.values)
      : problem.message;
    return t("commands.failed", { reason });
  }
  const command = field(call, "command");
  if (!isCommandId(command)) return t("commands.running");
  const running = RUNNING[command];
  if (running) return t(running);
  return commands.get(command)
    ? t("commands.running.window", { command: windowLabel(t, command) })
    : t("commands.running");
}
