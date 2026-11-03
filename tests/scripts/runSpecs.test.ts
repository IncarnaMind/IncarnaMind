import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const SCRIPT = join(__dirname, "..", "..", "scripts", "run-specs.mjs");

/** The check the specs workflow makes: the inputs arrive as environment variables. */
function check(inputs: { specs: string; repeat?: string; grep?: string }) {
  const result = spawnSync(process.execPath, [SCRIPT, "--check"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SPECS: inputs.specs,
      REPEAT: inputs.repeat ?? "1",
      GREP: inputs.grep ?? "",
    },
  });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

describe("the inputs of a run of named specs", () => {
  test("accepts specs that exist, with or without a line, and any repeat from 1 to 10", () => {
    expect(check({ specs: "e2e/tabNames.spec.ts" }).ok).toBe(true);
    expect(check({ specs: "e2e/tabNames.spec.ts:12  e2e/titleBar.spec.ts", repeat: "10" }).ok).toBe(
      true,
    );
    expect(check({ specs: "e2e/tabNames.spec.ts", grep: "^tab (names|bar) 1.2$" }).ok).toBe(true);
  });

  test.each([
    ["a path that leaves e2e/", "e2e/../package.json"],
    ["a path that climbs back into e2e/", "e2e/../e2e/tabNames.spec.ts"],
    ["shell code", "; rm -rf /"],
    ["shell code after a spec", "e2e/tabNames.spec.ts;touch pwned"],
    ["a command substitution", "e2e/$(id).spec.ts"],
    ["a file that is not a spec", "package.json"],
    ["a spec outside e2e/", "src/core/core.spec.ts"],
    ["a spec that does not exist", "e2e/doesNotExist.spec.ts"],
    ["a line that is not a number", "e2e/tabNames.spec.ts:abc"],
    ["a line of zero", "e2e/tabNames.spec.ts:0"],
    ["a flag", "--config=evil.ts"],
    ["nothing", "   "],
  ])("refuses %s", (_name, specs) => {
    const { ok, output } = check({ specs });
    expect(ok).toBe(false);
    expect(output).toMatch(/Error:/);
  });

  test.each(["0", "11", "-1", "1.5", "two", "", "1; id"])("refuses repeat %j", (repeat) => {
    const { ok, output } = check({ specs: "e2e/tabNames.spec.ts", repeat });
    expect(ok).toBe(false);
    expect(output).toContain("repeat must be a whole number from 1 to 10");
  });

  test.each(["a; rm -rf /", "`id`", "a & b", "a > b", "tab\nnames", "x".repeat(201), "("])(
    "refuses the grep %j",
    (grep) => {
      expect(check({ specs: "e2e/tabNames.spec.ts", grep }).ok).toBe(false);
    },
  );

  test("says what is wrong in one line a person can act on", () => {
    const { output } = check({ specs: "e2e/../package.json" });
    expect(output).toContain(
      '"e2e/../package.json" is not a spec: write e2e/<name>.spec.ts, or e2e/<name>.spec.ts:<line>',
    );
  });

  test("reports every problem at once, and as annotations on Actions", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--check"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_ACTIONS: "true",
        SPECS: "nope",
        REPEAT: "11",
        GREP: "",
      },
    });
    expect(result.status).toBe(1);
    const lines = result.stderr.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(/^::error title=Run named specs::/);
  });
});
