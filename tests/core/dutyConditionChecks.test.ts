/**
 * A sentence that copies a clause but puts its duty another way ("should" for "must") or states
 * flat a rule the clause holds on a condition is never Supported (#1766, #1708): the check's reply
 * says so in its own Duty and Condition lines, and the code reads only their closing word. A reply
 * that leaves either line out, or gives one with no closing word, is asked once for its whole
 * reply again and is never Supported without them. Neither line ever makes a conflict weaker.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import {
  checkGenerate,
  checkReply,
  isCheckRun,
  type Plan,
  requestedFigures,
} from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";

const BERTHS = {
  name: "Berth rules.md",
  contents: [
    "# Berth rules",
    "",
    "Berth holders must wear a life jacket on the pontoons.",
    "",
    "Berth holders may run a generator only if the harbour master agrees.",
    "",
    "The marina office can store spare sails for berth holders.",
    "",
    "Berth holders get a 10% discount on fuel, unless they pay their fees late.",
    "",
  ].join("\n"),
};

const BERTHS_ZH = {
  name: "泊位守则.md",
  contents: [
    "# 泊位守则",
    "",
    "泊位持有人必须在浮桥上穿救生衣。",
    "",
    "只有经港务长同意，泊位持有人才可以使用发电机。",
    "",
    "码头办公室可以为泊位持有人保管备用帆。",
    "",
  ].join("\n"),
};

interface Case {
  sentence: string;
  quote: string;
  verdict: "supported" | "unsupported" | "contradicted";
  /** Its Duty line's field; no line when null. */
  duty: string | null;
  /** Its Condition line's field; no line when null. */
  condition: string | null;
  /** Its Duty and Condition lines once asked for them again: the same again when absent. */
  again?: { duty: string | null; condition: string | null };
  /** It replies with one JSON object, as some models do, in place of its lines. */
  json?: true;
  /** It writes its verdict lines beside `cite`, then only its verdict, sentence and Evidence. */
  split?: true;
  /** The Document's number each figure of the sentence is bound to, when it has one. */
  number?: string;
}

/** How the check's ask for the Duty and Condition lines starts. */
const ASKED = "Your reply has no Duty or Condition line";

function replying(each: Case, calls: ModelCall[]) {
  const plans: Record<string, Plan> = {
    [each.sentence]: { verdict: each.verdict, quote: each.quote, judgement: "conflict" },
  };
  return scriptedModel(
    (call) => {
      if (!isCheckRun(call)) return { text: "" };
      calls.push(call);
      const searched = call.results.filter((result) => result.tool === "search_documents");
      if (searched.length === 0) return checkReply(call, plans);
      const cited = call.results.some((result) => result.tool === "cite");
      const fields = call.prompt.includes(ASKED) ? (each.again ?? each) : each;
      const verdictLines = [
        `Verdict: ${each.verdict}`,
        "Absence: no",
        "Scope: none, same",
        "Topic: found",
        "Roles: none / none, same",
        "Time: none / none, same",
        ...(fields.duty === null ? [] : [`Duty: ${fields.duty}`]),
        ...(fields.condition === null ? [] : [`Condition: ${fields.condition}`]),
      ];
      if (!cited) {
        const passage = shownPassages(searched.at(-1)?.text ?? "").find((shown) =>
          shown.text.includes(each.quote),
        );
        return {
          ...(each.split && { text: verdictLines.join("\n") }),
          calls: [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage: passage?.id, quote: each.quote }] },
            },
          ],
        };
      }
      if (each.json)
        return {
          text: JSON.stringify({
            verdict: each.verdict,
            asserts_absence: false,
            scope: "same",
            topic: "found",
            roles: "none / none, same",
            time: "none / none, same",
            ...(fields.duty !== null && { duty: fields.duty }),
            ...(fields.condition !== null && { condition: fields.condition }),
            says: "The rules say so.",
            evidence: [1],
          }),
        };
      const lines = each.split
        ? [`Verdict: ${each.verdict}`, "Absence: no", "The rules say so [^1].", "Evidence: [1]"]
        : [...verdictLines, "The rules say so [^1].", "Evidence: [1]"];
      const figures = requestedFigures(call);
      if (figures.length === 0)
        return { text: [...lines, "Covered: the rule", "Not covered: its wording"].join("\n") };
      const items = figures.map(({ id }) => ({
        id,
        verdict: each.verdict,
        scope: "same",
        topic: "found",
        roles: "same",
        says: null,
        reading: null,
        relation: "equals",
        source: { citation: 1, number: each.number, reading: null, unitQuote: null },
        calculation: null,
      }));
      return {
        text: `${lines.join("\n")}\nFigures: ${JSON.stringify({ items, remainder: null })}`,
      };
    },
    {
      generate: checkGenerate({
        [each.sentence]: { judgement: "conflict", strict: { text: "Judgement: conflict" } },
      }),
    },
  );
}

const paragraph = (id: string, value: string): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content: [{ type: "text", text: value }],
});

async function check(
  each: Case,
  document: { name: string; contents: string },
  calls: ModelCall[] = [],
) {
  const setup = await setUpWithDocuments(replying(each, calls), [document]);
  writeMind(setup.client, [paragraph("point", each.sentence)]);
  await setup.client.settled();
  await setup.core.checkSentences({
    requestId: "check",
    mindId: setup.mind.id,
    action: "check-against-documents",
    from: { blockId: "point", offset: 0 },
    to: { blockId: "point", offset: each.sentence.length },
  });
  await setup.client.settled();
  return claimSpans(readMind(setup.client)).find(
    (claim) => claim.sentence.text.trim() === each.sentence,
  )?.check;
}

const SAME = "none / none, same";

describe("a duty put another way, or a rule without its condition, is never Supported (#1766, #1708)", () => {
  test.each<[string, Case, typeof BERTHS, "supported" | "unsupported"]>([
    [
      "en, should for must",
      {
        sentence: "Berth holders should wear a life jacket on the pontoons.",
        quote: "Berth holders must wear a life jacket on the pontoons.",
        verdict: "supported",
        duty: "should / must, differs",
        condition: SAME,
      },
      BERTHS,
      "unsupported",
    ],
    [
      "en, the same duty in other words",
      {
        sentence: "Berth holders are required to wear a life jacket on the pontoons.",
        quote: "Berth holders must wear a life jacket on the pontoons.",
        verdict: "supported",
        duty: "must / must, same",
        condition: SAME,
      },
      BERTHS,
      "supported",
    ],
    [
      "en, the rule without its condition",
      {
        sentence: "Berth holders may run a generator.",
        quote: "Berth holders may run a generator only if the harbour master agrees.",
        verdict: "supported",
        duty: "may / may, same",
        condition: "none / only if the harbour master agrees, differs",
      },
      BERTHS,
      "unsupported",
    ],
    [
      "en, the rule with its condition",
      {
        sentence: "Berth holders may run a generator if the harbour master agrees to it.",
        quote: "Berth holders may run a generator only if the harbour master agrees.",
        verdict: "supported",
        duty: "may / may, same",
        condition: "if the harbour master agrees to it / only if the harbour master agrees, same",
      },
      BERTHS,
      "supported",
    ],
    [
      "en, a figure's rule without its exception",
      {
        sentence: "Berth holders get a 10% discount on fuel.",
        quote: "Berth holders get a 10% discount on fuel, unless they pay their fees late.",
        verdict: "supported",
        duty: "none / none, same",
        condition: "none / unless they pay their fees late, differs",
        number: "10%",
      },
      BERTHS,
      "unsupported",
    ],
    [
      "en, a figure's rule with its exception",
      {
        sentence: "Berth holders get a 10% discount on fuel unless they pay their fees late.",
        quote: "Berth holders get a 10% discount on fuel, unless they pay their fees late.",
        verdict: "supported",
        duty: "none / none, same",
        condition: "unless they pay their fees late / unless they pay their fees late, same",
        number: "10%",
      },
      BERTHS,
      "supported",
    ],
    [
      "zh, 应该 for 必须",
      {
        sentence: "泊位持有人应该在浮桥上穿救生衣。",
        quote: "泊位持有人必须在浮桥上穿救生衣。",
        verdict: "supported",
        duty: "should / must, differs",
        condition: SAME,
      },
      BERTHS_ZH,
      "unsupported",
    ],
    [
      "zh, the rule without its condition",
      {
        sentence: "泊位持有人可以使用发电机。",
        quote: "只有经港务长同意，泊位持有人才可以使用发电机。",
        verdict: "supported",
        duty: "may / may, same",
        condition: "none / 只有经港务长同意, differs",
      },
      BERTHS_ZH,
      "unsupported",
    ],
    [
      "zh, the rule with its condition",
      {
        sentence: "泊位持有人经港务长同意后可以使用发电机。",
        quote: "只有经港务长同意，泊位持有人才可以使用发电机。",
        verdict: "supported",
        duty: "may / may, same",
        condition: "经港务长同意后 / 只有经港务长同意, same",
      },
      BERTHS_ZH,
      "supported",
    ],
    [
      "en, a JSON reply whose duty differs",
      {
        sentence: "Berth holders should wear a life jacket on the pontoons.",
        quote: "Berth holders must wear a life jacket on the pontoons.",
        verdict: "supported",
        duty: "should / must, differs",
        condition: SAME,
        json: true,
      },
      BERTHS,
      "unsupported",
    ],
    [
      "en, a JSON reply whose duty is the same",
      {
        sentence: "Berth holders are required to wear a life jacket on the pontoons.",
        quote: "Berth holders must wear a life jacket on the pontoons.",
        verdict: "supported",
        duty: "must / must, same",
        condition: SAME,
        json: true,
      },
      BERTHS,
      "supported",
    ],
    [
      "en, the lines written beside cite, the condition differing",
      {
        sentence: "Berth holders may run a generator.",
        quote: "Berth holders may run a generator only if the harbour master agrees.",
        verdict: "supported",
        duty: "may / may, same",
        condition: "none / only if the harbour master agrees, differs",
        split: true,
      },
      BERTHS,
      "unsupported",
    ],
    [
      "en, the lines written beside cite, both the same",
      {
        sentence: "The marina office can store spare sails for berth holders.",
        quote: "The marina office can store spare sails for berth holders.",
        verdict: "supported",
        duty: "may / may, same",
        condition: SAME,
        split: true,
      },
      BERTHS,
      "supported",
    ],
  ])("%s", async (_, each, document, state) => {
    const checked = await check(each, document);
    expect(checked?.state).toBe(state);
    if (state === "unsupported") expect(checked?.state).not.toBe("contradicted");
    // A sentence with a figure is checked figure by figure: its reply's lines still decide.
    if (each.number) expect(checked?.figures).toHaveLength(1);
  });

  test.each<[string, Case, typeof BERTHS]>([
    [
      "en, the parties' duty the other way round",
      {
        sentence: "Berth holders must not wear a life jacket on the pontoons.",
        quote: "Berth holders must wear a life jacket on the pontoons.",
        verdict: "contradicted",
        duty: "must not / must, differs",
        condition: SAME,
      },
      BERTHS,
    ],
    [
      "zh, a condition that differs",
      {
        sentence: "只有经码头经理同意，泊位持有人才可以使用发电机。",
        quote: "只有经港务长同意，泊位持有人才可以使用发电机。",
        verdict: "contradicted",
        duty: "may / may, same",
        condition: "只有经码头经理同意 / 只有经港务长同意, differs",
      },
      BERTHS_ZH,
    ],
  ])("%s stays Contradicted", async (_, each, document) => {
    const checked = await check(each, document);
    expect(checked?.state).toBe("contradicted");
  });
});

describe("a Supported reply without its Duty or Condition line is asked once, and never Supported without them", () => {
  const asks = (calls: readonly ModelCall[]) => calls.filter((call) => call.prompt.includes(ASKED));
  test.each<[string, Case, "supported" | "not-checked", number]>([
    [
      "no Duty line, given when asked",
      {
        sentence: "The marina office can store spare sails for berth holders.",
        quote: "The marina office can store spare sails for berth holders.",
        verdict: "supported",
        duty: null,
        condition: SAME,
        again: { duty: "may / may, same", condition: SAME },
      },
      "supported",
      1,
    ],
    [
      "no Condition line, still none when asked",
      {
        sentence: "The marina office can store spare sails for berth holders.",
        quote: "The marina office can store spare sails for berth holders.",
        verdict: "supported",
        duty: "may / may, same",
        condition: null,
      },
      "not-checked",
      1,
    ],
    [
      "a Duty line with no closing word, still none when asked",
      {
        sentence: "The marina office can store spare sails for berth holders.",
        quote: "The marina office can store spare sails for berth holders.",
        verdict: "supported",
        duty: "may / may",
        condition: SAME,
      },
      "not-checked",
      1,
    ],
    [
      "a figure's sentence with no Condition line, still none when asked",
      {
        sentence: "Berth holders get a 10% discount on fuel unless they pay their fees late.",
        quote: "Berth holders get a 10% discount on fuel, unless they pay their fees late.",
        verdict: "supported",
        duty: "none / none, same",
        condition: null,
        number: "10%",
      },
      "not-checked",
      1,
    ],
    [
      "both lines, never asked",
      {
        sentence: "The marina office can store spare sails for berth holders.",
        quote: "The marina office can store spare sails for berth holders.",
        verdict: "supported",
        duty: "may / may, same",
        condition: SAME,
      },
      "supported",
      0,
    ],
  ])("%s", async (_, each, state, asked) => {
    const calls: ModelCall[] = [];
    const checked = await check(each, BERTHS, calls);
    expect(checked?.state).toBe(state);
    expect(asks(calls)).toHaveLength(asked);
    if (each.number) expect(checked?.figures).toHaveLength(1);
  });
});

describe("the Duty and Condition lines only ever take support away (#1766, #1708)", () => {
  // A reply the judge didn't call Supported stays as the judge said, whatever its lines say.
  test.each<[string, Case, typeof BERTHS, "unsupported" | "contradicted"]>([
    [
      "en, Unsupported with both lines the same",
      {
        sentence: "Berth holders must wear a life jacket in the clubhouse.",
        quote: "Berth holders must wear a life jacket on the pontoons.",
        verdict: "unsupported",
        duty: "must / must, same",
        condition: SAME,
      },
      BERTHS,
      "unsupported",
    ],
    [
      "zh, Unsupported with both lines the same",
      {
        sentence: "泊位持有人必须在会所内穿救生衣。",
        quote: "泊位持有人必须在浮桥上穿救生衣。",
        verdict: "unsupported",
        duty: "must / must, same",
        condition: SAME,
      },
      BERTHS_ZH,
      "unsupported",
    ],
    [
      "en, Contradicted with both lines the same",
      {
        sentence: "Berth holders must wear a helmet on the pontoons.",
        quote: "Berth holders must wear a life jacket on the pontoons.",
        verdict: "contradicted",
        duty: "must / must, same",
        condition: SAME,
      },
      BERTHS,
      "contradicted",
    ],
    [
      "en, a figure's sentence Unsupported with both lines the same",
      {
        sentence: "Berth holders get a 10% discount on moorings unless they pay their fees late.",
        quote: "Berth holders get a 10% discount on fuel, unless they pay their fees late.",
        verdict: "unsupported",
        duty: "none / none, same",
        condition: "unless they pay their fees late / unless they pay their fees late, same",
        number: "10%",
      },
      BERTHS,
      "unsupported",
    ],
    [
      "en, a figure's sentence Contradicted with both lines the same",
      {
        sentence: "Berth holders get a 20% discount on fuel unless they pay their fees late.",
        quote: "Berth holders get a 10% discount on fuel, unless they pay their fees late.",
        verdict: "contradicted",
        duty: "none / none, same",
        condition: "unless they pay their fees late / unless they pay their fees late, same",
        number: "10%",
      },
      BERTHS,
      "contradicted",
    ],
  ])("%s", async (_, each, document, state) => {
    const checked = await check(each, document);
    expect(checked?.state).toBe(state);
    expect(checked?.state).not.toBe("supported");
    if (each.number) expect(checked?.figures).toHaveLength(1);
  });
});
