import { describe, expect, test } from "vitest";
import type { Citation, CitationAttributes, ClaimCheckAttributes } from "../../src/core";
import { readChangeLines } from "../../src/core/answers/checks/prompt";
import { REWRITE_INSTRUCTIONS, rewriteOf } from "../../src/core/answers/checks/rewrite";
import { setUpWithDocuments } from "../helpers/citations";
import { writeMind } from "../helpers/minds";
import { type GenerateCall, scriptedModel } from "../helpers/models";

/*
 * Rewrite with what the Documents say (#1554): the model names the old words and the quote's,
 * and only a rewrite whose words and figures are all the quote's is kept.
 */

const LEASE = "The Tenant shall pay a monthly rent of $14,250, due on the first day of each month.";
const NO_DATE = () => null;

const quoted = (quote: string): Citation => ({
  passageId: "passage-lease",
  documentId: "lease",
  documentName: "Office lease",
  contentHash: "hash-lease",
  pageFrom: null,
  pageTo: null,
  location: null,
  quote,
  check: "found",
  checkReason: null,
});

const rewritten = (sentence: string, reply: string, quote = LEASE) =>
  rewriteOf(sentence, reply, quoted(quote), NO_DATE);

describe("A rewrite's reply", () => {
  test("is read as one change, its old words and the quote's", () => {
    expect(readChangeLines("Change 1: $12,500\nTo 1: $14,250")).toEqual({
      from: "$12,500",
      choices: [{ wording: "$14,250", marker: 1 }],
    });
    expect(readChangeLines("The lease gives another rent.")).toBeNull();
  });

  test("names the quote's words for the sentence's, as a correction does", () => {
    expect(REWRITE_INSTRUCTIONS).toContain('"Change 1: "');
    expect(REWRITE_INSTRUCTIONS).toContain('"To 1: "');
  });
});

describe("A rewrite is kept", () => {
  test("when the quote holds its words and every figure of the sentence it makes", () => {
    expect(
      rewritten("The Tenant pays a monthly rent of $12,500.", "Change 1: $12,500\nTo 1: $14,250"),
    ).toEqual({
      kind: "rewritten",
      correction: { from: "$12,500", choices: [{ wording: "$14,250", evidence: quoted(LEASE) }] },
    });
  });

  test("in Chinese too", () => {
    expect(
      rewritten(
        "每位员工每年享有 10 天带薪年假。",
        "Change 1: 10\nTo 1: 15",
        "每位员工每年享有 15 天带薪年假。",
      ),
    ).toMatchObject({
      kind: "rewritten",
      correction: { from: "10", choices: [{ wording: "15" }] },
    });
  });
});

describe("A rewrite is refused, and the sentence kept", () => {
  test("when the sentence it makes still gives a figure the quote doesn't, in another clause too", () => {
    expect(
      rewritten(
        "The Tenant pays a monthly rent of $12,500; the building has 3 floors.",
        "Change 1: $12,500\nTo 1: $14,250",
      ),
    ).toEqual({ kind: "kept" });
    expect(
      rewritten(
        "每位员工每年享有 10 天带薪年假，另有 5 天病假。",
        "Change 1: 10\nTo 1: 15",
        "每位员工每年享有 15 天带薪年假。",
      ),
    ).toEqual({ kind: "kept" });
    expect(
      rewritten(
        "The Tenant pays a monthly rent of $12,500 for 3 floors.",
        "Change 1: $12,500\nTo 1: $14,250",
      ),
    ).toEqual({ kind: "kept" });
    // The quote's number in another currency is not the quote's figure.
    expect(
      rewritten(
        "The Tenant pays a monthly rent of $12,500; the deposit is €14,250.",
        "Change 1: $12,500\nTo 1: $14,250",
      ),
    ).toEqual({ kind: "kept" });
    // The same change, with no other figure, is kept.
    expect(
      rewritten("The Tenant pays a monthly rent of $12,500.", "Change 1: $12,500\nTo 1: $14,250"),
    ).toMatchObject({ kind: "rewritten" });
  });

  test("when its words aren't the quote's", () => {
    expect(
      rewritten("The Tenant pays a monthly rent of $12,500.", "Change 1: $12,500\nTo 1: $15,000"),
    ).toEqual({ kind: "kept" });
  });

  test("when the sentence names a period the quote doesn't", () => {
    expect(
      rewritten("In 2025 the monthly rent was $12,500.", "Change 1: $12,500\nTo 1: $14,250"),
    ).toEqual({ kind: "kept" });
  });

  test("when the reply says nothing differs, or gives two choices", () => {
    expect(
      rewritten("The Tenant pays a monthly rent of $12,500.", "Change 1: none\nTo 1: none"),
    ).toEqual({ kind: "kept" });
    expect(
      rewritten(
        "The rent is $12,500.",
        "Change 1: $12,500\nTo 1: $14,250\nChange 2: $12,500\nTo 2: $42,750",
        "The rent is $14,250 and the deposit is $42,750.",
      ),
    ).toEqual({ kind: "kept" });
    expect(
      rewritten(
        "The rent is $12,500.",
        "Change 1: $12,500\nTo 1: $14,250",
        "The rent is $14,250 and the deposit is $42,750.",
      ),
    ).toMatchObject({ kind: "rewritten" });
  });
});

const SENTENCE = "Rent is 1100 dollars.";
const LINE = "Rent is 1250 dollars monthly.";

/** A Note whose one sentence carries a check that found `LINE` saying something different. */
async function noteWithCheck(
  generate: (call: GenerateCall) => { text: string },
  change:
    | Partial<ClaimCheckAttributes>
    | ((evidence: CitationAttributes) => Partial<ClaimCheckAttributes>) = {},
  text = SENTENCE,
  cites = false,
) {
  const calls: GenerateCall[] = [];
  const model = scriptedModel(() => ({ text: "" }), {
    generate: (call) => {
      // Automatic tagging asks too, in the background: only the rewrite's requests count.
      if (call.system === REWRITE_INSTRUCTIONS) calls.push(call);
      return generate(call);
    },
  });
  const { core, client, mind, documents } = await setUpWithDocuments(model, [
    { name: "Rent.md", contents: `# Rent\n\n${LINE}` },
  ]);
  const [rent] = documents;
  if (!rent) throw new Error("The Document wasn't added.");
  const cited = await core.citeSelection({
    documentId: rent.id,
    parts: [{ unit: null, text: LINE }],
  });
  const evidence: CitationAttributes = {
    ...cited,
    documentId: rent.id,
    documentName: rent.name,
    check: "found",
    checkReason: null,
  };
  const check: ClaimCheckAttributes = {
    id: "check-rent",
    request: "request-rent",
    action: "check-against-documents",
    state: "unsupported",
    reason: null,
    detail: null,
    providerId: "ollama",
    modelId: "local-model",
    text: SENTENCE,
    evidence,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt: "2026-11-04T00:00:00.000Z",
    ...(typeof change === "function" ? change(evidence) : change),
  };
  writeMind(client, [
    {
      type: "paragraph",
      attrs: { id: "rent-block" },
      content: cites
        ? [
            {
              type: "text",
              text: text.slice(0, -1),
              marks: [{ type: "claimCheck", attrs: check }],
            },
            { type: "citation", attrs: evidence },
            { type: "text", text: text.slice(-1), marks: [{ type: "claimCheck", attrs: check }] },
          ]
        : [{ type: "text", text, marks: [{ type: "claimCheck", attrs: check }] }],
    },
  ]);
  await client.settled();
  return { core, mindId: mind.id, calls, cited };
}

describe("rewriteFromDocuments", () => {
  test("asks the check's model about the Passage it found and gives back the correction", async () => {
    const { core, mindId, calls, cited } = await noteWithCheck(() => ({
      text: "Change 1: 1100\nTo 1: 1250",
    }));
    const result = await core.rewriteFromDocuments({ mindId, checkId: "check-rent" });
    expect(result).toMatchObject({
      kind: "rewritten",
      correction: {
        from: "1100",
        choices: [{ wording: "1250", evidence: { quote: cited.quote, check: "found" } }],
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.system).toBe(REWRITE_INSTRUCTIONS);
    expect(calls[0]?.prompt).toContain(SENTENCE);
    expect(calls[0]?.prompt).toContain(LINE);
  });

  test("keeps the sentence when the model's words aren't the Passage's", async () => {
    const { core, mindId, calls } = await noteWithCheck(() => ({
      text: "Change 1: 1100\nTo 1: 1300",
    }));
    expect(await core.rewriteFromDocuments({ mindId, checkId: "check-rent" })).toEqual({
      kind: "kept",
    });
    expect(calls).toHaveLength(1);
  });

  test.each([
    ["its check isn't unsupported", { state: "supported" as const }, SENTENCE, false],
    ["its check found no Passage", { evidence: null }, SENTENCE, false],
    ["its words changed since the check", {}, "Rent is 1100 dollars a month.", false],
    ["it has a Citation now", {}, SENTENCE, true],
  ])("sends nothing when %s", async (_, change, text, cites) => {
    const { core, mindId, calls } = await noteWithCheck(
      () => ({ text: "Change 1: 1100\nTo 1: 1250" }),
      change,
      text,
      cites,
    );
    expect(await core.rewriteFromDocuments({ mindId, checkId: "check-rent" })).toEqual({
      kind: "changed",
    });
    expect(calls).toHaveLength(0);
  });

  test("sends nothing when the Passage's quote isn't in the Document any more", async () => {
    const moved = await noteWithCheck(
      () => ({ text: "Change 1: 1100\nTo 1: 1250" }),
      (evidence) => ({ evidence: { ...evidence, quote: "Rent is 1250 euros monthly." } }),
    );
    expect(
      await moved.core.rewriteFromDocuments({ mindId: moved.mindId, checkId: "check-rent" }),
    ).toEqual({ kind: "changed" });
    expect(moved.calls).toHaveLength(0);
    // The same Note with the Document's own quote is asked.
    const held = await noteWithCheck(() => ({ text: "Change 1: 1100\nTo 1: 1250" }));
    expect(
      await held.core.rewriteFromDocuments({ mindId: held.mindId, checkId: "check-rent" }),
    ).toMatchObject({ kind: "rewritten" });
    expect(held.calls).toHaveLength(1);
  });
});
