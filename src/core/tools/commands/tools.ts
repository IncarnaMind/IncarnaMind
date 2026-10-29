/**
 * The commands' Tools (#1110, ADR-0013): the assistant does what the User could do with the
 * app's commands. `list_commands` finds the Documents or Minds a command would act on, matched
 * exactly, and says which commands apply; `run_command` runs one. Only the commands marked for
 * the assistant (`ASSISTANT_COMMANDS`) can run. What a call does decides whether it asks the User
 * first (./policy): a few changes inside IncarnaMind run at once and the Run's changes are one
 * step of Undo; the rest wait for the User at the Answer's gate (`check`).
 */
import {
  ASSISTANT_COMMANDS,
  type AssistantCommandId,
  isAppCommand,
} from "../../../shared/commands";
import {
  COMMAND_AT_ONCE,
  type CommandAsk,
  type CommandDone,
  type CommandProblem,
  type CommandsFound,
  type CommandTarget,
  type UserAnswer,
  type UserQuestion,
} from "../../api";
import { TranslatableError } from "../../errors";
import { COMMAND_TOOLS, type Tool, type ToolProviderInfo } from "../index";
import { type Findable, type FindInput, find, foundLine, foundOf } from "./find";
import { askOf, type CommandRename, renamesOf } from "./policy";
import {
  type CheckedCommand,
  COMMAND_EXPORT_FORMATS,
  type CommandFiling,
  type CommandsHost,
  checkCommand,
  commandEffects,
  parseCommandInput,
} from "./run";
import type { CommandSteps } from "./steps";

const PROVIDER: ToolProviderInfo = { kind: "commands", id: "commands", name: "Commands" };

/** How many found things the model reads; past that it is asked to narrow the search. */
const MAX_LISTED = 100;

const ARGUMENTS: Readonly<Record<AssistantCommandId, string>> = {
  "document.rename": "ids: one Document; name: its new name",
  "document.moveTo": "ids; folder: a Folder's name, made if there is none",
  "document.tags": "ids; tag: a Tag's name, made if there is none",
  "document.delete": "ids: sent to Recently deleted, where the User can restore them",
  "mind.rename": "ids: one Note; name: its new name",
  "mind.moveTo": "ids; folder: a Folder's name, made if there is none",
  "mind.delete": "ids: sent to Recently deleted, where the User can restore them",
  "mind.export": `ids: one Note; format: ${COMMAND_EXPORT_FORMATS.join(", ")}; folder: an absolute path, or none for the Output location; marks: "mark" or "leave", only when the User's request says whether a Word file marks the text IncarnaMind wrote`,
  "documents.addFromFolder":
    "folder: an absolute path or ~/…; kinds: file extensions such as pdf, or none for every kind",
};

const commandsOn = (kind: CommandTarget | "library") =>
  (Object.keys(ASSISTANT_COMMANDS) as AssistantCommandId[]).filter(
    (command) => ASSISTANT_COMMANDS[command].on === kind,
  );

const commandList = (kind: CommandTarget | "library") =>
  commandsOn(kind)
    .map((command) => `${command} (${ARGUMENTS[command]})`)
    .join("; ");

const nouns: Record<CommandTarget, [string, string]> = {
  document: ["Document", "Documents"],
  mind: ["Note", "Notes"],
};

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
  /** The Run's instructions name a saved web page, whose title someone else wrote. */
  namesWebPage: boolean;
  /** The renames of the Conversation's earlier Answers, oldest first (`renamesIn`). */
  renames: readonly CommandRename[];
  /** The Run the calls are part of: its changes are one step of Undo in `steps`. */
  runId: string;
  steps: CommandSteps;
  /** Asks the User in the tray for a command that needs an answer to go on; none: it can't ask. */
  ask?: (toolCallId: string, question: UserQuestion, signal: AbortSignal) => Promise<UserAnswer>;
  found(toolCallId: string, found: CommandsFound): void;
  ran(toolCallId: string, done: CommandDone): void;
  failed(toolCallId: string, problem: CommandProblem): void;
}

const given = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const problemOf = (command: string, error: unknown): CommandProblem => ({
  command,
  message: error instanceof Error ? error.message : String(error),
  wording: error instanceof TranslatableError ? error.wording : null,
});

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
  ): Promise<{ checked: CheckedCommand; ask: CommandAsk | null; readTitles: boolean }>;
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
  let readTitles = options.namesWebPage;
  // A model calls several at once: two that would each make the same Tag or Folder must not race.
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const next = turn.then(run, run);
    turn = next.catch(() => undefined);
    return next;
  };

  const listTool: Tool = {
    name: COMMAND_TOOLS.list,
    description: `Finds the User's Documents or Notes for a command, and the commands that apply to them. It matches exactly: a name that holds the words given, a Tag, a Folder (all that are given), never by meaning. Act only on what it found, by id, with ${COMMAND_TOOLS.run}.`,
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["document", "mind"] },
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
      const query: FindInput = {
        kind: input.kind === "mind" ? "mind" : "document",
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
      if (shown.some((each) => each.webPage)) readTitles = true;
      return [
        `Found ${found.length === 1 ? `1 ${one}` : `${found.length} ${many}`}:`,
        ...shown.map((each) => foundLine(each, options.focusedMindId)),
        ...(found.length > shown.length
          ? [`…and ${found.length - shown.length} more: narrow it by name, Tag or Folder.`]
          : []),
        `Commands for ${many}: ${commandList(query.kind)}.`,
      ].join("\n");
    },
  };

  const runTool: Tool = {
    name: COMMAND_TOOLS.run,
    description: `Runs one of the app's commands for the User, on ${nouns.document[1]} or ${nouns.mind[1]} ${COMMAND_TOOLS.list} found, by id. For Documents: ${commandList("document")}. For Notes: ${commandList("mind")}. To add files: ${commandList("library")}. A change inside IncarnaMind runs at once and the User can undo it. These wait for the User to allow them: a file saved anywhere but the Output location itself, files added from a folder, every delete, and a change that would take this answer past ${COMMAND_AT_ONCE} things changed. Say only what each call returned.`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", enum: Object.keys(ASSISTANT_COMMANDS) },
        ids: { type: "array", items: { type: "string" } },
        name: { type: "string" },
        folder: { type: "string" },
        tag: { type: "string" },
        format: { type: "string", enum: [...COMMAND_EXPORT_FORMATS] },
        marks: {
          type: "string",
          enum: ["mark", "leave"],
          description:
            'For a Word export: set only when the User\'s request says whether to mark the text IncarnaMind wrote ("without the AI marks"). Never choose for them.',
        },
        kinds: { type: "array", items: { type: "string" } },
      },
      required: ["command"],
      additionalProperties: false,
    },
    provider: PROVIDER,
    providerTool: COMMAND_TOOLS.run,
    effects: commandEffects,
    untrustedResult: false,
    async call(_input, { toolCallId, signal }) {
      const command = checked.get(toolCallId);
      checked.delete(toolCallId);
      if (!command) throw new Error("The command wasn't checked before it ran.");
      const ask = options.ask;
      let ran: Awaited<ReturnType<CheckedCommand["run"]>>;
      try {
        ran = await inTurn(() =>
          command.run(ask ? (question) => ask(toolCallId, question, signal) : null),
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
      options.ran(toolCallId, { ...ran.done, command: command.command, run: options.runId });
      return ran.said;
    },
  };

  return {
    tools: [listTool, runTool],
    async check(toolCallId, input) {
      try {
        const command = await checkCommand(
          parseCommandInput(input),
          options.host,
          options.filing,
          options.focusedMindId,
          options.wallId,
        );
        const ask = askOf(command, { changed, renames });
        checked.set(toolCallId, command);
        if (ask) asks.set(toolCallId, ask);
        else if (isAppCommand(command.command)) {
          changed += command.items.length;
          counted.set(toolCallId, command.items.length);
        }
        return { checked: command, ask, readTitles };
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
