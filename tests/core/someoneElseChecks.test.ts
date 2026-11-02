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
  /** Its Roles line once asked for the sentence's own words; the same line again when absent. */
  again?: string;
  /** Each figure's roles on the Figures line: the Roles line's closing word when absent. */
  itemRoles?: string;
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
      if (!call.results.some((result) => result.tool === "cite")) {
        const passage = shownPassages(searched.at(-1)?.text ?? "").find((shown) =>
          shown.text.includes(each.quote),
        );
        return {
          calls: [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage: passage?.id, quote: each.quote }] },
            },
          ],
        };
      }
      const asked = call.prompt.includes(ASKED);
      const lines = [
        `Verdict: ${each.verdict}`,
        "Absence: no",
        "Scope: none, same",
        "Topic: found",
        `Roles: ${asked ? (each.again ?? each.roles) : each.roles}`,
        "Time: none / none, same",
        "The Document gives this to the Tenant [^1].",
        "Evidence: [1]",
        ...(each.extra ?? []),
      ];
      const figures = requestedFigures(call);
      if (figures.length === 0) return { text: lines.join("\n") };
      const roles = each.itemRoles ?? each.roles.split(",").at(-1)?.trim();
      const items = figures.map(({ id }) => ({
        id,
        verdict: each.verdict,
        scope: "same",
        topic: "found",
        roles,
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
