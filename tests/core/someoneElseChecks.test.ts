/**
 * A sentence about someone else than the Document's party is neither backed nor contradicted by
 * it (#1766, was #1718): the check's own Roles field says another party has it, and then the
 * sentence is Unsupported, never Contradicted and never Supported, whatever its verdict line and
 * the contradiction's two judgements say. The parties the other way round still contradict.
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
  SAME_DETAIL,
} from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";

const RULES = {
  name: "House rules.md",
  contents: [
    "# House rules",
    "",
    "The Tenant may keep a cat in the flat.",
    "",
    "The Tenant pays the Landlord a rent of 900 per month.",
    "",
    "The Tenant reports repairs to the caretaker.",
    "",
  ].join("\n"),
};

const RULES_ZH = {
  name: "房屋守则.md",
  contents: [
    "# 房屋守则",
    "",
    "乙方可在房屋内养猫。",
    "",
    "乙方每月向甲方支付租金人民币900元。",
    "",
    "乙方向物业管理员报修。",
    "",
  ].join("\n"),
};

interface Case {
  sentence: string;
  quote: string;
  verdict: "supported" | "contradicted" | "unsupported";
  roles: string;
  /** More lines of its reply, such as a Coverage line. */
  extra?: string[];
  /** Its Roles line once asked for the sentence's own words: the same again when absent, none when "". */
  again?: string;
  /** The Figures line's remainder: null, the sentence has nothing beyond its figures, when absent. */
  remainder?: Record<string, unknown> | null;
  /** Each figure's roles on the Figures line: the Roles line's closing word when absent. */
  itemRoles?: string;
  /** Its Scope line's field: "none, same" when absent. */
  scope?: string;
  /** Its Time line's field: "none / none, same" when absent. */
  time?: string;
  /** It replies with one JSON object, as some models do, in place of its lines. */
  json?: true;
  /**
   * It writes its verdict lines beside `cite`, then only its verdict, sentence, Evidence and any
   * Figures line, as Claude Haiku 5.5 split its reply (#1673, #2184).
   */
  split?: true;
  /** The Document's number each figure of the sentence is bound to, when it has one. */
  number?: string;
}

/** The model checks the sentence as `each` says: it cites the quote, then gives its verdict lines. */
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
      const asked = call.prompt.includes(ASKED);
      const roles = asked ? (each.again ?? each.roles) : each.roles;
      const verdictLines = [
        `Verdict: ${each.verdict}`,
        "Absence: no",
        `Scope: ${each.scope ?? "none, same"}`,
        "Topic: found",
        ...(roles === "" ? [] : [`Roles: ${roles}`]),
        `Time: ${each.time ?? "none / none, same"}`,
        SAME_DETAIL,
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
      const lines = each.split
        ? [
            `Verdict: ${each.verdict}`,
            "Absence: no",
            SAME_DETAIL,
            "The Document gives this to the Tenant [^1].",
            "Evidence: [1]",
          ]
        : [
            ...verdictLines,
            "The Document gives this to the Tenant [^1].",
            "Evidence: [1]",
            ...(each.extra ?? []),
          ];
      if (each.json)
        return {
          text: JSON.stringify({
            verdict: each.verdict,
            asserts_absence: false,
            scope: each.scope ?? "same",
            topic: "found",
            roles,
            time: each.time ?? "none / none, same",
            duty: "none / none, same",
            condition: "none / none, same",
            says: "The Document gives this to the Tenant.",
            evidence: [1],
          }),
        };
      const figures = requestedFigures(call);
      if (figures.length === 0) return { text: lines.join("\n") };
      const items = figures.map(({ id }) => ({
        id,
        verdict: each.verdict,
        scope: "same",
        topic: "found",
        roles: each.itemRoles ?? each.roles.split(",").at(-1)?.trim(),
        says: null,
        reading: null,
        relation: "equals",
        source: { citation: 1, number: each.number, reading: null, unitQuote: null },
        calculation: null,
      }));
      return {
        text: `${lines.join("\n")}\nFigures: ${JSON.stringify({ items, remainder: each.remainder ?? null })}`,
      };
    },
    // Both judgements of a contradiction call it a conflict: only the reply's own field can say whose it is.
    {
      generate: checkGenerate({
        [each.sentence]: { judgement: "conflict", strict: { text: "Judgement: conflict" } },
      }),
    },
  );
}

/** How the check's ask for the sentence's own words in its Roles line starts. */
const ASKED = "Your Roles line's first side isn't the sentence's own words";

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
  const span = claimSpans(readMind(setup.client)).find(
    (claim) => claim.sentence.text.trim() === each.sentence,
  );
  return span?.check;
}

describe("a sentence about someone else is Unsupported, never Contradicted or Supported (#1766)", () => {
  test.each<[string, Case, typeof RULES]>([
    [
      "en, contradicted",
      {
        sentence: "The caretaker may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "contradicted",
        roles: "The caretaker may keep a cat / The Tenant may keep a cat, other",
      },
      RULES,
    ],
    [
      "en, supported",
      {
        sentence: "The caretaker may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: "The caretaker may keep a cat / The Tenant may keep a cat, other",
      },
      RULES,
    ],
    [
      "en, a figure",
      {
        sentence: "The caretaker pays the Landlord a rent of 700 per month.",
        quote: "The Tenant pays the Landlord a rent of 900 per month.",
        verdict: "contradicted",
        roles: "The caretaker pays the Landlord / The Tenant pays the Landlord, other",
        number: "900",
      },
      RULES,
    ],
    [
      "zh, contradicted",
      {
        sentence: "物业管理员可在房屋内养猫。",
        quote: "乙方可在房屋内养猫。",
        verdict: "contradicted",
        roles: "物业管理员可在房屋内养猫 / 乙方可在房屋内养猫, other",
      },
      RULES_ZH,
    ],
    [
      "zh, supported",
      {
        sentence: "物业管理员可在房屋内养猫。",
        quote: "乙方可在房屋内养猫。",
        verdict: "supported",
        roles: "物业管理员可在房屋内养猫 / 乙方可在房屋内养猫, other",
      },
      RULES_ZH,
    ],
    [
      "zh, a figure",
      {
        sentence: "物业管理员每月向甲方支付租金人民币700元。",
        quote: "乙方每月向甲方支付租金人民币900元。",
        verdict: "contradicted",
        roles: "物业管理员每月向甲方支付 / 乙方每月向甲方支付, other",
        number: "900",
      },
      RULES_ZH,
    ],
  ])("%s", async (_, each, document) => {
    const checked = await check(each, document);
    expect(checked?.state).toBe("unsupported");
    expect(checked?.state).not.toBe("contradicted");
    expect(checked?.state).not.toBe("supported");
  });

  // The guard reads the reply's own word for whose it is, never the words: the parties the other
  // way round still contradict, and the same parties with another figure still do.
  test.each<[string, Case, typeof RULES]>([
    [
      "en, the parties the other way round",
      {
        sentence: "The Landlord pays the Tenant a rent of 900 per month.",
        quote: "The Tenant pays the Landlord a rent of 900 per month.",
        verdict: "contradicted",
        roles: "The Landlord pays the Tenant / The Tenant pays the Landlord, differs",
        number: "900",
      },
      RULES,
    ],
    [
      "zh, the same parties and another figure",
      {
        sentence: "乙方每月向甲方支付租金人民币700元。",
        quote: "乙方每月向甲方支付租金人民币900元。",
        verdict: "contradicted",
        roles: "乙方每月向甲方支付 / 乙方每月向甲方支付, same",
        number: "900",
      },
      RULES_ZH,
    ],
  ])("%s stays Contradicted", async (_, each, document) => {
    const checked = await check(each, document);
    expect(checked?.state).toBe("contradicted");
    expect(checked?.state).not.toBe("unsupported");
  });
});

describe("a Supported reply whose Roles line gives other words than the sentence's is Not checked (#1766)", () => {
  // The words on the sentence's side of the Roles line must be the sentence's own, in their order,
  // with words left out between them; the Passage's direction or "none" there compared nothing.
  test.each<[string, Case, typeof RULES, "not-checked" | "supported"]>([
    [
      "en, the Passage's direction written for a reversed sentence",
      {
        sentence: "The caretaker reports repairs to the Tenant.",
        quote: "The Tenant reports repairs to the caretaker.",
        verdict: "supported",
        roles:
          "The Tenant reports repairs to the caretaker / The Tenant reports repairs to the caretaker, same",
      },
      RULES,
      "not-checked",
    ],
    [
      "en, none for a sentence's own duty word",
      {
        sentence: "The Tenant should keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: "none / The Tenant may keep a cat, same",
      },
      RULES,
      "not-checked",
    ],
    [
      "en, the sentence's own words with others left out",
      {
        sentence: "Repairs are always reported by the Tenant to the caretaker.",
        quote: "The Tenant reports repairs to the caretaker.",
        verdict: "supported",
        roles:
          "reported by the Tenant to the caretaker / The Tenant reports repairs to the caretaker, same",
      },
      RULES,
      "supported",
    ],
    [
      "zh, the Passage's direction written for a reversed sentence",
      {
        sentence: "物业管理员向乙方报修。",
        quote: "乙方向物业管理员报修。",
        verdict: "supported",
        roles: "乙方向物业管理员报修 / 乙方向物业管理员报修, same",
      },
      RULES_ZH,
      "not-checked",
    ],
    [
      "zh, the sentence's own words with others left out",
      {
        sentence: "乙方每次都向物业管理员报修。",
        quote: "乙方向物业管理员报修。",
        verdict: "supported",
        roles: "乙方 向物业管理员报修 / 乙方向物业管理员报修, same",
      },
      RULES_ZH,
      "supported",
    ],
  ])("%s", async (_, each, document, state) => {
    const checked = await check(each, document);
    expect(checked?.state).toBe(state);
    if (state === "not-checked") expect(checked?.state).not.toBe("supported");
  });
});

describe("a Coverage line that names no member and says the membership isn't known is read (#1766)", () => {
  const coverage = `Coverage: ${JSON.stringify({
    unit: "caretakers",
    quantifier: "all",
    complete: false,
    members: [],
    domainEvidence: [],
  })}`;
  test.each<[string, Case, typeof RULES]>([
    [
      "en, unsupported",
      {
        sentence: "Every caretaker may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "unsupported",
        roles: "Every caretaker may keep a cat / The Tenant may keep a cat, other",
        extra: [coverage],
      },
      RULES,
    ],
    [
      "en, supported",
      {
        sentence: "Every caretaker may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: "Every caretaker may keep a cat / The Tenant may keep a cat, same",
        extra: [coverage],
      },
      RULES,
    ],
    [
      "zh, unsupported",
      {
        sentence: "所有物业管理员都可在房屋内养猫。",
        quote: "乙方可在房屋内养猫。",
        verdict: "unsupported",
        roles: "所有物业管理员都可在房屋内养猫 / 乙方可在房屋内养猫, other",
        extra: [coverage],
      },
      RULES_ZH,
    ],
  ])("%s is Unsupported", async (_, each, document) => {
    const checked = await check(each, document);
    expect(checked?.state).toBe("unsupported");
    expect(checked?.state).not.toBe("supported");
  });
});

describe("asked once for the sentence's own words, a reply is judged on them (#1766)", () => {
  const asks = (calls: readonly ModelCall[]) => calls.filter((call) => call.prompt.includes(ASKED));
  test.each<[string, Case, typeof RULES, "supported" | "unsupported"]>([
    [
      "en, should for may, copied once asked",
      {
        sentence: "The Tenant should keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: "none / The Tenant may keep a cat, same",
        again: "The Tenant should keep a cat / The Tenant may keep a cat, differs",
      },
      RULES,
      "unsupported",
    ],
    [
      "zh, the reversed parties, copied once asked",
      {
        sentence: "物业管理员向乙方报修。",
        quote: "乙方向物业管理员报修。",
        verdict: "supported",
        roles: "乙方向物业管理员报修 / 乙方向物业管理员报修, same",
        again: "物业管理员向乙方报修 / 乙方向物业管理员报修, differs",
      },
      RULES_ZH,
      "unsupported",
    ],
    [
      "en, a faithful sentence copied once asked",
      {
        sentence: "Repairs are always reported by the Tenant to the caretaker.",
        quote: "The Tenant reports repairs to the caretaker.",
        verdict: "supported",
        roles: "The Tenant reports repairs / The Tenant reports repairs to the caretaker, same",
        again:
          "reported by the Tenant to the caretaker / The Tenant reports repairs to the caretaker, same",
      },
      RULES,
      "supported",
    ],
  ])("%s", async (_, each, document, state) => {
    const calls: ModelCall[] = [];
    const checked = await check(each, document, calls);
    expect(checked?.state).toBe(state);
    expect(asks(calls)).toHaveLength(1);
  });

  test("a reply that gives the sentence's own words is asked nothing", async () => {
    const calls: ModelCall[] = [];
    const checked = await check(
      {
        sentence: "乙方每次都向物业管理员报修。",
        quote: "乙方向物业管理员报修。",
        verdict: "supported",
        roles: "乙方 向物业管理员报修 / 乙方向物业管理员报修, same",
      },
      RULES_ZH,
      calls,
    );
    expect(checked?.state).toBe("supported");
    expect(asks(calls)).toHaveLength(0);
  });
});

describe("the Roles line's closing word decides, and a one-sided line names no words of the sentence (#1766)", () => {
  test.each<[string, Case, typeof RULES, "contradicted" | "unsupported" | "not-checked"]>([
    [
      "en, a reason in brackets after differs",
      {
        sentence: "The Landlord pays the Tenant a rent of 900 per month.",
        quote: "The Tenant pays the Landlord a rent of 900 per month.",
        verdict: "contradicted",
        roles:
          "The Landlord pays the Tenant / The Tenant pays the Landlord, differs (the other way round)",
        itemRoles: "differs",
        number: "900",
      },
      RULES,
      "contradicted",
    ],
    [
      "zh, a reason in brackets after differs",
      {
        sentence: "物业管理员向乙方报修。",
        quote: "乙方向物业管理员报修。",
        verdict: "contradicted",
        roles: "物业管理员向乙方报修 / 乙方向物业管理员报修, differs（the other way round）",
      },
      RULES_ZH,
      "contradicted",
    ],
    [
      "en, figures bound as the same parties' though the Roles line says other",
      {
        sentence: "The caretaker pays the Landlord a rent of 700 per month.",
        quote: "The Tenant pays the Landlord a rent of 900 per month.",
        verdict: "contradicted",
        roles: "The caretaker pays the Landlord / The Tenant pays the Landlord, other",
        itemRoles: "same",
        number: "900",
      },
      RULES,
      "unsupported",
    ],
    [
      "zh, figures bound as the same parties' though the Roles line says other",
      {
        sentence: "物业管理员每月向甲方支付租金人民币700元。",
        quote: "乙方每月向甲方支付租金人民币900元。",
        verdict: "contradicted",
        roles: "物业管理员每月向甲方支付 / 乙方每月向甲方支付, other",
        itemRoles: "same",
        number: "900",
      },
      RULES_ZH,
      "unsupported",
    ],
    [
      "en, a Supported reply whose one-sided Roles line gives the Passage's words",
      {
        sentence: "The Tenant should keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: "The Tenant may keep a cat, same",
      },
      RULES,
      "not-checked",
    ],
    [
      "zh, a Supported reply whose sides have no spaces round the slash",
      {
        sentence: "物业管理员向乙方报修。",
        quote: "乙方向物业管理员报修。",
        verdict: "supported",
        roles: "乙方向物业管理员报修/乙方向物业管理员报修, same",
      },
      RULES_ZH,
      "not-checked",
    ],
  ])("%s", async (_, each, document, state) => {
    const checked = await check(each, document);
    expect(checked?.state).toBe(state);
    if (state !== "contradicted") expect(checked?.state).not.toBe("contradicted");
    expect(checked?.state).not.toBe("supported");
  });
});

describe("a Roles line that names no party and no must or may on either side holds nothing back (#1766)", () => {
  // A figure's sentence often names neither: the guard is for words given as the sentence's.
  test.each<[string, Case, typeof RULES]>([
    [
      "en",
      {
        sentence: "The rent is 900 per month.",
        quote: "The Tenant pays the Landlord a rent of 900 per month.",
        verdict: "supported",
        roles: "none / none, same",
        number: "900",
      },
      RULES,
    ],
    [
      "zh",
      {
        sentence: "租金为每月人民币900元。",
        quote: "乙方每月向甲方支付租金人民币900元。",
        verdict: "supported",
        roles: "无 / 无, same",
        number: "900",
      },
      RULES_ZH,
    ],
  ])("%s: Supported, asked nothing", async (_, each, document) => {
    const calls: ModelCall[] = [];
    const checked = await check(each, document, calls);
    expect(checked?.state).toBe("supported");
    expect(calls.filter((call) => call.prompt.includes(ASKED))).toHaveLength(0);
  });
});

describe("once asked for the sentence's own words, a reply that gives none is Not checked (#1766)", () => {
  const asks = (calls: readonly ModelCall[]) => calls.filter((call) => call.prompt.includes(ASKED));
  test.each<[string, Case, typeof RULES]>([
    [
      "en, no Roles line after the ask",
      {
        sentence: "The Tenant should keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: "none / The Tenant may keep a cat, same",
        again: "",
      },
      RULES,
    ],
    [
      "en, none on both sides after the ask",
      {
        sentence: "The Tenant should keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: "none / The Tenant may keep a cat, same",
        again: "none / none, same",
      },
      RULES,
    ],
    [
      "zh, no Roles line after the ask",
      {
        sentence: "物业管理员向乙方报修。",
        quote: "乙方向物业管理员报修。",
        verdict: "supported",
        roles: "乙方向物业管理员报修 / 乙方向物业管理员报修, same",
        again: "",
      },
      RULES_ZH,
    ],
    [
      "en, a figure sentence that gives none on both sides after the ask",
      {
        sentence: "The Tenant should pay the Landlord a rent of 900 per month.",
        quote: "The Tenant pays the Landlord a rent of 900 per month.",
        verdict: "supported",
        roles: "The Tenant pays the Landlord / The Tenant pays the Landlord, same",
        again: "none / none, same",
        number: "900",
      },
      RULES,
    ],
    [
      "zh, none on both sides for a sentence whose Scope line names its party",
      {
        sentence: "物业管理员向乙方报修。",
        quote: "乙方向物业管理员报修。",
        verdict: "supported",
        roles: "无 / 无, same",
        scope: "物业管理员, same",
      },
      RULES_ZH,
    ],
    [
      "zh, a figure sentence whose Scope line names its party, none on both sides",
      {
        sentence: "甲方每月向乙方支付租金人民币900元。",
        quote: "乙方每月向甲方支付租金人民币900元。",
        verdict: "supported",
        roles: "无 / 无, same",
        scope: "甲方, same",
        number: "900",
        remainder: {
          text: "甲方每月向乙方支付租金",
          verdict: "supported",
          scope: "same",
          topic: "found",
          roles: "same",
          says: null,
          citation: 1,
        },
      },
      RULES_ZH,
    ],
    [
      "en, a figure sentence whose Roles line gives the Passage's words",
      {
        sentence: "The Tenant should pay the Landlord a rent of 900 per month.",
        quote: "The Tenant pays the Landlord a rent of 900 per month.",
        verdict: "supported",
        roles: "The Tenant pays the Landlord / The Tenant pays the Landlord, same",
        number: "900",
      },
      RULES,
    ],
  ])("%s", async (_, each, document) => {
    const calls: ModelCall[] = [];
    const checked = await check(each, document, calls);
    expect(checked?.state).toBe("not-checked");
    expect(checked?.state).not.toBe("supported");
    expect(asks(calls)).toHaveLength(1);
  });

  test("a figure sentence whose Roles line copies its own words is Supported and asked nothing", async () => {
    const calls: ModelCall[] = [];
    const checked = await check(
      {
        sentence: "The Tenant pays the Landlord a rent of 900 per month.",
        quote: "The Tenant pays the Landlord a rent of 900 per month.",
        verdict: "supported",
        roles: "The Tenant pays the Landlord / The Tenant pays the Landlord, same",
        number: "900",
      },
      RULES,
      calls,
    );
    expect(checked?.state).toBe("supported");
    expect(asks(calls)).toHaveLength(0);
  });
});

describe("the Roles line's closing word is read past its quoting and its reason (#1766)", () => {
  const OTHER = "The caretaker may keep a cat / The Tenant may keep a cat";
  test.each<[string, Case, typeof RULES, "unsupported" | "contradicted"]>([
    [
      "in backticks",
      {
        sentence: "The caretaker may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: `${OTHER}, \`other\``,
      },
      RULES,
      "unsupported",
    ],
    [
      "before a semicolon",
      {
        sentence: "The caretaker may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: `${OTHER}, other;`,
      },
      RULES,
      "unsupported",
    ],
    [
      "in full-width letters",
      {
        sentence: "The caretaker may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: `${OTHER}, ｏｔｈｅｒ`,
      },
      RULES,
      "unsupported",
    ],
    [
      "with a reason after a colon",
      {
        sentence: "The caretaker may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: `${OTHER}, other: the Passage gives the same right only to the Tenant`,
      },
      RULES,
      "unsupported",
    ],
    [
      "with a reason after a dash, on a contradiction",
      {
        sentence: "The caretaker may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "contradicted",
        roles: `${OTHER}, other — the Passage names only the Tenant`,
      },
      RULES,
      "unsupported",
    ],
    ...["— other", ": other", "(other)", "→ other", "、other", "— other, not the same party"].map(
      (closing): [string, Case, typeof RULES, "unsupported"] => [
        `after “${closing}”`,
        {
          sentence: "The caretaker may keep a cat in the flat.",
          quote: "The Tenant may keep a cat in the flat.",
          verdict: "supported",
          roles: `${OTHER} ${closing}`,
        },
        RULES,
        "unsupported",
      ],
    ),
    [
      "with a reason that holds a slash",
      {
        sentence: "The caretaker may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: `${OTHER}, other (the Tenant/the caretaker)`,
      },
      RULES,
      "unsupported",
    ],
    [
      "zh, with a reason after a colon",
      {
        sentence: "物业管理员可在房屋内养猫。",
        quote: "乙方可在房屋内养猫。",
        verdict: "supported",
        roles: "物业管理员可在房屋内养猫 / 乙方可在房屋内养猫, other：文件只给了乙方",
      },
      RULES_ZH,
      "unsupported",
    ],
    [
      '"the other" in a side is no closing word',
      {
        sentence: "The Landlord reports repairs to the other party.",
        quote: "The Tenant reports repairs to the caretaker.",
        verdict: "contradicted",
        roles:
          "The Landlord reports repairs to the other party / The Tenant reports repairs to the caretaker, differs",
      },
      RULES,
      "contradicted",
    ],
  ])("%s", async (_, each, document, state) => {
    const checked = await check(each, document);
    expect(checked?.state).toBe(state);
    expect(checked?.state).not.toBe("supported");
  });
});

describe("a figure sentence the Roles line gives to someone else: its other words decide nothing either (#1766)", () => {
  const remainder = (text: string) => ({
    text,
    verdict: "contradicted",
    scope: "same",
    topic: "found",
    roles: "same",
    says: null,
    citation: 1,
  });
  test.each<[string, Case, typeof RULES, "unsupported" | "contradicted"]>([
    [
      "en, someone else's: Unsupported",
      {
        sentence: "The caretaker pays the Landlord a rent of 900 per week.",
        quote: "The Tenant pays the Landlord a rent of 900 per month.",
        verdict: "supported",
        roles: "The caretaker pays the Landlord / The Tenant pays the Landlord, other",
        itemRoles: "same",
        number: "900",
        remainder: remainder("per week"),
      },
      RULES,
      "unsupported",
    ],
    [
      "en, the same parties': Contradicted",
      {
        sentence: "The Tenant pays the Landlord a rent of 900 per week.",
        quote: "The Tenant pays the Landlord a rent of 900 per month.",
        verdict: "supported",
        roles: "The Tenant pays the Landlord / The Tenant pays the Landlord, same",
        number: "900",
        remainder: remainder("per week"),
      },
      RULES,
      "contradicted",
    ],
    [
      "zh, someone else's: Unsupported",
      {
        sentence: "物业管理员每周向甲方支付租金人民币900元。",
        quote: "乙方每月向甲方支付租金人民币900元。",
        verdict: "supported",
        roles: "物业管理员每周向甲方支付 / 乙方每月向甲方支付, other",
        itemRoles: "same",
        number: "900",
        remainder: remainder("每周"),
      },
      RULES_ZH,
      "unsupported",
    ],
    [
      "zh, the same parties': Contradicted",
      {
        sentence: "乙方每周向甲方支付租金人民币900元。",
        quote: "乙方每月向甲方支付租金人民币900元。",
        verdict: "supported",
        roles: "乙方每周向甲方支付 / 乙方每月向甲方支付, same",
        number: "900",
        remainder: remainder("每周"),
      },
      RULES_ZH,
      "contradicted",
    ],
  ])("%s", async (_, each, document, state) => {
    const checked = await check(each, document);
    expect(checked?.state).toBe(state);
    expect(checked?.state).not.toBe("supported");
  });
});

describe("a closing word is read only where it closes the field (#1766)", () => {
  const NOTICE = {
    name: "Notice.md",
    contents:
      "# Notice\n\nEach party may notify the other in writing.\n\nOther tenants may use the garden.\n",
  };
  test.each<[string, Case, "supported" | "contradicted"]>([
    [
      "a line with no closing word whose sides end with “the other” stays Contradicted",
      {
        sentence: "Each party must notify the other in writing.",
        quote: "Each party may notify the other in writing.",
        verdict: "contradicted",
        roles: "Each party must notify the other / Each party may notify the other",
      },
      "contradicted",
    ],
    [
      "a Passage side that starts with “Other” stays Supported",
      {
        sentence: "Other tenants may use the garden.",
        quote: "Other tenants may use the garden.",
        verdict: "supported",
        roles: "Other tenants may use the garden / Other tenants may use the garden, same",
      },
      "supported",
    ],
  ])("%s", async (_, each, state) => {
    const checked = await check(each, NOTICE);
    expect(checked?.state).toBe(state);
    expect(checked?.state).not.toBe("unsupported");
  });

  test.each<[string, string, "supported" | "unsupported"]>([
    [
      "differs, then a reason that says “same”",
      "already / from next year, differs (not the same)",
      "unsupported",
    ],
    ["same, then a reason", "already / already, same (as the Passage)", "supported"],
    [
      "differs, then a reason in full-width brackets",
      "已 / 明年起, differs（不是同一时间）",
      "unsupported",
    ],
  ])("a Time line: %s", async (_, time, state) => {
    const checked = await check(
      {
        sentence: "The Tenant may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: "The Tenant may keep a cat / The Tenant may keep a cat, same",
        time,
      },
      RULES,
    );
    expect(checked?.state).toBe(state);
    expect(checked?.state).not.toBe(state === "supported" ? "unsupported" : "supported");
  });

  test("a Roles line too long for its sides to be copied words is no support", async () => {
    const calls: ModelCall[] = [];
    const checked = await check(
      {
        sentence: "The Tenant may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: `The Tenant may keep a cat / ${"the Tenant may keep a cat, ".repeat(80)}same`,
      },
      RULES,
      calls,
    );
    expect(checked?.state).toBe("not-checked");
    expect(checked?.state).not.toBe("supported");
    expect(calls.filter((call) => call.prompt.includes(ASKED))).toHaveLength(1);
  });
});

describe("the Roles line read in the shapes a model gives it (#1766)", () => {
  const calls: ModelCall[] = [];
  const asks = () => calls.filter((call) => call.prompt.includes(ASKED));
  test.each<[string, Case, typeof RULES, "supported" | "unsupported", number]>([
    [
      "a Passage side that starts with “same-day” is no closing word",
      {
        sentence: "The Tenant may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: "The Tenant may keep a cat / same-day notice must be given by the Tenant, differs",
      },
      RULES,
      "unsupported",
      0,
    ],
    [
      "a Time line whose Passage side starts with “same-day” differs",
      {
        sentence: "The Tenant may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: "The Tenant may keep a cat / The Tenant may keep a cat, same",
        time: "already / same-day, differs",
      },
      RULES,
      "unsupported",
      0,
    ],
    [
      "a JSON reply whose roles are a closing word alone, as with no Roles line",
      {
        sentence: "The Tenant may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: "same",
        scope: "the Tenant, same",
        json: true,
      },
      RULES,
      "supported",
      0,
    ],
    [
      "a JSON reply whose roles give the sentence's words",
      {
        sentence: "乙方可在房屋内养猫。",
        quote: "乙方可在房屋内养猫。",
        verdict: "supported",
        roles: "乙方可在房屋内养猫 / 乙方可在房屋内养猫, same",
        json: true,
      },
      RULES_ZH,
      "supported",
      0,
    ],
    [
      "a JSON reply whose roles give the Passage's direction",
      {
        sentence: "物业管理员向乙方报修。",
        quote: "乙方向物业管理员报修。",
        verdict: "supported",
        roles: "乙方向物业管理员报修 / 乙方向物业管理员报修, same",
        again: "物业管理员向乙方报修 / 乙方向物业管理员报修, differs",
        json: true,
      },
      RULES_ZH,
      "unsupported",
      1,
    ],
    [
      "the sentence's words copied with its Citation marker",
      {
        sentence: "The Tenant may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: "The Tenant may keep a cat [1] / The Tenant may keep a cat, same",
      },
      RULES,
      "supported",
      0,
    ],
    [
      "a figure the Figures line gives to someone else, under a Roles line that says same",
      {
        sentence: "The Tenant pays the Landlord a rent of 900 per month.",
        quote: "The Tenant pays the Landlord a rent of 900 per month.",
        verdict: "supported",
        roles: "The Tenant pays the Landlord / The Tenant pays the Landlord, same",
        itemRoles: "other",
        number: "900",
      },
      RULES,
      "unsupported",
      0,
    ],
    [
      "a Coverage line that names no member, for the Passage's own parties",
      {
        sentence: "Every tenant may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "unsupported",
        roles: "Every tenant may keep a cat / The Tenant may keep a cat, same",
        extra: [
          `Coverage: ${JSON.stringify({
            unit: "tenants",
            quantifier: "all",
            complete: false,
            members: [],
            domainEvidence: [],
          })}`,
        ],
      },
      RULES,
      "unsupported",
      0,
    ],
  ])("%s", async (_, each, document, state, asked) => {
    calls.length = 0;
    const checked = await check(each, document, calls);
    expect(checked?.state).toBe(state);
    expect(checked?.state).not.toBe(state === "supported" ? "not-checked" : "supported");
    expect(asks()).toHaveLength(asked);
  });
});

describe("a reply split across turns keeps the fields its last turn leaves out (#1766)", () => {
  test.each<[string, Case, typeof RULES, "unsupported" | "contradicted"]>([
    [
      "en, someone else's, contradicted in both turns",
      {
        sentence: "The caretaker may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "contradicted",
        roles: "The caretaker may keep a cat / The Tenant may keep a cat, other",
        split: true,
      },
      RULES,
      "unsupported",
    ],
    [
      "zh, someone else's, contradicted in both turns",
      {
        sentence: "物业管理员可在房屋内养猫。",
        quote: "乙方可在房屋内养猫。",
        verdict: "contradicted",
        roles: "物业管理员可在房屋内养猫 / 乙方可在房屋内养猫, other",
        split: true,
      },
      RULES_ZH,
      "unsupported",
    ],
    [
      "en, someone else's, supported in both turns",
      {
        sentence: "The caretaker may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: "The caretaker may keep a cat / The Tenant may keep a cat, other",
        split: true,
      },
      RULES,
      "unsupported",
    ],
    [
      "en, someone else's figure, its Figures line in the last turn",
      {
        sentence: "The caretaker pays the Landlord a rent of 700 per month.",
        quote: "The Tenant pays the Landlord a rent of 900 per month.",
        verdict: "contradicted",
        roles: "The caretaker pays the Landlord / The Tenant pays the Landlord, other",
        itemRoles: "same",
        number: "900",
        split: true,
      },
      RULES,
      "unsupported",
    ],
    [
      "zh, someone else's figure, its Figures line in the last turn",
      {
        sentence: "物业管理员每月向甲方支付租金人民币700元。",
        quote: "乙方每月向甲方支付租金人民币900元。",
        verdict: "contradicted",
        roles: "物业管理员每月向甲方支付 / 乙方每月向甲方支付, other",
        itemRoles: "same",
        number: "900",
        split: true,
      },
      RULES_ZH,
      "unsupported",
    ],
    [
      "en, a Time line that differs, written beside cite",
      {
        sentence: "The Tenant may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: "The Tenant may keep a cat / The Tenant may keep a cat, same",
        time: "already / from next year, differs",
        split: true,
      },
      RULES,
      "unsupported",
    ],
    [
      "en, the same parties' figure, contradicted in both turns",
      {
        sentence: "The Tenant pays the Landlord a rent of 700 per month.",
        quote: "The Tenant pays the Landlord a rent of 900 per month.",
        verdict: "contradicted",
        roles: "The Tenant pays the Landlord / The Tenant pays the Landlord, same",
        number: "900",
        split: true,
      },
      RULES,
      "contradicted",
    ],
  ])("%s", async (_, each, document, state) => {
    const checked = await check(each, document);
    expect(checked?.state).toBe(state);
    expect(checked?.state).not.toBe("supported");
  });

  test("a split reply naming nothing in Roles, its Scope naming the party beside cite, is asked", async () => {
    const calls: ModelCall[] = [];
    const checked = await check(
      {
        sentence: "The Tenant should keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: "none / none, same",
        scope: "the Tenant, same",
        split: true,
      },
      RULES,
      calls,
    );
    expect(checked?.state).toBe("not-checked");
    expect(checked?.state).not.toBe("supported");
    expect(calls.filter((call) => call.prompt.includes(ASKED))).toHaveLength(1);
  });

  test("a split reply whose own words are the sentence's stays Supported", async () => {
    const checked = await check(
      {
        sentence: "The Tenant may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat.",
        verdict: "supported",
        roles: "The Tenant may keep a cat / The Tenant may keep a cat, same",
        split: true,
      },
      RULES,
    );
    expect(checked?.state).toBe("supported");
  });
});

describe("the Passage's own words after a comma are no closing word (#1766, #2311)", () => {
  const LODGINGS = {
    name: "Lodgings.md",
    contents: [
      "# Lodgings",
      "",
      "The Tenant, same as any lodger, may keep a cat in the flat.",
      "",
      "The boiler will be replaced in May, same as the radiators.",
      "",
      "No party, other than the Tenant, may sublet the flat.",
      "",
      "The Tenant may keep a cat in the flat; other pets need the Landlord's consent.",
      "",
    ].join("\n"),
  };
  test.each<[string, Case, "supported" | "unsupported" | "contradicted"]>([
    [
      "“same as any lodger” in the Passage's side, must for may",
      {
        sentence: "The Tenant must keep a cat in the flat.",
        quote: "The Tenant, same as any lodger, may keep a cat in the flat.",
        verdict: "supported",
        roles:
          "The Tenant must keep a cat / The Tenant, same as any lodger, may keep a cat, differs",
      },
      "unsupported",
    ],
    [
      "“same as the radiators” in a Time line that differs",
      {
        sentence: "The boiler has already been replaced.",
        quote: "The boiler will be replaced in May, same as the radiators.",
        verdict: "supported",
        roles: "The boiler has already been replaced / The boiler will be replaced, same",
        time: "already been replaced / will be replaced in May, same as the radiators, differs",
      },
      "unsupported",
    ],
    [
      "“other than the Tenant” in a contradiction",
      {
        sentence: "The Landlord may sublet the flat.",
        quote: "No party, other than the Tenant, may sublet the flat.",
        verdict: "contradicted",
        roles: "The Landlord may sublet / No party, other than the Tenant, may sublet, differs",
      },
      "contradicted",
    ],
    [
      "“; other pets” in a true sentence's Passage side",
      {
        sentence: "The Tenant may keep a cat in the flat.",
        quote: "The Tenant may keep a cat in the flat; other pets need the Landlord's consent.",
        verdict: "supported",
        roles:
          "The Tenant may keep a cat / The Tenant may keep a cat; other pets need the Landlord's consent, same",
      },
      "supported",
    ],
  ])("%s", async (_, each, state) => {
    const checked = await check(each, LODGINGS);
    expect(checked?.state).toBe(state);
    if (state !== "supported") expect(checked?.state).not.toBe("supported");
    else expect(checked?.state).not.toBe("unsupported");
  });

  test("“N/A” on both sides names nothing, for a sentence of figures", async () => {
    const calls: ModelCall[] = [];
    const checked = await check(
      {
        sentence: "The rent is 900 per month.",
        quote: "The Tenant pays the Landlord a rent of 900 per month.",
        verdict: "supported",
        roles: "N/A / N/A, same",
        number: "900",
      },
      RULES,
      calls,
    );
    expect(checked?.state).toBe("supported");
    expect(calls.filter((call) => call.prompt.includes(ASKED))).toHaveLength(0);
  });
});
