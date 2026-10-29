import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { readFigures } from "../../src/shared/figures";
import { checkGenerate, checkReply } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { readMind, writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const CLAIM = "The lease has no break clause.";
const CLAUSE = "Either party may end this lease with 30 days' notice.";

function absenceModel(
  verdict: "supported" | "contradicted",
  wholeReads: number[],
  reportedAbsence: boolean | undefined = true,
) {
  return scriptedModel(
    (call) => checkReply(call, { [CLAIM]: { verdict: "supported", absence: reportedAbsence } }),
    {
      generate: (call) => {
        if (call.system.startsWith("Classify whether a sentence says something is absent")) {
          return { text: "yes" };
        }
        if (call.system.startsWith("Read the whole Documents")) {
          wholeReads.push(1);
          if (verdict === "supported") return { text: JSON.stringify({ verdict }) };
          const passage = /id="([^"]+)"/.exec(call.prompt)?.[1];
          return { text: JSON.stringify({ verdict, passage, quote: CLAUSE }) };
        }
        return checkGenerate({ [CLAIM]: { verdict: "supported", absence: true } })(call);
      },
    },
  );
}

describe("Checking an absence sentence", () => {
  test("a true absence is Supported only after the whole Document is read, with its pages kept", async () => {
    const wholeReads: number[] = [];
    const { core, documents } = await setUpWithDocuments(absenceModel("supported", wholeReads), [
      {
        name: "Lease.pdf",
        contents: buildPdf([
          { lines: ["Term", "The lease runs for three years."] },
          { lines: ["Rent", "The tenant pays rent monthly."] },
        ]),
      },
    ]);

    const result = await core.checkClaim({ claim: CLAIM });

    expect(result).toMatchObject({ verdict: "supported", evidence: null });
    expect(result.readDocuments?.[0]).toMatchObject({
      documentId: documents[0]?.id,
      locations: [
        { kind: "page", from: 1, to: 1 },
        { kind: "page", from: 2, to: 2 },
      ],
    });
    expect(wholeReads).toHaveLength(1);
  });

  test("a failed re-check clears the earlier whole-read Locations", async () => {
    let wholeReply = JSON.stringify({ verdict: "supported" });
    const model = scriptedModel(
      (call) => checkReply(call, { [CLAIM]: { verdict: "supported", absence: true } }),
      {
        generate: (call) => {
          if (call.system.startsWith("Read the whole Documents")) return { text: wholeReply };
          return checkGenerate({ [CLAIM]: { verdict: "supported", absence: true } })(call);
        },
      },
    );
    const { core, client, mind } = await setUpWithDocuments(model, [
      {
        name: "Lease.pdf",
        contents: buildPdf([{ lines: ["Term", "The lease runs for three years."] }]),
      },
    ]);
    writeMind(client, [
      { type: "paragraph", attrs: { id: "one" }, content: [{ type: "text", text: CLAIM }] },
    ]);
    await client.settled();
    const check = () =>
      core.checkSentences({
        requestId: randomUUID(),
        mindId: mind.id,
        action: "check-against-documents",
        from: { blockId: "one", offset: 0 },
        to: { blockId: "one", offset: CLAIM.length },
      });

    await check();
    await client.settled();
    expect(claimSpans(readMind(client))[0]?.check.readDocuments).toHaveLength(1);

    wholeReply = "not JSON";
    await check();
    await client.settled();
    expect(claimSpans(readMind(client))[0]?.check).toMatchObject({
      state: "not-checked",
      reason: "malformed",
    });
    expect(claimSpans(readMind(client))[0]?.check.readDocuments).toEqual([]);
  });

  test.each([
    { name: "false", reported: false },
    { name: "missing", reported: undefined },
  ])("an Absence: $name line never lets Supported stand on search alone", async ({ reported }) => {
    const wholeReads: number[] = [];
    const { core } = await setUpWithDocuments(absenceModel("supported", wholeReads, reported), [
      {
        name: "Lease.pdf",
        contents: buildPdf([{ lines: ["Term", "The lease runs for three years."] }]),
      },
    ]);

    const result = await core.checkClaim({ claim: CLAIM });

    expect(result).toMatchObject({ verdict: "supported", evidence: null });
    expect(result.readDocuments).toHaveLength(1);
    expect(wholeReads).toHaveLength(1);
  });

  test("a sentence with a saved figure still needs the whole read before Supported", async () => {
    const claim = "The company never disclosed the $5 million loan.";
    const quote = "The company disclosed a $5 million loan on 14 May 2026.";
    const reading = readFigures("$5 million", { language: "en" })[0];
    if (!reading) throw new Error("The absence fixture has no figure.");
    const wholeReads: number[] = [];
    const model = scriptedModel(
      (call) => checkReply(call, { [claim]: { verdict: "supported", absence: false, quote } }),
      {
        generate: (call) => {
          if (call.system.startsWith("Classify whether a sentence says something is absent")) {
            return { text: "yes" };
          }
          if (call.system.startsWith("Read the whole Documents")) {
            wholeReads.push(1);
            return { text: JSON.stringify({ verdict: "supported" }) };
          }
          return checkGenerate({ [claim]: { verdict: "supported", absence: false, quote } })(call);
        },
      },
    );
    const { core } = await setUpWithDocuments(model, [
      { name: "Disclosures.pdf", contents: buildPdf([{ lines: [quote] }]) },
    ]);

    const result = await core.checkClaim({
      claim,
      figures: [
        {
          id: "loan",
          locator: {
            kind: "text",
            from: { blockId: "p", offset: 0 },
            to: { blockId: "p", offset: 1 },
          },
          reading,
          calculated: null,
        },
      ],
    });

    expect(result).toMatchObject({ verdict: "supported" });
    expect(result.readDocuments).toHaveLength(1);
    expect(wholeReads).toHaveLength(1);
  });

  test("one unreadable page makes the whole-scope absence Not checked, never Supported", async () => {
    const wholeReads: number[] = [];
    const scan = readFileSync(join(import.meta.dirname, "../fixtures/scans/en-clean.jpg"));
    const textRecognition = createFakeTextRecognizer({
      script: {
        pages: {
          "1": { lines: ["The lease runs for three years."] },
          "2": { fail: "Unreadable page" },
        },
      },
    });
    const { core } = await setUpWithDocuments(
      absenceModel("supported", wholeReads),
      [{ name: "Lease.pdf", contents: buildPdf([{ scan }, { scan }]) }],
      { textRecognizer: textRecognition },
    );

    const result = await core.checkClaim({ claim: CLAIM });

    expect(result).toMatchObject({ verdict: "not-checked", reason: "absence-read-limit" });
    expect(wholeReads).toHaveLength(0);
  });

  test("an unreadable PDF beside a readable one makes the scope Not checked, never Supported", async () => {
    const wholeReads: number[] = [];
    const { core } = await setUpWithDocuments(absenceModel("supported", wholeReads), [
      {
        name: "Lease.pdf",
        contents: buildPdf([{ lines: ["The lease runs for three years."] }]),
      },
      { name: "Broken.pdf", contents: "Not a PDF" },
    ]);

    const result = await core.checkClaim({ claim: CLAIM });

    expect(result).toMatchObject({ verdict: "not-checked", reason: "absence-read-limit" });
    expect(wholeReads).toHaveLength(0);
  });

  test("a false absence is Contradicted with the clause found by the whole read", async () => {
    const wholeReads: number[] = [];
    const { core } = await setUpWithDocuments(absenceModel("contradicted", wholeReads), [
      {
        name: "Lease.pdf",
        contents: buildPdf([
          { lines: ["Term", "The lease runs for three years."] },
          { lines: ["Break clause", CLAUSE] },
        ]),
      },
    ]);

    const result = await core.checkClaim({ claim: CLAIM });

    expect(result).toMatchObject({
      verdict: "contradicted",
      evidence: { quote: CLAUSE, check: "found", pageFrom: 2, pageTo: 2 },
    });
    expect(result.readDocuments?.[0]?.locations).toHaveLength(2);
    expect(wholeReads).toHaveLength(1);
  });

  test("an invalid whole-read Passage never falls back to the search's Citation", async () => {
    const wholeReads: number[] = [];
    const model = scriptedModel(
      (call) =>
        checkReply(call, {
          [CLAIM]: {
            verdict: "supported",
            absence: true,
            quote: "The lease runs for three years.",
          },
        }),
      {
        generate: (call) => {
          if (call.system.startsWith("Read the whole Documents")) {
            wholeReads.push(1);
            return {
              text: JSON.stringify({ verdict: "contradicted", passage: "P999", quote: CLAUSE }),
            };
          }
          return checkGenerate({ [CLAIM]: { verdict: "supported", absence: true } })(call);
        },
      },
    );
    const { core } = await setUpWithDocuments(model, [
      {
        name: "Lease.pdf",
        contents: buildPdf([
          { lines: ["Term", "The lease runs for three years."] },
          { lines: ["Break clause", CLAUSE] },
        ]),
      },
    ]);

    const result = await core.checkClaim({ claim: CLAIM });

    expect(result).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
    expect(wholeReads).toHaveLength(1);
  });

  test("no Documents leaves an absence Not checked, never Unsupported from an empty search", async () => {
    const wholeReads: number[] = [];
    const { core } = await setUpWithDocuments(absenceModel("supported", wholeReads), []);

    const result = await core.checkClaim({ claim: CLAIM });

    expect(result).toMatchObject({ verdict: "not-checked", reason: "absence-read-limit" });
    expect(wholeReads).toHaveLength(0);
  });

  test("a scope over 40 pages is Not checked instead of guessed from search results", async () => {
    const wholeReads: number[] = [];
    const { core } = await setUpWithDocuments(absenceModel("supported", wholeReads), [
      {
        name: "Lease.pdf",
        contents: buildPdf(
          Array.from({ length: 41 }, (_, index) => ({
            lines: [`Page ${index + 1}`, "Rent schedule"],
          })),
        ),
      },
    ]);

    const result = await core.checkClaim({ claim: CLAIM });

    expect(result).toMatchObject({ verdict: "not-checked", reason: "absence-read-limit" });
    expect(wholeReads).toHaveLength(0);
  });
});
