import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { requireAttributionDry, runAttributionDry } from "./adapter";

test("the frozen attribution set loads through public Core without external calls", async () => {
  const mode = process.env.INCARNAMIND_ATTRIBUTION_MODE ?? "dry";
  requireAttributionDry(mode);
  const arm = process.env.INCARNAMIND_ATTRIBUTION_ARM ?? "after";
  if (arm !== "before" && arm !== "after")
    throw new Error("The attribution arm must be before or after.");
  const root = resolve(__dirname, "../..");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const sourceHead = git("rev-parse", "HEAD").trim();
  const sourceDiff = git("diff", "HEAD", "--", "src", "tests/helpers", "vitest.config.ts");
  const directory = join(
    root,
    "test-results",
    "attribution-eval",
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${arm}-dry`,
  );
  await mkdir(directory, { recursive: true });
  const result = await runAttributionDry({
    arm,
    mode,
    onCase: async (row, requests) => {
      await appendFile(join(directory, "outcomes.jsonl"), `${JSON.stringify({ row, requests })}\n`);
    },
  });
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify(
      {
        ...result,
        manifest: {
          ...result.manifest,
          sourceHead,
          sourceDirty: sourceDiff !== "",
          sourceDiffSHA256: createHash("sha256").update(sourceDiff).digest("hex"),
        },
      },
      null,
      2,
    ),
  );
  console.log(
    `Attribution dry loader: ${result.summary.executed}/${result.manifest.caseCount} retained; ${result.summary.requests} scripted requests; $0 external cost. Not a model-quality measurement.`,
  );
});
