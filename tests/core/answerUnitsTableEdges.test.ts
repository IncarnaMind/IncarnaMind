import { describe, test } from "vitest";
import { readsAsMeasured, rowsOf } from "../helpers/answerUnitsTable";

describe("#2997's measured table: the issue's rows, twins and edge cases", () => {
  // protects=each row reads, in an Answer and in Check against Documents, what was measured here; fails_when=any row reads otherwise, the first such stopping the run with its id; no_claim=what a real model replies.
  test("every row reads as measured", { timeout: 600_000 }, async () => {
    await readsAsMeasured(rowsOf("edges"));
  });

  // protects=a bare "points" or 点 is read as percentage points only after a rise or fall ("rose twenty points", "下降了0.5点"), never as a count ("three points to cover", "提出了3点意见"), a time (3点钟), an ordinal (第3点) or a "3-point plan", each beside its twin, in English and Chinese; fails_when=any of those rows reads otherwise; no_claim=what a real model replies.
  test("points and 点 are a share only after a rise or fall", { timeout: 600_000 }, async () => {
    await readsAsMeasured(rowsOf("points"));
  });

  // protects=a heading heads every row under it up to a blank line or the next heading, a year in it included, a row with its own bracket is a row, a heading row of cells states only its column's unit, a number's own label outranks its column's and a unit line elsewhere, right scale kept and wrong caught, in English and Chinese; fails_when=any of those rows reads otherwise; no_claim=what a real model replies.
  test("a heading's unit reaches every row under it", { timeout: 600_000 }, async () => {
    await readsAsMeasured(rowsOf("headings"));
  });
});
