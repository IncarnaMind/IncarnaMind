import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { checkRecordCiteSet } from "../../eval/record-cites/set";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("the public record-cite evaluation set (#1709)", { timeout: 600_000 }, () => {
  test("every key matches the saved public court Documents and their exact resolved Locations", async () => {
    const report = await checkRecordCiteSet(ROOT);
    expect(report.failures, report.failures.join("\n")).toEqual([]);
    expect(report.documents).toBe(2);
    expect(report.cases).toBe(8);
    expect(report.cites).toBe(10);
  });
});
