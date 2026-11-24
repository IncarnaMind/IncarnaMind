/**
 * What Claude Code asks its host before it uses a tool of its own, and does without asking, read
 * as IncarnaMind shows it in a Note's conversation (#3653), and the answers sent back. Claude Code
 * 2.1.331 sends a question as a `can_use_tool` control request: the tool's name and input, the id
 * of its call, and the rules it suggests for a wider answer, each with where it would keep it.
 * Only its "session" scope is ever sent back, which holds until the process ends and is written
 * nowhere; a rule it would keep in a settings file is never asked for.
 */
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { NoteAction, NoteAnswer, NoteQuestion } from "../core/api";
import { object } from "./agentCommand";

const lines = (text: string) => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length);

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Where a file is: from the conversation's folder when it is in it, else from home as "~". */
export interface Places {
  /** The conversation's folder, and the same folder as the system names it once links are followed. */
  folders: readonly string[];
  home: string;
}

function placeOf(path: string, { folders, home }: Places): { value: string; inFolder: boolean } {
  // Claude Code names files by their whole path; one it didn't is from where it works.
  const whole = resolve(folders[0] ?? "", path);
  for (const folder of folders) {
    const from = relative(folder, whole);
    if (from !== "" && !from.startsWith("..") && !isAbsolute(from)) {
      return { value: from, inFolder: true };
    }
  }
  const fromHome = relative(home, whole);
  if (home !== "" && fromHome !== "" && !fromHome.startsWith("..") && !isAbsolute(fromHome)) {
    return { value: `~${sep}${fromHome}`, inFolder: false };
  }
  return { value: whole, inFolder: false };
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
    return command === "" ? null : { kind: "command", value: command, inFolder: true };
  }
  if (name === "Write") {
    const path = text(input.file_path);
    if (path === "") return null;
    const there = existsSync(resolve(places.folders[0] ?? "", path));
    return {
      kind: there ? "change" : "write",
      ...placeOf(path, places),
      size: { kind: there ? "whole" : "new", count: lines(text(input.content)) },
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

type Suggestion = Record<string, unknown>;

/** The suggestions a "request" answer sends, each kept for the session only. */
function widerOf(request: Record<string, unknown>): {
  wider: NoteQuestion["wider"];
  send: Suggestion[];
} {
  const suggestions = (
    Array.isArray(request.permission_suggestions) ? request.permission_suggestions : []
  ).map(object);
  const rules = suggestions.filter(
    (each) => each.type === "addRules" && each.behavior === "allow" && Array.isArray(each.rules),
  );
  if (rules.length > 0) {
    return {
      wider: {
        rules: rules.flatMap((each) =>
          (each.rules as unknown[]).map(object).flatMap((rule) => {
            const tool = text(rule.toolName);
            const content = text(rule.ruleContent);
            return tool === "" ? [] : [content === "" ? tool : `${tool}(${content})`];
          }),
        ),
      },
      send: rules,
    };
  }
  const edits = suggestions.filter(
    (each) => each.type === "setMode" && each.mode === "acceptEdits",
  );
  if (edits.length > 0) return { wider: { mode: "acceptEdits" }, send: edits };
  return { wider: null, send: [] };
}

/** A question Claude Code asked, read: what it would do, its call's id, and its wider answer. */
export interface ReadQuestion {
  action: NoteAction;
  step: string | null;
  wider: NoteQuestion["wider"];
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
  if (!action || action.kind === "other" || !("input" in request)) return null;
  const input = object(request.input);
  const { wider, send } = widerOf(request);
  return {
    action,
    step: text(request.tool_use_id) || null,
    wider,
    answer(answer) {
      if (answer === "deny") return { behavior: "deny", message: DENIED };
      return {
        behavior: "allow",
        updatedInput: input,
        ...(answer === "request" &&
          send.length > 0 && {
            updatedPermissions: send.map((each) => ({ ...each, destination: "session" })),
          }),
      };
    },
  };
}
