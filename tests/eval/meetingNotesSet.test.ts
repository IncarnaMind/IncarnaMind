/**
 * The meeting-notes set of eval:speed (eval/speed/README.md › The meeting-notes set): each case is a
 * long call of the call-help set heard live and stopped, its notes read as the page shows them:
 * cited, judged, and every sentence a found Citation backs whose quote doesn't say it. Scripted
 * models only: nothing is sent anywhere.
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { callOf, TRANSCRIPT } from "../../eval/speed/callHelpCases";
import { meetingNotesSet } from "../../eval/speed/meetingNotes";
import { MEETING_NOTES_CASES } from "../../eval/speed/meetingNotesCases";
import { runOnArm } from "../../eval/speed/paired";
import type { CoreAdapters } from "../../src/core";
import { createFakeEmbedder } from "../../src/core/embedding/fake";
import { checkReply, isCheckRun } from "../helpers/checks";
import { shownPassages, transcriptCitations } from "../helpers/citations";
import { type ModelCall, scriptedModel } from "../helpers/models";

const block = (text: string, tag: string) =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1] ?? "";

const isFill = (call: ModelCall) =>
  call.prompt.includes("Fill them in from the transcript") || call.prompt.includes("took no notes");

/** One fact of the fill's reply, in its sections, citing the markers its body holds. */
function fact(id: string, body: string): string {
  return [
    `### FACT ${id}`,
    "```json",
    JSON.stringify({
      topic: id,
      citations: [...body.matchAll(/\[\^(\d+)\]/g)].map((match) => Number(match[1])),
      lines: [],
      sections: ["summary"],
      claim: false,
      supersedes: [],
    }),
    "```",
    body,
    `### END ${id}`,
  ].join("\n");
}

/** A model that fills the notes in with `reply`, citing the Transcript's lines as `quotes` names them by marker. */
function filling(quotes: Record<number, string>, reply: string, calls: ModelCall[]) {
  return scriptedModel((call) => {
    calls.push(call);
    if (isCheckRun(call)) return checkReply(call, {});
    if (!isFill(call)) return { text: "OK" };
    const cited = transcriptCitations(
      call,
      shownPassages(block(call.prompt, "live-transcript")),
      quotes,
    );
    return cited ?? { text: reply };
  });
}

/** A judge that grades every set of notes `grade` and lists `unstated`, keeping what it read. */
function judging(grade: string, unstated: number[], prompts: string[]) {
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      prompts.push(
        prompt
          .flatMap((message) =>
            typeof message.content === "string"
              ? [message.content]
              : message.content.flatMap((part) => ("text" in part ? [part.text] : [])),
          )
          .join("\n"),
      );
      return {
        content: [{ type: "text", text: JSON.stringify({ grade, unstated }) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

/** Stops the case's call once, its notes filled in by a scripted model, judged as `judge` says. */
async function stopped(
  id: string,
  quotes: Record<number, string>,
  reply: string,
  judge: { grade: string; unstated: number[] },
) {
  const group = meetingNotesSet().find((each) => each.name === `meeting-notes-${id}`);
  const item = group?.items[0];
  if (!group || !item) throw new Error(`No case ${id}.`);
  const calls: ModelCall[] = [];
  const model = filling(quotes, reply, calls);
  // The notes are filled in on an Ollama choice; the model is scripted, so the server is always here.
  const ollamaModels: CoreAdapters["ollamaModels"] = {
    describe: async () => null,
    loaded: async () => null,
    running: async () => true,
  };
  const opened = await group.open({
    embedder: createFakeEmbedder(),
    ollamaModels,
    keep: false,
    log: () => undefined,
    embeddings: false,
    recordTimings: true,
    chatModels: () => () => model,
  });
  try {
    const { library } = opened;
    const { id: providerId } = await library.core.saveChatProvider({
      kind: "ollama",
      modelId: "local-model",
    });
    const recorder = library.timings;
    if (!recorder || !opened.meeting) throw new Error("The case opened without its Meeting.");
    const judged: string[] = [];
    const run = await runOnArm(item, {
      library,
      meeting: opened.meeting,
      recorder,
      choice: { providerId, modelId: "local-model" },
      model: "ollama/local-model",
      arm: "today",
      grade: async () => "unread",
      claimsJudge: judging(judge.grade, judge.unstated, judged),
    });
    return { run, calls, judged };
  } finally {
    await opened.close();
  }
}

function caseNamed(id: string) {
  const found = MEETING_NOTES_CASES.find((each) => each.id === id);
  if (!found) throw new Error(`No case ${id}.`);
  return found;
}
const WANT = caseNamed("notes-en-want");
const lineOf = (group: number) => WANT.rests[group]?.[0]?.line ?? "";

describe("The meeting-notes cases", () => {
  test("6 cases a language, each a long call of its own, resting on lines its call says", () => {
    expect(new Set(MEETING_NOTES_CASES.map((each) => each.id)).size).toBe(12);
    expect(MEETING_NOTES_CASES.filter((each) => each.language === "en")).toHaveLength(6);
    expect(MEETING_NOTES_CASES.filter((each) => each.language === "zh-CN")).toHaveLength(6);
    for (const each of MEETING_NOTES_CASES) {
      expect(each.call.long, each.id).toBe(true);
      const said = callOf(each.call).map((turn) => turn.text);
      // Its own lines, then the rollout talk's two.
      expect(each.rests.length, each.id).toBeGreaterThanOrEqual(3);
      for (const group of each.rests) {
        for (const rest of group) {
          expect(rest.in, each.id).toBe(TRANSCRIPT);
          expect(said, each.id).toContain(rest.line);
        }
      }
    }
  });
});

describe("Stop during the call", { timeout: 180_000 }, () => {
  test("fills the notes in from the call's Transcript, read as the page shows them: cited, judged, with when they went in", async () => {
    // Part of a line is enough, as a Citation quotes it: the rollout talk's lines are long.
    const quotes = {
      1: lineOf(0),
      2: lineOf(1),
      3: "It's a separate workspace.",
      4: "a named onboarding contact for the first three months",
    };
    const { run, calls, judged } = await stopped(
      "en-want",
      quotes,
      [
        fact("P1_june", "It has to run before their audit in June [^1]."),
        fact("P1_budget", "Their budget is fixed at eight thousand dollars a month [^2]."),
        fact("P1_trial", "The trial runs in a separate workspace [^3]."),
        fact("P1_contact", "They get a named onboarding contact for three months [^4]."),
      ].join("\n"),
      { grade: "right", unstated: [] },
    );

    expect(run.status).toBe("done");
    // Every line of the call, heard once and in order, whatever its length.
    const heard = [
      ...block(calls.find(isFill)?.prompt ?? "", "live-transcript").matchAll(
        /^\[[\d:]+ (?:Me|Them)\] (.*)$/gm,
      ),
    ].map((match) => match[1]);
    expect([...new Set(heard)]).toEqual(callOf(WANT.call).map((turn) => turn.text));
    expect(run.firstSignMs).toEqual(expect.any(Number));
    expect(run.firstWordsMs ?? 0).toBeGreaterThanOrEqual(run.firstSignMs ?? Infinity);
    expect(run.doneMs ?? 0).toBeGreaterThanOrEqual(run.firstWordsMs ?? Infinity);
    expect(run.citations).toBe(4);
    expect(run.found).toBe(4);
    expect(run.cited).toBe(true);
    expect(run.grade).toBe("right");
    expect(run.falseSupported).toBe(0);
    expect(run.failures).toEqual([]);
    expect(judged[0]).toContain("Their budget is fixed at eight thousand dollars a month [2]");
    expect(judged[0]).toContain("(found)");
  });

  test("notes that don't cite a line the case rests on aren't cited, and a sentence the judge says its quote doesn't state is a false Supported", async () => {
    const { run } = await stopped(
      "en-want",
      { 1: lineOf(0) },
      fact("P1_june", "It has to run before their audit in May [^1]."),
      { grade: "partly", unstated: [1] },
    );

    expect(run.status).toBe("done");
    expect(run.found).toBe(1);
    expect(run.cited).toBe(false);
    expect(run.grade).toBe("partly");
    expect(run.falseSupported).toBe(1);
  });
});
