/**
 * In the assistant, with the commands' Tools (#1110): "Rename the Northwind files by date"
 * (按日期重命名 Northwind 的文件) finds them with list_commands, then renames each, its date
 * added before its name, one call each; "Move the leases into Real estate" (把租约移到“房地产”)
 * moves what it found by "lease" in one call, "Tag every invoice Finance" (给发票加上“财务”标签)
 * tags those found by "invoice", "Delete the drafts" sends those found by "draft" to Recently
 * deleted, and "Delete the document with id X" names an id nothing has. "Export this Mind as Word"
 * exports the Mind in focus, to the folder after "to" when there is one, marking the text IncarnaMind
 * wrote ("with the AI marks") or not ("without the AI marks") when it says so, and "Delete this Mind"
 * sends it to Recently deleted; "Add the PDFs in /path"
 * adds a folder's PDFs. Each then replies with the first sentence of what its calls returned.
 */
import { lastResult, type Prompt, type Reply, toolResults } from "./prompt";

interface Found {
  id: string;
  name: string;
  added: string;
  focused: boolean;
}

function foundIn(result: string): Found[] {
  return [...result.matchAll(/^- (\S+): “(.+?)” \((.*)\)$/gm)].map((match) => ({
    id: match[1] ?? "",
    name: match[2] ?? "",
    added: /added (\d{4}-\d{2}-\d{2})/.exec(match[3] ?? "")?.[1] ?? "",
    focused: (match[3] ?? "").includes("the Mind in focus"),
  }));
}

const firstSentence = (result: string) => /^.*?[.。](?=\s|$)/su.exec(result)?.[0] ?? result;

const said = (prompt: Prompt): Reply => {
  const results = toolResults(prompt, "run_command");
  const failed = lastResult(prompt, "run_command");
  return {
    text: results.map(firstSentence).join(" ") || firstSentence(failed ?? "Nothing changed."),
  };
};

function findThen(
  prompt: Prompt,
  query: { kind: "document" | "mind"; name?: string },
  act: (found: Found[]) => Record<string, unknown> | null,
): Reply {
  const listed = lastResult(prompt, "list_commands");
  if (listed === undefined) return { tool: "list_commands", input: query };
  if (lastResult(prompt, "run_command") !== undefined) return said(prompt);
  const found = foundIn(listed);
  const input = found.length > 0 ? act(found) : null;
  return input ? { tool: "run_command", input } : { text: firstSentence(listed) };
}

const RENAME = /\brename the (.+?) files by date\b|按日期重命名 ?(.+?) ?的文件/i;
const MOVE = /\bmove the leases into (.+?)[.?!]*$|把租约移到“(.+?)”/i;
const TAG = /\btag every invoice (.+?)[.?!]*$|给发票加上“(.+?)”标签/i;
const DELETE_DRAFTS = /\bdelete the drafts\b/i;
const DELETE_ID = /\bdelete the document with id (\S+?)[.?!]*$/i;
const DELETE_MIND = /\bdelete this mind\b/i;
const EXPORT = /\bexport this mind as word(?: (with|without) the ai marks)?(?: to (\S+?))?[.?!]*$/i;
const ADD = /\badd the pdfs in (\S+?)[.?!]*$/i;

/** The scripted assistant's choice with the commands' Tools: a call, the reply, or null. */
export function commandsReply(
  prompt: Prompt,
  question: string,
  names: readonly string[],
): Reply | null {
  if (!names.includes("run_command")) return null;
  const rename = RENAME.exec(question);
  if (rename) {
    const name = rename[1] ?? rename[2] ?? "";
    const listed = lastResult(prompt, "list_commands");
    if (listed === undefined) return { tool: "list_commands", input: { kind: "document", name } };
    const next = foundIn(listed)[toolResults(prompt, "run_command").length];
    if (!next) return said(prompt);
    return {
      tool: "run_command",
      input: { command: "document.rename", ids: [next.id], name: `${next.added} ${next.name}` },
    };
  }
  const move = MOVE.exec(question);
  if (move) {
    return findThen(prompt, { kind: "document", name: "lease" }, (found) => ({
      command: "document.moveTo",
      ids: found.map((each) => each.id),
      folder: move[1] ?? move[2],
    }));
  }
  const tag = TAG.exec(question);
  if (tag) {
    return findThen(prompt, { kind: "document", name: "invoice" }, (found) => ({
      command: "document.tags",
      ids: found.map((each) => each.id),
      tag: tag[1] ?? tag[2],
    }));
  }
  if (DELETE_DRAFTS.test(question)) {
    return findThen(prompt, { kind: "document", name: "draft" }, (found) => ({
      command: "document.delete",
      ids: found.map((each) => each.id),
    }));
  }
  const unknown = DELETE_ID.exec(question);
  if (unknown) {
    if (lastResult(prompt, "run_command") !== undefined) return said(prompt);
    return { tool: "run_command", input: { command: "document.delete", ids: [unknown[1]] } };
  }
  if (DELETE_MIND.test(question)) {
    return findThen(prompt, { kind: "mind" }, (found) => {
      const mind = found.find((each) => each.focused);
      return mind ? { command: "mind.delete", ids: [mind.id] } : null;
    });
  }
  const exported = EXPORT.exec(question);
  if (exported) {
    return findThen(prompt, { kind: "mind" }, (found) => {
      const mind = found.find((each) => each.focused);
      return mind
        ? {
            command: "mind.export",
            ids: [mind.id],
            format: "docx",
            ...(exported[1] && { marks: exported[1].toLowerCase() === "with" ? "mark" : "leave" }),
            ...(exported[2] && { folder: exported[2] }),
          }
        : null;
    });
  }
  const add = ADD.exec(question);
  if (add) {
    if (lastResult(prompt, "run_command") !== undefined) return said(prompt);
    return {
      tool: "run_command",
      input: { command: "documents.addFromFolder", folder: add[1], kinds: ["pdf"] },
    };
  }
  return null;
}
