/**
 * IncarnaMind's own record of what an Answer's Tool calls did: what
 * each one changed, and in which Mind, or why it changed nothing. It is
 * written from the calls' cards, never from the model's words, so a later
 * Question in the conversation knows what really happened before (./context),
 * and a reply that claims a change no call made is asked again with it
 * (./claimedChanges). In English, as the rest of the instructions are.
 */
import type { AnswerToolCall, MindChange, MindProblem } from "../api";

/** A Mind's name now, by its id; null for one deleted or unknown. */
export type MindNames = (mindId: string) => string | null;

/**
 * What became of a change's Proposals since the Answer: how many still wait in
 * its Mind, and how many the User accepted and rejected. `gone`: its Mind is no longer there.
 */
export interface ChangeState {
  waiting: number;
  accepted: number;
  rejected: number;
  gone?: boolean;
}

/** What became of a call's change, if known: read from its Mind as it is now. */
export type ChangeStates = (change: MindChange) => ChangeState | null;

const field = (call: AnswerToolCall, name: string): string => {
  const value = call.input[name];
  return typeof value === "string" ? value.trim() : "";
};

const quoted = (text: string) => `“${text.replace(/\s+/g, " ").slice(0, 120)}”`;

const counted = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

function whyNot(problem: MindProblem | undefined): string {
  switch (problem?.kind) {
    case "waiting":
      return problem.mixed
        ? "your own waiting changes sit beside the User's text there"
        : `${counted(problem.count, "change")} the assistant can't revise waited there for the User`;
    case "no-mind":
      return "no Mind was open and none was named";
    case "not-found":
      return `no Mind is called ${quoted(problem.name)}`;
    case "several":
      return `several Minds are called ${quoted(problem.name)}`;
    case "no-heading":
      return `it has no heading ${quoted(problem.heading)}`;
    case "no-place":
      return `it has no heading or paragraph ${quoted(problem.place)}`;
    case "several-places":
      return `more than one place is called ${quoted(problem.name)}, and the User didn't say which`;
    case "no-text":
      return "there was no text there to change";
    case "too-long":
      return "it was too much text to change at once";
    case "changed":
      return "its text changed while it was being read";
    case "content-not-own":
      return "new text can only replace your own text, still waiting or as you wrote it";
    case "copy":
      return `“${problem.text}” is there already, as your own waiting text: revise it with edit_mind`;
    case "new-version":
      return `it is a new version of your own text “${problem.text}” there: change that text in place with edit_mind`;
    case "stopped":
      return "it was stopped";
    case "no-table":
      return "its table couldn't be made";
    case "uncited":
      return "its sources were written as text, or as markers with no Citation recorded";
    case "local-mode":
      return "“Keep everything on this computer” is on";
    case "not-ready":
      return "the model couldn't be used";
    case "model":
      return `the model failed: ${problem.message}`;
    case undefined:
      return "it failed";
  }
}

function detailsOf(change: MindChange): string {
  const tables = change.tables ? `, ${counted(change.tables, "table")} among them` : "";
  const cited = change.cited ? `, with ${counted(change.cited, "Citation")}` : "";
  const left = change.unrecorded
    ? `; ${counted(change.unrecorded, "marker")} had no Citation recorded with cite, so ${change.unrecorded === 1 ? "it was" : "they were"} left out`
    : "";
  return `${tables}${cited}${left}`;
}

function mindOf(call: AnswerToolCall, names: MindNames): string {
  const problem = call.mindProblem;
  const id = call.mindChange?.mindId ?? (problem && "mindId" in problem ? problem.mindId : null);
  const name = (id && names(id)) || field(call, "mind") || field(call, "title");
  return name ? quoted(name) : "the Mind the User was in";
}

/** What the User did with `total` Proposals, in words; "" when nothing says they did anything. */
function decisions(total: number, accepted: number, rejected: number): string {
  const part = (verb: string, count: number) =>
    count < total
      ? `${verb} ${count} of ${total}`
      : total === 1
        ? `${verb} it`
        : `${verb} all ${total}`;
  if (accepted > 0 && rejected > 0) return `accepted ${accepted} and rejected ${rejected}`;
  if (accepted > 0) return part("accepted", accepted);
  if (rejected > 0) return part("rejected", rejected);
  return "";
}

/**
 * What became of a change's Proposals, as the next Question reads it. The
 * User's decisions count only while they and the waiting ones fit the change
 * (an Undo can leave them not fitting).
 */
function fateOf(proposals: number, state: ChangeState | null): string {
  if (!state) return "waiting for the User";
  if (state.gone) return GONE;
  const { waiting, accepted, rejected } = state;
  if (waiting >= proposals) return "waiting for the User";
  const did =
    accepted + rejected + waiting <= proposals ? decisions(proposals, accepted, rejected) : "";
  if (!did)
    return waiting > 0
      ? `${waiting} of ${proposals} still waiting for the User`
      : "none waiting any more";
  return `then the User ${did}${waiting > 0 ? `, ${waiting} still waiting` : ""}`;
}

function mindLine(call: AnswerToolCall, names: MindNames, states?: ChangeStates): string {
  const mind = mindOf(call, names);
  const change = call.mindChange;
  const section = field(call, "part") ? ` (section ${quoted(field(call, "part"))})` : "";
  if (call.status !== "done") {
    const verb = call.tool === "read_mind" ? "couldn't read it" : "nothing changed";
    return `${call.tool} ${mind}${section}: ${verb}: ${whyNot(call.mindProblem)}`;
  }
  const fate = change ? fateOf(change.proposals, states?.(change) ?? null) : "";
  const proposed = change
    ? `proposed ${counted(change.proposals, "change")}, ${fate}${detailsOf(change)}`
    : "";
  switch (call.tool) {
    case "read_mind":
      return `read_mind ${mind}: read it`;
    case "create_mind":
      return change && change.proposals > 0
        ? `create_mind: made the Mind ${mind} and ${proposed}`
        : `create_mind: made the Mind ${mind}, empty`;
    case "add_to_mind":
      return `add_to_mind ${mind}: proposed ${counted(change?.proposals ?? 0, "new Block")}, ${fate}${change ? detailsOf(change) : ""}`;
    default:
      if (!change) return `${call.tool} ${mind}${section}: no change was needed`;
      return change.revised
        ? `${call.tool} ${mind}${section}: revised your own waiting text in place, and ${proposed}`
        : `${call.tool} ${mind}${section}: ${proposed}`;
  }
}

/** A call's line in the record; null for one with nothing to say (a note that a Connector needs signing in). */
function lineOf(call: AnswerToolCall, names: MindNames, states?: ChangeStates): string | null {
  const done = call.status === "done";
  switch (call.source) {
    case "minds":
      return mindLine(call, names, states);
    case "documents":
      if (call.tool === "calculate") {
        return `calculate: ${counted(call.resultCount ?? 0, "figure")} worked out`;
      }
      return done
        ? `${call.tool} ${quoted(field(call, "query"))}: ${counted(call.resultCount ?? 0, "Passage")}`
        : `${call.tool} ${quoted(field(call, "query"))}: failed`;
    case "web":
      if (call.tool === "read_web_page") {
        const page = call.webPage;
        return page && "documentId" in page
          ? `read_web_page ${field(call, "url")}: saved as the Document ${quoted(page.name)}`
          : `read_web_page ${field(call, "url")}: couldn't be read`;
      }
      return `${call.tool} ${quoted(field(call, "query"))}: ${done ? "done" : "failed"}`;
    case "sources":
      return `${call.tool} ${quoted(field(call, "query"))}: ${done ? counted(call.resultCount ?? 0, "work") : "failed"}`;
    case "skill":
      if (call.tool === "run_skill_script") {
        return `run_skill_script ${field(call, "script")}: ${done ? "ran" : call.approval === "denied" ? "the User denied it" : "didn't run"}`;
      }
      return `${call.tool} ${quoted(field(call, "name") || field(call, "skill"))}: ${done ? "done" : "failed"}`;
    case "connector":
      if (call.signInRequired) return null;
      return `${call.tool} (the Connector ${quoted(call.connector?.name ?? "")}): ${
        done
          ? "done"
          : call.approval === "denied"
            ? "the User denied it, so it wasn't made"
            : "failed"
      }`;
  }
}

export function toolRecordLines(
  calls: readonly AnswerToolCall[],
  names: MindNames,
  states?: ChangeStates,
): string[] {
  return calls.flatMap((call) => {
    const line = lineOf(call, names, states);
    return line ? [`- ${line}`] : [];
  });
}

const GONE = "but the Mind is no longer there";
const WITH_ITS_ANSWER =
  "What the Tools of your Answer above really did, as IncarnaMind recorded it:";
const WITHOUT_ITS_ANSWER =
  "What the Tools of an earlier Answer of yours really did, as IncarnaMind recorded it:";

/**
 * The record of an earlier Answer's calls, as the message after it starts with; "" with none.
 * `cited`: how many Citations its reply holds, which the model reads as plain references.
 */
export function toolRecord(
  calls: readonly AnswerToolCall[],
  names: MindNames,
  cited = 0,
  states?: ChangeStates,
): string {
  const lines = [
    ...toolRecordLines(calls, names, states),
    ...(cited > 0
      ? [
          `- cite: ${counted(cited, "Citation")} in your reply; each reads as its source in brackets, like [Tides, p. 3]`,
        ]
      : []),
  ];
  if (lines.length === 0) return "";
  return ["<tool-record>", WITH_ITS_ANSWER, ...lines, "</tool-record>"].join("\n");
}

export const withoutItsAnswer = (record: string): string =>
  record.replace(WITH_ITS_ANSWER, WITHOUT_ITS_ANSWER);

export const RECORD_BLOCK = /<tool-record>[\s\S]*?<\/tool-record>/g;

/** A record's block, as a message holds it: what reads it for anything but the model leaves it out. */
export const TOOL_RECORD = /<tool-record>[\s\S]*?<\/tool-record>\s*/g;

/** Whether a record tells of changes to a Mind that is still there: the one thing worth keeping after its Answer's text. */
export const tellsOfChanges = (record: string): boolean =>
  record
    .split("\n")
    .some((line) => / proposed \d+ (?:changes?|new Blocks?)/.test(line) && !line.includes(GONE));
