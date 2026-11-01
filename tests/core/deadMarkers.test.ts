import { describe, expect, test } from "vitest";
import { withoutDeadMarkers } from "../../src/core/answers/citations";
import { answerBlocks, markersWithoutCitation } from "../../src/shared/answerBlocks";
import { askAssistant } from "../helpers/assistant";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const FIRST =
  "Tea drinking began in southwest China, where it was first used as a medicinal drink.";
const SECOND = "Traders carried tea along the Tea Horse Road to Tibet.";
const TEA = { name: "Tea history.md", contents: `# Tea history\n\n${FIRST}\n\n${SECOND}\n` };

const ENGLISH = {
  question: "Where was tea first drunk?",
  answer:
    "Tea was first drunk in southwest China [^1]. Traders took it along the Tea Horse Road to Tibet [^2].",
  sentences: [
    "Tea was first drunk in southwest China.",
    "Traders took it along the Tea Horse Road to Tibet [^2].",
  ],
  phrase: "southwest China",
};
const CHINESE = {
  question: "茶最早是在哪里喝的？",
  answer: "茶最早在中国西南地区被当作药饮[^1]。商人沿着茶马古道把茶叶运到了西藏[^2]。",
  sentences: ["茶最早在中国西南地区被当作药饮。", "商人沿着茶马古道把茶叶运到了西藏[^2]。"],
  phrase: "西南地区",
};

const passageIds = (call: ModelCall) =>
  [...JSON.stringify(call.options.prompt).matchAll(/<passage id=\\"(P\d+)/g)].map((m) => m[1]);

/**
 * A model that searches once, then answers with markers and never calls
 * `cite`; `asked` is how it replies to the one request for Citations.
 */
function markingModel(answer: string, asked: (call: ModelCall) => ScriptedReply) {
  return scriptedModel(
    (call) => {
      if (call.json) return asked(call);
      if (!call.results.some((result) => result.tool === "search_documents")) {
        return { calls: [{ tool: "search_documents", input: { query: "tea" } }] };
      }
      return { text: answer };
    },
    { judgesItsAnswers: true },
  );
}

describe("A Citation marker never shows without a Citation behind it", { timeout: 30_000 }, () => {
  // protects=an Answer that writes markers and never calls cite is asked once for its Citations, in English and in Chinese over an English Document, and each Citation takes the marker its sentence has; fails_when=the model isn't asked, is asked twice, or the Answer keeps a marker no Citation backs; no_claim=what a real model replies.
  test.each([
    ["English", ENGLISH],
    ["Chinese", CHINESE],
  ])("%s: the Citations asked for take the markers the Answer has", async (_language, each) => {
    let requests = 0;
    const model = markingModel(each.answer, (call) => {
      requests++;
      const [id] = passageIds(call);
      return {
        text: JSON.stringify({
          citations: [
            { sentence: each.sentences[0], passage: id, quote: FIRST },
            { sentence: each.sentences[1], passage: id, quote: SECOND },
          ],
        }),
      };
    });
    const { core } = await setUpWithDocuments(model, [TEA]);

    const answer = await askAssistant(core, { text: each.question });

    expect(requests).toBe(1);
    expect(answer.text).toBe(each.answer);
    expect(answer.citations.map(({ marker, quote, check }) => [marker, quote, check])).toEqual([
      [1, FIRST, "found"],
      [2, SECOND, "found"],
    ]);
    expect(markersWithoutCitation(answer)).toEqual([]);
  });

  // protects=an Answer that cites one marker and writes another with no record is asked once, and the Citation it gives takes that marker, the first one staying as it was; fails_when=the stray marker is left or the model isn't asked; no_claim=none beyond protects.
  test("a marker with no record beside one that has it is asked about once", async () => {
    let requests = 0;
    const model = scriptedModel(
      (call) => {
        if (call.json) {
          requests++;
          const [id] = passageIds(call);
          return {
            text: JSON.stringify({
              citations: [{ sentence: ENGLISH.sentences[1], passage: id, quote: SECOND }],
            }),
          };
        }
        const search = call.results.find((result) => result.tool === "search_documents");
        if (!search) return { calls: [{ tool: "search_documents", input: { query: "tea" } }] };
        if (!call.results.some((result) => result.tool === "cite")) {
          const [passage] = shownPassages(search.text);
          const record = { marker: 1, passage: passage?.id, quote: FIRST };
          return { calls: [{ tool: "cite", input: { citations: [record] } }] };
        }
        return { text: ENGLISH.answer };
      },
      { judgesItsAnswers: true },
    );
    const { core } = await setUpWithDocuments(model, [TEA]);

    const answer = await askAssistant(core, { text: ENGLISH.question });

    expect(requests).toBe(1);
    expect(answer.text).toBe(ENGLISH.answer);
    expect(answer.citations.map(({ marker, quote }) => [marker, quote])).toEqual([
      [1, FIRST],
      [2, SECOND],
    ]);
    expect(markersWithoutCitation(answer)).toEqual([]);
  });

  // protects=a sentence the Answer quotes is cited without a request, and another sentence still holding a marker with no record gets the one request, the Citation taking its marker and the first kept as it was; fails_when=the stray marker is left, the model isn't asked, or a second Citation lands on the quoted sentence; no_claim=none beyond protects.
  test("a marker left over after the quoted sentence is cited is asked about once", async () => {
    const quote = SECOND.replace(/\.$/, "");
    const quoted = `As the notes put it, "${quote}" [^1]. People first used it as a medicine in the south-west [^2].`;
    let requests = 0;
    const model = markingModel(quoted, (call) => {
      requests++;
      const [id] = passageIds(call);
      return {
        text: JSON.stringify({
          citations: [
            { sentence: `As the notes put it, "${quote}".`, passage: id, quote: SECOND },
            {
              sentence: "People first used it as a medicine in the south-west.",
              passage: id,
              quote: FIRST,
            },
          ],
        }),
      };
    });
    const { core } = await setUpWithDocuments(model, [TEA]);

    const answer = await askAssistant(core, { text: ENGLISH.question });

    expect(requests).toBe(1);
    expect(answer.text).toBe(quoted);
    expect(answer.citations.map(({ marker, quote }) => [marker, quote])).toEqual([
      [1, quote],
      [2, FIRST],
    ]);
    expect(markersWithoutCitation(answer)).toEqual([]);
  });

  // protects=markers in a table's cells are asked about once like any others, and each Citation takes the marker of the cell it names, in English and Chinese over an English Document; fails_when=the model isn't asked, a Citation lands outside the table, or a marker is left; no_claim=none beyond protects.
  test.each([
    [
      "English",
      ENGLISH.question,
      ["Tea began in southwest China [^1]", "Traders took it to Tibet [^2]"],
      "Source",
    ],
    [
      "Chinese",
      CHINESE.question,
      ["茶最早在中国西南地区被当作药饮[^1]", "商人把茶叶运到了西藏[^2]"],
      "来源",
    ],
  ])(
    "%s: the markers in a table's cells are asked about once",
    async (_language, question, cells, head) => {
      const table = [
        `| Claim | ${head} |`,
        "|:--|:--|",
        ...cells.map((cell) => `| ${cell} | Tea history |`),
      ].join("\n");
      let requests = 0;
      const model = markingModel(table, (call) => {
        requests++;
        const [id] = passageIds(call);
        return {
          text: JSON.stringify({
            citations: [
              { sentence: cells[0], passage: id, quote: FIRST },
              { sentence: cells[1], passage: id, quote: SECOND },
            ],
          }),
        };
      });
      const { core } = await setUpWithDocuments(model, [TEA]);

      const answer = await askAssistant(core, { text: question });

      expect(requests).toBe(1);
      expect(answer.text).toBe(table);
      expect(answer.citations.map(({ marker, quote }) => [marker, quote])).toEqual([
        [1, FIRST],
        [2, SECOND],
      ]);
    },
  );

  // protects=when the model gives no Citation for what it wrote, the Answer shows no marker and keeps its sentences, after one request and no more; fails_when=a marker shows, a sentence goes, or the model is asked again; no_claim=how the check treats the uncited sentences (tests/core/claims.test.ts).
  test.each([
    ["English", ENGLISH],
    ["Chinese", CHINESE],
  ])("%s: with none given, the sentences stay without a marker", async (_language, each) => {
    let requests = 0;
    const model = markingModel(each.answer, () => {
      requests++;
      return { text: JSON.stringify({ citations: [] }) };
    });
    const { core } = await setUpWithDocuments(model, [TEA]);

    const answer = await askAssistant(core, { text: each.question });

    expect(requests).toBe(1);
    expect(answer.citations).toEqual([]);
    expect(answer.text).not.toContain("[^");
    expect(answer.text).toContain(each.phrase);
    const shown = JSON.stringify(answerBlocks({ ...answer, status: "done" }));
    expect(shown).not.toContain("[^");
    expect(shown).toContain(each.phrase);
  });

  // protects=a provider that refuses the one request leaves the Answer finished, as written, with no marker shown and no second request; fails_when=the Answer fails, a marker shows, or the model is asked again; no_claim=how the provider's refusal is worded.
  test("a refused request leaves the Answer finished, without its markers", async () => {
    let requests = 0;
    const model = markingModel(CHINESE.answer, () => {
      requests++;
      return { error: { status: 500, message: "The provider is down." } };
    });
    const { core } = await setUpWithDocuments(model, [TEA]);

    const answer = await askAssistant(core, { text: CHINESE.question });

    expect(requests).toBe(1);
    expect(answer.status).toBe("done");
    expect(answer.citations).toEqual([]);
    expect(answer.text).not.toContain("[^");
    expect(JSON.stringify(answerBlocks({ ...answer, status: "done" }))).not.toContain("[^");
  });
});

describe("The text without markers nothing backs", () => {
  // protects=a marker no Citation backs goes with the space before it unless a word follows, in English and Chinese, while a backed marker, a marker in code and a footnote definition stay; fails_when=a backed marker goes, code changes, or a definition loses its marker; no_claim=none beyond protects.
  test("goes with its space, and code, footnote definitions and backed markers stay", () => {
    const backed = (marker: number) => marker === 1;
    expect(withoutDeadMarkers("A claim [^2]. Another [^1][^3], then more.", backed)).toBe(
      "A claim. Another [^1], then more.",
    );
    expect(withoutDeadMarkers("先说一点[^2]。再说一点[^1][^3]。", backed)).toBe(
      "先说一点。再说一点[^1]。",
    );
    expect(withoutDeadMarkers("See [^2]word and a [^3] sign.", backed)).toBe(
      "See word and a sign.",
    );
    const kept = ["Write `[^2]` for it.", "```", "[^2]", "```", "", "[^2]: Source, p. 1"].join(
      "\n",
    );
    expect(withoutDeadMarkers(kept, backed)).toBe(kept);
    for (const written of [
      "Write ``a [^2] b`` for it.",
      "The sum $x[^2] + y$ stays.",
      "$$\nx[^2]\n$$",
    ]) {
      expect(withoutDeadMarkers(written, backed)).toBe(written);
    }
    expect(withoutDeadMarkers("| A [^2] | B [^1] |\n|:--|:--|\n| C [^3] | D |", backed)).toBe(
      "| A | B [^1] |\n|:--|:--|\n| C | D |",
    );
  });
});
