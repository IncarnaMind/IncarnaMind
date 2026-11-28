/**
 * What the User's own Codex does and asks in a Note's conversation (#3653), read from its
 * app-server: each item it starts as a step, and each approval it asks for as a question, with the
 * answers its own request offers, each passed back as Codex gave it.
 */
import { resolve } from "node:path";
import type { OwnAiAsk } from "../core/adapters";
import type { NoteAction, NoteAnswer, NoteRule, NoteSuggested } from "../core/api";
import { object } from "./agentCommand";
import { type agentSteering, type Places, placeOf } from "./ownPlaces";

const text = (value: unknown) => (typeof value === "string" ? value : "");

const lines = (value: string) => (value === "" ? 0 : value.replace(/\n$/, "").split("\n").length);

type Steering = ReturnType<typeof agentSteering>;

// Codex runs each command as `<shell> -lc '<command>'`, or in double quotes when it holds a single
// one: the card shows the command it runs. In double quotes, only one with nothing the shell would
// expand (`$`, a backtick) and no backslash but those that escape is unwrapped.
const WRAPPED = /^\S*\/(?:ba|z)?sh -l?c '([^']*)'$/;
const WRAPPED_DOUBLE = /^\S*\/(?:ba|z)?sh -l?c "((?:[^"\\$`]|\\["\\$`])*)"$/;

/** A command as Codex runs it, with its own shell's wrapping taken off where nothing hides in it. */
export function commandOf(command: string): string {
  const single = WRAPPED.exec(command)?.[1];
  if (single !== undefined) return single;
  const double = WRAPPED_DOUBLE.exec(command)?.[1];
  return double === undefined ? command : double.replace(/\\(["\\$`])/g, "$1");
}

/** One word of a command as a shell reads it, quoted where it must be. */
const shellWord = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/** A unified diff's lines taken out ("- ") and put in ("+ "), its hunks apart, and how many. */
function changeOf(diff: string): { change: string; count: number } {
  const hunks: string[][] = [];
  let count = 0;
  let minus = 0;
  let plus = 0;
  const settle = () => {
    count += Math.max(minus, plus);
    minus = 0;
    plus = 0;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      settle();
      hunks.push([]);
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    const sign = line.charAt(0);
    if (sign !== "-" && sign !== "+") continue;
    if (hunks.length === 0) hunks.push([]);
    hunks.at(-1)?.push(`${sign} ${line.slice(1)}`);
    if (sign === "-") minus++;
    else plus++;
  }
  settle();
  return {
    change: hunks
      .filter((hunk) => hunk.length > 0)
      .map((hunk) => hunk.join("\n"))
      .join("\n…\n"),
    count,
  };
}

/** One file of a change Codex makes: written anew, deleted, changed or moved. */
function fileActionOf(
  change: Record<string, unknown>,
  places: Places,
  steering: Steering,
): NoteAction | null {
  const path = text(change.path);
  if (path === "") return null;
  const kind = object(change.kind);
  const diff = text(change.diff);
  const cwd = places.folders[0] ?? "";
  const moved = text(kind.move_path);
  const marked = { ...steering.mark(path, cwd), ...(moved !== "" && steering.mark(moved, cwd)) };
  const where = placeOf(path, places);
  if (kind.type === "add") {
    return {
      kind: "write",
      ...where,
      size: { kind: "new", count: lines(diff) },
      content: diff,
      ...marked,
    };
  }
  if (kind.type === "delete") {
    const gone = diff
      .split("\n")
      .filter((line, at, all) => line !== "" || at < all.length - 1)
      .map((line) => `- ${line}`)
      .join("\n");
    return {
      kind: "change",
      ...where,
      size: { kind: "changes", count: lines(diff) },
      change: gone,
      ...marked,
    };
  }
  const { change: changed, count } = changeOf(diff);
  return {
    kind: "change",
    ...where,
    ...(moved !== "" && { value: `${where.value} → ${placeOf(moved, places).value}` }),
    size: { kind: "changes", count },
    change: changed,
    ...marked,
  };
}

/**
 * A change of several files as one step: each file's path, and what it does to each, the files
 * apart. One file is that file's own.
 */
function fileChangeOf(item: Record<string, unknown>, places: Places, steering: Steering) {
  const changes = Array.isArray(item.changes) ? item.changes.map(object) : [];
  const actions = changes.flatMap((each) => {
    const action = fileActionOf(each, places, steering);
    return action ? [action] : [];
  });
  const [first] = actions;
  if (!first || actions.length !== changes.length) return null;
  if (actions.length === 1) return { action: first, paths: [first.value] };
  const body = (action: NoteAction) =>
    action.change ?? (action.content ?? "").replace(/\n$/, "").replace(/^/gm, "+ ");
  const action: NoteAction = {
    kind: actions.every((each) => each.kind === "write") ? "write" : "change",
    value: actions.map((each) => each.value).join("\n"),
    inFolder: actions.every((each) => each.inFolder === true),
    size: {
      kind: "changes",
      count: actions.reduce((sum, each) => sum + (each.size?.count ?? 0), 0),
    },
    change: actions.map((each) => `${each.value}\n${body(each)}`).join("\n…\n"),
    ...(actions.some((each) => each.steers) && { steers: true }),
    ...(actions.some((each) => each.unsure) && { unsure: true }),
  };
  return { action, paths: actions.map((each) => each.value) };
}

/**
 * A field's label, as Codex's own prompt shows it: only the label is taken from what it displays,
 * since the value the tool is sent is what the card must show.
 */
function labelOf(display: unknown, name: string): string {
  const shown = Array.isArray(display)
    ? display.map(object).find((each) => text(each.name) === name)
    : undefined;
  return (shown && text(shown.display_name)) || name;
}

/** What a tool's input says, one row per field, exactly as it is sent. */
function inputOf(given: unknown): { name: string; value: string }[] {
  const fields = object(given);
  return Object.entries(fields).map(([name, value]) => ({
    name,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

/**
 * What an item Codex starts does, as a step; null for one that does nothing with a tool of its
 * own (its words, its reasoning) or that can't be read. IncarnaMind's own Tools are not its steps.
 */
export function itemActionOf(
  item: Record<string, unknown>,
  places: Places,
  steering: Steering,
  server: string,
): NoteAction | null {
  if (item.type === "commandExecution") {
    const command = commandOf(text(item.command));
    return command === ""
      ? null
      : { kind: "command", value: command, ...(steering.names(command) && { steers: true }) };
  }
  if (item.type === "fileChange") return fileChangeOf(item, places, steering)?.action ?? null;
  if (item.type === "mcpToolCall") {
    const tool = text(item.tool);
    const named = text(item.server);
    if (tool === "" || named === server) return null;
    const input = inputOf(item.arguments);
    return {
      kind: "tool",
      value: tool,
      server: named,
      ...(input.length > 0 && { input }),
    };
  }
  if (item.type === "webSearch") {
    const action = object(item.action);
    const url = text(action.url);
    if (action.type === "openPage" && url !== "") {
      let host = "";
      try {
        host = new URL(url).host;
      } catch {
        return null;
      }
      return { kind: "web", value: url, host };
    }
    const query = text(item.query);
    return query === "" ? null : { kind: "search", value: query };
  }
  if (item.type === "imageView") {
    const path = text(item.path);
    return path === "" ? null : { kind: "read", ...placeOf(path, places) };
  }
  return null;
}

/**
 * No to a command, as its request lets Codex take one: "decline", or "cancel" where it doesn't offer
 * that; with no list of what it offers, "decline", as it takes from every request.
 */
const noOf = (params: Record<string, unknown>) =>
  Array.isArray(params.availableDecisions) &&
  !params.availableDecisions.includes("decline") &&
  params.availableDecisions.includes("cancel")
    ? "cancel"
    : "decline";

/**
 * Codex's answer to a request IncarnaMind can't show, by its method and what it offers: no, as
 * Codex reads one.
 */
export function refusalOf(
  method: string,
  params: Record<string, unknown>,
): Record<string, unknown> | null {
  if (method === "item/commandExecution/requestApproval") return { decision: noOf(params) };
  if (method === "item/fileChange/requestApproval") return { decision: "decline" };
  if (method === "mcpServer/elicitation/request") {
    return { action: "decline", content: null, _meta: null };
  }
  if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
  if (method === "item/tool/requestUserInput") return { answers: {} };
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: "denied" };
  }
  return null;
}

/** A question Codex asks, as the card shows it, and Codex's own answer for each of the User's. */
export interface CodexQuestion extends OwnAiAsk {
  answer(answer: NoteAnswer): Record<string, unknown>;
}

/** The lasting answer a command's request offers: commands that start the way it does, kept in Codex's rules. */
function lastingOf(decisions: readonly unknown[]) {
  for (const each of decisions) {
    const amendment = object(object(each).acceptWithExecpolicyAmendment).execpolicy_amendment;
    if (Array.isArray(amendment) && amendment.length > 0 && amendment.every((part) => text(part))) {
      return { decision: each, start: amendment.map(shellWord).join(" ") };
    }
  }
  return null;
}

/**
 * Whether a command's request asks for more than running it, as files or the network beyond what
 * its sandbox allows: the card can't show that, so it is refused (ADR-0034's addendum).
 */
function grantsMore(given: unknown): boolean {
  const { network, fileSystem, ...rest } = object(given);
  const files = Object.entries(object(fileSystem)).filter(([key]) => key !== "globScanMaxDepth");
  return (
    object(network).enabled === true ||
    files.some(([, each]) => (Array.isArray(each) ? each.length > 0 : each != null)) ||
    Object.values(rest).some((each) => each != null)
  );
}

/** What a question of Codex's is read with: where it works, what steers it, and its file changes. */
export interface Asking {
  places: Places;
  steering: Steering;
  /** The file change an item of Codex's is, by its id, which a question names. */
  files(itemId: string): Record<string, unknown> | undefined;
  /** Codex runs commands in a sandbox of its own: one it asks about runs outside it once allowed. */
  sandboxed: boolean;
}

/** A command's question: the command, where it runs and the site it reaches, as Codex asked. */
function commandQuestion(
  params: Record<string, unknown>,
  step: string | null,
  { places, steering, sandboxed }: Asking,
): CodexQuestion | null {
  if (params.kind === "writeStdin" || grantsMore(params.additionalPermissions)) return null;
  const decisions = Array.isArray(params.availableDecisions)
    ? params.availableDecisions
    : ["accept", "decline"];
  if (!decisions.includes("accept")) return null;
  const command = commandOf(text(params.command));
  const network = object(params.networkApprovalContext);
  const host = text(network.host);
  const reason = text(params.reason).trim();
  if (command === "" && host === "") return null;
  const cwd = text(params.cwd);
  const elsewhere =
    cwd !== "" && !places.folders.some((folder) => resolve(folder) === resolve(cwd));
  const action: NoteAction =
    command === ""
      ? {
          kind: "web",
          value: `${text(network.protocol) || "https"}://${host}`,
          host,
          ...(reason !== "" && { reason }),
        }
      : {
          kind: "command",
          value: command,
          ...(host !== "" && { host }),
          ...(elsewhere && { folder: placeOf(cwd, places).value }),
          ...(steering.names(command) && { steers: true }),
          // A request for the network alone runs the command in the sandbox still.
          ...(sandboxed && host === "" && { unsandboxed: true }),
          ...(reason !== "" && { reason }),
        };
  const lasting = lastingOf(decisions);
  const forSession = decisions.includes("acceptForSession");
  const no = noOf({ availableDecisions: decisions });
  // What Codex allows for the session is the site where it asks for one, else the command.
  const rule: NoteRule = host !== "" ? { kind: "site", host } : { kind: "command", value: command };
  return {
    step,
    action,
    suggested: lasting
      ? [{ kind: "rules", kept: "everywhere", rules: [{ kind: "commands", start: lasting.start }] }]
      : [],
    forRequest: forSession ? [{ kind: "rules", kept: "request", rules: [rule] }] : [],
    answer: (answer) => ({
      decision:
        answer === "once"
          ? "accept"
          : answer === "request" && forSession
            ? "acceptForSession"
            : answer === "suggested" && lasting
              ? lasting.decision
              : no,
    }),
  };
}

/**
 * The question a request of Codex's asks, by its method: a command, a change to files (by the
 * step `asking.files` holds for its item), or a tool of a server the User set up in it; null for a
 * request the card can't show.
 */
export function questionOf(
  method: string,
  params: Record<string, unknown>,
  asking: Asking,
): CodexQuestion | null {
  const step = text(params.itemId) || null;
  const { places, steering } = asking;
  if (method === "item/commandExecution/requestApproval") {
    return commandQuestion(params, step, asking);
  }
  if (method === "item/fileChange/requestApproval") {
    const item = step === null ? undefined : asking.files(step);
    const found = item ? fileChangeOf(item, places, steering) : null;
    if (!found) return null;
    const root = text(params.grantRoot);
    const reason = text(params.reason).trim();
    const forRequest: NoteSuggested[] =
      root !== ""
        ? [{ kind: "folders", kept: "request", folders: [placeOf(root, places).value] }]
        : [
            {
              kind: "rules",
              kept: "request",
              rules: found.paths.map((path) => ({ kind: "file", path })),
            },
          ];
    return {
      step,
      action: { ...found.action, ...(reason !== "" && { reason }) },
      suggested: [],
      forRequest,
      answer: (answer) => ({
        decision:
          answer === "once" ? "accept" : answer === "request" ? "acceptForSession" : "decline",
      }),
    };
  }
  if (method === "mcpServer/elicitation/request") {
    const meta = object(params._meta);
    if (params.mode !== "form" || meta.codex_approval_kind !== "mcp_tool_call") return null;
    const tool = text(meta.tool_name);
    const server = text(params.serverName);
    if (tool === "" || server === "") return null;
    const persist = Array.isArray(meta.persist) ? meta.persist : [];
    const rules: NoteRule[] = [{ kind: "tool", tool, server }];
    const shown = inputOf(meta.tool_params).map((field) => ({
      ...field,
      name: labelOf(meta.tool_params_display, field.name),
    }));
    return {
      step,
      action: {
        kind: "tool",
        value: tool,
        server,
        ...(shown.length > 0 && { input: shown }),
      },
      suggested: persist.includes("always") ? [{ kind: "rules", kept: "everywhere", rules }] : [],
      forRequest: persist.includes("session") ? [{ kind: "rules", kept: "request", rules }] : [],
      answer: (answer) =>
        answer === "deny"
          ? { action: "decline", content: null, _meta: null }
          : {
              action: "accept",
              content: {},
              _meta:
                answer === "suggested" && persist.includes("always")
                  ? { persist: "always" }
                  : answer === "request" && persist.includes("session")
                    ? { persist: "session" }
                    : null,
            },
    };
  }
  return null;
}
