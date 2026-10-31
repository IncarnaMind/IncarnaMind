/**
 * The citation benchmark's set (#1999): `eval/citations/documents.json` and
 * `eval/citations/questions.jsonl`. Every gold quote is checked at its
 * Location against what processing stores, and on no other Unit of its
 * Document; the counts are the design's, and every Question records the day a
 * second reader checked its answer against the text. Runs with `npm test`,
 * without a model.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { checkCitationSet, loadCitationSet, promptCopies } from "../../eval/citations/checkSet";
import { findingLine, scanBenchmark } from "../../eval/citations/scan";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("The citation benchmark's set (#1999)", { timeout: 600_000 }, () => {
  test("the Documents are listed, and every gold quote is verbatim at its Location", async () => {
    const report = await checkCitationSet(ROOT);
    expect(report.failures, report.failures.join("\n")).toEqual([]);
    expect(report.documents).toBeGreaterThanOrEqual(12);
    expect(report.questions).toBe(150);
    expect(report.crossLingual).toBe(15);
    expect(report.secondReaderChecked).toBe(150);
  });

  test("no Question or gold quote is copied from the app's prompts or their examples", async () => {
    const { questions } = await loadCitationSet(ROOT);
    expect(await promptCopies(ROOT, questions)).toEqual([]);
  });

  test("the published files hold no key, personal data or unlisted Document", async () => {
    const findings = await scanBenchmark(ROOT, [join(ROOT, "eval/citations")]);
    expect(findings.map(findingLine)).toEqual([]);
  });
});
