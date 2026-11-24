/**
 * What Claude Code asks its host before it uses a tool of its own, and does without asking, read
 * as IncarnaMind shows it in a Note's conversation (#3653), and the answers sent back. Claude Code
 * 2.1.331 sends a question as a `can_use_tool` control request: the tool's name and input, the id
 * of its call, and the answers it suggests, each a change to its permissions with where it would
 * keep it. One the User picks goes back exactly as Claude Code gave it.
 */
import { existsSync, realpathSync } from "node:fs";
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

/** Where `path` really is, links followed: its nearest folder that is there, resolved, and the rest. */
function realOf(path: string): string | null {
  for (let at = path, rest = ""; ; ) {
    try {
      return join(realpathSync(at), rest);
    } catch {
      const up = dirname(at);
      if (up === at) return null;
      rest = join(basename(at), rest);
      at = up;
    }
  }
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
    const real = realOf(whole) ?? whole;
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
      ...(input.run_in_background === true && { background: true }),
      ...(input.dangerouslyDisableSandbox === true && { unsandboxed: true }),
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
      ...(steers(path) && { steers: true }),
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
      ...(steers(path) && { steers: true }),
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
 * A file Claude Code reads as its own: instructions (CLAUDE.md), settings, hooks, commands, agents
 * and skills (under .claude), and the servers of a folder (.mcp.json). Written in the conversation's
 * folder, it steers every later request there.
 */
function steers(path: string): boolean {
  const name = basename(path);
  return (
    name === "CLAUDE.md" ||
    name === "CLAUDE.local.md" ||
    name === ".mcp.json" ||
    path.split(/[\\/]/).includes(".claude")
  );
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
  // `//path/**`: every file under that folder, as Claude Code writes a folder's rule.
  const under = /^\/(\/[^*]*?)\/\*\*$/.exec(content)?.[1];
  if (under && (tool === "Read" || tool === "Edit" || tool === "Write")) {
    return { kind: "files", change: tool !== "Read", folder: folderOf(under, places) };
  }
  if (tool === "Bash" && content !== "") {
    const start = content.endsWith(":*") ? content.slice(0, -2) : null;
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
 * Claude Code says a lasting answer mustn't be offered for it.
 */
function suggestionsOf(request: Record<string, unknown>, places: Places) {
  if (request.suppress_always_allow_rule === true) return [];
  const given = Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [];
  return given.flatMap((each) => {
    const said = suggestedOf(object(each), places);
    return said ? [{ said, sent: each as unknown }] : [];
  });
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
      const chosen = typeof answer === "number" ? suggestions[answer] : undefined;
      return {
        behavior: "allow",
        updatedInput: input,
        ...(chosen && { updatedPermissions: [chosen.sent] }),
      };
    },
  };
}
