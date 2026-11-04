import { writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { Citation, CitationAttributes, ClaimCheckAttributes, Core } from "../../src/core";
import { readChangeLines } from "../../src/core/answers/checks/prompt";
import { REWRITE_INSTRUCTIONS, rewriteOf } from "../../src/core/answers/checks/rewrite";
import { setUpWithDocuments } from "../helpers/citations";
import { waitForProcessing } from "../helpers/documents";
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

  test("when the words it writes are a name the quote doesn't hold", () => {
    const quote = "The Landlord is Westmarch Commercial Property Investments Limited.";
    expect(
      rewritten(
        "The Landlord is Northgate Holdings.",
        "Change 1: Northgate Holdings\nTo 1: Eastgate Holdings",
        quote,
      ),
    ).toEqual({ kind: "kept" });
    expect(
      rewritten(
        "The Landlord is Northgate Holdings.",
        "Change 1: Northgate Holdings\nTo 1: Westmarch Commercial Property Investments Limited",
        quote,
      ),
    ).toMatchObject({ kind: "rewritten" });
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
      rewritten("The rent is $12,500.", "Change 1: $12,500\nTo 1: $14,250", "The rent is $14,250."),
    ).toMatchObject({ kind: "rewritten" });
  });
});

describe("A rewrite changes only the value that differs", () => {
  test.each([
    [
      "a condition after the figure",
      "The Tenant pays a monthly rent of $12,500.",
      "Change 1: $12,500.\nTo 1: $14,250, due on the first day of each month.",
      LEASE,
    ],
    [
      "a condition after the words",
      "Each tenant may keep one cat.",
      "Change 1: one cat\nTo 1: two cats if they keep them on a lead",
      "Each tenant may keep two cats if they keep them on a lead.",
    ],
    [
      "words after the figure's unit",
      "Invoices are paid within 30 days.",
      "Change 1: 30 days\nTo 1: 45 days after the invoice is received",
      "Invoices are paid within 45 days after the invoice is received.",
    ],
    [
      "a clause after the figure, in Chinese",
      "货款应在30日内支付。",
      "Change 1: 30日内支付\nTo 1: 45日内支付，逾期按日加收万分之五滞纳金",
      "货款应在45日内支付，逾期按日加收万分之五滞纳金。",
    ],
    [
      "a condition after a Chinese name",
      "项目负责人为李明。",
      "Change 1: 李明\nTo 1: 王芳但须经董事会批准",
      "项目负责人为王芳但须经董事会批准。",
    ],
    [
      "a negation",
      "The Landlord may enter the premises.",
      "Change 1: may enter\nTo 1: may not enter",
      "The Landlord may not enter the premises without notice.",
    ],
    [
      "another thing's name with its figure",
      "The deposit is $40,000.",
      "Change 1: deposit is $40,000\nTo 1: rent is $14,250",
      "The monthly rent is $14,250.",
    ],
    ["a role in Chinese", "合同由董事签署。", "Change 1: 董事\nTo 1: 经理", "合同由经理签署。"],
    [
      "a name with a title, in Chinese",
      "合同由李明签署。",
      "Change 1: 李明\nTo 1: 张经理",
      "合同由张经理签署。",
    ],
    [
      "a name with words after it, in Chinese",
      "项目负责人为李明。",
      "Change 1: 李明\nTo 1: 王芳女士",
      "项目负责人为王芳女士。",
    ],
    [
      "a company's short name, in Chinese",
      "承租方为华润。",
      "Change 1: 华润\nTo 1: 万科",
      "承租方为万科。",
    ],
    [
      "a name of more than 8 words",
      "The Landlord is Northgate Holdings.",
      "Change 1: Northgate Holdings\nTo 1: Westmarch Commercial Property Investments Limited Trading As Westmarch Lettings",
      "The Landlord is Westmarch Commercial Property Investments Limited Trading As Westmarch Lettings.",
    ],
  ])("refuses %s", (_, sentence, reply, quote) => {
    expect(rewritten(sentence, reply, quote)).toEqual({ kind: "kept" });
  });

  test.each([
    [
      "a figure",
      "The Tenant pays a monthly rent of $12,500.",
      "Change 1: $12,500\nTo 1: $14,250",
      LEASE,
    ],
    [
      "a figure with its scale, in Chinese",
      "公司去年营收 1.2亿元。",
      "Change 1: 1.2亿元\nTo 1: 1.5亿元",
      "公司去年营收 1.5亿元。",
    ],
    [
      "a name",
      "The Landlord is Northgate Holdings.",
      "Change 1: Northgate Holdings\nTo 1: Westmarch Commercial Property Investments Limited",
      "The Landlord is Westmarch Commercial Property Investments Limited.",
    ],
    ["a Chinese name", "项目负责人为李明。", "Change 1: 李明\nTo 1: 王芳", "项目负责人为王芳。"],
  ])("keeps %s for one", (_, sentence, reply, quote) => {
    expect(rewritten(sentence, reply, quote)).toMatchObject({ kind: "rewritten" });
  });

  test("refuses a figure for another rate", () => {
    expect(
      rewritten(
        "Rent is $12,000 per year.",
        "Change 1: $12,000\nTo 1: $14,250",
        "Rent is $14,250 per month.",
      ),
    ).toEqual({ kind: "kept" });
    expect(
      rewritten(
        "每位员工每年享有 10 天带薪年假。",
        "Change 1: 10\nTo 1: 15",
        "每位员工每月享有 15 天带薪年假。",
      ),
    ).toEqual({ kind: "kept" });
    expect(
      rewritten(
        "Rent is $12,000 per month.",
        "Change 1: $12,000\nTo 1: $14,250",
        "Rent is $14,250 per month.",
      ),
    ).toMatchObject({ kind: "rewritten" });
  });

  test("refuses a figure from a quote that gives two, which may be another thing's", () => {
    const line = "The monthly rent is $14,250 and the deposit is $42,750.";
    expect(rewritten("The deposit is $40,000.", "Change 1: $40,000\nTo 1: $14,250", line)).toEqual({
      kind: "kept",
    });
    expect(rewritten("The deposit is $40,000.", "Change 1: $40,000\nTo 1: $42,750", line)).toEqual({
      kind: "kept",
    });
    expect(
      rewritten(
        "每位员工每年享有 10 天病假。",
        "Change 1: 10\nTo 1: 15",
        "每位员工每年享有 15 天带薪年假和 5 天病假。",
      ),
    ).toEqual({ kind: "kept" });
    expect(
      rewritten(
        "The security deposit is $40,000.",
        "Change 1: $40,000\nTo 1: $42,750",
        "The security deposit is $42,750, held by the Landlord until the lease ends.",
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
  return { core, mindId: mind.id, calls, cited, documentId: rent.id, path: rent.path };
}

/** Files the Document in a Folder that keeps its work inside it, which the Note is outside. */
async function wallOff(core: Core, documentId: string): Promise<string> {
  const folder = await core.createLibraryGroup({ name: "Client A", description: "" });
  await core.assignDocumentGroup(documentId, folder.id);
  await core.updateLibraryGroup(folder.id, { name: "Client A", description: "", keepInside: true });
  return folder.id;
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

  test("sends nothing once the Passage's Document is behind a Folder wall the Note is outside", async () => {
    const { core, mindId, calls, documentId } = await noteWithCheck(() => ({
      text: "Change 1: 1100\nTo 1: 1250",
    }));
    expect(await core.rewriteFromDocuments({ mindId, checkId: "check-rent" })).toMatchObject({
      kind: "rewritten",
    });
    expect(calls).toHaveLength(1);
    await wallOff(core, documentId);
    expect(await core.rewriteFromDocuments({ mindId, checkId: "check-rent" })).toEqual({
      kind: "changed",
    });
    expect(calls).toHaveLength(1);
  });

  test("sends nothing once a new version of the Document came, even one that still holds the quote", async () => {
    const { core, mindId, calls, documentId, path } = await noteWithCheck(() => ({
      text: "Change 1: 1100\nTo 1: 1250",
    }));
    await writeFile(path, `# Rent\n\nThe flat is on the second floor.\n\n${LINE}`);
    await core.reconcileDocuments();
    const [processed] = await waitForProcessing(core, [documentId]);
    expect(processed?.status).toBe("ready");
    expect(await core.rewriteFromDocuments({ mindId, checkId: "check-rent" })).toEqual({
      kind: "changed",
    });
    expect(calls).toHaveLength(0);
  });

  test.each([
    ["its Document went to Recently deleted", "deleted"],
    ["its Document is the User's own workings, never cited", "not cited"],
  ])("sends nothing when %s", async (_, change) => {
    const { core, mindId, calls, documentId } = await noteWithCheck(() => ({
      text: "Change 1: 1100\nTo 1: 1250",
    }));
    if (change === "deleted") await core.deleteDocument(documentId);
    else await core.setNotCited(documentId, true);
    expect(await core.rewriteFromDocuments({ mindId, checkId: "check-rent" })).toEqual({
      kind: "changed",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("A Citation chosen in a Document's viewer", () => {
  test("is refused for a Note outside the Folder wall the Document is behind", async () => {
    const { core, mindId, documentId } = await noteWithCheck(() => ({ text: "" }));
    const parts = [{ unit: null, text: LINE }];
    expect(await core.citeSelection({ documentId, parts, mindId })).toMatchObject({
      quote: LINE,
    });
    const folderId = await wallOff(core, documentId);
    await expect(core.citeSelection({ documentId, parts, mindId })).rejects.toThrow(
      "This Folder keeps its work inside it.",
    );
    // Inside the wall, the same words are cited.
    const inside = await core.createMind({ title: "Client A note", folderId });
    expect(await core.citeSelection({ documentId, parts, mindId: inside.id })).toMatchObject({
      quote: LINE,
    });
  });
});
