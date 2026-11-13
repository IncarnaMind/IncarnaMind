import { describe, test } from "vitest";
import { readsAsMeasured, rowsOf } from "../helpers/answerUnitsTable";

describe("#2997's measured table: the recorded rows of the currency tests (#2226)", () => {
  // protects=each row reads, in an Answer and in Check against Documents, what was measured here; fails_when=any row reads otherwise, the first such stopping the run with its id; no_claim=what a real model replies.
  test("every row reads as measured", { timeout: 600_000 }, async () => {
    await readsAsMeasured(rowsOf("currencies"));
  });
});
