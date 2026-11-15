import { describe, expect, test } from "vitest";
import { askAssistant } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, writeMind } from "../helpers/minds";
import {
  type GenerateCall,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/**
 * What the check of what a reply says it changed is told of an edit (#2769, #2878), through the
 * core as the assistant runs a turn: which kind of change an applied edit made (paragraphs it
 * edited, added, took out, and how many stayed as they were) and the part it named, by counts and
 * names only. Without them the check can't hold "it also removed the other section" or "the
 * paragraph is removed" to an edit that did not. The edit model and the judge are scripted; the
 * judge only reads what it was sent.
 */

type Step = { tool: string; input: Record<string, unknown>; edit?: string };
type Line = { h: string } | { p: string };

const NOTES = {
  en: {
    title: "Coastal summary",
    lines: [
      { h: "Coastal Flood Risk Review" },
      { p: "The coast flooded twice in 2025." },
      { p: "Sea walls held at Pier 4 and Pier 7." },
      { h: "Tide report" },
      { p: "The gauges were read each hour." },
      { p: "High tide reached 4.2 m on 3 March." },
    ] satisfies Line[],
  },
  zh: {
    title: "沿海总结",
    lines: [
      { h: "沿海洪水风险回顾" },
      { p: "2025 年海岸两次被淹。" },
      { p: "4 号和 7 号码头的海堤都挡住了水。" },
      { h: "潮汐报告" },
      { p: "水位计每小时读数一次。" },
      { p: "3 月 3 日高潮位达到 4.2 米。" },
    ] satisfies Line[],
  },
} as const;

/** The record of the claims check's request, as the judge read it. */
async function recordAfter(
  language: "en" | "zh",
  asked: string,
  steps: Step[],
  reply = "Done.",
): Promise<{ record: Record<string, unknown>[]; prompt: string }> {
  const { title } = NOTES[language];
  const lines: readonly Line[] = NOTES[language].lines;
  const edits = steps.flatMap((step) => (step.edit === undefined ? [] : [step.edit]));
  let edited = 0;
  const judged: GenerateCall[] = [];
  const model = scriptedModel(
    (call: ModelCall): ScriptedReply => {
      if (/<passage>\n/.test(call.prompt))
        return { text: `${edits[edited++] ?? ""}\n<why>Done.</why>` };
      const next = steps[call.results.length];
      return next ? { calls: [{ tool: next.tool, input: next.input }] } : { text: reply };
    },
    {
      generate: (call) => {
        if (call.question === "request-done")
          return { text: '{"asks_change":"yes","request":"done"}' };
        if (call.question === "claimed-changes") judged.push(call);
        return { text: '{"claims":[]}' };
      },
    },
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    heading(1, title),
    ...lines.map((line) => ("h" in line ? heading(2, line.h) : note(line.p))),
  ]);
  await client.settled();
  await askAssistant(core, { text: asked, mindId: mind.id });
  await client.settled();
  core.close();
  const prompt = judged[0]?.prompt;
  if (prompt === undefined) throw new Error("The claims check was not asked.");
  const json = /<tool-record>\n([\s\S]*?)\n<\/tool-record>/.exec(prompt)?.[1] ?? "";
  if (json === "") throw new Error("The request holds no record.");
  return { record: JSON.parse(json) as Record<string, unknown>[], prompt };
}

const changeOf = (record: Record<string, unknown>[]) =>
  record[0]?.change as Record<string, unknown> | undefined;

const REMOVAL = {
  en: {
    asked: "Remove the part about the Tide report.",
    part: "Tide report",
    edit: "<removed>## Tide report</removed>\n\n<removed>The gauges were read each hour.</removed>\n\n<removed>High tide reached 4.2 m on 3 March.</removed>",
  },
  zh: {
    asked: "把潮汐报告那一部分删掉。",
    part: "潮汐报告",
    edit: "<removed>## 潮汐报告</removed>\n\n<removed>水位计每小时读数一次。</removed>\n\n<removed>3 月 3 日高潮位达到 4.2 米。</removed>",
  },
} as const;

describe("The check is told what kind of change an applied edit made and the part it named (#2769)", {
  timeout: 60_000,
}, () => {
  // protects=an edit that took out one section reaches the check with the part it named and counts that say two paragraphs and a title went and the rest of the Note stayed, in English and Chinese; fails_when=the record gives only a total changed, so "it also removed the other section" and "the Note is empty" can't be held to anything; no_claim=what the judge makes of the counts.
  test.each(["en", "zh"] as const)("a section taken out: %s", async (language) => {
    const each = REMOVAL[language];
    const { record } = await recordAfter(language, each.asked, [
      {
        tool: "edit_mind",
        input: { instruction: each.asked, part: each.part, removes_only: true },
        edit: each.edit,
      },
    ]);

    const change = changeOf(record);
    expect(change?.part).toBe(each.part);
    expect(change?.touched).toEqual({
      edited: 0,
      added: 0,
      removed: 2,
      titlesAdded: 0,
      titlesRemoved: 1,
      untouched: 4,
    });
    expect(change?.place).toEqual({
      firstParagraph: 3,
      lastParagraph: 4,
      ofParagraphs: 4,
      underHeading: true,
    });
  });

  // protects=an edit that made a paragraph longer reaches the check as one paragraph edited and none added or taken out; fails_when=the record can't say nothing was taken out, so "the paragraph is removed" for a request to make it longer stays unchallenged; no_claim=what the judge makes of the counts.
  test.each([
    {
      language: "en",
      asked: "Make it longer.",
      part: "The gauges were read",
      edit: "¶1 The gauges were read each hour. They were checked against the harbour office clock.",
    },
    {
      language: "zh",
      asked: "把它写长一点。",
      part: "水位计每小时",
      edit: "¶1 水位计每小时读数一次。读数每天与港务局的钟核对。",
    },
  ] as const)("a paragraph made longer: $language", async (each) => {
    const { record } = await recordAfter(each.language, each.asked, [
      {
        tool: "edit_mind",
        input: { instruction: each.asked, part: each.part },
        edit: each.edit,
      },
    ]);

    const change = changeOf(record);
    expect(change?.part).toBe(each.part);
    expect(change?.touched).toEqual({
      edited: 1,
      added: 0,
      removed: 0,
      titlesAdded: 0,
      titlesRemoved: 0,
      untouched: 6,
    });
    expect(change?.place).toEqual({
      firstParagraph: 3,
      lastParagraph: 3,
      ofParagraphs: 4,
      underHeading: true,
    });
  });

  // protects=the counts and the place hold no text of the User's, only numbers and a yes or no, and the part is the name the call gave (a name the record has always sent: nothingChangedIn and a waiting change's state); fails_when=a paragraph, a title or a sentence of the Note is in the request beside them, or the heading a paragraph sits under; no_claim=the part's name, which the call wrote.
  test("a section taken out: none of the Note's words are sent", async () => {
    const each = REMOVAL.en;
    const { prompt } = await recordAfter("en", each.asked, [
      {
        tool: "edit_mind",
        input: { instruction: each.asked, part: each.part, removes_only: true },
        edit: each.edit,
      },
    ]);

    expect(prompt).not.toContain("The gauges were read each hour");
    expect(prompt).not.toContain("High tide reached");
    expect(prompt).not.toContain("Sea walls");
    expect(prompt).not.toContain("Coastal Flood Risk Review");
  });
});
