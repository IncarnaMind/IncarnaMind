/**
 * An Answer written beside `cite` is not written twice (#466): the Tool loop
 * ends when the records are all taken, and keeps one copy when they weren't.
 */
import { describe, expect, test } from "vitest";
import { askAndFinish, citationsIn, setUpWithDocuments, shownPassages } from "../helpers/citations";
import type { MindClient } from "../helpers/mindClient";
import { answerIn } from "../helpers/minds";
import {
  type GenerateCall,
  type GeneratedReply,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  unscripted,
} from "../helpers/models";

const SPRING = "Spring tides happen at new moon and at full moon.";
const NEAP = "Neap tides happen at the quarter moons.";
const WRONG = "Spring tides happen only at the new moon.";
const ANSWER = "Spring tides come at new and full moon[^1].";

const TIDES_MD = ["# Tides", "", SPRING, "", NEAP].join("\n");

/** A model the list beside the catalog names as writing first (#489). */
const WRITES_THEN_CITES = { answerPaths: { writesThenCites: () => true } };

/** The one small call that decides whether each part is the Answer's or the model's working (#2371). */
const judging =
  (...parts: ("answer" | "working")[]) =>
  (call: GenerateCall): GeneratedReply =>
    call.question === "working-text"
      ? { text: JSON.stringify({ parts }) }
      : unscripted(call.question, call.system);

/** A model that searches, then writes its Answer and calls `cite` in one turn, as Claude Haiku 5.5 does. */
function writesBesideCite(quotes: string[]) {
  return scriptedModel((call: ModelCall): ScriptedReply => {
    const searched = call.results.find((result) => result.tool === "search_documents");
    if (!searched) {
      return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
    }
    const passage = shownPassages(searched.text)[0]?.id ?? "P1";
    const cites = call.results.filter((result) => result.tool === "cite").length;
    const quote = quotes[Math.min(cites, quotes.length - 1)] as string;
    // The turn after the first `cite` has nothing more to say: the model is asked only if the loop goes on.
    if (cites >= quotes.length) return { text: ANSWER };
    return {
      text: ANSWER,
      calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote }] } }],
    };
  });
}

/** The Answer's text with each Citation shown as "[c]". */
const shown = (client: MindClient, answerId: string) => {
  const answer = answerIn(client, answerId);
  return answer.textBetween(0, answer.content.size, "\n", (leaf) =>
    leaf.type.name === "citation" ? "[c]" : "",
  );
};

describe("An Answer written in the turn that calls cite", { timeout: 30_000 }, () => {
  test("every record taken: the model isn't called again, and the Answer is there once", async () => {
    const model = writesBesideCite([SPRING]);
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.md", contents: TIDES_MD },
    ]);

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    // The search, then the turn with the Answer and `cite`.
    expect(model.doStreamCalls).toHaveLength(2);
    expect(citationsIn(client, answerId).map((citation) => citation.quote)).toEqual([SPRING]);
    expect(shown(client, answerId)).toBe("Spring tides come at new and full moon[c].");
  });

  test("a record to fix: the model fixes it and the Answer stays one copy, with the fixed Citation", async () => {
    const model = writesBesideCite([WRONG, SPRING]);
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.md", contents: TIDES_MD },
    ]);

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    // The search, the first turn, and the turn that fixes the record and writes the Answer again.
    expect(model.doStreamCalls).toHaveLength(3);
    expect(citationsIn(client, answerId).map((citation) => citation.quote)).toEqual([SPRING]);
    expect(shown(client, answerId)).toBe("Spring tides come at new and full moon[c].");
  });

  test("a record to fix in a cite call of its own: the loop ends once it is taken", async () => {
    const model = scriptedModel((call: ModelCall): ScriptedReply => {
      const searched = call.results.find((result) => result.tool === "search_documents");
      if (!searched) {
        return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
      }
      const passage = shownPassages(searched.text)[0]?.id ?? "P1";
      const cites = call.results.filter((result) => result.tool === "cite").length;
      if (cites >= 2) return { text: ANSWER };
      const record = { marker: 1, passage, quote: cites === 0 ? WRONG : SPRING };
      return {
        ...(cites === 0 && { text: ANSWER }),
        calls: [{ tool: "cite", input: { citations: [record] } }],
      };
    });
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [{ name: "Tides.md", contents: TIDES_MD }],
      WRITES_THEN_CITES,
    );

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    // The search, the Answer with its records, and the fix: no call after the fix is taken.
    expect(model.doStreamCalls).toHaveLength(3);
    expect(citationsIn(client, answerId).map((citation) => citation.quote)).toEqual([SPRING]);
    expect(shown(client, answerId)).toBe("Spring tides come at new and full moon[c].");
  });

  test("a model that cites before any text is told none of its reply has shown yet", async () => {
    const replies: string[] = [];
    const model = scriptedModel((call: ModelCall): ScriptedReply => {
      const searched = call.results.find((result) => result.tool === "search_documents");
      if (!searched) {
        return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
      }
      const cited = call.results.find((result) => result.tool === "cite");
      if (cited) {
        replies.push(cited.text);
        return { text: ANSWER };
      }
      const passage = shownPassages(searched.text)[0]?.id ?? "P1";
      return {
        reasoning: ANSWER,
        calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote: SPRING }] } }],
      };
    });
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [{ name: "Tides.md", contents: TIDES_MD }],
      WRITES_THEN_CITES,
    );

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(replies).toEqual([expect.stringContaining("Your reply has shown no text yet")]);
    expect(shown(client, answerId)).toBe("Spring tides come at new and full moon[c].");
  });

  test("a model that still cites first, then writes: the Answer is there once", async () => {
    const model = scriptedModel((call: ModelCall): ScriptedReply => {
      const searched = call.results.find((result) => result.tool === "search_documents");
      if (!searched) {
        return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
      }
      if (call.results.some((result) => result.tool === "cite")) return { text: ANSWER };
      const passage = shownPassages(searched.text)[0]?.id ?? "P1";
      return {
        calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote: SPRING }] } }],
      };
    });
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [{ name: "Tides.md", contents: TIDES_MD }],
      WRITES_THEN_CITES,
    );

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(model.doStreamCalls).toHaveLength(3);
    expect(citationsIn(client, answerId).map((citation) => citation.quote)).toEqual([SPRING]);
    expect(shown(client, answerId)).toBe("Spring tides come at new and full moon[c].");
  });

  // protects=an Answer shows neither the text before its search nor the text beside cite with no marker in it, only the Answer after them; fails_when=a preamble shows in the Answer; no_claim=none beyond protects.
  test("text before the search and beside cite with no marker in it isn't shown", async () => {
    const model = scriptedModel((call: ModelCall): ScriptedReply => {
      const searched = call.results.find((result) => result.tool === "search_documents");
      if (!searched) {
        return {
          text: "Let me look that up.",
          calls: [{ tool: "search_documents", input: { query: "spring tides" } }],
        };
      }
      if (call.results.some((result) => result.tool === "cite")) return { text: ANSWER };
      const passage = shownPassages(searched.text)[0]?.id ?? "P1";
      return {
        text: "I'll note where that comes from.",
        calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote: SPRING }] } }],
      };
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.md", contents: TIDES_MD },
    ]);

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(citationsIn(client, answerId).map((citation) => citation.quote)).toEqual([SPRING]);
    expect(shown(client, answerId)).toBe("Spring tides come at new and full moon[c].");
  });

  // protects=the model's working remark after the Answer, before cite, stays out of the Answer, while the Answer's own prose written before cite is kept; fails_when=the remark shows, or the Answer's first paragraph is dropped; no_claim=none beyond protects.
  test("a remark written after the Answer, before cite, isn't shown; the Answer's prose is", async () => {
    const model = scriptedModel(
      (call: ModelCall): ScriptedReply => {
        const searched = call.results.find((result) => result.tool === "search_documents");
        if (!searched) {
          return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
        }
        const passage = shownPassages(searched.text)[0]?.id ?? "P1";
        return {
          text: `Tides are driven by the Moon.\n\n${ANSWER}\n\nCitations need to be recorded now.`,
          calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote: SPRING }] } }],
        };
      },
      { generate: judging("answer", "working") },
    );
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [{ name: "Tides.md", contents: TIDES_MD }],
      WRITES_THEN_CITES,
    );

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(citationsIn(client, answerId).map((citation) => citation.quote)).toEqual([SPRING]);
    expect(shown(client, answerId)).toBe(
      "Tides are driven by the Moon.\nSpring tides come at new and full moon[c].",
    );
  });

  // protects=an uncited caveat written after the Answer, before cite, stays: the judge decides it is the Answer's, not the model's working; fails_when=the caveat is dropped; no_claim=none beyond protects.
  test("a caveat written after the Answer, before cite, is shown when it is the Answer's", async () => {
    const model = scriptedModel(
      (call: ModelCall): ScriptedReply => {
        const searched = call.results.find((result) => result.tool === "search_documents");
        if (!searched) {
          return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
        }
        const passage = shownPassages(searched.text)[0]?.id ?? "P1";
        return {
          text: `${ANSWER}\n\nThe tide table doesn't say how high the water rises.`,
          calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote: SPRING }] } }],
        };
      },
      { generate: judging("answer") },
    );
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [{ name: "Tides.md", contents: TIDES_MD }],
      WRITES_THEN_CITES,
    );

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(shown(client, answerId)).toBe(
      "Spring tides come at new and full moon[c].\nThe tide table doesn't say how high the water rises.",
    );
  });

  // protects=a working remark between two cited paragraphs is judged where it sits and taken back, while both cited paragraphs stay; fails_when=the remark shows, or a marked paragraph is dropped; no_claim=none beyond protects.
  test("a remark between two cited paragraphs isn't shown; both paragraphs are", async () => {
    const model = scriptedModel(
      (call: ModelCall): ScriptedReply => {
        const searched = call.results.find((result) => result.tool === "search_documents");
        if (!searched) {
          return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
        }
        const passage = shownPassages(searched.text)[0]?.id ?? "P1";
        return {
          text: `${ANSWER}\n\nCitations need to be recorded now.\n\nNeap tides happen at the quarter moons [^2].`,
          calls: [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage, quote: SPRING },
                  { marker: 2, passage, quote: NEAP },
                ],
              },
            },
          ],
        };
      },
      { generate: judging("working", "answer") },
    );
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [{ name: "Tides.md", contents: TIDES_MD }],
      WRITES_THEN_CITES,
    );

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(shown(client, answerId)).toBe(
      "Spring tides come at new and full moon[c].\nNeap tides happen at the quarter moons [c].",
    );
  });

  // protects=a working remark on the Answer's last line, after a single newline, is taken back and the Answer's line stays; fails_when=the remark shows or the Answer's line goes; no_claim=none beyond protects.
  test("a remark on a new line of the Answer's last paragraph isn't shown", async () => {
    const model = scriptedModel(
      (call: ModelCall): ScriptedReply => {
        const searched = call.results.find((result) => result.tool === "search_documents");
        if (!searched) {
          return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
        }
        const passage = shownPassages(searched.text)[0]?.id ?? "P1";
        return {
          text: `${ANSWER}\nCitations need to be recorded now.`,
          calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote: SPRING }] } }],
        };
      },
      { generate: judging("working") },
    );
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [{ name: "Tides.md", contents: TIDES_MD }],
      WRITES_THEN_CITES,
    );

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(shown(client, answerId)).toBe("Spring tides come at new and full moon[c].");
  });

  // protects=a working remark that carries a marker of its own is judged too, not kept because of the marker; fails_when=the remark stays; no_claim=none beyond protects.
  test("a remark carrying a marker, written after the Answer, isn't shown", async () => {
    const model = scriptedModel(
      (call: ModelCall): ScriptedReply => {
        const searched = call.results.find((result) => result.tool === "search_documents");
        if (!searched) {
          return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
        }
        const passage = shownPassages(searched.text)[0]?.id ?? "P1";
        return {
          text: `${ANSWER}\n\nCitations need to be recorded now [^2].`,
          calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote: SPRING }] } }],
        };
      },
      { generate: judging("working") },
    );
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [{ name: "Tides.md", contents: TIDES_MD }],
      WRITES_THEN_CITES,
    );

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(shown(client, answerId)).toBe("Spring tides come at new and full moon[c].");
  });

  // protects=a remedy holding both a working remark and a caveat is judged part by part: the remark goes, the caveat stays; fails_when=the remark shows or the caveat is dropped; no_claim=none beyond protects.
  test("a remark and a caveat in one trailing span are decided apart", async () => {
    const model = scriptedModel(
      (call: ModelCall): ScriptedReply => {
        const searched = call.results.find((result) => result.tool === "search_documents");
        if (!searched) {
          return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
        }
        const passage = shownPassages(searched.text)[0]?.id ?? "P1";
        return {
          text: `${ANSWER}\n\nCitations need to be recorded now.\n\nThe tide table doesn't say how high the water rises.`,
          calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote: SPRING }] } }],
        };
      },
      { generate: judging("working", "answer") },
    );
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [{ name: "Tides.md", contents: TIDES_MD }],
      WRITES_THEN_CITES,
    );

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(shown(client, answerId)).toBe(
      "Spring tides come at new and full moon[c].\nThe tide table doesn't say how high the water rises.",
    );
  });

  // protects=a judgement that fails keeps every part, so no Answer text is lost; fails_when=any text is dropped on a failure; no_claim=none beyond protects.
  test("a judgement that fails keeps the text", async () => {
    const model = scriptedModel(
      (call: ModelCall): ScriptedReply => {
        const searched = call.results.find((result) => result.tool === "search_documents");
        if (!searched) {
          return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
        }
        const passage = shownPassages(searched.text)[0]?.id ?? "P1";
        return {
          text: `${ANSWER}\n\nCitations need to be recorded now.`,
          calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote: SPRING }] } }],
        };
      },
      { generate: () => ({ text: "not a verdict" }) },
    );
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [{ name: "Tides.md", contents: TIDES_MD }],
      WRITES_THEN_CITES,
    );

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(shown(client, answerId)).toBe(
      "Spring tides come at new and full moon[c].\nCitations need to be recorded now.",
    );
  });

  // protects=a <cite> block written as text beside a cite call keeps its records: the judgement never sees Tool-call text; fails_when=the block is judged away and its Citation lost; no_claim=none beyond protects.
  test("a cite block written as text keeps its records, unjudged", async () => {
    const model = scriptedModel(
      (call: ModelCall): ScriptedReply => {
        const searched = call.results.find((result) => result.tool === "search_documents");
        if (!searched) {
          return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
        }
        const passage = shownPassages(searched.text)[0]?.id ?? "P1";
        return {
          text: `${ANSWER}\n\n${NEAP} [^2].\n\n<cite>${JSON.stringify([
            { marker: 2, passage, quote: NEAP },
          ])}</cite>`,
          calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote: SPRING }] } }],
        };
      },
      { generate: judging("working") },
    );
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [{ name: "Tides.md", contents: TIDES_MD }],
      WRITES_THEN_CITES,
    );

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    // The block's record is kept; a marker-less record may also be listed on its own.
    const got = new Set(citationsIn(client, answerId).map((citation) => citation.quote));
    expect(got).toEqual(new Set([SPRING, NEAP]));
  });
});
