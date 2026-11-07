import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const SCRIPT = join(__dirname, "..", "..", "scripts", "smoke-shard.mjs");
const EVERY_SPEC = readdirSync(join(__dirname, "..", "..", "e2e"))
  .filter((file) => file.endsWith(".spec.ts"))
  .map((file) => `e2e/${file}`);

/** What CI's plan step writes to $GITHUB_OUTPUT for a pull request with these changed files. */
function planFor(changed: string[] | "all") {
  const result = spawnSync(
    process.execPath,
    changed === "all" ? [SCRIPT, "plan", "--all"] : [SCRIPT, "plan"],
    { encoding: "utf8", input: changed === "all" ? "" : changed.join("\n") },
  );
  expect(result.status, result.stderr).toBe(0);
  const lines = Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  expect(JSON.parse(lines.shards)).toEqual(
    Array.from({ length: Number(lines.count) }, (_, index) => index + 1),
  );
  return { specs: lines.specs ? lines.specs.split(" ") : [], count: Number(lines.count) };
}

function shardOf(specs: string[], current: number, total: number): string[] {
  const result = spawnSync(process.execPath, [SCRIPT, String(current), String(total)], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, SMOKE_SPECS: specs.join(" ") },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim().split(" ").filter(Boolean);
}

describe("the smoke specs a pull request runs", () => {
  test("a changed spec runs, on its own shard, and the app code beside it adds none", () => {
    expect(planFor(["e2e/tabNames.spec.ts", "src/renderer/src/App.tsx"])).toEqual({
      specs: ["e2e/tabNames.spec.ts"],
      count: 1,
    });
  });

  test("a change to app code alone, the timing table or the packaged tests runs no spec", () => {
    expect(planFor(["src/core/core.ts", "src/renderer/src/styles.css"])).toEqual({
      specs: [],
      count: 0,
    });
    expect(planFor(["e2e/durations.json", "e2e/packaged/app.ts"])).toEqual({ specs: [], count: 0 });
  });

  test("a deleted spec runs nothing", () => {
    expect(planFor(["e2e/noSuchSpec.spec.ts"])).toEqual({ specs: [], count: 0 });
  });

  test.each([
    ["a helper", "e2e/app.ts"],
    ["a fixture", "e2e/fixtures/opinions.ts"],
    ["the Playwright config", "playwright.config.ts"],
    ["the dependencies", "package-lock.json"],
    ["the workflow", ".github/workflows/ci.yml"],
  ])("a change to %s runs every spec in ten shards", (_, file) => {
    const { specs, count } = planFor([file]);
    expect(specs.sort()).toEqual([...EVERY_SPEC].sort());
    expect(count).toBe(10);
  });

  test("the nightly run and a release run every spec in ten shards", () => {
    const { specs, count } = planFor("all");
    expect(specs.sort()).toEqual([...EVERY_SPEC].sort());
    expect(count).toBe(10);
  });
});

describe("the shards", () => {
  test("every spec runs in exactly one of ten shards", () => {
    const dealt = Array.from({ length: 10 }, (_, index) =>
      shardOf(EVERY_SPEC, index + 1, 10),
    ).flat();
    expect(dealt.sort()).toEqual([...EVERY_SPEC].sort());
  });

  test("a pull request's specs go only to its shards", () => {
    expect(shardOf(["e2e/tabNames.spec.ts", "e2e/titleBar.spec.ts"], 1, 1)).toEqual([
      "e2e/tabNames.spec.ts",
      "e2e/titleBar.spec.ts",
    ]);
  });
});
