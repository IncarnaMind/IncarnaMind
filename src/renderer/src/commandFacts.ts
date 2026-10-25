/**
 * What the assistant's commands did (#1110), in the words of their rows, their card and the
 * undo line: from what each call returned, never from the reply. Only data and words.
 */
import type {
  AnswerToolCall,
  CommandDone,
  CommandsFound,
  ConversationAnswer,
} from "../../core/api";
import { ASSISTANT_COMMANDS, type AssistantCommandId } from "../../shared/commands";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { folderName } from "./linkedFolders";
import type { Translate } from "./objects";

/** Each command's words once done: for one thing, then for several. */
const DONE: Readonly<Record<Exclude<AssistantCommandId, "mind.export">, [MessageKey, MessageKey]>> =
  {
    "document.rename": ["commands.done.rename.document.one", "commands.done.rename.document"],
    "mind.rename": ["commands.done.rename.mind.one", "commands.done.rename.mind"],
    "document.moveTo": ["commands.done.moveTo.document.one", "commands.done.moveTo.document"],
    "mind.moveTo": ["commands.done.moveTo.mind.one", "commands.done.moveTo.mind"],
    "document.tags": ["commands.done.tags.one", "commands.done.tags"],
    "document.delete": ["commands.done.delete.document.one", "commands.done.delete.document"],
    "mind.delete": ["commands.done.delete.mind.one", "commands.done.delete.mind"],
    "documents.addFromFolder": ["commands.done.add.one", "commands.done.add"],
  };

const RUNNING: Readonly<Record<AssistantCommandId, MessageKey>> = {
  "document.rename": "commands.running.rename",
  "mind.rename": "commands.running.rename",
  "document.moveTo": "commands.running.moveTo",
  "mind.moveTo": "commands.running.moveTo",
  "document.tags": "commands.running.tags",
  "document.delete": "commands.running.delete",
  "mind.delete": "commands.running.delete",
  "mind.export": "commands.running.export",
  "documents.addFromFolder": "commands.running.add",
};

const isCommand = (value: string): value is AssistantCommandId =>
  Object.hasOwn(ASSISTANT_COMMANDS, value);

/** "Found 3 Documents · named “Northwind”", or that none matched. */
export function foundText(t: Translate, found: CommandsFound): string {
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
  done: Pick<CommandDone, "command" | "items" | "into" | "file">,
  count = done.items.length,
): string {
  if (done.command === "mind.export") {
    return done.file
      ? t("commands.done.export", { file: done.file.name, folder: folderName(done.file.folder) })
      : t("commands.done.none");
  }
  if (count === 0) return t("commands.done.none");
  const into = done.into?.name ?? "";
  const params: MessageParams = { count, folder: into, tag: into };
  const [one, many] = DONE[done.command];
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

/** Whether Undo takes anything back: a file saved stays saved. */
export const undoable = (done: readonly CommandDone[]): boolean =>
  done.some((each) => each.command !== "mind.export" && each.items.length > 0);

/**
 * What a Run's commands did, those alike counted together:
 * "Renamed 3 Documents · Moved 2 Documents to “Real estate”".
 */
export function runText(t: Translate, done: readonly CommandDone[]): string {
  const groups = new Map<string, { done: CommandDone; count: number }>();
  for (const each of done) {
    const key =
      each.command === "mind.export"
        ? `${each.command} ${each.file?.path ?? ""}`
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
    return t(
      field(call, "kind") === "mind" ? "commands.finding.mind" : "commands.finding.document",
    );
  }
  if (call.command) return doneText(t, call.command);
  if (call.approval === "denied") return t("commands.denied");
  if (call.status === "failed") {
    const problem = call.commandProblem;
    if (!problem) return t("commands.notRun");
    const reason = problem.wording
      ? t(problem.wording.key, problem.wording.values)
      : problem.message;
    return t("commands.failed", { reason });
  }
  const command = field(call, "command");
  return t(isCommand(command) ? RUNNING[command] : "commands.running");
}
