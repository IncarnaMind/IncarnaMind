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
 * adds a folder's PDFs. From the window's list (#1421): "Make a Folder called Leases and move the
 * leases into it" (新建一个叫“租约”的文件夹，把租约移进去) moves what it found into the Folder it
 * names, made for it; "Open the X beside this one" (在旁边打开“X”) opens the Document it found to
 * the side; "Check this Note" (核对这篇笔记) checks the Note in front; "Bring back the X I deleted"
 * (把删掉的“X”恢复) restores what it found in Recently deleted; "Put the documents about
 * rent together" (把关于租金的文档放在一起) has Organize sort every Document in no Folder toward
 * "Rent"; "Start recording a meeting" (开始录制会议) starts one; and "Turn on Local mode"
 * (打开本地模式) asks for what is the User's alone. Each then
 * replies with the first sentence of what its calls returned, or nothing after one whose card is
 * the reply: a window's command it marked done, or what is the User's alone.
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
    focused: (match[3] ?? "").includes("the Note in focus"),
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
  query: { kind: "document" | "mind" | "deleted"; name?: string },
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
const FOLDER_AND_MOVE =
  /\bmake a folder called (.+?) and move the (.+?)s? into it\b|新建一个叫“(.+?)”的文件夹，把(.+?)移进去/i;
const BESIDE = /\bopen the (.+?) beside this one\b|在旁边打开“(.+?)”/i;
const CHECK = /\bcheck this (?:mind|note)\b|核对这篇笔记/i;
const ORGANIZE_ABOUT = /\bput the documents about (.+?) together\b|把关于(.+?)的文档放在一起/i;
const LOCAL_MODE = /\bturn on local mode\b|打开本地模式/i;
const RESTORE = /\bbring back the (.+?) i deleted\b|把删掉的“(.+?)”恢复/i;
const RECORD = /\bstart recording a meeting\b|开始录制会议/i;

function runOnce(prompt: Prompt, input: Record<string, unknown>): Reply {
  if (lastResult(prompt, "run_command") !== undefined) return said(prompt);
  return { tool: "run_command", input };
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The scripted assistant's choice with the commands' Tools: a call, the reply, or null. */
export function commandsReply(
  prompt: Prompt,
  question: string,
  names: readonly string[],
): Reply | null {
  if (!names.includes("run_command")) return null;
  const made = FOLDER_AND_MOVE.exec(question);
  if (made) {
    const folder = made[1] ?? made[3] ?? "";
    const name = made[2] ?? made[4] ?? "";
    return findThen(prompt, { kind: "document", name }, (found) => ({
      command: "document.moveTo",
      ids: found.map((each) => each.id),
      folder,
    }));
  }
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
  const beside = BESIDE.exec(question);
  if (beside) {
    return findThen(prompt, { kind: "document", name: beside[1] ?? beside[2] ?? "" }, (found) =>
      found[0] ? { command: "document.openBeside", ids: [found[0].id], done: true } : null,
    );
  }
  if (CHECK.test(question)) return runOnce(prompt, { command: "mind.check", done: true });
  const about = ORGANIZE_ABOUT.exec(question);
  if (about) {
    const topic = (about[1] ?? about[2] ?? "").trim();
    return runOnce(prompt, {
      command: "documents.organize",
      folder: capitalized(topic),
      about: topic,
    });
  }
  const restore = RESTORE.exec(question);
  if (restore) {
    return findThen(prompt, { kind: "deleted", name: restore[1] ?? restore[2] ?? "" }, (found) => ({
      command: "deleted.restore",
      ids: found.map((each) => each.id),
    }));
  }
  if (RECORD.test(question)) return runOnce(prompt, { command: "meeting.record" });
  if (LOCAL_MODE.test(question)) {
    // The card under the reply says where the User changes it: there is nothing to add.
    if (lastResult(prompt, "run_command") !== undefined) return { text: "" };
    return {
      tool: "run_command",
      input: { command: "settings.change", setting: "localMode", value: "on" },
    };
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
