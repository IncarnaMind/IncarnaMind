import { describe, expect, test } from "vitest";
import { helpAskedLines } from "../../src/core/answers/helpCitations";
import { citeUnmarked } from "../../src/core/answers/unmarkedQuotes";
import { scriptedModel } from "../helpers/models";

const OLDER_ROOFS = [
  "# Older roof types",
  "",
  "- Asbestos cement sheet roofs can take panels after an asbestos survey by a licensed contractor.",
  "- On those roofs, installers work from crawl boards and never stand on the sheets.",
].join("\n");
const SURVEY =
  "Asbestos cement sheet roofs can take panels after an asbestos survey by a licensed contractor.";
const FITTING = [
  "# 安装工期",
  "",
  "- 每台充电桩安装需要半天。",
  "- 储能电池安装需要两天。",
  "- 200 千瓦的屋顶光伏安装大约需要三周。",
].join("\n");
const BEFORE_SURVEY = [
  "# Before your survey",
  "",
  "- Send us the roof plans or the building's drawings.",
  "- Send us the last twelve months of electricity bills.",
  "- Send us a photo of the main switchboard.",
].join("\n");
const ROOF_PLANS = "Send us the roof plans or the building's drawings.";
const BILLS = "Send us the last twelve months of electricity bills.";

/**
 * Runs the path that asks once for an Answer's Citations, the model giving `given`, with
 * `recorded` the records the Answer has already, and for a typed reply (`typed`) its own rule:
 * what the Answer then holds, and what the request was asked about.
 */
async function asked(
  answer: string,
  passages: { id: string; text: string }[],
  given: { sentence: string; passage: string; quote: string }[],
  { typed = false, recorded = [] }: { typed?: boolean; recorded?: [number, string][] } = {},
) {
  const records = new Map<number, string>(recorded);
  const prompts: string[] = [];
  const model = scriptedModel((call) => {
    if (!call.json) return { text: "" };
    prompts.push(call.prompt);
    return { text: JSON.stringify({ citations: given }) };
  });
  const steps = citeUnmarked(
    {
      model,
      documents: {
        documentCount: passages.length,
        searchDocuments: async () => ({ text: "", passageCount: 0 }),
        shownPassages: () => passages,
        quoteFound: (passage, quote) =>
          passages.some(
            (each) => each.id === passage && each.text.includes(quote.replace(/[。.]$/u, "")),
          ),
        hasRecord: (marker) => records.has(marker),
        cite: (cited) => {
          for (const each of cited) records.set(each.marker, each.quote);
          return "";
        },
      },
      ...(typed && { askedLines: helpAskedLines }),
      signal: new AbortController().signal,
    },
    answer,
    undefined,
    null,
  );
  let next = await steps.next();
  while (!next.done) next = await steps.next();
  return { text: next.value, records, prompts };
}

// The two typed replies of #2925's second real-model round whose one request for Citations gave
// an answer and still ended uncited; the run didn't keep what the request gave.
describe("The one request for a typed reply's Citations, taken as it is today (#2925)", () => {
  // protects=an answer the one request gives for an option, in the forms a model copies an option's sentence (with its ★ and quotation marks, without them, with its → line), is taken onto that option; fails_when=one of them is dropped, so an option the model cited right stays uncited; no_claim=what a real model gives.
  test.each([
    ["the option's line as written", '★ "{plain}"'],
    ["its sentence in its quotation marks", '"{plain}"'],
    ["its sentence alone", "{plain}"],
    [
      "the option with its → line",
      '★ "{plain}"\n→ keeps the east side in the plan; adds survey time',
    ],
  ])("an option's Citation is taken whatever the request copies: %s", async (_form, copied) => {
    const plain =
      "Yes, we can put panels on the east roof, but only after a licensed asbestos survey and with crawl boards for the installers";
    const reply = `★ "${plain}"\n→ keeps the east side in the plan; adds survey time\n\n"Let's get an asbestos survey booked so we know the east roof's status before we commit"\n→ moves the decision forward without committing`;
    const { text, records } = await asked(
      reply,
      [{ id: "P2", text: OLDER_ROOFS }],
      [{ sentence: copied.replace("{plain}", plain), passage: "P2", quote: SURVEY }],
    );
    expect([...records.values()]).toEqual([SURVEY]);
    expect(text.split("\n")[0]).toMatch(/installers"\s*\[\^1\]$/);
  });

  // protects=a Chinese sentence of several clauses takes the answer the one request gives for it, whole or clause by clause; fails_when=a clause's Citation is dropped for not being the whole sentence; no_claim=what a real model gives.
  test("a Chinese line's Citations are taken whole or clause by clause", async () => {
    const line = "每台充电桩安装需要半天；储能电池安装需要两天；200 千瓦屋顶光伏安装大约需要三周。";
    const passages = [{ id: "P3", text: FITTING }];
    const whole = await asked(line, passages, [
      { sentence: line, passage: "P3", quote: "每台充电桩安装需要半天。" },
    ]);
    expect([...whole.records.values()]).toEqual(["每台充电桩安装需要半天。"]);
    expect(whole.text).toContain("[^1]");
    const clauses = await asked(line, passages, [
      { sentence: "每台充电桩安装需要半天", passage: "P3", quote: "每台充电桩安装需要半天。" },
      { sentence: "储能电池安装需要两天", passage: "P3", quote: "储能电池安装需要两天。" },
    ]);
    expect([...clauses.records.values()]).toEqual([
      "每台充电桩安装需要半天。",
      "储能电池安装需要两天。",
    ]);
    expect(clauses.text).toContain("[^1]");
    expect(clauses.text).toContain("[^2]");
  });

  // protects=an answer whose quote the check doesn't find on the Passage it names is never taken; fails_when=a quote that isn't there is cited; no_claim=why a real model's quote misses.
  test("a quote not on the Passage it names isn't taken", async () => {
    const { records, text } = await asked(
      "Yes, the roof can take panels after a survey.",
      [{ id: "P2", text: OLDER_ROOFS }],
      [
        {
          sentence: "Yes, the roof can take panels after a survey.",
          passage: "P2",
          quote: "The roof can take panels after a survey.",
        },
      ],
    );
    expect([...records.values()]).toEqual([]);
    expect(text).not.toContain("[^");
  });
});

describe("The lines of a typed reply the one request is asked about (#2925)", () => {
  const passages = [
    { id: "P2", text: OLDER_ROOFS },
    { id: "P3", text: BEFORE_SURVEY },
  ];
  const named = (text: string, recorded: number[] = []) =>
    helpAskedLines(text, passages, (marker) => recorded.includes(marker)).map((line) => [
      line.text,
      line.replaces ?? null,
    ]);

  // protects=a line of fact with no Citation is asked about, and an option of advice, a "→" line, a line that something wasn't found, and a line that has its own Citation aren't; fails_when=a fact line is left out, or a line with no fact or that says something isn't known is asked about; no_claim=what the request gives.
  test("a line of fact with no Citation, and not advice, its → line, a not-found line or a cited one", () => {
    expect(
      named(
        [
          "★ Asbestos cement roofs can take panels after a licensed survey",
          "→ keeps the east roof in the plan",
          "",
          "Let's talk about timing next week",
          "→ buys time",
          "",
          "The fire rating isn't in your Documents.",
          "",
          "Send us a photo of the main switchboard [^1]",
        ].join("\n"),
        [1],
      ),
    ).toEqual([["★ Asbestos cement roofs can take panels after a licensed survey", null]]);
  });

  // protects=list items that share one Citation are each asked about, carrying the Citation an answer for them replaces, while a Citation on one line alone is left; fails_when=a shared Citation's items aren't asked about, or a line citing its own is; no_claim=which items the request answers.
  test("list items sharing one Citation are each asked about; a Citation on one line isn't", () => {
    expect(
      named(
        [
          "Roof plans or the building's drawings [^1]",
          "",
          "The last twelve months of electricity bills [^1]",
          "",
          "A photo of the main switchboard [^2]",
        ].join("\n"),
        [1, 2],
      ),
    ).toEqual([
      ["Roof plans or the building's drawings [^1]", 1],
      ["The last twelve months of electricity bills [^1]", 1],
    ]);
  });

  // protects=across languages the rule reaches a line by a figure it shares with the Passages, and a line with none isn't reached (it stays as it is); fails_when=a line with a shared figure in the other language isn't asked about, or a figure-less one is; no_claim=what the request gives.
  test.each([
    {
      reply: "每台充电桩安装需要半天。\n\n储能电池安装需要 2 天，200 千瓦大约三周。",
      document:
        "# Fitting times\n\n- A van charger takes half a day to fit.\n- A 200 kWp rooftop array takes about three weeks.",
      reached: "储能电池安装需要 2 天，200 千瓦大约三周。",
      direction: "a Chinese reply over an English Document",
    },
    {
      reply: "A charger takes half a day to fit.\n\nA 200 kWp array takes about three weeks.",
      document: FITTING,
      reached: "A 200 kWp array takes about three weeks.",
      direction: "an English reply over a Chinese Document",
    },
  ])("$direction: only a line sharing a figure is reached", ({ reply, document, reached }) => {
    expect(
      helpAskedLines(reply, [{ text: document }], () => false).map((line) => line.text),
    ).toEqual([reached]);
  });
});

describe("A typed reply's one request for Citations, asked about its own lines (#2925)", () => {
  // protects=a list whose items share one Citation is asked about those items alone, and an item the request cites takes its own Citation while one it doesn't keeps the model's; fails_when=a line the rule didn't name is asked about or cited, or an item loses the Citation the model wrote without getting another; no_claim=what a real model gives.
  test("a list sharing one Citation: each item the request cites takes its own; one it doesn't keeps the model's", async () => {
    const reply = [
      "The documents list what to send:",
      "",
      "Roof plans or the building's drawings [^1]",
      "",
      "The last twelve months of electricity bills [^1]",
      "",
      "A photo of the main switchboard [^1]",
    ].join("\n");
    const { text, records, prompts } = await asked(
      reply,
      [{ id: "P3", text: BEFORE_SURVEY }],
      [
        {
          sentence: "The last twelve months of electricity bills",
          passage: "P3",
          quote: BILLS,
        },
        { sentence: "The documents list what to send:", passage: "P3", quote: ROOF_PLANS },
      ],
      { typed: true, recorded: [[1, ROOF_PLANS]] },
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("The last twelve months of electricity bills");
    expect(prompts[0]).not.toContain("The documents list what to send:");
    expect(text).toContain("Roof plans or the building's drawings [^1]");
    expect(text).toMatch(/The last twelve months of electricity bills \[\^2\]/);
    expect(text).toContain("A photo of the main switchboard [^1]");
    expect(text.split("\n")[0]).toBe("The documents list what to send:");
    expect(records.get(2)).toBe(BILLS);
  });

  // protects=a line that says something wasn't found never gets a Citation from the request, though the request gives one for it; fails_when=it does; no_claim=what the line says.
  test("a line saying something wasn't found never gets a Citation from it", async () => {
    // Worded too far from the Passage to be matched without asking.
    const fact = "Theirs can take panels once a licensed contractor checks the asbestos.";
    const reply = `The fire rating isn't in your Documents.\n\n${fact}`;
    const { text, prompts } = await asked(
      reply,
      [{ id: "P2", text: OLDER_ROOFS }],
      [
        { sentence: "The fire rating isn't in your Documents.", passage: "P2", quote: SURVEY },
        { sentence: fact, passage: "P2", quote: SURVEY },
      ],
      { typed: true },
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("fire rating");
    expect(text.split("\n")[0]).toBe("The fire rating isn't in your Documents.");
    expect(text).toMatch(/checks the asbestos\s*\[\^1\]\.?$/);
  });
});
