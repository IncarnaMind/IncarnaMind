import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import { askAssistant, changesIn, lastResult, mindCalls } from "../helpers/assistant";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";
import { para, pptxOf, sp, txBody } from "../helpers/pptx";

/**
 * What the assistant writes into a Mind carries real Citations (#1075),
 * through the core's public interface as the assistant asks: text whose
 * sources are written as a name in brackets, as a model reads Citations in
 * <mind> and earlier Answers, is refused once, with each such source named,
 * so the model cites and writes again; written once more, each is made the
 * Citation recorded for it or left out, never kept as text. "Put that in a
 * new Mind" puts in the last Answer itself, with its Citations. The model's
 * choices are scripted; real models' are checked by hand.
 */

const DECK_QUOTE = "The building at 5 rue Berryer has 1,200 square metres of offices";
const PLAN_QUOTE = "公司预计未来三年收入每年增长百分之二十";

const DECK = {
  name: "5_Rue_Berryer_Paris.pptx",
  contents: pptxOf({
    slides: [
      { shapes: sp({ body: txBody(para("5 rue Berryer, Paris")) }) },
      { shapes: sp({ body: txBody(para("The lease runs for nine years.")) }) },
      { shapes: sp({ body: txBody(para(`${DECK_QUOTE}.`)) }) },
    ],
  }),
};

const PLAN = {
  name: "执行概要.md",
  contents: ["# 执行概要", "", "## 6.3.1 未来三年财务预测", "", `${PLAN_QUOTE}。`].join("\n"),
};

const DECK_SOURCE = "[5_Rue_Berryer_Paris, slide 3]";
const PLAN_SOURCE = "[执行概要, § 6.3.1 未来三年财务预测]";

/** The owner's two shapes, as GPT-6.1 Sol wrote them into a Mind. */
const AS_TEXT = `${DECK_QUOTE} ${DECK_SOURCE}.\n\n${PLAN_QUOTE}${PLAN_SOURCE}。`;
const CITED = `${DECK_QUOTE} [^1].\n\n${PLAN_QUOTE}[^2]。`;

const called = (call: ModelCall, tool: string) => call.results.some((each) => each.tool === tool);

/** Searches for both lines, then `next`, with the id of the Passage that holds some words. */
function searchingFirst(
  call: ModelCall,
  next: (passage: (words: string) => string) => ScriptedReply,
): ScriptedReply {
  if (!called(call, "search_documents")) {
    return {
      calls: [
        { tool: "search_documents", input: { query: "rue Berryer offices" } },
        { tool: "search_documents", input: { query: "未来三年财务预测" } },
      ],
    };
  }
  const shown = call.results
    .filter((each) => each.tool === "search_documents")
    .flatMap((each) => shownPassages(each.text));
  return next((words) => {
    const id = shown.find((passage) => passage.text.includes(words))?.id;
    if (!id) throw new Error(`No Passage holds “${words}”.`);
    return id;
  });
}

const cite = (records: { marker: number; passage: string; quote: string }[]): ScriptedReply => ({
  calls: [{ tool: "cite", input: { citations: records } }],
});

/** A Mind's text, each Citation as ⟨its check⟩. */
function shown(doc: ProseMirrorNode): string {
  let text = "";
  doc.descendants((node) => {
    if (node.isText) text += node.text ?? "";
    else if (node.type.name === "citation") text += `⟨${String(node.attrs.check)}⟩`;
    else if (node.isBlock && text !== "") text += "\n";
    return true;
  });
  return text.trim();
}

async function mindText(core: Core, mindId: string): Promise<string> {
  const client = await connectToMind(core, mindId);
  await client.settled();
  return shown(readMind(client));
}

describe("Sources written as text into a Mind (#1075)", { timeout: 30_000 }, () => {
  // protects=a new Mind written with its sources as a name in brackets, in both of the owner's shapes, is refused with each named and how to cite, and isn't left behind; once the model cites and makes it again, it holds checked Citations and no bracketed text, in English and Chinese; fails_when=the brackets go into the Mind, the refusal doesn't name them, an empty Mind stays, or the retry's Citations aren't checked; no_claim=that a real model then cites.
  test.each([
    ["Write a summary of the Folder into a new Mind.", "Summary"],
    ["帮我跟进文件夹里面的内容写一份摘要", "摘要"],
  ])(
    "“%s” with sources as text is refused, then written with checked Citations",
    async (request, title) => {
      const told: string[] = [];
      const model = scriptedModel((call) =>
        searchingFirst(call, (passage) => {
          if (!called(call, "create_mind")) {
            return {
              calls: [
                { tool: "create_mind", input: { title, content: AS_TEXT }, streamInput: true },
              ],
            };
          }
          if (!called(call, "cite")) {
            told.push(call.results.find((each) => each.tool === "create_mind")?.text ?? "");
            return cite([
              { marker: 1, passage: passage(DECK_QUOTE), quote: DECK_QUOTE },
              { marker: 2, passage: passage(PLAN_QUOTE), quote: PLAN_QUOTE },
            ]);
          }
          if (call.results.filter((each) => each.tool === "create_mind").length === 1) {
            return { calls: [{ tool: "create_mind", input: { title, content: CITED } }] };
          }
          return { text: "Done." };
        }),
      );
      const { core, documents } = await setUpWithDocuments(model, [DECK, PLAN]);
      expect(documents).toHaveLength(2);

      const answer = await askAssistant(core, { text: request });

      expect(told[0]).toContain(`“${DECK_SOURCE}”`);
      expect(told[0]).toContain(`“${PLAN_SOURCE}”`);
      expect(told[0]).toContain("Record each source with cite");
      expect(told[0]).toContain(`“${title}” wasn't made`);
      expect(told[0]).toContain("call create_mind again");
      expect(mindCalls(answer)[0]?.mindProblem).toMatchObject({ kind: "uncited" });
      const minds = await core.listMinds();
      expect(minds.filter((each) => each.title === title)).toHaveLength(1);
      const made = changesIn(answer).find((change) => change.created);
      if (!made) throw new Error("No Mind was made.");
      expect(await mindText(core, made.mindId)).toBe(
        `${title}\n${DECK_QUOTE} ⟨found⟩.\n${PLAN_QUOTE}⟨found⟩。`,
      );
    },
  );

  // protects=brackets that name no Document stay exactly as written, and nothing is refused: a checkbox beside the one cited Document, code, maths, intervals, times, "[1]" and quoted "[Section 4]" (#1087 review); fails_when=a checkbox becomes a Citation, or any of them is cut or refused; no_claim=none beyond protects.
  test("brackets that aren't sources stay exactly as written", async () => {
    const content = [
      "- [ ] Visit the building",
      `${DECK_QUOTE} [^1].`,
      '```python\ndf[["col1","col2"]]\narr[0, 10:20]\n```',
      "Between [t1, t2], open [09:00, 17:00], as [1] says.",
      "“Claims under [Section 4] are void.”",
    ].join("\n\n");
    const model = scriptedModel((call) =>
      searchingFirst(call, (passage) => {
        if (!called(call, "cite")) {
          return cite([{ marker: 1, passage: passage(DECK_QUOTE), quote: DECK_QUOTE }]);
        }
        return called(call, "add_to_mind")
          ? { text: "Done." }
          : { calls: [{ tool: "add_to_mind", input: { content } }] };
      }),
    );
    const { core, mind } = await setUpWithDocuments(model, [DECK]);

    const answer = await askAssistant(core, {
      text: "Add my notes to this Mind.",
      mindId: mind.id,
    });

    expect(mindCalls(answer)[0]?.mindProblem).toBeUndefined();
    expect(await mindText(core, mind.id)).toBe(
      [
        "[ ] Visit the building",
        `${DECK_QUOTE} ⟨found⟩.`,
        'df[["col1","col2"]]\narr[0, 10:20]',
        "Between [t1, t2], open [09:00, 17:00], as [1] says.",
        "“Claims under [Section 4] are void.”",
      ].join("\n"),
    );
  });

  // protects=a bare Document name in brackets is refused, and written so again with no Citation recorded for it is left out and counted, not kept as text (#1087 review); fails_when="[5_Rue_Berryer_Paris]" stays in the Mind or goes uncounted; no_claim=none beyond protects.
  test("a bare Document name is refused, then left out and counted", async () => {
    const content = `${DECK_QUOTE} [5_Rue_Berryer_Paris].`;
    const model = scriptedModel((call) =>
      call.results.filter((each) => each.tool === "add_to_mind").length < 2
        ? { calls: [{ tool: "add_to_mind", input: { content } }] }
        : { text: "Done." },
    );
    const { core, mind } = await setUpWithDocuments(model, [DECK]);

    const answer = await askAssistant(core, { text: "Add the office size.", mindId: mind.id });

    expect(mindCalls(answer)[0]?.mindProblem).toMatchObject({ kind: "uncited" });
    expect(changesIn(answer).at(-1)?.droppedSources).toBe(1);
    expect(await mindText(core, mind.id)).toBe(`${DECK_QUOTE}.`);
  });

  // protects=text with sources as text written in the last step that can call Tools goes in, each source made its Citation or left out, since there is no step left to try again (#1087 review); fails_when=it is refused and the Mind stays empty, or the Answer has no reply; no_claim=none beyond protects.
  test("with no step left to try again, the text goes in", async () => {
    const model = scriptedModel((call) => {
      const done = call.results.length;
      if (done < 7)
        return { calls: [{ tool: "search_documents", input: { query: `offices ${done}` } }] };
      if (done === 7) {
        const shown = call.results.flatMap((each) => shownPassages(each.text));
        const deck = shown.find((passage) => passage.text.includes("rue Berryer has"))?.id;
        return cite([{ marker: 1, passage: deck ?? "", quote: DECK_QUOTE }]);
      }
      if (done === 8) return { calls: [{ tool: "add_to_mind", input: { content: AS_TEXT } }] };
      return { text: "Added the summary." };
    });
    const { core, mind } = await setUpWithDocuments(model, [DECK, PLAN]);

    const answer = await askAssistant(core, {
      text: "Add a summary to this Mind.",
      mindId: mind.id,
    });

    expect(mindCalls(answer)[0]?.mindProblem).toBeUndefined();
    expect(answer.text).toBe("Added the summary.");
    expect(await mindText(core, mind.id)).toBe(`${DECK_QUOTE} ⟨found⟩.\n${PLAN_QUOTE}。`);
  });

  // protects=a refused new Mind leaves none behind, so a reply that says it wrote into one is caught as a claim no call made (#1087 review); fails_when=an empty Mind stays, or "I wrote the summary into the new Mind" passes; no_claim=the wording of the note.
  test("a refused new Mind leaves none, and a reply claiming it is caught", async () => {
    const model = scriptedModel((call) =>
      called(call, "create_mind")
        ? { text: "I wrote the summary into the new Mind." }
        : {
            calls: [
              {
                tool: "create_mind",
                input: { title: "Summary", content: AS_TEXT },
                streamInput: true,
              },
            ],
          },
    );
    const { core } = await setUpWithDocuments(model, [DECK, PLAN]);

    const answer = await askAssistant(core, { text: "Write a summary into a new Mind." });

    expect((await core.listMinds()).map((each) => each.title)).not.toContain("Summary");
    expect(changesIn(answer)).toEqual([]);
    expect(answer.steps?.unbackedClaims?.length).toBeGreaterThan(0);
  });

  // protects=written as text once more after the refusal, a source the model recorded becomes its Citation and one it didn't is left out, said to the model and on the card, never kept as text; fails_when=a bracket stays in the Mind, or one left out goes unsaid; no_claim=how a real model takes the refusal.
  test("written as text again, sources become their Citations or are left out and counted", async () => {
    const model = scriptedModel((call) =>
      searchingFirst(call, (passage) => {
        const added = call.results.filter((each) => each.tool === "add_to_mind").length;
        if (added === 0) return { calls: [{ tool: "add_to_mind", input: { content: AS_TEXT } }] };
        if (!called(call, "cite")) {
          return cite([{ marker: 1, passage: passage(DECK_QUOTE), quote: DECK_QUOTE }]);
        }
        if (added === 1) return { calls: [{ tool: "add_to_mind", input: { content: AS_TEXT } }] };
        return { text: "Done." };
      }),
    );
    const { core, mind } = await setUpWithDocuments(model, [DECK, PLAN]);

    const answer = await askAssistant(core, {
      text: "Add a summary of the Documents to this Mind.",
      mindId: mind.id,
    });

    expect(lastResult(model)).toContain(
      "1 source was written as a name in brackets that matched no Citation you recorded, so it was left out",
    );
    expect(changesIn(answer).at(-1)?.droppedSources).toBe(1);
    expect(await mindText(core, mind.id)).toBe(`${DECK_QUOTE} ⟨found⟩.\n${PLAN_QUOTE}。`);
  });
});

describe("The last Answer put into a Mind (#1075)", { timeout: 30_000 }, () => {
  // protects=asked to put the last Answer into a new Mind, the Mind gets that Answer's own text with its checked Citation, not a copy the model retypes, in English and Chinese; fails_when=the Mind's text is the model's content, or its Citation is lost; no_claim=that a real model gives answer rather than content.
  test.each([
    ["Put that into a new Mind.", "Offices"],
    ["把这个写进一个新笔记。", "办公室"],
  ])("“%s” puts in the Answer itself, cited", async (request, title) => {
    const model = scriptedModel((call) => {
      if (call.prompt.includes(request)) {
        return called(call, "create_mind")
          ? { text: "Done." }
          : { calls: [{ tool: "create_mind", input: { title, answer: true } }] };
      }
      return searchingFirst(call, (passage) =>
        called(call, "cite")
          ? { text: `${DECK_QUOTE} [^1].` }
          : cite([{ marker: 1, passage: passage(DECK_QUOTE), quote: DECK_QUOTE }]),
      );
    });
    const { core } = await setUpWithDocuments(model, [DECK]);
    const first = await askAssistant(core, { text: "How big are the offices?" });

    const answer = await askAssistant(core, {
      text: request,
      conversationId: first.conversationId,
    });

    const made = changesIn(answer).find((change) => change.created);
    if (!made) throw new Error("No Mind was made.");
    expect(await mindText(core, made.mindId)).toBe(`${title}\n${DECK_QUOTE} ⟨found⟩.`);
  });
});
