/**
 * Citation markers the model left out, placed by the engine (see
 * src/core/answers/markerPlacement.ts): the rules on their own, then through
 * the engine with scripted models, in the Tool loop and with structured output.
 */
import { describe, expect, test } from "vitest";
import {
  placeMissingMarkers,
  withFigureCitations,
  withMissingMarkers,
} from "../../src/core/answers/markerPlacement";
import {
  askAndFinish,
  citationsIn,
  citingModel,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import type { MindClient } from "../helpers/mindClient";
import { answerIn } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";

const SPRING = "Spring tides happen at new moon and at full moon.";
const NEAP = "Neap tides happen when the Moon is at its first or last quarter.";

const TIDES_MD = [
  "# Tides",
  "",
  "The Moon's gravity raises two tidal bulges on the Earth.",
  "",
  SPRING,
  "",
  NEAP,
].join("\n");

describe("Placing a missing marker", () => {
  test("after the sentence its quote matches, before the full stop", () => {
    const { text, placed } = placeMissingMarkers(
      "The Moon raises two bulges. Spring tides come at new and full moon. Neap tides are smaller.",
      [{ marker: 1, quote: SPRING }],
    );
    expect(text).toBe(
      "The Moon raises two bulges. Spring tides come at new and full moon[^1]. Neap tides are smaller.",
    );
    expect(placed).toEqual([{ marker: 1, at: "sentence" }]);
  });

  test("after the sentence the record names, when it names one", () => {
    const { text } = placeMissingMarkers(
      "Spring tides are the largest. Spring tides come at new and full moon.",
      [{ marker: 3, quote: SPRING, sentence: "Spring tides are the largest." }],
    );
    expect(text).toBe("Spring tides are the largest[^3]. Spring tides come at new and full moon.");
  });

  test("after the markers already there, in order, and never twice", () => {
    const { text, placed } = placeMissingMarkers(
      "Spring tides come at new and full moon [^1]. Neap tides come at the quarter moons.",
      [
        { marker: 1, quote: SPRING },
        { marker: 3, quote: "Spring tides happen at new moon and at full moon" },
        { marker: 2, quote: NEAP },
      ],
    );
    expect(text).toBe(
      "Spring tides come at new and full moon [^1][^3]. Neap tides come at the quarter moons[^2].",
    );
    expect(placed.map((each) => each.marker)).toEqual([2, 3]);
  });

  test("in Chinese, by the characters it shares, before the 。", () => {
    const { text } = placeMissingMarkers("月球引起两次潮汐。大潮出现在新月和满月时。小潮较弱。", [
      { marker: 1, quote: "大潮发生在新月和满月的时候" },
    ]);
    expect(text).toBe("月球引起两次潮汐。大潮出现在新月和满月时[^1]。小潮较弱。");
  });

  test("with no sentence close enough, at the end of the paragraph that shares the most words", () => {
    const { text, placed } = placeMissingMarkers(
      "The Moon matters.\n\nCoasts differ. Every place is unique.\n\nThat is all.",
      [{ marker: 1, quote: "Most coasts therefore see two high tides every day." }],
    );
    // Each sentence of the second paragraph shares one word with the quote: together, the most.
    expect(placed).toEqual([{ marker: 1, at: "paragraph" }]);
    expect(text).toBe(
      "The Moon matters.\n\nCoasts differ. Every place is unique[^1].\n\nThat is all.",
    );
  });

  test("an Answer in another language than the Passage: next to the nearest marker the model wrote", () => {
    const { text, placed } = placeMissingMarkers(
      "潮汐每天两次[^1]。\n\n大潮在新月和满月时最强[^3]。",
      [{ marker: 2, quote: "Spring tides happen at new moon and at full moon." }],
    );
    expect(placed).toEqual([{ marker: 2, at: "paragraph" }]);
    expect(text).toBe("潮汐每天两次[^1][^2]。\n\n大潮在新月和满月时最强[^3]。");
  });

  test("with nothing to go by, by the record's place among the records", () => {
    const { text } = placeMissingMarkers("第一段。\n\n第二段。", [
      { marker: 1, quote: "Alpha." },
      { marker: 2, quote: "Beta." },
    ]);
    expect(text).toBe("第一段[^1]。\n\n第二段[^2]。");
  });

  test("never into code, headings, math or footnote definitions", () => {
    const answer = [
      "## Spring tides at new and full moon",
      "",
      "```",
      "spring tides happen at new moon and at full moon",
      "```",
      "",
      "$$",
      "spring + tides",
      "$$",
      "",
      "They come twice a month.",
      "[^9]: Spring tides happen at new moon and at full moon.",
    ].join("\n");
    const { text } = placeMissingMarkers(answer, [{ marker: 1, quote: SPRING }]);
    expect(text).toBe(answer.replace("twice a month.", "twice a month[^1]."));
  });

  test("only for records the core took: a marker without a valid record would be removed again", () => {
    const answer = "Spring tides come at new and full moon.";
    expect(withMissingMarkers(answer, [{ marker: 1, quote: SPRING }], () => false).text).toBe(
      answer,
    );
    expect(withMissingMarkers(answer, [{ marker: 1, quote: SPRING }], () => true).text).toBe(
      "Spring tides come at new and full moon[^1].",
    );
  });

  test("not for a record with an empty quote: nothing says where it goes", () => {
    const answer = "Spring tides come at new and full moon.";
    for (const quote of [" ", "…", '"..."', "“”"]) {
      expect(withMissingMarkers(answer, [{ marker: 1, quote }], () => true)).toEqual({
        text: answer,
        placed: [],
      });
    }
  });
});

describe("A figure's Citations, where it has none (#1831)", () => {
  const citations = (figure: number) => (figure === 2 ? [] : [figure + 4]);
  const million = { value: 310e6, shown: "£310 million", show: { language: "en" as const } };
  const figureOf = (figure: number) =>
    figure === 4
      ? { ...million, show: { ...million.show, as: null, decimals: null, scale: "million" } }
      : null;
  const cite = (text: string, of = citations) => withFigureCitations(text, of, figureOf);

  // protects=a figure's Citations go right after it, in English and Chinese, a cell's at its end, and never where a Citation already is; fails_when=net debt's marker lands on the EBITDA number, or a figure already cited gets a second one; no_claim=which quotes a figure has, which calculate keeps.
  test("go right after each figure, and nowhere a Citation already is", () => {
    expect(cite("Net debt was [=1] at Q3. EBITDA was [=3].")).toBe(
      "Net debt was [=1][^5] at Q3. EBITDA was [=3][^7].",
    );
    expect(cite("Net debt was [=1], against EBITDA of £95 million.")).toBe(
      "Net debt was [=1][^5], against EBITDA of £95 million.",
    );
    expect(cite("净负债为[=1]；调整后EBITDA为[=3]。")).toBe(
      "净负债为[=1][^5]；调整后EBITDA为[=3][^7]。",
    );
    expect(cite("[=1]")).toBe("[=1][^5]");
    const table = "| Metric | Q3 |\n|---|---|\n| Net debt | [=1] (draft) |\n| EBITDA | [=3] [^2] |";
    expect(cite(table)).toBe(
      "| Metric | Q3 |\n|---|---|\n| Net debt | [=1] (draft)[^5] |\n| EBITDA | [=3] [^2] |",
    );
    expect(cite("Net debt was [=1] at Q3[^1].")).toBe("Net debt was [=1] at Q3[^1].");
    expect(cite("Net debt was [=1]. [^1]")).toBe("Net debt was [=1]. [^1]");
    expect(cite("净负债为[=1]。 [^1]")).toBe("净负债为[=1]。 [^1]");
    expect(cite("A margin of [=2].")).toBe("A margin of [=2].");
    expect(cite("```\n[=1]\n```")).toBe("```\n[=1]\n```");
    expect(cite("Net debt was [=1], and `[=1]` is how it is written.")).toBe(
      "Net debt was [=1][^5], and `[=1]` is how it is written.",
    );
  });

  // protects=a scale written after a figure's marker is the figure's, so its Citation goes after the scale; one shared by two figures goes after the last; fails_when="[=4][^8] million" splits the figure from its scale, or a shared marker is written twice; no_claim=none beyond protects.
  test("go past the scale written after a figure, and once for figures that share them", () => {
    expect(cite("Net debt was [=4] million at Q3.")).toBe("Net debt was [=4] million[^8] at Q3.");
    expect(cite("Net debt [=1] and EBITDA [=3] at Q3.", () => [5])).toBe(
      "Net debt [=1] and EBITDA [=3][^5] at Q3.",
    );
  });
});

describe("The engine places the markers a model left out", { timeout: 30_000 }, () => {
  test("in the Tool loop: records given with cite, an Answer written without their markers", async () => {
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [
        { marker: 1, passage: passages[0]?.id ?? "P1", quote: SPRING },
        { marker: 2, passage: passages[0]?.id ?? "P1", quote: NEAP },
      ],
      answer: "Spring tides come at new and full moon. Neap tides come at the quarter moons.",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.md", contents: TIDES_MD },
    ]);

    const { answerId, finished } = await askAndFinish(
      core,
      client,
      mind.id,
      "Tell me about tides.",
    );

    expect(citationsIn(client, answerId).map((citation) => citation.quote)).toEqual([SPRING, NEAP]);
    expect(finished).toMatchObject({ placedMarkers: 2, droppedRecords: 0, droppedMarkers: 0 });
    expect(withCitationsShown(client, answerId)).toBe(
      "Spring tides come at new and full moon[c]. Neap tides come at the quarter moons[c].",
    );
  });

  test("with structured output: the JSON's records, an answer without their markers", async () => {
    const model = scriptedModel((call) => {
      if (call.tools.length > 0)
        return { error: { status: 400, message: "tiny does not support tools" } };
      const passage = shownPassages(call.system)[0];
      return {
        text: JSON.stringify({
          answer: "Spring tides come at new and full moon. The Moon raises two bulges.",
          citations: [{ marker: 1, passage: passage?.id ?? "P1", quote: SPRING }],
        }),
      };
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.md", contents: TIDES_MD },
    ]);

    const { answerId, finished } = await askAndFinish(
      core,
      client,
      mind.id,
      "When are spring tides?",
    );

    expect(finished).toMatchObject({ citationSupport: "structured-output", placedMarkers: 1 });
    const [citation] = citationsIn(client, answerId);
    expect(citation).toMatchObject({ quote: SPRING, check: "found" });
    // After the sentence it supports, not the last one.
    expect(withCitationsShown(client, answerId)).toBe(
      "Spring tides come at new and full moon[c]. The Moon raises two bulges.",
    );
  });
});

/** An Answer's text with each Citation shown as "[c]". */
function withCitationsShown(client: MindClient, answerId: string): string {
  const answer = answerIn(client, answerId);
  return answer.textBetween(0, answer.content.size, "\n", (leaf) =>
    leaf.type.name === "citation" ? "[c]" : "",
  );
}
