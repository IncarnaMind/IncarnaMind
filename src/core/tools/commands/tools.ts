/**
 * The commands' Tools (#1110, #1421, ADR-0013): the assistant does what the User could do with
 * the app's commands, the window's list that ⌘K shows. `list_commands` finds the Documents,
 * Minds, Folders or Tags a command would act on, matched exactly, and says which commands apply;
 * for "window", the commands that act on the window in front. `run_command` runs one: the core's
 * own (./catalogue), or the window's, which the window runs as ⌘K does. What a call does decides
 * whether it asks the User first (./policy): a few changes inside IncarnaMind run at once and the
 * Run's changes are one step of Undo; the rest wait for the User at the Answer's gate (`check`).
 * A command that only acts on the window, or that is the User's alone, ends the turn: the card
 * under the reply says in one line what it did, or where the User changes it.
 */
import { COMMAND_TARGETS, type CommandTarget, type OfferedCommand } from "../../../shared/commands";
import {
  COMMAND_AT_ONCE,
  type CommandAsk,
  type CommandDone,
  type CommandProblem,
  type CommandsFound,
  type UserAnswer,
  type UserQuestion,
  type WindowCommandEnd,
} from "../../api";
import { TranslatableError } from "../../errors";
import type { Language } from "../../language";
import { COMMAND_TOOLS, type Tool, type ToolProviderInfo } from "../index";
import {
  CORE_COMMANDS,
  type CoreCommandId,
  checkCommand,
  commandEffects,
  coreCommandsOn,
  isCoreCommand,
} from "./catalogue";
import { type Findable, type FindInput, find, foundLine, foundOf } from "./find";
import { askOf, type CommandRename, renamesOf } from "./policy";
import {
  type CheckedCommand,
  COMMAND_EXPORT_FORMATS,
  type CommandFiling,
  type CommandsHost,
  parseCommandInput,
} from "./run";
import { SETTING_NAMES } from "./settings";
import type { CommandSteps } from "./steps";

const PROVIDER: ToolProviderInfo = { kind: "commands", id: "commands", name: "Commands" };

/** How many found things the model reads; past that it is asked to narrow the search. */
const MAX_LISTED = 100;

const coreLine = (id: CoreCommandId) => `${id} (${CORE_COMMANDS[id].takes})`;

const windowLine = (entry: OfferedCommand) =>
  `${entry.id} (“${entry.label}”${entry.purpose ? `: ${entry.purpose}` : ""}${entry.deletes ? "; to Recently deleted, asks first" : entry.final ? "; can't be undone, asks first" : ""})`;

/** The core's commands for a kind, then the window's that act on it and that the core doesn't run. */
function commandsFor(kind: CommandTarget, offered: readonly OfferedCommand[]): string {
  const windows = offered.filter(
    (entry) => entry.yours === null && entry.on?.includes(kind) && !isCoreCommand(entry.id),
  );
  return [...coreCommandsOn(kind).map(coreLine), ...windows.map(windowLine)].join("; ");
}

const nouns: Record<CommandTarget, [string, string]> = {
  document: ["Document", "Documents"],
  mind: ["Note", "Notes"],
  folder: ["Folder", "Folders"],
  tag: ["Tag", "Tags"],
  deleted: ["thing in Recently deleted", "things in Recently deleted"],
};

/** What only the User changes (#1421), as the model is told how to ask for it. */
const YOURS_RULE =
  "Never yours to change: keys and sign-ins, consent, Local mode, Privacy and what leaves the computer, what you may do without asking, the monthly spending cap, deleting for good, giving “Checked by me”, and marking text as the User's own. For a request for one, call run_command with settings.change and that setting (localMode, consent, privacy, webSearch, apiKey, signIn, approvals, monthlyCap, …), or with the window's own command for it: nothing runs, and the User is shown where they change it.";

export interface CommandToolsOptions {
  host: CommandsHost;
  /** The User's Documents, Minds, Folders and Tags as they are now. */
  findable(mindId: string | null, wallId?: string | null): Promise<Findable>;
  /** The wall of the Conversation, when no Note is open. */
  wallId?: string | null;
  /** Where what a command adds is filed (#1934). */
  filing: CommandFiling;
  /** The Mind the User is in, which `list_commands` points out. */
  focusedMindId: string | null;
  /** The saved web pages the Run's instructions name, by id: their titles are someone else's. */
  titledPages: readonly string[];
  /** The renames of the Conversation's earlier Answers, oldest first (`renamesIn`). */
  renames: readonly CommandRename[];
  /** The Answer the calls are part of: the window that asked for it runs the window's commands. */
  answerId: string;
  /** The Run the calls are part of: its changes are one step of Undo in `steps`. */
  runId: string;
  steps: CommandSteps;
  /** The asking window's commands, as it offered them (#1421); empty: only the core's own. */
  offered: readonly OfferedCommand[];
  /** The asking window, which alone runs its commands; null: none asked, so none run. */
  clientId: string | null;
  /** The Answer's language, which what a command asks the User in the tray is in. */
  language: Language;
  /** Asks the User in the tray for a command that needs an answer to go on; none: it can't ask. */
  ask?: (toolCallId: string, question: UserQuestion, signal: AbortSignal) => Promise<UserAnswer>;
  found(toolCallId: string, found: CommandsFound): void;
  ran(toolCallId: string, done: CommandDone): void;
  failed(toolCallId: string, problem: CommandProblem): void;
  /** How a window's command that started and went on ended, after its call returned. */
  ended(toolCallId: string, end: { done: CommandDone } | { problem: CommandProblem }): void;
}

const given = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const problemOf = (command: string, error: unknown): CommandProblem => ({
  command,
  message: error instanceof Error ? error.message : String(error),
  wording: error instanceof TranslatableError ? error.wording : null,
});

const isTarget = (value: unknown): value is CommandTarget =>
  COMMAND_TARGETS.some((each) => each === value);

export function commandTools(options: CommandToolsOptions): {
  tools: Tool[];
  /**
   * Checks a call of `run_command` at the Answer's gate and keeps it for its run: what it would
   * do, whether it asks first, and whether the Run had read a web page's title by then. Throws,
   * the card saying why, for one that can't run. One call at a time: the count of the Answer's
   * changes decides the next.
   */
  check(
    toolCallId: string,
    input: Record<string, unknown>,
    read: boolean,
  ): Promise<{ checked: CheckedCommand; ask: CommandAsk | null; readTitles: string[] }>;
  /** The User allowed a call `check` asked about: one past the Answer's limit starts its count again. */
  allowed(toolCallId: string): void;
  /** The User didn't allow a call `check` kept: it never runs. */
  drop(toolCallId: string): void;
} {
  const checked = new Map<string, CheckedCommand>();
  const asks = new Map<string, CommandAsk>();
  /** How many things the Answer changed without asking, since the User last allowed more. */
  let changed = 0;
  /** Each call's share of `changed`, until it ran: one that fails changed nothing. */
  const counted = new Map<string, number>();
  const renames = [...options.renames];
  const readTitles = new Set(options.titledPages);
  /** What the model read of the window's commands that ran: marked `done`, one ends the turn. */
  const oneLine = new Set<string>();
  /** The window's commands still going on when their calls returned, by call. */
  const goingOn = new Map<string, CommandDone>();
  /** An end that came before its call had returned, by call. */
  const endedEarly = new Map<string, WindowCommandEnd>();
  const windowEnded = (toolCallId: string, end: WindowCommandEnd) => {
    const done = goingOn.get(toolCallId);
    if (!done) {
      endedEarly.set(toolCallId, end);
      return;
    }
    goingOn.delete(toolCallId);
    options.ended(
      toolCallId,
      end.ran
        ? { done: { ...done, window: { changed: end.changed } } }
        : { problem: problemOf(done.command, new TranslatableError(end.wording ?? end.why)) },
    );
  };
  // A model calls several at once: two that would each make the same Tag or Folder must not race.
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const next = turn.then(run, run);
    turn = next.catch(() => undefined);
    return next;
  };
  const windowCommands = options.offered.filter(
    (entry) => entry.on === null && entry.yours === null && !isCoreCommand(entry.id),
  );
  const yoursCommands = options.offered.filter((entry) => entry.yours !== null);

  const listTool: Tool = {
    name: COMMAND_TOOLS.list,
    description: `Finds the User's Documents, Notes, Folders or Tags, or what is in Recently deleted (kind "deleted"), for a command, and the commands that apply to them. It matches exactly: a name that holds the words given, a Tag, a Folder (all that are given), never by meaning. Act only on what it found, by id, with ${COMMAND_TOOLS.run}. With kind "window", it lists the commands that act on the window in front instead: opening things, beside the Note too, Settings at a page, recording, checking the Note in front, exporting and the rest of what ⌘K offers.`,
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...COMMAND_TARGETS, "window"] },
        name: { type: "string", description: "Words the name holds." },
        tag: { type: "string", description: "A Tag's name." },
        folder: { type: "string", description: "A Folder's name." },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    provider: PROVIDER,
    providerTool: COMMAND_TOOLS.list,
    effects: () => [{ action: "read", scope: { kind: "library" } }],
    untrustedResult: false,
    async call(input, { toolCallId }) {
      if (!isTarget(input.kind)) {
        options.found(toolCallId, { kind: "window", count: windowCommands.length, by: {} });
        return [
          windowCommands.length === 0
            ? "The window offers no command now."
            : `Commands for the window in front: ${windowCommands.map(windowLine).join("; ")}.`,
          ...(yoursCommands.length > 0
            ? [
                `The User's alone, which only tell them where they change it: ${yoursCommands.map((entry) => `${entry.id} (“${entry.label}”)`).join("; ")}.`,
              ]
            : []),
        ].join("\n");
      }
      const query: FindInput = {
        kind: input.kind,
        name: given(input.name),
        tag: given(input.tag),
        folder: given(input.folder),
      };
      const found = find(query, await options.findable(options.focusedMindId, options.wallId));
      options.found(toolCallId, foundOf(query, found.length));
      const [one, many] = nouns[query.kind];
      if (found.length === 0) {
        return `No ${one} matches, so no command can act on one. Say so, and change nothing.`;
      }
      const shown = found.slice(0, MAX_LISTED);
      for (const each of shown) if (each.webPage) readTitles.add(each.id);
      return [
        `Found ${found.length === 1 ? `1 ${one}` : `${found.length} ${many}`}:`,
        ...shown.map((each) => foundLine(each, options.focusedMindId)),
        ...(found.length > shown.length
          ? [`…and ${found.length - shown.length} more: narrow it by name, Tag or Folder.`]
          : []),
        `Commands for ${many}: ${commandsFor(query.kind, options.offered)}.`,
      ].join("\n");
    },
  };

  const runTool: Tool = {
    name: COMMAND_TOOLS.run,
    description: [
      `Runs one of the app's commands for the User, as ⌘K would, on what ${COMMAND_TOOLS.list} found, by id. For Documents: ${coreCommandsOn("document").map(coreLine).join("; ")}. For Notes: ${coreCommandsOn("mind").map(coreLine).join("; ")}. For Folders: ${coreCommandsOn("folder").map(coreLine).join("; ")}. For Tags: ${coreCommandsOn("tag").map(coreLine).join("; ")}. For what is in Recently deleted: ${coreCommandsOn("deleted").map(coreLine).join("; ")}. For the Library: ${coreCommandsOn("library").map(coreLine).join("; ")}. Settings: ${coreLine("settings.change")}.`,
      `${COMMAND_TOOLS.list} gives the other commands that apply to what it found, and with kind "window" those that act on the window in front; run any of them by its id the same way.`,
      `A change inside IncarnaMind runs at once and the User can undo it. These wait for the User to allow them: a file saved anywhere but the Output location itself, files added from a folder, a new Output location, every delete, a command that can't be undone, starting a recording or turning the microphone on, and a change that would take this answer past ${COMMAND_AT_ONCE} things changed.`,
      YOURS_RULE,
      "Set done on the call that does the last thing the request asks for; leave it out while more is to do. After a window's command with done, no reply is needed: what it shows is the reply. Otherwise say only what each call returned.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: `A command's id, as given here or by ${COMMAND_TOOLS.list}.`,
        },
        ids: { type: "array", items: { type: "string" } },
        name: { type: "string" },
        folder: { type: "string" },
        tag: { type: "string" },
        about: { type: "string" },
        format: { type: "string", enum: [...COMMAND_EXPORT_FORMATS] },
        marks: {
          type: "string",
          enum: ["mark", "leave"],
          description:
            'For a Word export: set only when the User\'s request says whether to mark the text IncarnaMind wrote ("without the AI marks"). Never choose for them.',
        },
        kinds: { type: "array", items: { type: "string" } },
        style: { type: "string" },
        font: { type: "string" },
        size: { type: "string" },
        setting: { type: "string", enum: SETTING_NAMES },
        value: { type: "string" },
        done: {
          type: "boolean",
          description:
            "true on the call that does the last thing the User's request asks for; left out while more is to do.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    provider: PROVIDER,
    providerTool: COMMAND_TOOLS.run,
    effects: commandEffects,
    untrustedResult: false,
    // Only a window's command the model marked as the request's last ends the turn: a refusal
    // never does, so a request that asked for more goes on to it.
    endsTurn: (result, input) => input.done === true && oneLine.has(result),
    async call(_input, { toolCallId, signal }) {
      const command = checked.get(toolCallId);
      checked.delete(toolCallId);
      if (!command) throw new Error("The command wasn't checked before it ran.");
      const ask = options.ask;
      let ran: Awaited<ReturnType<CheckedCommand["run"]>>;
      try {
        ran = await inTurn(() =>
          command.run(
            ask ? (question) => ask(toolCallId, question(options.language), signal) : null,
            signal,
          ),
        );
      } catch (error) {
        changed -= counted.get(toolCallId) ?? 0;
        options.failed(toolCallId, problemOf(command.command, error));
        throw error;
      } finally {
        counted.delete(toolCallId);
      }
      renames.push(...renamesOf(ran.done.items));
      if (ran.step) options.steps.add(options.runId, ran.step);
      const done = { ...ran.done, command: command.command, run: options.runId };
      options.ran(toolCallId, done);
      if (ran.done.window) oneLine.add(ran.said);
      if (ran.done.window?.running) {
        goingOn.set(toolCallId, done);
        const early = endedEarly.get(toolCallId);
        endedEarly.delete(toolCallId);
        if (early) windowEnded(toolCallId, early);
      }
      return ran.said;
    },
  };

  return {
    tools: [listTool, runTool],
    async check(toolCallId, input, read) {
      try {
        const command = await checkCommand(parseCommandInput(input), options.host, {
          offered: options.offered,
          findable: () => options.findable(options.focusedMindId, options.wallId),
          wallId: options.wallId ?? null,
          filing: options.filing,
          answerId: options.answerId,
          runId: options.runId,
          toolCallId,
          mindId: options.focusedMindId,
          clientId: options.clientId,
          ended: (end) => windowEnded(toolCallId, end),
        });
        const ask = askOf(command, { changed, renames, read: read || readTitles.size > 0 });
        checked.set(toolCallId, command);
        if (ask) asks.set(toolCallId, ask);
        else if (command.changes) {
          changed += command.items.length;
          counted.set(toolCallId, command.items.length);
        }
        return { checked: command, ask, readTitles: [...readTitles] };
      } catch (error) {
        options.failed(toolCallId, problemOf(String(input.command ?? ""), error));
        throw error;
      }
    },
    allowed: (toolCallId) => {
      const ask = asks.get(toolCallId);
      asks.delete(toolCallId);
      if (ask?.kind === "change" && ask.reason === "many") changed = 0;
    },
    drop: (toolCallId) => {
      checked.delete(toolCallId);
      asks.delete(toolCallId);
    },
  };
}
