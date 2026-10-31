/**
 * run_code in the OS sandbox (spike, docs/adr/0025): a pandas analysis on a
 * copied CSV, with its figures checked against the cells, and what the code
 * can't do: read the home, change its inputs, reach the network, see a
 * secret, or run past its limits. The home and data folders are stand-ins
 * in temporary folders. Python is the one RUN_CODE_PYTHON names (a bundled
 * CPython with pandas, its packages in RUN_CODE_SITE); without it the Python
 * cases are skipped.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { type CodeDocument, createCodeRunner } from "../../src/core/runCode";
import { createProcessLauncher } from "../../src/main/processes";
import { loadOsSandbox } from "../../src/main/sandbox";
import { createTempDataFolder } from "../helpers/core";

const runtime = dirname(
  dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime")),
);
const sandbox = await loadOsSandbox({
  seccompHelper: join(runtime, "vendor", "seccomp", process.arch, "apply-seccomp"),
});
const unavailable = sandbox.available ? undefined : sandbox.reason;
const python = process.env.RUN_CODE_PYTHON;
const site = process.env.RUN_CODE_SITE;

const SALES = [
  "region,quarter,revenue",
  "North,Q1,120.5",
  "South,Q1,98",
  "East,Q1,143.25",
  "North,Q2,131",
  "South,Q2,101.5",
  "East,Q2,150",
  "North,Q3,128.75",
  "South,Q3,99",
  "East,Q3,162",
  "",
].join("\n");

async function setUp({ denyTemp = false } = {}) {
  const root = await realpath(await createTempDataFolder());
  const home = join(root, "home");
  const canary = join(home, ".ssh", "id_canary");
  await mkdir(dirname(canary), { recursive: true });
  await writeFile(canary, "HOME CANARY");
  const data = join(root, "data");
  await mkdir(data);
  const library = join(home, "Reports");
  await mkdir(library);
  const csv = join(library, "sales.csv");
  await writeFile(csv, SALES);
  const tempDir = join(root, "temp");
  await mkdir(tempDir);
  if (!sandbox.available) throw new Error(sandbox.reason);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GITHUB_TOKEN: "ghp_secret",
  };
  const executor = sandbox.createExecutor({
    processes: createProcessLauncher(async () => env),
    environment: async () => env,
    tempDir,
    denyRead: denyTemp ? [home, data, tempDir] : [home, data],
    reportError: (error) => {
      throw error;
    },
  });
  const runner = createCodeRunner({
    executor,
    tempDir,
    python: python ? { command: python, ...(site ? { site } : {}) } : null,
    limits: {
      fileBytes: 50 * 1024 * 1024,
      processes: 64,
      memoryBytes: 1024 * 1024 * 1024,
      folderBytes: 100 * 1024 * 1024,
    },
    maxOutputBytes: 64 * 1024,
    files: { count: 20, bytes: 5 * 1024 * 1024 },
  });
  const sales: CodeDocument = {
    documentId: "doc-sales",
    name: "sales.csv",
    path: csv,
    contentHash: createHash("sha256").update(SALES).digest("hex"),
  };
  return { runner, sales, canary, tempDir, csv };
}

const run = (
  runner: Awaited<ReturnType<typeof setUp>>["runner"],
  language: "python" | "bash",
  code: string,
  documents: CodeDocument[],
  timeoutMs = 60_000,
) => runner.run({ language, code, documents, timeoutMs, signal: new AbortController().signal });

describe.skipIf(unavailable !== undefined || !python)(
  `run_code with Python in the OS sandbox${unavailable ? ` (skipped: ${unavailable})` : ""}`,
  () => {
    test("runs a pandas analysis on a copied CSV, and checks its figures against the cells", async () => {
      const { runner, sales } = await setUp();
      const result = await run(
        runner,
        "python",
        `
import matplotlib.pyplot as plt
df = read_table("sales.csv")
result("total", df["revenue"].sum(), "Total revenue", "EUR", of=df["revenue"], how="sum")
north = df.loc[df["region"] == "North", "revenue"]
result("north", north.sum(), "North revenue", "EUR", of=north, how="sum")
result("inflated", df["revenue"].sum() * 1.1, "Inflated", "EUR", of=df["revenue"], how="sum")
result("growth", 0.081, "Growth", "%")
by_region = df.groupby("region")["revenue"].sum().sort_values(ascending=False)
table("by_region", by_region.to_frame())
by_region.plot(kind="bar").figure.savefig("out/by_region.png")
print(by_region.to_string())
`,
        [sales],
      );
      expect(result.refused).toBeNull();
      expect(result.exec?.exitCode).toBe(0);
      expect(result.exec?.stdout).toContain("East");
      expect(result.figures.map((figure) => [figure.name, figure.check.kind])).toEqual([
        ["total", "recalculated"],
        ["north", "recalculated"],
        ["inflated", "differs"],
        ["growth", "unchecked"],
      ]);
      expect(result.figures[0]?.value).toBe(1134);
      expect(result.figures[1]?.of?.rows).toEqual([2, 5, 8]);
      expect(result.files.map((file) => file.name)).toEqual(["by_region.csv", "by_region.png"]);
      const png = result.files[1]?.data;
      expect([...(png ?? []).slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
      expect(result.inputs).toEqual([
        {
          documentId: "doc-sales",
          name: "sales.csv",
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ]);
    }, 120_000);

    test("can't read the home, change its inputs, reach the network or see a secret", async () => {
      const { runner, sales, canary } = await setUp();
      const result = await run(
        runner,
        "python",
        `
import json, os, socket
seen = {}
def attempt(name, work):
    try:
        work()
        seen[name] = "allowed"
    except Exception as error:
        seen[name] = type(error).__name__
attempt("read home", lambda: open(${JSON.stringify(canary)}).read())
attempt("change input", lambda: open("../inputs/sales.csv", "a").write("x"))
attempt("new input", lambda: open("../inputs/more.csv", "w").write("x"))
attempt("write work", lambda: open("note.txt", "w").write("x"))
attempt("dns", lambda: socket.getaddrinfo("example.com", 443))
attempt("tcp", lambda: socket.create_connection(("1.1.1.1", 443), timeout=3))
attempt("loopback", lambda: socket.create_connection(("127.0.0.1", 9), timeout=3))
seen["secret"] = "GITHUB_TOKEN" in os.environ
print(json.dumps(seen))
`,
        [sales],
      );
      const seen = JSON.parse(result.exec?.stdout.trim().split("\n").at(-1) ?? "{}");
      expect(seen["write work"]).toBe("allowed");
      expect(seen["read home"]).toBe("PermissionError");
      expect(seen["change input"]).toBe("PermissionError");
      expect(seen["new input"]).toBe("PermissionError");
      expect(seen.dns).not.toBe("allowed");
      expect(seen.tcp).not.toBe("allowed");
      expect(seen.loopback).not.toBe("allowed");
      expect(seen.secret).toBe(false);
    }, 60_000);

    test("reads a neighbour in the shared temporary folder unless that folder is denied too", async () => {
      const open = await setUp();
      const neighbour = join(open.tempDir, "neighbour.txt");
      await writeFile(neighbour, "NEIGHBOUR");
      const code = `print(open(${JSON.stringify(neighbour)}).read())`;
      expect((await run(open.runner, "python", code, [])).exec?.stdout).toContain("NEIGHBOUR");
      const closed = await setUp({ denyTemp: true });
      const fenced = join(closed.tempDir, "neighbour.txt");
      await writeFile(fenced, "NEIGHBOUR");
      const denied = await run(
        closed.runner,
        "python",
        `import os\ntry:\n    open(${JSON.stringify(fenced)}).read()\n    print("read")\nexcept PermissionError:\n    print("denied")\nprint(len(read_table("sales.csv")))`,
        [closed.sales],
      );
      expect(denied.exec?.stdout.split("\n").filter(Boolean)).toEqual(["denied", "9"]);
    });

    test("a Document that changed since it was read doesn't run", async () => {
      const { runner, sales, csv } = await setUp();
      await writeFile(csv, `${SALES}West,Q3,1\n`);
      const result = await run(runner, "python", "print('ran')", [sales]);
      expect(result.refused).toContain("changed since IncarnaMind read it");
      expect(result.exec).toBeNull();
    });

    test("is stopped at its time, memory and folder limits, and its output is cut", async () => {
      const { runner } = await setUp();
      const endless = await run(runner, "python", "while True: pass", [], 2_000);
      expect(endless.exec?.timedOut).toBe(true);
      const loud = await run(runner, "python", "print('x' * 10_000_000)", []);
      expect(loud.exec?.stdoutTruncated).toBe(true);
      expect(loud.exec?.stdout.length).toBe(65_536);
      const hungry = await run(
        runner,
        "python",
        "import time\nheld = []\nfor _ in range(30):\n    held.append(b'x' * 100_000_000)\n    time.sleep(0.05)",
        [],
      );
      expect(hungry.exec?.limit).toBe("memory");
      const bigFile = await run(
        runner,
        "python",
        "open('big.bin', 'wb').write(b'x' * 80_000_000)",
        [],
      );
      expect(bigFile.exec?.exitCode).not.toBe(0);
      expect(bigFile.exec?.stderr).toMatch(/File too large|OSError/);
      const filling = await run(
        runner,
        "python",
        "import time\nfor n in range(40):\n    open(f'fill{n}.bin', 'wb').write(b'x' * 10_000_000)\n    time.sleep(0.02)",
        [],
      );
      expect(filling.exec?.limit).toBe("folder");
    }, 120_000);
  },
);

describe.skipIf(unavailable !== undefined)(
  `run_code with bash in the OS sandbox${unavailable ? ` (skipped: ${unavailable})` : ""}`,
  () => {
    test("bash can't read the home, change its inputs or reach the network", async () => {
      const { runner, sales, canary } = await setUp();
      const result = await run(
        runner,
        "bash",
        `
cat ${JSON.stringify(canary)} >/dev/null 2>&1 && echo "home: allowed" || echo "home: denied"
echo x >> ../inputs/sales.csv 2>/dev/null && echo "input: allowed" || echo "input: denied"
curl -sS -m 3 https://example.com >/dev/null 2>&1 && echo "net: allowed" || echo "net: denied"
wc -l < ../inputs/sales.csv | tr -d ' ' | sed 's/^/rows: /'
echo "token: \${GITHUB_TOKEN:-none}"
`,
        [sales],
      );
      expect(result.exec?.stdout.split("\n").filter(Boolean)).toEqual([
        "home: denied",
        "input: denied",
        "net: denied",
        "rows: 10",
        "token: none",
      ]);
    });

    test("a fork bomb is held to its process limit and leaves nothing running", async () => {
      const { runner, tempDir } = await setUp();
      const result = await run(
        runner,
        "bash",
        "bomb() { bomb | bomb & }; bomb; sleep 30",
        [],
        4_000,
      );
      expect(result.exec?.timedOut).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const { stdout } = await promisify(execFile)("ps", ["-A", "-o", "command="]);
      const left = stdout.split("\n").filter((line) => line.includes(tempDir));
      expect(left).toEqual([]);
    }, 30_000);
  },
);
