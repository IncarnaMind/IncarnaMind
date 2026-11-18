/**
 * A cited sentence whose check is backed by a Passage its Citations don't hold (#3019): the model's
 * Supported stands with the Passage it found, for the Note to read against its Citations.
 */
import { describe, expect, test } from "vitest";
import { checkingModel } from "../helpers/checks";
import { type SourceFile, setUpWithDocuments } from "../helpers/citations";

const TIDES: SourceFile = {
  name: "Tides.md",
  // A line in each language, so that either sentence's search finds the Passage.
  contents:
    "The tide turns twice a day.\n\n港口的潮水每天都会涨落。\n\nThe harbour closes at dusk.\n",
};
const BOATS: SourceFile = { name: "Boats.md", contents: "Boats leave the harbour at dawn.\n" };
const LINE = "The tide turns twice a day.";

describe("A cited sentence's check backed by a Passage its Citations don't hold", () => {
  // protects=the check gives the model's own Supported with the Passage it found from a cite call, so the Note can read it against its Citations as they stand (#3019); fails_when=the check stores Not checked in its place, which no Add as Citation could bring back without a new request, or loses the Passage; no_claim=how the Note shows it, which tests/core/foundPassageCitation.test.ts holds.
  test("a cite call", async () => {
    const claim = "Tides turn twice in a day here.";
    const { core, documents } = await setUpWithDocuments(
      checkingModel({ [claim]: { verdict: "supported", quote: LINE, judgement: "same" } }),
      [TIDES, BOATS],
    );
    const [tides] = documents;
    if (!tides) throw new Error("Tides.md wasn't added.");
    const result = await core.checkClaim({
      claim,
      cited: [
        {
          documentName: tides.name,
          documentId: tides.id,
          contentHash: tides.contentHash,
          quote: "The harbour closes at dusk.",
        },
      ],
    });
    expect(result.verdict).toBe("supported");
    if (result.verdict !== "supported") return;
    expect(result.evidence?.quote).toBe(LINE);
  });
});
