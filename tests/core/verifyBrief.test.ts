import { describe, expect, test, vi } from "vitest";
import { briefFrom } from "../../src/core/answers/checks/verifyBrief";
import { briefOf } from "../../src/shared/verificationBrief";
import { checkGenerate, checkReply, type Plan } from "../helpers/checks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { scriptedModel, scriptedModels } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

/**
 * The brief of a document someone else wrote (#3277): once its claims are found the model says
 * what the document concludes and which claims its figures are, by number; the code holds the
 * reply to what is structural, and a brief that can't be written never stops the check.
 */

const SUPPORTED = "Spring tides come at new and full moon.";
const CONTRADICTED = "Harbours publish the times of high water every week.";
const UNSUPPORTED = "Penguins nest on the cliffs above the harbour.";

const REPORT = buildPdf([
  { lines: ["Harbour report", "1 Tides", SUPPORTED, CONTRADICTED] },
  { lines: ["2 Wildlife", UNSUPPORTED, "Thank you for reading this report."] },
]);

const PLANS: Record<string, Plan> = {
  [SUPPORTED]: { verdict: "supported", quote: "Spring tides happen at new moon and at full moon" },
  [CONTRADICTED]: { verdict: "unsupported" },
  [UNSUPPORTED]: { verdict: "unsupported" },
};

const TIDES = {
  name: "Tides.md",
  contents:
    "# Tides\n\nSpring tides come at new and full moon. Spring tides come at the full moon.\n",
};

/** A verified report, found its claims with the model's brief reply `brief`; null: it asks for none. */
async function foundWith(brief: (() => string) | null) {
  const asked: string[] = [];
  const model = scriptedModel((call) => checkReply(call, PLANS), {
    generate: (call) => {
      if (call.question === "verify-brief") {
        asked.push(call.prompt);
        return { text: brief ? brief() : "" };
      }
      return checkGenerate(PLANS)(call);
    },
  });
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, TIDES.name, TIDES.contents)]);
  const path = await writeSourceFile(sources, "Harbour report.pdf", REPORT);
  const result = await core.verifyDocument({ path });
  if (!result.ok) throw new Error(`The report wasn't verified: ${result.reason}`);
  const client = await connectToMind(core, result.mind.id);
  await client.settled();
  const found = await core.findClaims({ requestId: crypto.randomUUID(), mindId: result.mind.id });
  await client.settled();
  return { found, client, asked };
}

describe("The brief of a verified document", { timeout: 30_000 }, () => {
  // protects=the model reads the document's claims, numbered with their pages, and the brief keeps the lines it wrote and the claims they and the figures rest on, by Block and words; fails_when=a line is kept with no claim under it, or a page is missing from what the model reads
  test("is written once the claims are found, from the claims alone", async () => {
    const { found, client, asked } = await foundWith(() =>
      JSON.stringify({
        conclusions: [
          { line: "Spring tides come at new and full moon.", claim: 1 },
          { line: "Penguins nest above the harbour.", claim: 3 },
        ],
        figures: [2],
      }),
    );

    expect(found).toEqual({ kind: "found", claims: 3 });
    expect(asked).toHaveLength(1);
    expect(JSON.parse(asked[0] ?? "{}")).toEqual({
      claims: [
        { number: 1, page: 1, text: SUPPORTED },
        { number: 2, page: 1, text: CONTRADICTED },
        { number: 3, page: 2, text: UNSUPPORTED },
      ],
    });
    const brief = briefOf(client.doc);
    expect(brief?.conclusions.map((each) => [each.line, each.at.text])).toEqual([
      ["Spring tides come at new and full moon.", SUPPORTED],
      ["Penguins nest above the harbour.", UNSUPPORTED],
    ]);
    expect(brief?.figures.map((each) => each.text)).toEqual([CONTRADICTED]);
  });

  // protects=a brief that can't be written, or is read as nothing, never stops the claims being found, and leaves none behind
  test.each([
    ["an unreadable reply", () => "no brief to give"],
    ["a reply naming no claim", () => JSON.stringify({ conclusions: [{ line: "x", claim: 9 }] })],
  ])("%s leaves no brief and the claims found", async (_, reply) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { found, client } = await foundWith(reply);

      expect(found).toEqual({ kind: "found", claims: 3 });
      expect(briefOf(client.doc)).toBeNull();
    } finally {
      errors.mockRestore();
    }
  });
});

describe("What a reply may give the brief", () => {
  const claims = Array.from({ length: 12 }, (_, index) => ({
    number: index + 1,
    text: `Claim ${index + 1}.`,
    sentence: { blockId: `b${index + 1}`, text: `Claim ${index + 1}.` },
  }));

  // protects=at most three conclusions and five figures, each once, each a claim the model was shown: a count and a lookup, never a reading of the words
  test("is held to three conclusions, five figures, each claim once", () => {
    const brief = briefFrom(
      {
        conclusions: [1, 2, 3, 4, 5, 6, 7].map((claim) => ({ line: `Line ${claim}`, claim })),
        figures: [1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      },
      claims,
      "sorted",
    );

    expect(brief?.conclusions.map((each) => each.line)).toEqual(["Line 1", "Line 2", "Line 3"]);
    expect(brief?.figures.map((each) => each.blockId)).toEqual(
      [1, 2, 3, 4, 5].map((number) => `b${number}`),
    );
  });

  // protects=a line pointing at no claim, an empty line, a claim named twice and a reply that isn't an object are dropped, and a reply left with nothing is no brief
  test("drops what points at no claim", () => {
    expect(
      briefFrom(
        {
          conclusions: [
            { line: "Fine", claim: 2 },
            { line: "Again", claim: 2 },
            { line: "  ", claim: 3 },
            { line: "Nowhere", claim: 99 },
            { line: "No number" },
          ],
          figures: ["x", 99],
        },
        claims,
        "sorted",
      )?.conclusions,
    ).toEqual([{ line: "Fine", at: { blockId: "b2", text: "Claim 2." } }]);
    expect(briefFrom({ conclusions: [{ line: "Nowhere", claim: 99 }] }, claims, "s")).toBeNull();
    expect(briefFrom("a brief", claims, "s")).toBeNull();
  });
});
