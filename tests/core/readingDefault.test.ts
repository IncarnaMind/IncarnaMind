/**
 * A unit line's Document default is no condition (#2889): in the check of a sentence that names a
 * unit, a Supported reply whose one Condition is its Document's "unless otherwise stated" keeps its
 * Supported. Any other condition still takes it away, a sentence that names no unit is read as
 * written, and a reply that isn't Supported never becomes one.
 */
import { describe, expect, test } from "vitest";
import { readVerdict, withReadingDefault } from "../../src/core/answers/checks/prompt";
import { checkingModel, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";

const reply = (verdict: string, condition: string) =>
  [
    `Verdict: ${verdict}`,
    "Absence: no",
    "Scope: none, same",
    "Topic: found",
    "Roles: Figures are in GBP million / All figures in GBP million, same",
    "Time: none / none, same",
    "Duty: none / none, same",
    `Condition: ${condition}`,
    "The report gives its figures in GBP million. [^1]",
    "Evidence: [1]",
  ].join("\n");

const DEFAULTS = [
  "none / unless otherwise stated, differs",
  "none / unless otherwise stated, same",
  "none / except where noted, differs",
  "none / All figures in GBP million unless stated otherwise, differs",
  "none / 除另有说明外, differs",
  "none / 如无特别说明, differs",
];

const CONDITIONS = [
  "none / unless otherwise agreed in writing, differs",
  "none / except as otherwise provided in Schedule 2, differs",
  "none / only with the Landlord's consent unless otherwise stated, differs",
  "none / provided it gives 30 days' notice, differs",
  "none / 除非双方另有约定, differs",
  "none / 除合同另有规定外, differs",
  "none / 经出租人同意后, differs",
  "after notice / unless otherwise stated, differs",
];

describe("withReadingDefault", () => {
  // protects=a Supported reply whose one Condition is its Document's default for reading figures, in English and Chinese, written "differs" or "same", reads as no condition; fails_when="unless otherwise stated" still takes the judge's Supported away; no_claim=whether a sentence names a unit, which the check decides.
  test.each(DEFAULTS)("Supported, Condition: %s", (condition) => {
    const before = readVerdict(reply("supported", condition));
    const after = readVerdict(withReadingDefault(reply("supported", condition)));
    expect(before?.condition).not.toBe("same");
    expect(after).toMatchObject({ verdict: "supported", condition: "same" });
  });

  // protects=any other condition, an "otherwise agreed" or "otherwise provided" one included, and one the sentence states itself, still takes the Supported away; fails_when=a dropped condition beside a default reads as none; no_claim=none beyond protects.
  test.each(CONDITIONS)("Supported, Condition: %s, is left as it is", (condition) => {
    expect(withReadingDefault(reply("supported", condition))).toBe(reply("supported", condition));
  });

  // protects=no reply that isn't Supported is changed, so none becomes Supported; fails_when=a Contradicted or Unsupported reply is rewritten or reads Supported; no_claim=none beyond protects.
  test.each(
    (["unsupported", "contradicted"] as const).flatMap((verdict) =>
      [...DEFAULTS, ...CONDITIONS].map((condition) => ({ verdict, condition })),
    ),
  )("$verdict, Condition: $condition, never becomes Supported", ({ verdict, condition }) => {
    const text = reply(verdict, condition);
    expect(withReadingDefault(text)).toBe(text);
    expect(readVerdict(withReadingDefault(text))?.verdict).toBe(verdict);
  });
});

describe("a unit line's check reads its Document's default as none", () => {
  const DOCUMENT = {
    name: "Westfield report.txt",
    contents:
      "Westfield report\nAll figures in GBP million unless otherwise stated\nRevenue 100.5\n",
  };
  const plan = (condition: string, verdict: Plan["verdict"] = "supported"): Plan => ({
    verdict,
    quote: "All figures in GBP million unless otherwise stated",
    says: `Condition: ${condition}\nThe report gives its figures in GBP million.`,
  });
  const check = async (claim: string, planned: Plan) => {
    const { core } = await setUpWithDocuments(checkingModel({ [claim]: planned }), [DOCUMENT]);
    const result = await core.checkClaim({ claim });
    core.close();
    return result;
  };

  // protects=the judge's own Supported on a unit line stands when its one Condition is the Document's "unless otherwise stated"; fails_when=it reads Unsupported; no_claim=a real model's verdict, which tests/live/defaultUnits.live.test.ts measures.
  test("Figures are in GBP million: Supported", async () => {
    const result = await check(
      "Figures are in GBP million, as the report gives them.",
      plan("none / unless otherwise stated, differs"),
    );
    expect(result.verdict).toBe("supported");
  });

  // protects=a sentence that names no unit is read as written, and another condition in a unit line's check still takes the Supported away; fails_when=either reads Supported; no_claim=none beyond protects.
  test.each([
    [
      "The Tenant may sublet the flat, as the report gives it.",
      "none / unless otherwise stated, differs",
    ],
    [
      "Figures are in GBP million, as the report gives them.",
      "none / unless otherwise agreed, differs",
    ],
  ])("%s with Condition %s: not Supported", async (claim, condition) => {
    const result = await check(claim, plan(condition));
    expect(result.verdict).not.toBe("supported");
  });

  // protects=the judge's Unsupported or Contradicted on a unit line is never turned into Supported, whatever its Condition says; fails_when=code gives a Supported the judge didn't; no_claim=none beyond protects.
  test.each(["unsupported", "contradicted"] as const)(
    "judged %s: never Supported",
    async (verdict) => {
      const result = await check(
        "Figures are in GBP million, as the report gives them.",
        plan("none / unless otherwise stated, differs", verdict),
      );
      expect(result.verdict).not.toBe("supported");
    },
  );
});
