import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { checkRecordCiteSet, loadRecordCiteSet } from "../../eval/record-cites/set";
import { createTempDataFolder } from "../helpers/core";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("the public record-cite evaluation set (#1709)", { timeout: 600_000 }, () => {
  test("every key matches the saved public court Documents and their exact resolved Locations", async () => {
    const report = await checkRecordCiteSet(ROOT);
    expect(report.failures, report.failures.join("\n")).toEqual([]);
    expect(report.documents).toBe(2);
    expect(report.cases).toBe(8);
    expect(report.cites).toBe(10);
  });

  test("a malformed set names the missing arrays instead of failing at its first case", async () => {
    const root = await createTempDataFolder();
    await mkdir(join(root, "eval/record-cites"), { recursive: true });
    await writeFile(join(root, "eval/record-cites/set.json"), '{"documents":[]}');
    await expect(loadRecordCiteSet(root)).rejects.toThrow(
      'eval/record-cites/set.json must hold "documents" and "cases" arrays.',
    );
  });
});
