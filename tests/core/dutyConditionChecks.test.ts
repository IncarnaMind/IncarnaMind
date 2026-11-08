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
    "如果港务长同意，泊位持有人可以租用拖车。",
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
  /** Its Duty and Condition lines as written, in place of `duty` and `condition`. */
  lines?: readonly string[];
  /** With `split`, the lines its last turn writes of its own too. */
  lastLines?: readonly string[];
  /** Its reply when the check looks again at a reply that disagreed with itself. */
  look?: string;
  /** With `split`, the lines its last turn writes once asked for its Roles in its own words. */
  rolesAgain?: readonly string[];
}

/** What every ask for the Duty and Condition lines says. */
const ASKED = "its Duty line gives each side as one of must, should, may, must not or none";

/** How the check's ask for a Roles line in the sentence's own words starts. */
const ROLES_ASKED = "Your Roles line's first side";

/** How the check's second look at a reply that disagreed with itself starts. */
const LOOKS_AGAIN = "Your last check of this sentence";

function replying(each: Case, calls: ModelCall[], looks: string[]) {
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
        ...(each.lines ?? [
          ...(fields.duty === null ? [] : [`Duty: ${fields.duty}`]),
          ...(fields.condition === null ? [] : [`Condition: ${fields.condition}`]),
        ]),
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
      // Asked for its lines, it writes its whole reply again in one turn, as the ask tells it to.
      const lines =
        each.split && !call.prompt.includes(ASKED)
          ? [
              `Verdict: ${each.verdict}`,
              "Absence: no",
              ...((call.prompt.includes(ROLES_ASKED) ? each.rolesAgain : undefined) ??
                each.lastLines ??
                []),
              "The rules say so [^1].",
              "Evidence: [1]",
            ]
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
      generate: (call) => {
        if (call.system.startsWith(LOOKS_AGAIN)) {
          looks.push(call.system);
          return {
            text:
              each.look ??
              "Verdict: unsupported\nScope: none, same\nTopic: found\nRoles: none / none, same\nTime: none / none, same\nThe rules say more.\nEvidence: [1]",
          };
        }
        return checkGenerate({
          [each.sentence]: { judgement: "conflict", strict: { text: "Judgement: conflict" } },
        })(call);
      },
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
  looks: string[] = [],
) {
  const setup = await setUpWithDocuments(replying(each, calls, looks), [document]);
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
    [
      "the same duty in two words, given in the form's words when asked",
      {
        sentence: "Berth holders have to wear a life jacket on the pontoons.",
        quote: "Berth holders must wear a life jacket on the pontoons.",
        verdict: "supported",
        duty: "has to / must, same",
        condition: SAME,
        again: { duty: "must / must, same", condition: SAME },
      },
      "supported",
      1,
    ],
  ])("%s", async (_, each, state, asked) => {
    const calls: ModelCall[] = [];
    const checked = await check(each, BERTHS, calls);
    expect(checked?.state).toBe(state);
    expect(asks(calls)).toHaveLength(asked);
    if (each.number) expect(checked?.figures).toHaveLength(1);
  });

  test.each<[string, Case, string]>([
    [
      "a line that calls a condition on one side and none on the other the same",
      {
        sentence: "Berth holders may run a generator.",
        quote: "Berth holders may run a generator only if the harbour master agrees.",
        verdict: "supported",
        duty: "may / may, same",
        condition: "none / only if the harbour master agrees, same",
      },
      "says same while its two sides differ",
    ],
    [
      "a reply with no Condition line",
      {
        sentence: "The marina office can store spare sails for berth holders.",
        quote: "The marina office can store spare sails for berth holders.",
        verdict: "supported",
        duty: "may / may, same",
        condition: null,
      },
      "has no Duty or Condition line that can be read",
    ],
  ])("the ask for %s says what is wrong", async (_, each, says) => {
    const calls: ModelCall[] = [];
    await check(each, BERTHS, calls);
    expect(asks(calls)).toHaveLength(1);
    expect(asks(calls)[0]?.prompt).toContain(says);
  });

  test("the ask names the words each side of the Duty line takes", async () => {
    const calls: ModelCall[] = [];
    await check(
      {
        sentence: "Berth holders have to wear a life jacket on the pontoons.",
        quote: "Berth holders must wear a life jacket on the pontoons.",
        verdict: "supported",
        duty: "has to / must, same",
        condition: SAME,
      },
      BERTHS,
      calls,
    );
    expect(asks(calls)[0]?.prompt).toContain("must, should, may, must not or none");
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

describe("an Unsupported reply whose own Duty or Condition says why is not asked again (#1766, #1708)", () => {
  const dropped: Case = {
    sentence: "Berth holders may run a generator.",
    quote: "Berth holders may run a generator only if the harbour master agrees.",
    verdict: "unsupported",
    duty: "may / may, same",
    condition: "none / only if the harbour master agrees, differs",
  };
  test.each<[string, Case, number]>([
    ["its Condition differs", dropped, 0],
    ["it gives no Condition line", { ...dropped, condition: null }, 0],
    // Paired: with every field the same, the reply disagrees with itself and is asked once more.
    ["every field the same", { ...dropped, condition: SAME }, 1],
  ])("%s", async (_, each, asked) => {
    const looks: string[] = [];
    const checked = await check(each, BERTHS, [], looks);
    expect(looks).toHaveLength(asked);
    expect(checked?.state).not.toBe("supported");
  });
});

describe("the second look at a reply that disagreed with itself asks for and reads its Duty and Condition (#1766, #1708)", () => {
  // A second look whose Roles line names nothing is refused (#2313): it copies the sentence's words.
  const looked = (lines: readonly string[], who = "Berth holders may run a generator") =>
    [
      "Verdict: supported",
      "Absence: no",
      "Scope: none, same",
      "Topic: found",
      `Roles: ${who} / ${who}, same`,
      "Time: none / none, same",
      ...lines,
      "The rules say so.",
      "Evidence: [1]",
    ].join("\n");
  const both = ["Duty: may / may, same", `Condition: ${SAME}`];
  const dropped: Case = {
    sentence: "Berth holders may run a generator.",
    quote: "Berth holders may run a generator only if the harbour master agrees.",
    verdict: "unsupported",
    duty: "may / may, same",
    condition: SAME,
  };
  const droppedZh: Case = {
    sentence: "泊位持有人可以租用拖车。",
    quote: "如果港务长同意，泊位持有人可以租用拖车。",
    verdict: "unsupported",
    duty: "may / may, same",
    condition: SAME,
  };

  test("its form asks for the Duty and Condition lines it reads", async () => {
    const looks: string[] = [];
    await check({ ...dropped, look: looked(both) }, BERTHS, [], looks);
    expect(looks).toHaveLength(1);
    for (const label of ["Duty", "Condition"])
      expect(looks[0]).toMatch(new RegExp(`^${label}:`, "m"));
  });

  test.each<[string, Case, typeof BERTHS, "unsupported" | "not-checked"]>([
    [
      "en, Supported again with the condition left out",
      {
        ...dropped,
        look: looked([
          "Duty: may / may, same",
          "Condition: none / only if the harbour master agrees, differs",
        ]),
      },
      BERTHS,
      "unsupported",
    ],
    [
      "en, Supported again with another duty",
      { ...dropped, look: looked(["Duty: may / must, differs", `Condition: ${SAME}`]) },
      BERTHS,
      "unsupported",
    ],
    [
      "en, Supported again with neither line",
      { ...dropped, look: looked([]) },
      BERTHS,
      "not-checked",
    ],
    [
      "en, Unsupported again, naming the condition left out",
      {
        ...dropped,
        look: looked([
          "Duty: may / may, same",
          "Condition: none / only if the harbour master agrees, differs",
        ]).replace("Verdict: supported", "Verdict: unsupported"),
      },
      BERTHS,
      "unsupported",
    ],
    [
      "zh, Supported again with neither line",
      { ...droppedZh, look: looked([], "泊位持有人可以租用拖车") },
      BERTHS_ZH,
      "not-checked",
    ],
  ])("%s", async (_, each, document, state) => {
    const looks: string[] = [];
    const checked = await check(each, document, [], looks);
    expect(looks).toHaveLength(1);
    expect(checked?.state).toBe(state);
  });

  test("Supported again with both lines the same is Not checked: a second look only lowers (#2816)", async () => {
    const looks: string[] = [];
    const checked = await check(
      {
        sentence: "The marina office can store spare sails for berth holders.",
        quote: "The marina office can store spare sails for berth holders.",
        verdict: "unsupported",
        duty: "may / may, same",
        condition: SAME,
        look: looked(both, "The marina office can store spare sails"),
      },
      BERTHS,
      [],
      looks,
    );
    expect(looks).toHaveLength(1);
    expect(checked?.state).toBe("not-checked");
  });
});

describe("a Duty or Condition line is read only by its own closing word (#1766, #1708)", () => {
  const RENT = {
    name: "Boat hire.md",
    contents: [
      "# Boat hire",
      "",
      "Members may hire a paddle board, provided that both hirers are of the same age group.",
      "",
      "Members may hire a kayak, delivered same-day to the slipway.",
      "",
      "Members must sign the hire book before they launch.",
      "",
      "Members may hire a canoe only if they paddle with a partner from the same club.",
      "",
      "Members may swap boats if the hire fees are the same.",
      "",
      "Members may hire a dinghy if the bosun and/or the treasurer agrees.",
      "",
      "Members must not leave a boat on the slipway.",
      "",
    ].join("\n"),
  };
  const asks = (calls: readonly ModelCall[]) => calls.filter((call) => call.prompt.includes(ASKED));
  test.each<[string, Case, "supported" | "unsupported" | "not-checked", number]>([
    [
      "a 'same' inside the copied words is no closing word",
      {
        sentence: "Members may hire a paddle board.",
        quote:
          "Members may hire a paddle board, provided that both hirers are of the same age group.",
        verdict: "supported",
        duty: "may / may, same",
        condition: "none / provided that both hirers are of the same age group",
      },
      "not-checked",
      1,
    ],
    [
      "a 'same-day' inside the copied words is no closing word",
      {
        sentence: "Members may hire a kayak.",
        quote: "Members may hire a kayak, delivered same-day to the slipway.",
        verdict: "supported",
        duty: "may / may, same",
        condition: "none / delivered same-day",
      },
      "not-checked",
      1,
    ],
    [
      "a line whose only 'same' is inside both copied sides",
      {
        sentence: "Members may hire a canoe if they paddle with a partner from the same club.",
        quote: "Members may hire a canoe only if they paddle with a partner from the same club.",
        verdict: "supported",
        duty: "may / may, same",
        condition:
          "if they paddle with a partner from the same club / only if they paddle with a partner from the same club",
      },
      "not-checked",
      1,
    ],
    [
      "a Duty line that names two duties and calls them the same",
      {
        sentence: "Members should sign the hire book before they launch.",
        quote: "Members must sign the hire book before they launch.",
        verdict: "supported",
        duty: "should / must, same",
        condition: SAME,
      },
      "not-checked",
      1,
    ],
    [
      "a Condition line with a condition on one side, called the same",
      {
        sentence: "Members may hire a paddle board.",
        quote:
          "Members may hire a paddle board, provided that both hirers are of the same age group.",
        verdict: "supported",
        duty: "may / may, same",
        condition: "none / provided that both hirers are of the same age group, same",
      },
      "not-checked",
      1,
    ],
    [
      "two Condition lines, the first that differs",
      {
        sentence: "Members may hire a paddle board.",
        quote:
          "Members may hire a paddle board, provided that both hirers are of the same age group.",
        verdict: "supported",
        duty: null,
        condition: null,
        lines: [
          "Duty: may / may, same",
          "Condition: none / provided that both hirers are of the same age group, differs",
          "Condition: none / none, same",
        ],
      },
      "unsupported",
      0,
    ],
    [
      "the same duty, its closing word last",
      {
        sentence: "Members are required to sign the hire book before they launch.",
        quote: "Members must sign the hire book before they launch.",
        verdict: "supported",
        duty: "must / must, same",
        condition: SAME,
      },
      "supported",
      0,
    ],
    [
      "a 'same' that ends the copied words is no closing word",
      {
        sentence: "Members may swap boats if the club agrees.",
        quote: "Members may swap boats if the hire fees are the same.",
        verdict: "supported",
        duty: "may / may, same",
        condition: "if the club agrees / if the hire fees are the same",
      },
      "not-checked",
      1,
    ],
    [
      "a Duty line glossed as the form glosses it, two duties called the same",
      {
        sentence: "Members should sign the hire book before they launch.",
        quote: "Members must sign the hire book before they launch.",
        verdict: "supported",
        duty: "should (advice) / must (a duty), same",
        condition: SAME,
      },
      "not-checked",
      1,
    ],
    [
      "a Duty line in other words than the form's, two duties called the same",
      {
        sentence: "Members can sign the hire book before they launch.",
        quote: "Members must sign the hire book before they launch.",
        verdict: "supported",
        duty: "can / must, same",
        condition: SAME,
      },
      "not-checked",
      1,
    ],
    [
      "a Duty line glossed as the form glosses it, the same duty",
      {
        sentence: "Members may hire a kayak, delivered same-day to the slipway.",
        quote: "Members may hire a kayak, delivered same-day to the slipway.",
        verdict: "supported",
        duty: "may (a permission) / may (a permission or an ability), same",
        condition: SAME,
      },
      "supported",
      0,
    ],
    [
      "a Condition line whose empty side is a dash, called the same",
      {
        sentence: "Members may hire a paddle board.",
        quote:
          "Members may hire a paddle board, provided that both hirers are of the same age group.",
        verdict: "supported",
        duty: "may / may, same",
        condition: "— / provided that both hirers are of the same age group, same",
      },
      "not-checked",
      1,
    ],
    [
      "a Condition line whose empty side is bracketed, called the same",
      {
        sentence: "Members may hire a paddle board.",
        quote:
          "Members may hire a paddle board, provided that both hirers are of the same age group.",
        verdict: "supported",
        duty: "may / may, same",
        condition: "(none) / provided that both hirers are of the same age group, same",
      },
      "not-checked",
      1,
    ],
    [
      "a Condition line with no condition on either side, written as dashes",
      {
        sentence: "Members must sign the hire book before they launch.",
        quote: "Members must sign the hire book before they launch.",
        verdict: "supported",
        duty: "must / must, same",
        condition: "— / —, same",
      },
      "supported",
      0,
    ],
    [
      "a 'differs' written beside cite holds when the last turn writes its own line",
      {
        sentence: "Members may hire a paddle board.",
        quote:
          "Members may hire a paddle board, provided that both hirers are of the same age group.",
        verdict: "supported",
        duty: "may / may, same",
        condition: "none / provided that both hirers are of the same age group, differs",
        split: true,
        lastLines: ["Duty: may / may, same", `Condition: ${SAME}`],
      },
      "unsupported",
      0,
    ],
    [
      "a Condition copied in brackets on one side, called the same",
      {
        sentence: "Members may hire a paddle board.",
        quote:
          "Members may hire a paddle board, provided that both hirers are of the same age group.",
        verdict: "supported",
        duty: "may / may, same",
        condition: "none / (provided that both hirers are of the same age group), same",
      },
      "not-checked",
      1,
    ],
    [
      "a Condition line with only the Passage's side, called the same",
      {
        sentence: "Members may hire a paddle board.",
        quote:
          "Members may hire a paddle board, provided that both hirers are of the same age group.",
        verdict: "supported",
        duty: "may / may, same",
        condition: "provided that both hirers are of the same age group, same",
      },
      "not-checked",
      1,
    ],
    [
      "a Condition line with one side that is none, called the same",
      {
        sentence: "Members must sign the hire book before they launch.",
        quote: "Members must sign the hire book before they launch.",
        verdict: "supported",
        duty: "must / must, same",
        condition: "none, same",
      },
      "supported",
      0,
    ],
    [
      "a Condition with a slash in its words on one side, called the same",
      {
        sentence: "Members may hire a dinghy.",
        quote: "Members may hire a dinghy if the bosun and/or the treasurer agrees.",
        verdict: "supported",
        duty: "may / may, same",
        condition: "none / if the bosun and/or the treasurer agrees, same",
      },
      "not-checked",
      1,
    ],
    [
      "a Condition with a slash in its words on both sides, the same",
      {
        sentence: "Members may hire a dinghy if the bosun and/or the treasurer agrees.",
        quote: "Members may hire a dinghy if the bosun and/or the treasurer agrees.",
        verdict: "supported",
        duty: "may / may, same",
        condition:
          "if the bosun and/or the treasurer agrees / if the bosun and/or the treasurer agrees, same",
      },
      "supported",
      0,
    ],
    [
      "a Duty line that calls must and must not the same",
      {
        sentence: "Members must leave a boat on the slipway.",
        quote: "Members must not leave a boat on the slipway.",
        verdict: "supported",
        duty: "must / must not, same",
        condition: SAME,
      },
      "not-checked",
      1,
    ],
    [
      "a rule put the other way round, the same word on both sides",
      {
        sentence: "Members must keep the slipway clear of boats.",
        quote: "Members must not leave a boat on the slipway.",
        verdict: "supported",
        duty: "must / must, same",
        condition: SAME,
      },
      "supported",
      0,
    ],
    [
      "a 'differs' that ends the line, with no comma before it",
      {
        sentence: "Members may hire a paddle board.",
        quote:
          "Members may hire a paddle board, provided that both hirers are of the same age group.",
        verdict: "supported",
        duty: "may / may, same",
        condition: "none / provided that both hirers are of the same age group differs",
      },
      "unsupported",
      0,
    ],
    [
      "a self-denying Condition line, then one that reads the same",
      {
        sentence: "Members may hire a paddle board.",
        quote:
          "Members may hire a paddle board, provided that both hirers are of the same age group.",
        verdict: "supported",
        duty: null,
        condition: null,
        lines: [
          "Duty: may / may, same",
          "Condition: none / provided that both hirers are of the same age group, same",
          `Condition: ${SAME}`,
        ],
      },
      "not-checked",
      1,
    ],
    [
      "a self-denying Condition beside cite, then the last turn's own line",
      {
        sentence: "Members may hire a paddle board.",
        quote:
          "Members may hire a paddle board, provided that both hirers are of the same age group.",
        verdict: "supported",
        duty: "may / may, same",
        condition: "none / provided that both hirers are of the same age group, same",
        split: true,
        lastLines: ["Duty: may / may, same", `Condition: ${SAME}`],
      },
      "not-checked",
      1,
    ],
    [
      "a Condition side that is none with a gloss, beside a condition, called the same",
      {
        sentence: "Members may hire a paddle board.",
        quote:
          "Members may hire a paddle board, provided that both hirers are of the same age group.",
        verdict: "supported",
        duty: "may / may, same",
        condition:
          "none (unconditional) / provided that both hirers are of the same age group, same",
      },
      "not-checked",
      1,
    ],
    [
      "a Condition line with none on both sides, one glossed",
      {
        sentence: "Members must sign the hire book before they launch.",
        quote: "Members must sign the hire book before they launch.",
        verdict: "supported",
        duty: "must / must, same",
        condition: "none (unconditional) / none, same",
      },
      "supported",
      0,
    ],
    [
      "a 'differs' beside cite, then a reply asked for its Roles in the sentence's own words",
      {
        sentence: "Members may hire a paddle board.",
        quote:
          "Members may hire a paddle board, provided that both hirers are of the same age group.",
        verdict: "supported",
        duty: "may / may, same",
        condition: "none / provided that both hirers are of the same age group, differs",
        split: true,
        lastLines: [
          "Roles: hirers of the same age group may hire / hirers may hire, same",
          "Duty: may / may, same",
          `Condition: ${SAME}`,
        ],
        rolesAgain: [
          "Roles: Members may hire / Members may hire, same",
          "Duty: may / may, same",
          `Condition: ${SAME}`,
        ],
      },
      "unsupported",
      0,
    ],
    [
      "lines all the same beside cite, then a reply asked for its Roles in the sentence's own words",
      {
        sentence: "Members must sign the hire book before they launch.",
        quote: "Members must sign the hire book before they launch.",
        verdict: "supported",
        duty: "must / must, same",
        condition: SAME,
        split: true,
        lastLines: [
          "Roles: every member must sign / Members must sign, same",
          "Duty: must / must, same",
          `Condition: ${SAME}`,
        ],
        rolesAgain: [
          "Roles: Members must sign / Members must sign, same",
          "Duty: must / must, same",
          `Condition: ${SAME}`,
        ],
      },
      "supported",
      0,
    ],
    [
      "lines beside cite and in the last turn, all the same",
      {
        sentence: "Members must sign the hire book before they launch.",
        quote: "Members must sign the hire book before they launch.",
        verdict: "supported",
        duty: "must / must, same",
        condition: SAME,
        split: true,
        lastLines: ["Duty: must / must, same", `Condition: ${SAME}`],
      },
      "supported",
      0,
    ],
  ])("%s", async (_, each, state, asked) => {
    const calls: ModelCall[] = [];
    const checked = await check(each, RENT, calls);
    expect(checked?.state).toBe(state);
    expect(asks(calls)).toHaveLength(asked);
  });

  test.each<[string, Case, "supported" | "unsupported"]>([
    [
      "zh, 义务 and 条件 lines, the condition left out",
      {
        sentence: "泊位持有人可以使用发电机。",
        quote: "只有经港务长同意，泊位持有人才可以使用发电机。",
        verdict: "supported",
        duty: null,
        condition: null,
        lines: ["义务：may / may, same", "条件：none / 只有经港务长同意, differs"],
      },
      "unsupported",
    ],
    [
      "zh, 义务 and 条件 lines, both the same",
      {
        sentence: "码头办公室可以为泊位持有人保管备用帆。",
        quote: "码头办公室可以为泊位持有人保管备用帆。",
        verdict: "supported",
        duty: null,
        condition: null,
        lines: ["义务：may / may, same", "条件：none / none, same"],
      },
      "supported",
    ],
    [
      "zh, a Duty line that names two duties and calls them the same",
      {
        sentence: "泊位持有人应该在浮桥上穿救生衣。",
        quote: "泊位持有人必须在浮桥上穿救生衣。",
        verdict: "supported",
        duty: "should / must, same",
        condition: SAME,
      },
      "unsupported",
    ],
    [
      "zh, a 义务 line in Chinese words, two duties called the same",
      {
        sentence: "泊位持有人应该在浮桥上穿救生衣。",
        quote: "泊位持有人必须在浮桥上穿救生衣。",
        verdict: "supported",
        duty: null,
        condition: null,
        lines: ["义务：应该 / 必须，same", "条件：none / none，same"],
      },
      "unsupported",
    ],
    [
      "zh, a Duty line in Chinese words, two duties called the same",
      {
        sentence: "泊位持有人应该在浮桥上穿救生衣。",
        quote: "泊位持有人必须在浮桥上穿救生衣。",
        verdict: "supported",
        duty: "应该 / 须, same",
        condition: SAME,
      },
      "unsupported",
    ],
    [
      "zh, a 条件 side that is none with a gloss, beside a condition, called the same",
      {
        sentence: "泊位持有人可以使用发电机。",
        quote: "只有经港务长同意，泊位持有人才可以使用发电机。",
        verdict: "supported",
        duty: null,
        condition: null,
        lines: ["义务：may / may, same", "条件：无（未提条件）/ 只有经港务长同意，same"],
      },
      "unsupported",
    ],
    [
      "zh, a Duty line in Chinese words, the same duty",
      {
        sentence: "泊位持有人须在浮桥上穿救生衣。",
        quote: "泊位持有人必须在浮桥上穿救生衣。",
        verdict: "supported",
        duty: "须 / 须, same",
        condition: SAME,
      },
      "supported",
    ],
  ])("%s", async (_, each, state) => {
    const checked = await check(each, BERTHS_ZH);
    if (state === "supported") expect(checked?.state).toBe("supported");
    else expect(checked?.state).not.toBe("supported");
  });
});
