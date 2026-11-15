import { describe, test } from "vitest";
import { readsAsMeasured, rowsOf } from "../helpers/answerUnitsTable";

describe("#2997's measured table: an organisation named after a colon", () => {
  // protects=each row reads, in an Answer and in Check against Documents, what was measured here: the organisation's line of a Chinese financial statement (编制单位：万禾股份有限公司 and every label like it), its hazards (names that begin with or hold a scale, a currency or a unit, with a unit line and without), real unit lines under it and alone, a bare unit label, joined lines, English labels, and Markdown, Word and PDF files, right and wrong sentences side by side; fails_when=any row reads otherwise, the first such stopping the run with its id; no_claim=what a real model replies.
  test("every row reads as measured", { timeout: 600_000 }, async () => {
    await readsAsMeasured(rowsOf("organisations"));
  });
});
