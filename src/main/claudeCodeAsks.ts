/**
 * What Claude Code asks its host before it uses a tool of its own, and does without asking, read
 * as IncarnaMind shows it in a Note's conversation (#3653), and the answers sent back. Claude Code
 * 2.1.331 sends a question as a `can_use_tool` control request: the tool's name and input, the id
 * of its call, and the answers it suggests, each a change to its permissions with where it would
 * keep it. One the User picks goes back exactly as Claude Code gave it.
 */
import { existsSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { NoteAction, NoteAnswer, NoteKept, NoteRule, NoteSuggested } from "../core/api";
import { object } from "./agentCommand";

const lines = (text: string) => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length);

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Where a file is: from the conversation's folder when it is in it, else from home as "~". */
export interface Places {
  /** The conversation's folder, and the same folder as the system names it once links are followed. */
  folders: readonly string[];
  home: string;
}

// On Windows the system's own resolver also gives a short 8.3 name (CLAUDE~1) its long one.
const realpath = process.platform === "win32" ? realpathSync.native : realpathSync;

/** Where `path` really is, links followed: its nearest folder that is there, resolved, and the rest. */
function realOf(path: string): string | null {
  for (let at = path, rest = ""; ; ) {
    try {
      return join(realpath(at), rest);
    } catch {
      const up = dirname(at);
      if (up === at) return null;
      rest = join(basename(at), rest);
      at = up;
    }
  }
}

/**
 * Where `path` leads: links followed, the last one too when what it names isn't there yet, since a
 * write through it makes that file.
 */
function leadsTo(path: string): string | null {
  let at = path;
  for (let hops = 0; hops < 40; hops += 1) {
    let target: string;
    try {
      target = readlinkSync(at);
    } catch {
      return realOf(at);
    }
    at = resolve(dirname(at), target);
  }
  return null;
}

/** `path` from `folder`, when it is inside it; null when it isn't. */
function within(folder: string, path: string): string | null {
  const from = relative(folder, path);
  return from !== "" && !from.startsWith("..") && !isAbsolute(from) ? from : null;
}

function placeOf(path: string, { folders, home }: Places): { value: string; inFolder: boolean } {
  // Claude Code names files by their whole path; one it didn't is from where it works.
  const whole = resolve(folders[0] ?? "", path);
  const outside = (where: string) => {
    const fromHome = home === "" ? null : within(home, where);
    return { value: fromHome === null ? where : `~${sep}${fromHome}`, inFolder: false };
  };
  for (const folder of folders) {
    const from = within(folder, whole);
    if (from === null) continue;
    // A link inside the folder can lead out of it: there it is named where it really goes.
    const real = leadsTo(whole) ?? whole;
    const really = folders.some((each) => within(realOf(each) ?? each, real) !== null);
    return really ? { value: from, inFolder: true } : outside(real);
  }
  return outside(whole);
}

const changeOf = (pairs: readonly { from: string; to: string }[]) =>
  pairs
    .map(({ from, to }) =>
      [
        ...from.split("\n").map((line) => `- ${line}`),
        ...to.split("\n").map((line) => `+ ${line}`),
      ].join("\n"),
    )
    .join("\n…\n");

/** The server and tool a `mcp__<server>__<tool>` name stands for. */
function toolOf(name: string, server: unknown): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const named = text(object(server).name);
  if (named !== "" && name.startsWith(`mcp__${named}__`)) {
    return { server: named, tool: name.slice(`mcp__${named}__`.length) };
  }
  const rest = name.slice("mcp__".length);
  const at = rest.indexOf("__");
  return at > 0 ? { server: rest.slice(0, at), tool: rest.slice(at + 2) } : null;
}

/**
 * What a call of one of Claude Code's own tools does, from its name and input; one of another
 * tool, by its name only ("other"), and null for a call it can't read.
 */
export function actionOf(
  name: string,
  given: unknown,
  places: Places,
  server?: unknown,
): NoteAction | null {
  const input = object(given);
  if (name === "Bash") {
    const command = text(input.command);
    if (command === "") return null;
    // Where a command runs can't be told from it: it may change folder first.
    return {
      kind: "command",
      value: command,
      ...(namesSteering(command) && { steers: true }),
      ...(input.run_in_background === true && { background: true }),
      ...(input.dangerouslyDisableSandbox === true && { unsandboxed: true }),
      ...(text(input.description).trim() !== "" && { description: text(input.description).trim() }),
    };
  }
  if (name === "Write") {
    const path = text(input.file_path);
    if (path === "") return null;
    const there = existsSync(resolve(places.folders[0] ?? "", path));
    const content = text(input.content);
    return {
      kind: there ? "change" : "write",
      ...placeOf(path, places),
      size: { kind: there ? "whole" : "new", count: lines(content) },
      content,
      ...(steers(path, places.folders[0] ?? "") && { steers: true }),
    };
  }
  if (name === "Edit" || name === "MultiEdit") {
    const path = text(input.file_path);
    if (path === "") return null;
    const edits = (name === "Edit" ? [input] : Array.isArray(input.edits) ? input.edits : []).map(
      (each) => ({ from: text(object(each).old_string), to: text(object(each).new_string) }),
    );
    return {
      kind: "change",
      ...placeOf(path, places),
      ...(steers(path, places.folders[0] ?? "") && { steers: true }),
      size: {
        kind: "changes",
        count: edits.reduce((sum, { from, to }) => sum + Math.max(lines(from), lines(to)), 0),
      },
      change: changeOf(edits),
    };
  }
  if (name === "NotebookEdit") {
    const path = text(input.notebook_path);
    return path === "" ? null : { kind: "change", ...placeOf(path, places) };
  }
  if (name === "Skill") {
    const skill = text(input.skill);
    const args = text(input.args);
    return skill === ""
      ? null
      : {
          kind: "skill",
          value: skill,
          ...(args !== "" && { input: [{ name: "args", value: args }] }),
        };
  }
  if (name === "Read" || name === "NotebookRead") {
    const path = text(input.file_path) || text(input.notebook_path);
    return path === "" ? null : { kind: "read", ...placeOf(path, places) };
  }
  if (name === "Glob" || name === "Grep" || name === "LS") {
    const path = text(input.path);
    const pattern = text(input.pattern);
    const where = path === "" ? { value: "", inFolder: true } : placeOf(path, places);
    const value = [where.value, pattern]
      .filter((part) => part !== "")
      .join(where.value === "" ? "" : " ");
    return value === "" ? null : { kind: "read", value, inFolder: where.inFolder };
  }
  if (name === "WebFetch") {
    const url = text(input.url);
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      return null;
    }
    return host === "" ? null : { kind: "web", value: url, host };
  }
  if (name === "WebSearch") {
    const query = text(input.query);
    return query === "" ? null : { kind: "search", value: query };
  }
  const tool = toolOf(name, server);
  if (tool) {
    return {
      kind: "tool",
      value: tool.tool,
      server: tool.server,
      input: Object.entries(input).map(([key, value]) => ({
        name: key,
        value: typeof value === "string" ? value : JSON.stringify(value),
      })),
    };
  }
  return name === "" ? null : { kind: "other", value: name };
}

/** Whether a call is one of IncarnaMind's own Tools, which never ask. */
export const oursIn = (server: string) => (name: unknown) =>
  typeof name === "string" && (name === `mcp__${server}` || name.startsWith(`mcp__${server}__`));

/**
 * The files Claude Code reads as its own, by name in lower case: macOS's and Windows's disks open a
 * file by its name in any case, so claude.md there is CLAUDE.md.
 */
const STEERING_FILES: ReadonlySet<string> = new Set([
  "claude.md",
  "claude.local.md",
  // A folder's servers, and the User's own in their home folder: each a command started next time.
  ".mcp.json",
  ".claude.json",
]);

/**
 * A part of a path as the disk finds it: letters a disk takes as others folded (the long s, ſ, is
 * an s), and, as Windows opens a file, without the dots and spaces that end it or a stream named
 * after a colon (CLAUDE.md::$DATA is CLAUDE.md).
 */
const asFound = (part: string) =>
  part
    .normalize("NFKC")
    .toLowerCase()
    .replace(/:.*$/, "")
    .replace(/[. ]+$/, "");

const steersAsNamed = (path: string) => {
  const parts = path.split(/[\\/]/).map(asFound);
  return STEERING_FILES.has(parts.at(-1) ?? "") || parts.includes(".claude");
};

/** Whether `path` is a file with other names: a hard link to it can be one Claude Code reads. */
function linkedHard(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.nlink > 1;
  } catch {
    return false;
  }
}

/**
 * A file Claude Code reads as its own: instructions (CLAUDE.md), settings, hooks, commands, agents,
 * skills and its memory (under a .claude folder), and servers (.mcp.json, .claude.json). Written in
 * the conversation's folder, or in its memory, it steers every later request there. Checked as
 * named, where it really is from `cwd` (a symbolic link by another name can lead to one), and, for
 * a file with other names (a hard link), as one, since which of them it is can't be told cheaply.
 */
function steers(path: string, cwd: string): boolean {
  if (steersAsNamed(path)) return true;
  const whole = resolve(cwd, path);
  const real = leadsTo(whole);
  return (real !== null && steersAsNamed(real)) || linkedHard(real ?? whole);
}

const STEERING_NAMES =
  /claude(?:\.local)?\.md|\.mcp\.json|\.claude\.json|(?:^|[^\w.-])\.claude(?:$|[^\w.-])/i;

/**
 * A command that names one of those files or folders, in any case, its letters folded as a disk
 * does, with the quotes and backslashes a shell takes out of a name taken out too: it may write
 * one. A command that writes one without naming it, as a script, a pattern, a name it builds or an
 * archive it unpacks, is not seen.
 */
const namesSteering = (command: string) => {
  const folded = command.normalize("NFKC");
  return STEERING_NAMES.test(folded) || STEERING_NAMES.test(folded.replace(/["'\\]/g, ""));
};

/** The id IncarnaMind's PreToolUse hook is registered under, in `initialize`. */
export const STEERING_HOOK = "incarnamind-steering";

/**
 * The PreToolUse hook a conversation's run registers (#3653): a write or a change to one of Claude
 * Code's own steering files, by a file tool or by a command that names one, asks, since a text it
 * read could tell it to write them and every later request would follow it. Hooks run before the
 * mode and the rules (measured in its default, acceptEdits, auto and bypassPermissions modes, and
 * with the User's disableAllHooks); asking takes nothing away. A hook not answered keeps the call
 * waiting and one answered with an error refuses it, so every call is answered at once.
 */
export const STEERING_HOOKS = {
  PreToolUse: [
    {
      matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash",
      hookCallbackIds: [STEERING_HOOK],
      onFailure: "block",
    },
  ],
};

/** IncarnaMind's answer to its own hook for a tool call `input` of the hook's input. */
export function steeringAnswer(input: Record<string, unknown>): Record<string, unknown> {
  const name = text(input.tool_name);
  const given = object(input.tool_input);
  const path = text(given.file_path) || text(given.notebook_path);
  const steering =
    name === "Bash"
      ? namesSteering(text(given.command))
      : path !== "" && steers(path, text(input.cwd));
  if (!steering) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason:
        "IncarnaMind asks the User before Claude Code changes its own instructions or settings.",
    },
  };
}

/** A rule as Claude Code writes it in its settings: `Tool` or `Tool(content)`. */
const ruleText = (tool: string, content: string) => (content === "" ? tool : `${tool}(${content})`);

/**
 * A rule Claude Code suggests, in plain words where they say exactly what it covers:
 * `Bash(git log:*)` every command that starts with "git log", `Bash(touch a.txt)` that command,
 * `WebFetch(domain:x)` pages on x, `mcp__server__tool` that tool. Any other, as it is.
 */
function ruleOf(rule: Record<string, unknown>, places: Places): NoteRule | null {
  const tool = text(rule.toolName);
  const content = text(rule.ruleContent);
  if (tool === "") return null;
  if (tool === "WebSearch" && content === "") return { kind: "searches" };
  // `//path/**` every file under that folder, `/path/**` the same inside the conversation's folder,
  // as Claude Code writes a folder's rule.
  const under = /^(\/?)(\/[^*]*?)\/\*\*$/.exec(content);
  if (under && (tool === "Read" || tool === "Edit" || tool === "Write")) {
    const [, absolute, path = ""] = under;
    const folder = absolute ? path : resolve(places.folders[0] ?? "", `.${path}`);
    return { kind: "files", change: tool !== "Read", folder: folderOf(folder, places) };
  }
  if (tool === "Bash" && content !== "") {
    // Claude Code writes a command's start as `start:*`, and since 2.1 as `start *`.
    const start = content.endsWith(":*")
      ? content.slice(0, -2)
      : content.endsWith(" *")
        ? content.slice(0, -2)
        : null;
    const words = start ?? content;
    if (!words.includes("*") && words.trim() !== "") {
      return start === null ? { kind: "command", value: content } : { kind: "commands", start };
    }
  }
  if (tool === "WebFetch" && /^domain:[^*\s]+$/.test(content)) {
    return { kind: "site", host: content.slice("domain:".length) };
  }
  const named = content === "" ? toolOf(tool, null) : null;
  if (named) return { kind: "tool", tool: named.tool, server: named.server };
  return { kind: "rule", rule: ruleText(tool, content) };
}

/** A folder as the card names it: `""` for the conversation's own, else as a file's path is. */
const folderOf = (folder: string, places: Places) =>
  places.folders.some((each) => resolve(each) === resolve(folder))
    ? ""
    : placeOf(folder, places).value;

/** Where Claude Code keeps what an answer allows, by the destination it names. */
const KEPT: Record<string, NoteKept> = {
  session: "request",
  cliArg: "request",
  localSettings: "conversation",
  projectSettings: "conversation",
  userSettings: "everywhere",
};

/**
 * An answer Claude Code suggests, as the card says it; null for one kept where the card can't say,
 * which isn't offered.
 */
function suggestedOf(each: Record<string, unknown>, places: Places): NoteSuggested | null {
  const kept = KEPT[text(each.destination)];
  if (!kept) return null;
  const rules = Array.isArray(each.rules) ? each.rules.map(object) : [];
  if (each.type === "addRules" && each.behavior === "allow" && rules.length > 0) {
    const read = rules.map((rule) => ruleOf(rule, places));
    return read.every((rule) => rule !== null) ? { kind: "rules", kept, rules: read } : null;
  }
  if (each.type === "setMode" && text(each.mode) !== "") {
    return { kind: "mode", kept, mode: text(each.mode) };
  }
  const directories = Array.isArray(each.directories) ? each.directories.map(text) : [];
  if (each.type === "addDirectories" && directories.length > 0 && !directories.includes("")) {
    return {
      kind: "folders",
      kept,
      folders: directories.map((folder) => folderOf(folder, places)),
    };
  }
  const named = rules.map((rule) => ruleText(text(rule.toolName), text(rule.ruleContent)));
  const said = [text(each.type), text(each.behavior), named.join(", "), directories.join(", ")]
    .filter((part) => part !== "")
    .join(" ");
  return said === "" ? null : { kind: "other", kept, text: said };
}

/**
 * The answers a question suggests, each as Claude Code gave it and as the card says it. None when
 * Claude Code says a lasting answer mustn't be offered for it, or when one of them can't be read:
 * the card's lasting answer applies all of them, and says each.
 */
function suggestionsOf(request: Record<string, unknown>, places: Places) {
  if (request.suppress_always_allow_rule === true) return [];
  const given = Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [];
  const read: { said: NoteSuggested; sent: unknown }[] = [];
  for (const each of given) {
    const said = suggestedOf(object(each), places);
    if (!said) return [];
    read.push({ said, sent: each });
  }
  return read;
}

/** A question Claude Code asked, read: what it would do, its call's id, and its suggested answers. */
export interface ReadQuestion {
  action: NoteAction;
  step: string | null;
  suggested: NoteSuggested[];
  answer(answer: NoteAnswer): Record<string, unknown>;
}

const DENIED =
  "The User said no to this in IncarnaMind. Don't do it another way; say in your reply what you didn't do.";

/** The answer to a question IncarnaMind can't show the User: denied, and said why. */
export const REFUSED = {
  behavior: "deny",
  message:
    "IncarnaMind can't show this question to the User, so it isn't allowed. Ask the User in your reply instead.",
};

/** The answer to a question of a tool of IncarnaMind's own: its grant decides what it may do. */
export const allowed = (request: Record<string, unknown>) => ({
  behavior: "allow",
  updatedInput: object(request.input),
});

/** A `can_use_tool` request read, or null for one that can't be shown, which is denied. */
export function questionOf(request: Record<string, unknown>, places: Places): ReadQuestion | null {
  const name = text(request.tool_name);
  const action = actionOf(name, request.input, places, request.mcp_server);
  // A question whose card is the AI's own (its plan, its questions to the User) can't be answered
  // with a yes or a no here.
  if (!action || action.kind === "other" || request.requires_user_interaction === true) return null;
  if (!("input" in request)) return null;
  const input = object(request.input);
  const suggestions = suggestionsOf(request, places);
  return {
    action,
    step: text(request.tool_use_id) || null,
    suggested: suggestions.map(({ said }) => said),
    answer(answer) {
      if (answer === "deny") return { behavior: "deny", message: DENIED };
      // Claude Code's own "don't ask again" applies every suggestion together, each as given.
      return {
        behavior: "allow",
        updatedInput: input,
        ...(answer === "suggested" &&
          suggestions.length > 0 && { updatedPermissions: suggestions.map(({ sent }) => sent) }),
      };
    },
  };
}
