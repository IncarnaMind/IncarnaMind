/**
 * A quick model checks the reply against the Tool record, rather than wording
 * patterns deciding what the reply means. A failed or unreadable check finds
 * nothing: it must never put a false "nothing was written" line under an
 * honest Answer.
 */
import { generateText, jsonSchema, NoObjectGeneratedError, Output } from "ai";
import { type AnswerToolCall, CLAIMED_CHANGES, type ClaimedChange, type MindProblem } from "../api";
import { isRecord } from "../errors";
import type { ChatLanguageModel } from "../providers/models";
import { outputTokens } from "../providers/outputLimits";
import { tokenUsageOf } from "../providers/promptCache";
import type { TokenUsage } from "../runs/engine";
import type { UnmadeFixes } from "./claimedFixes";
import { replyJson } from "./quoteRetry";
import { type ChangeStates, type MindNames, toolRecordLines } from "./toolRecord";

/** What a sentence the judge read as a change is about; only a Mind's own change counts. */
export const CLAIM_ABOUT = ["mind", "reply", "document", "offer_or_question", "negation"] as const;

export type ClaimAbout = (typeof CLAIM_ABOUT)[number];

interface ClaimVerdict {
  sentence: string;
  kind: ClaimedChange;
  about: ClaimAbout;
  backed: boolean;
}

const verdictSchema = jsonSchema<{ claims: ClaimVerdict[] }>({
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sentence: { type: "string" },
          kind: { type: "string", enum: [...CLAIMED_CHANGES] },
          about: { type: "string", enum: [...CLAIM_ABOUT] },
          backed: { type: "boolean" },
        },
        required: ["sentence", "kind", "about", "backed"],
        additionalProperties: false,
      },
    },
  },
  required: ["claims"],
  additionalProperties: false,
});

export const CLAIM_CHECK_INSTRUCTIONS = [
  "You check an AI assistant's reply against IncarnaMind's record of what its Tools did to the User's Notes. The record's Tool names and fields say mind for a Note.",
  "Read every sentence of the reply. For each claim that a Note was made, written in, added to, changed, shortened, lengthened, replaced or removed from, return it with its kind and whether the record backs it. Return every such claim, backed or not backed.",
  "A change whose state is applied counts as made. A change that only waits for the User does not. A failed call, a denied call and no call change nothing. A revision of text the assistant wrote into a Note earlier is a change, like any other change to a Note.",
  "When the record has no Tool calls, or no change to a Note, every affirmative report of a change is unbacked; never return an empty list just to be cautious. / 如果没有工具调用或没有改动，任何声称已经改动的话都没有依据，必须返回，不能留空。",
  "Never flag a sentence about the reply itself, searching, a Document, or something that wasn't or couldn't be done. Never flag a sentence only for its wording, coverage or length, for where a page sits, for a Note's name, or for details the record doesn't give, such as which paragraph changed. A translation or other text in the reply itself is not a change to a Note.",
  "For every claim, about says what the sentence is about: mind when it is a Note, a page or a part of one that the assistant says it changed; reply when it is this reply's own text, such as what it sets out, lists, orders, sorts, organizes or summarizes; document when it is a Document; offer_or_question when the assistant offers to do something or asks; negation when it says nothing was or could be done. Only a claim about a mind counts.",
  "Examples:",
  "- Record: create_mind made “Notes”, applied. Reply: “I made a page, “Notes”, covering both papers.” Back it.",
  "- Record: edit_mind “Q3 review” proposed 3 changes, applied. Reply: “The second paragraph is now more formal.” Back it.",
  "- Record: no calls. Reply: “Done — the summary is now on the page.” kind: added, about: mind, backed: false.",
  "- Record: no calls. Reply: “Your summary is in “Q3 review” now.” kind: added, about: mind, backed: false.",
  "- Record: no calls. Reply: “Here it is in a new Note, “Library summary”.” kind: made, about: mind, backed: false.",
  "- Record: no calls. Reply: “I've renamed the page to “Q3 summary”.” kind: changed, about: mind, backed: false.",
  "- Record: no calls. Reply: “总结已经放在页面里了。” kind: added, about: mind, backed: false.",
  "- Record: no calls. Reply: “好了，第二段现在更清楚了。” kind: changed, about: mind, backed: false.",
  "- Record: no calls. Reply: “已在新的笔记中整理好总结。” kind: made, about: mind, backed: false.",
  "- Record: no calls. Reply: “The page was created on 3 March 2021 to track the project.” Return no claim: this describes a Document.",
  "- Record: no calls. Reply: “The new page replaces the version published in 2019.” Return no claim: a Document's new page replacing an earlier edition is not a Note the assistant made.",
  "- Record: no calls. Reply: “第二版中，已经修改了摘要部分的实验结论。” Return no claim: this reports what a Document's second edition says, not what the assistant changed.",
  "- Record: no calls. Reply: “这份总结已经完成于2023年。” Return no claim: a Document's completion date is not a change the assistant made.",
  "- Record: add_to_mind “Q3 review” proposed 2 changes, applied. Reply: “I added a risks section to “Q3 review”.” Back it.",
  "- Record: edit_mind “Plan” proposed 1 change, waiting for the User. Reply: “I shortened Plan.” Do not back it.",
  'Copy each claimed sentence exactly as it appears in the reply. Reply with one JSON object: {"claims":[{"sentence":"…","kind":"added","about":"mind","backed":false}]}, with an empty list when the reply claims nothing.',
].join("\n");

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function targetOf(call: AnswerToolCall, names: MindNames) {
  const problem: MindProblem | undefined = call.mindProblem;
  const id = call.mindChange?.mindId ?? (problem && "mindId" in problem ? problem.mindId : null);
  if (id) return { id, name: names(id) };
  const item = call.command?.items.find((each) => each.kind === "mind");
  if (item) return { id: item.id, name: item.renamed ?? item.name };
  const named = [call.input.mind, call.input.title, call.input.name].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  return named ? { name: named } : null;
}

/** The Minds each kind of change was made in, by id. */
export interface ChangeLog {
  made: Set<string>;
  changed: Set<string>;
  edited: Set<string>;
}

export function changeLogOf(calls: readonly AnswerToolCall[]): ChangeLog {
  const log: ChangeLog = { made: new Set(), changed: new Set(), edited: new Set() };
  for (const call of calls) {
    const change = call.mindChange;
    if (call.source !== "minds" || !change) continue;
    if (change.created) log.made.add(change.mindId);
    if (change.proposals > 0 || change.revised) log.changed.add(change.mindId);
    if (call.tool === "edit_mind" && (change.proposals > 0 || change.revised)) {
      log.edited.add(change.mindId);
    }
  }
  return log;
}

function recordOf(calls: readonly AnswerToolCall[], names: MindNames, states?: ChangeStates) {
  return calls.map((call) => {
    const change = call.mindChange;
    const state = change ? states?.(change) : null;
    return {
      tool: call.tool,
      status: call.status,
      ...(call.approval && { approval: call.approval }),
      resultCount: call.resultCount,
      target: targetOf(call, names),
      ...(call.mindProblem && { problem: call.mindProblem.kind }),
      ...(call.tool === "run_command" && {
        input: call.input,
        command: call.command ?? null,
        ...(call.commandProblem && { commandProblem: call.commandProblem.message }),
      }),
      ...(change && {
        change: {
          created: change.created,
          proposals: change.proposals,
          changed: change.changed ?? 0,
          paragraphs: change.paragraphs ?? 0,
          tables: change.tables ?? 0,
          charts: change.charts ?? 0,
          revised: change.revised === true,
          state,
        },
      }),
    };
  });
}

/** The values that keep a claim from counting: a missing or unknown one counts, since a provider may ignore the schema. */
const NOT_A_MIND: readonly string[] = CLAIM_ABOUT.filter((about) => about !== "mind");

// A model may straighten the reply's typographic quotes even when asked to copy it.
const comparableSentence = (text: string) =>
  text.trim().replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

function verdictOf(value: unknown, reply: string): ClaimedChange[] | null {
  if (!isRecord(value) || !Array.isArray(value.claims)) return null;
  const unbacked = new Set<ClaimedChange>();
  for (const item of value.claims) {
    if (!isRecord(item)) continue;
    const { sentence, kind, about, backed } = item;
    const claimed = CLAIMED_CHANGES.find((claim) => claim === kind);
    if (!claimed) return null;
    if (
      typeof sentence !== "string" ||
      sentence.trim() === "" ||
      !comparableSentence(reply).includes(comparableSentence(sentence)) ||
      typeof backed !== "boolean"
    ) {
      continue;
    }
    if (!backed && !(typeof about === "string" && NOT_A_MIND.includes(about)))
      unbacked.add(claimed);
  }
  return [...unbacked];
}

export interface ClaimCheckResult {
  claims: ClaimedChange[];
  usage: TokenUsage | null;
  durationMs: number;
}

export async function unbackedClaims(
  reply: string,
  calls: readonly AnswerToolCall[],
  minds: readonly { id: string; name: string }[],
  focused: string | null,
  {
    model,
    names,
    states,
    signal,
  }: {
    model: ChatLanguageModel;
    names: MindNames;
    states?: ChangeStates;
    signal: AbortSignal;
  },
): Promise<ClaimCheckResult> {
  if (reply.trim() === "") return { claims: [], usage: null, durationMs: 0 };
  const started = Date.now();
  const named: MindNames = (id) => names(id) ?? minds.find((mind) => mind.id === id)?.name ?? null;
  const prompt = [
    "<tool-record>",
    JSON.stringify(recordOf(calls, named, states), null, 2),
    "</tool-record>",
    "<focused-mind>",
    focused ? JSON.stringify({ id: focused, name: named(focused) }) : "none",
    "</focused-mind>",
    "<reply>",
    reply,
    "</reply>",
  ].join("\n");
  let value: unknown;
  let usage: TokenUsage | null = null;
  try {
    const result = await generateText({
      model,
      instructions: CLAIM_CHECK_INSTRUCTIONS,
      prompt,
      output: Output.object({ schema: verdictSchema, name: "change-claims" }),
      maxOutputTokens: outputTokens("claimed-changes"),
      maxRetries: 0,
      abortSignal: signal,
    });
    value = result.output;
    usage = tokenUsageOf(result.usage);
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error) && error.text) {
      try {
        value = await replyJson(error.text);
      } catch {
        value = null;
      }
    } else {
      if (!signal.aborted) {
        console.error(`The reply's change claims couldn't be checked: ${messageOf(error)}`);
      }
      return { claims: [], usage: null, durationMs: Date.now() - started };
    }
  }
  const claims = verdictOf(value, reply);
  if (claims === null) {
    console.error("The reply's change-claim check returned no readable verdict.");
    return { claims: [], usage, durationMs: Date.now() - started };
  }
  return { claims, usage, durationMs: Date.now() - started };
}

const CLAIMED_WORDS: Record<ClaimedChange, string> = {
  made: "made a Note",
  added: "added text to a Note",
  changed: "changed a Note",
  removed: "removed or replaced text in a Note",
};

export const UNSEEN_REPLY =
  "The User will not read your earlier reply and does not know you were asked again. Write your reply as if for the first time: don't mention, apologise for or correct an earlier reply.";

/** The record of what the calls did, then to write the reply again from it. */
export function askAgainNote(
  claims: readonly ClaimedChange[],
  calls: readonly AnswerToolCall[],
  names: MindNames,
  states?: ChangeStates,
): string {
  const said = claims.map((claim) => CLAIMED_WORDS[claim]).join(", and ");
  return [
    thisAnswersRecord(calls, names, states),
    `Your reply says you ${said}, but no Tool did that. Write your reply again from its start, without saying what you changed: IncarnaMind lists each change under your reply. Say plainly what wasn't done and why. If the User's request still needs a change you can make now, make it with the Tools first.`,
    UNSEEN_REPLY,
  ].join("\n");
}

/** The record of what the calls did, then what the reply says its edits fixed that they didn't (./claimedFixes). */
export function unmadeFixesNote(
  unmade: UnmadeFixes,
  calls: readonly AnswerToolCall[],
  names: MindNames,
  states?: ChangeStates,
): string {
  const said = [
    ...(unmade.words.length > 0
      ? [
          `that you fixed ${unmade.words.map((word) => `“${word}”`).join(", ")}, but your edits left ${unmade.words.length === 1 ? "it" : "them"} in the Note as before`,
        ]
      : []),
    ...(unmade.count
      ? [
          `${unmade.count.claimed} ${unmade.count.of === "places" ? "fixes" : "paragraphs changed"}, but your edits made ${unmade.count.made}`,
        ]
      : []),
  ];
  return [
    thisAnswersRecord(calls, names, states),
    `Your reply says ${said.join(", and ")}. If the User's request still needs that change, make it now with edit_mind. Then write your reply again from its start, saying only what your edits did.`,
    UNSEEN_REPLY,
  ].join("\n");
}

/** What the Tools of this Answer did, as IncarnaMind recorded it, for asking the model again. */
export function thisAnswersRecord(
  calls: readonly AnswerToolCall[],
  names: MindNames,
  states?: ChangeStates,
): string {
  const lines = toolRecordLines(calls, names, states);
  return [
    "<tool-record>",
    "What the Tools of this Answer really did, as IncarnaMind recorded it:",
    ...(lines.length > 0 ? lines : ["- No Tool was called."]),
    "</tool-record>",
  ].join("\n");
}
