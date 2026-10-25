import { describe, expect, test } from "vitest";
import {
  type AnswerEngineEvent,
  type AnswerTools,
  type CitationRecordInput,
  createAiSdkAnswerEngine,
} from "../../src/core/answers/engine";
import { heldBackFrom, takeToolText, toolTextIn } from "../../src/core/answers/toolText";
import { askAssistant } from "../helpers/assistant";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const FIRST =
  "Tea drinking began in southwest China, where it was first used as a medicinal drink.";
const TEA = { name: "Tea history.md", contents: `# Tea history\n\n${FIRST}\n` };

const ENGLISH = {
  question: "Where was tea first drunk?",
  sentence: "Tea was first drunk in southwest China [^1].",
};
const CHINESE = {
  question: "茶最早是在哪里喝的？",
  sentence: "茶最早在中国西南地区被当作药饮[^1]。",
};

const record = (passage: string | undefined) =>
  JSON.stringify([{ marker: 1, passage, quote: FIRST }]);

/** A model that searches once, then writes `reply` for the Passage it was shown, never calling `cite`. */
function writingModel(reply: (passage: string | undefined) => string) {
  return scriptedModel((call: ModelCall): ScriptedReply => {
    if (call.json) return { text: JSON.stringify({ citations: [] }) };
    const search = call.results.find((result) => result.tool === "search_documents");
    if (!search) return { calls: [{ tool: "search_documents", input: { query: "tea" } }] };
    return { text: reply(shownPassages(search.text)[0]?.id) };
  });
}

const requestsForCitations = (model: ReturnType<typeof scriptedModel>) =>
  model.doStreamCalls.length - 2;

describe("A cite record written as text", { timeout: 30_000 }, () => {
  // protects=a <cite> block written in the reply is never shown, and its record becomes the Citation the sentence's marker names, without asking the model; fails_when=the block shows, the Citation is lost, or the model is asked for it; no_claim=what a real model writes.
  test.each([
    ["English", ENGLISH],
    ["Chinese", CHINESE],
  ])("%s: it becomes a Citation", async (_language, each) => {
    const model = writingModel(
      (passage) => `${each.sentence}\n\n<cite>\n${record(passage)}[^2]\n</cite>`,
    );
    const { core } = await setUpWithDocuments(model, [TEA]);

    const answer = await askAssistant(core, { text: each.question });

    expect(answer.text).toBe(each.sentence);
    expect(answer.citations.map(({ marker, quote, check }) => [marker, quote, check])).toEqual([
      [1, FIRST, "found"],
    ]);
    expect(requestsForCitations(model)).toBe(0);
  });

  // protects=the escaped form, with its quotes escaped too, is read the same; fails_when=the escaped block shows or is not recovered; no_claim=none beyond protects.
  test.each([
    ["English", ENGLISH],
    ["Chinese", CHINESE],
  ])("%s: escaped, it becomes a Citation too", async (_language, each) => {
    const model = writingModel(
      (passage) =>
        `${each.sentence}\n\n&lt;cite&gt;${record(passage).replaceAll('"', "&quot;")}&lt;/cite&gt;`,
    );
    const { core } = await setUpWithDocuments(model, [TEA]);

    const answer = await askAssistant(core, { text: each.question });

    expect(answer.text).toBe(each.sentence);
    expect(answer.citations.map(({ quote }) => quote)).toEqual([FIRST]);
  });

  // protects=a tool-call block that is no citation record is removed, its sentences stay and read as uncited, and nothing of it shows, in English and Chinese; fails_when=markup shows or a sentence goes; no_claim=none beyond protects.
  test.each([
    ["English", ENGLISH],
    ["Chinese", CHINESE],
  ])("%s: another block goes, and the sentence reads as uncited", async (_language, each) => {
    const model = writingModel(
      () =>
        `${each.sentence}\n\n<cite>\n[{"note": "not a record"}]\n</cite>\n\n<tool_call>{"name": "search_documents", "arguments": {"query": "tea"}}</tool_call>`,
    );
    const { core } = await setUpWithDocuments(model, [TEA]);

    const answer = await askAssistant(core, { text: each.question });

    expect(answer.text).not.toMatch(/<cite|<tool_call|"arguments"/);
    expect(answer.text).not.toContain("[^");
    expect(answer.text).toContain(each.sentence.replace(/ ?\[\^1\]/, ""));
    expect(answer.citations).toEqual([]);
  });

  // protects=the same tag around words, or inside code, is the Answer's own and stays as written; fails_when=an HTML explanation loses its words or a code block changes; no_claim=none beyond protects.
  test("a tag around words, and one in code, stay", async () => {
    const text = [
      "The <cite> element marks a title, as in <cite>Moby Dick</cite>.",
      "",
      "```html",
      '<cite>[{"marker":1}]</cite>',
      "```",
    ].join("\n");
    const model = writingModel(() => text);
    const { core } = await setUpWithDocuments(model, [TEA]);

    const answer = await askAssistant(core, { text: "What does the cite tag do?" });

    expect(answer.text).toBe(text);
  });
});

/** A model that searches, calls `cite` with `records` for the Passage it was shown, then writes `reply`. */
function citingThenWriting(
  records: (passage: string | undefined) => unknown[],
  reply: (passage: string | undefined) => string,
) {
  return scriptedModel((call: ModelCall): ScriptedReply => {
    if (call.json) return { text: JSON.stringify({ citations: [] }) };
    const search = call.results.find((result) => result.tool === "search_documents");
    if (!search) return { calls: [{ tool: "search_documents", input: { query: "tea" } }] };
    const passage = shownPassages(search.text)[0]?.id;
    if (!call.results.some((result) => result.tool === "cite")) {
      return { calls: [{ tool: "cite", input: { citations: records(passage) } }] };
    }
    return { text: reply(passage) };
  });
}

describe("A cite record written as text, beside what the model did right", {
  timeout: 30_000,
}, () => {
  // protects=a block never closed loses its tag and its JSON only: the words after it stay, and its record is recovered; fails_when=the prose after it goes with it, or its markup shows; no_claim=none beyond protects.
  test.each([
    ["English", ENGLISH, "That is what the notes say."],
    ["Chinese", CHINESE, "以上是文档的说法。"],
  ])("%s: a block never closed leaves the words after it", async (_language, each, after) => {
    const model = writingModel(
      (passage) => `${each.sentence} <cite>${record(passage)}\n\n${after}`,
    );
    const { core } = await setUpWithDocuments(model, [TEA]);

    const answer = await askAssistant(core, { text: each.question });

    expect(answer.text).toBe(`${each.sentence}\n\n${after}`);
    expect(answer.citations.map(({ quote }) => quote)).toEqual([FIRST]);
  });

  // protects=a record in text is recovered only for a marker still unbacked: a Citation the model recorded with `cite` and the check found stays as it was; fails_when=the text block's invented quote replaces it; no_claim=none beyond protects.
  test.each([
    ["English", ENGLISH],
    ["Chinese", CHINESE],
  ])("%s: a recorded Citation is not overwritten", async (_language, each) => {
    const invented = JSON.stringify([
      { marker: 1, passage: "P1", quote: "Words that no page has." },
    ]);
    const model = citingThenWriting(
      (passage) => [{ marker: 1, passage, quote: FIRST }],
      () => `${each.sentence}\n\n<cite>${invented}</cite>`,
    );
    const { core } = await setUpWithDocuments(model, [TEA]);

    const answer = await askAssistant(core, { text: each.question });

    expect(answer.text).toBe(each.sentence);
    expect(answer.citations.map(({ marker, quote, check }) => [marker, quote, check])).toEqual([
      [1, FIRST, "found"],
    ]);
  });
});

/** Documents that find nothing and record what `cite` is given. */
function recordingDocuments(given: CitationRecordInput[]): AnswerTools {
  return {
    documentCount: 1,
    async searchDocuments() {
      return { text: "", passageCount: 0 };
    },
    cite: (records) => {
      given.push(...records);
      return "Recorded.";
    },
  };
}

describe("While the reply streams", () => {
  // protects=tool-call text never shows, not even while it comes in, and what shows at the end is the text without it; its records are given to cite; fails_when=a moment of the shown text holds a tag, or the records are lost; no_claim=none beyond protects.
  test("the block is held back as it is typed, and its record is recorded", async () => {
    const reply = `Tea began in China [^1].\n\n<cite>\n[{"marker":1,"passage":"P1","quote":"Tea began."}]\n</cite>`;
    const model = scriptedModel(() => ({ text: reply }));
    const given: CitationRecordInput[] = [];
    const events: AnswerEngineEvent[] = [];
    for await (const event of createAiSdkAnswerEngine().generate({
      instructions: () => "Answer.",
      messages: [{ role: "user", content: "Where?" }],
      question: "Where?",
      model,
      documents: recordingDocuments(given),
      tools: [],
      support: "tools",
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    let shown = "";
    for (const event of events) {
      if (event.type === "text-delta") shown += event.text;
      else if (event.type === "text-retracted") shown = shown.slice(0, -event.length);
      expect(shown).not.toMatch(/<cite>|&lt;cite|\[\{/);
    }
    expect(shown).toBe("Tea began in China [^1].");
    expect(given).toEqual([
      { marker: 1, passage: "P1", pageFrom: null, pageTo: null, quote: "Tea began." },
    ]);
  });
});

describe("Which text is tool-call text", () => {
  const SAMPLE = [
    "First [^1].",
    "",
    '<cite>\n[{"marker":1,"passage":"P5","quote":"A quote."}][^6]\n</cite>',
    "",
    "Last.",
  ].join("\n");

  // protects=a block alone on its lines goes with them, a block inside a sentence leaves the words around it, one cut off goes to the end, and the records come back as written; fails_when=blank lines pile up, words are lost, or a record is; no_claim=none beyond protects.
  test("a block goes with its lines, and its records come back", () => {
    expect(takeToolText(SAMPLE)).toEqual({
      text: "First [^1].\n\nLast.",
      records: [{ marker: 1, passage: "P5", quote: "A quote." }],
    });
    expect(takeToolText('So it is <invoke>{"name": "x"}</invoke> true.').text).toBe(
      "So it is true.",
    );
    expect(takeToolText('A.\n\n<cite>[{"marker": 1, "pas').text).toBe("A.");
    expect(takeToolText("先说一点[^1]。\n\n<cite>[]</cite>").text).toBe("先说一点[^1]。");
  });

  // protects=a block never closed goes with its JSON and keeps the words after it, or the rest of its paragraph when its JSON is cut off; fails_when=the words after it go; no_claim=none beyond protects.
  test("a block never closed keeps the words after it", () => {
    expect(
      takeToolText('A [^1]. <cite>[{"marker":1,"passage":"P1","quote":"q"}]\n\nMore words stay.'),
    ).toEqual({
      text: "A [^1].\n\nMore words stay.",
      records: [{ marker: 1, passage: "P1", quote: "q" }],
    });
    expect(takeToolText('A.\n\n<cite>[{"marker": 1, "pas\n\nMore words stay.').text).toBe(
      "A.\n\nMore words stay.",
    );
    expect(takeToolText('更多[^1]。<tool_call>{"name":"x"}\n- 要点').text).toBe(
      "更多[^1]。\n- 要点",
    );
  });

  // protects=two blocks side by side on a line leave the line and paragraph breaks after them; fails_when=the next line is joined to the sentence; no_claim=none beyond protects.
  test("blocks side by side keep the breaks after them", () => {
    expect(takeToolText('S.<cite>[{"a":1}]</cite><cite>[{"a":2}]</cite>\n- item').text).toBe(
      "S.\n- item",
    );
    expect(takeToolText('S.\n<cite>[{"a":1}]</cite>\n<cite>[{"a":2}]</cite>\n- item').text).toBe(
      "S.\n- item",
    );
    expect(takeToolText('S. <cite>[{"a":1}]</cite><cite>[{"a":2}]</cite>\n\nNext.').text).toBe(
      "S.\n\nNext.",
    );
  });

  // protects=only a tag of a Tool with JSON after it counts, and code or maths keeps its own; fails_when=prose with a tag, inline code, a double-backtick span or maths loses text; no_claim=none beyond protects.
  test("prose, code and maths keep their tags", () => {
    for (const kept of [
      "The <cite> element and <cite>Title</cite>.",
      'Write `<cite>[{"a":1}]</cite>` for it.',
      'Write ``<cite>[{"a":1}]</cite>`` for it.',
      'Maths $<cite>[{"a":1}]</cite>$ stays.',
      '```\n<cite>[{"a":1}]</cite>\n```',
    ]) {
      expect(takeToolText(kept).text).toBe(kept);
      expect(toolTextIn(kept)).toEqual([]);
    }
  });

  // protects=text is held back from a tag of a Tool that has JSON or nothing after it, or is still being typed, and not otherwise; fails_when=an Answer about an HTML tag stalls, or a block shows; no_claim=none beyond protects.
  test("held back from where a block starts or is typed", () => {
    expect(heldBackFrom("Hello <cite>")).toBe(6);
    expect(heldBackFrom('Hello <cite>[{"mar')).toBe(6);
    expect(heldBackFrom("Hello &lt;cite&gt;{&quot;a")).toBe(6);
    expect(heldBackFrom("Hello <ci")).toBe(6);
    expect(heldBackFrom("Hello &lt;ci")).toBe(6);
    expect(heldBackFrom("Hello <tool_c")).toBe(6);
    expect(heldBackFrom("Hello <cite>Title")).toBe("Hello <cite>Title".length);
    expect(heldBackFrom("a < b and <div")).toBe("a < b and <div".length);
    expect(heldBackFrom("Hello")).toBe(5);
    const fenced = '```\n<tool_call>{"name": "x"}</tool_call>\n```\nafter';
    expect(heldBackFrom(fenced)).toBe(fenced.length);
    expect(heldBackFrom('```\n<tool_call>{"name": "x"')).toBe(
      '```\n<tool_call>{"name": "x"'.length,
    );
  });
});

describe("An Answer with no Tools, or written as JSON", () => {
  const written = (events: AnswerEngineEvent[]) => {
    let shown = "";
    for (const event of events) {
      if (event.type === "text-delta") shown += event.text;
      else if (event.type === "text-retracted") shown = shown.slice(0, -event.length);
    }
    return shown;
  };

  async function generate(
    model: ReturnType<typeof scriptedModel>,
    support: "none" | "structured-output",
  ) {
    const events: AnswerEngineEvent[] = [];
    for await (const event of createAiSdkAnswerEngine().generate({
      instructions: () => "Answer.",
      messages: [{ role: "user", content: "Where?" }],
      question: "Where?",
      model,
      documents: recordingDocuments([]),
      tools: [],
      support,
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    return events;
  }

  // protects=the plain way and the JSON way of answering show no tool-call text either, once the reply is whole; fails_when=a block is left in the shown text; no_claim=none beyond protects.
  test("tool-call text is taken out of the shown text at the end", async () => {
    const block =
      '<tool_call>{"name": "search_documents", "arguments": {"query": "tea"}}</tool_call>';
    const plain = await generate(
      scriptedModel(() => ({ text: `Tea began in China.\n\n${block}` })),
      "none",
    );
    expect(written(plain)).toBe("Tea began in China.");

    const json = await generate(
      scriptedModel(() => ({
        text: JSON.stringify({ answer: `茶起源于中国。\n\n${block}`, citations: [] }),
      })),
      "structured-output",
    );
    expect(written(json)).toBe("茶起源于中国。");
  });
});
