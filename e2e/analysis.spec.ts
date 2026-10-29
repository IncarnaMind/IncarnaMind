import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import type { AnalysisRun } from "../src/core/analysis";
import type { AnalysisInput, AnalysisJob } from "../src/shared/analysis";
import { createDataFolder, launchApp, removeDataFolder } from "./app";

/*
 * Analyses run in Python, in the hidden window's sandbox (ADR-0023), through the core's record of
 * each run. A test build exposes the same runtime to these isolation probes.
 * The escape attempts are the spike's (#444): every one must fail, and a local server
 * standing in for the network must hear nothing.
 */

type Analyses = { run(job: AnalysisJob, stopAfterMs?: number): Promise<AnalysisRun> };

const run = (app: ElectronApplication, job: AnalysisJob, stopAfterMs?: number) =>
  app.evaluate(
    (_electron, asked) =>
      (globalThis as unknown as { incarnamindAnalysis: Analyses }).incarnamindAnalysis.run(
        asked.job,
        asked.stopAfterMs,
      ),
    { job, stopAfterMs },
  );

const python = (code: string, inputs: readonly AnalysisInput[] = []): AnalysisJob => ({
  language: "python",
  code,
  inputs,
});

/** A sheet of sales from row 2 (its heading row is 1): one revenue not a number, one empty. */
const SALES: AnalysisInput = {
  kind: "table",
  name: "sales",
  columns: ["Region", "Quarter", "Revenue"],
  firstRow: 2,
  rows: [
    ["North", "2026Q1", 120],
    ["North", "2026Q2", 150.5],
    ["South", "2026Q1", 80],
    ["South", "2026Q2", "n/a"],
    ["East", "2026Q1", 60],
    ["East", "2026Q2", null],
    ["West", "2026Q1", 40],
  ],
};

const REGIONS: AnalysisInput = {
  kind: "table",
  name: "regions",
  columns: ["Region", "Manager"],
  firstRow: 2,
  rows: [
    ["North", "Ana"],
    ["South", "Bo"],
    ["Central", "Chen"],
  ],
};

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

test("a group-by over a sheet gives its totals, with the steps, the cells that aren't numbers and a merge's unmatched rows reported", async () => {
  test.setTimeout(180_000);
  const { app } = await launchApp(dataDir, { sandboxed: true });

  const ran = await run(
    app,
    python(
      [
        'sales = step("Read the sales", inputs["sales"])',
        'sales = step("Kept rows with a revenue", sales.dropna(subset=["Revenue"]))',
        'totals = sales.groupby("Region", sort=True)["Revenue"].sum()',
        'result("totals", totals, "Revenue by region", "USD")',
        'result("total", totals.sum(), "Total revenue", "USD")',
        'merged = sales.merge(inputs["regions"], on="Region", how="left")',
        'chart("bar", totals, title="Revenue by region")',
      ].join("\n"),
      [SALES, REGIONS],
    ),
  );

  expect(ran.result.end).toEqual({ kind: "done" });
  expect(ran.versions).toMatchObject({ language: "python", languageVersion: "3.14.2" });
  expect(ran.versions?.packages).toMatchObject({ numpy: "2.4.6", pandas: "3.0.2" });
  const { output } = ran.result;
  expect(output.steps).toEqual([
    { label: "Read the sales", rows: 7, columns: 3 },
    { label: "Kept rows with a revenue", rows: 5, columns: 3 },
  ]);
  expect(output.results).toEqual([
    {
      kind: "table",
      name: "totals",
      label: "Revenue by region",
      unit: "USD",
      table: {
        columns: ["Region", "Revenue"],
        rows: [
          ["East", 60],
          ["North", 270.5],
          ["South", 80],
          ["West", 40],
        ],
        rowCount: 4,
        columnCount: 2,
      },
    },
    { kind: "figure", name: "total", label: "Total revenue", unit: "USD", value: 450.5 },
  ]);
  expect(output.notNumbers).toEqual([
    {
      input: "sales",
      column: "Revenue",
      count: 2,
      cells: [
        { row: 5, value: "n/a" },
        { row: 7, value: "" },
      ],
    },
  ]);
  expect(output.merges).toEqual([
    {
      line: 6,
      how: "left",
      leftRows: 5,
      rightRows: 3,
      rows: 5,
      matched: 3,
      leftOnly: 2,
      rightOnly: 1,
    },
  ]);
  expect(output.charts).toHaveLength(1);
  await app.close();
});

test("the same job gives the same output; the clock can't be read; the numbers written in the code are listed", async () => {
  test.setTimeout(180_000);
  const { app } = await launchApp(dataDir, { sandboxed: true });
  const seeded = python(
    [
      "import random, numpy as np",
      'print(hash("Revenue"), sorted({"b", "a"}), random.random(), np.random.default_rng().random())',
      'growth = inputs["sales"]["Revenue"].iloc[0] * 1.05 - 12',
      'result("growth", growth)',
    ].join("\n"),
    [SALES],
  );

  const first = await run(app, seeded);
  const again = await run(app, seeded);

  expect(first.result.end).toEqual({ kind: "done" });
  expect(again.output).toBe(first.output);
  expect(first.result.output.literals).toEqual([
    { value: 1.05, line: 3, text: "1.05" },
    { value: 12, line: 3, text: "12" },
  ]);

  for (const code of [
    "import datetime\ndatetime.datetime.now()",
    "from datetime import date\ndate.today()",
    "import time\ntime.time()",
    'import pandas as pd\npd.Timestamp("today")',
  ]) {
    const clock = await run(app, python(code));
    expect(clock.result.end).toMatchObject({ kind: "error", line: 2 });
    expect(clock.result.end.kind === "error" && clock.result.end.message).toContain(
      "Take the date as an input",
    );
  }
  await app.close();
});

test("a loop that never ends is stopped at its time limit and when stopped, and the next job runs", async () => {
  test.setTimeout(240_000);
  const { app } = await launchApp(dataDir, { sandboxed: true });

  const late = await run(app, { ...python("while True:\n    pass"), timeLimitMs: 3_000 });
  expect(late.result.end).toEqual({ kind: "timed-out", limitMs: 3_000 });

  // Once the interpreter that took its place is ready, a loop is stopped while it runs.
  expect((await run(app, python("print(1)"))).result.end).toEqual({ kind: "done" });
  const stopped = await run(app, python("while True:\n    pass"), 3_000);
  expect(stopped.result.end).toEqual({ kind: "stopped" });

  const next = await run(app, python('result("sum", 40 + 2)'));
  expect(next.result.end).toEqual({ kind: "done" });
  expect(next.result.output.results).toEqual([
    { kind: "figure", name: "sum", label: "sum", unit: null, value: 42 },
  ]);
  await app.close();
});

test("nothing leaves the sandbox: every way out to the network, to the computer's files and to Node fails, and the network hears nothing", async () => {
  test.setTimeout(180_000);
  const heard: string[] = [];
  const server = createServer((request, response) => {
    heard.push(`${request.method} ${request.url}`);
    response.end("reached");
  });
  server.on("upgrade", (request, socket) => {
    heard.push(`upgrade ${request.url}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const secretFolder = join(tmpdir(), `incarnamind-analysis-${randomUUID()}`);
  await mkdir(secretFolder, { recursive: true });
  const secret = join(secretFolder, "secret.txt");
  await writeFile(secret, "kept on the computer");
  // Python's /tmp is the sandbox's own, in memory: written there, the file isn't on the computer.
  const marker = `/tmp/incarnamind-analysis-marker-${randomUUID()}.txt`;
  const { app } = await launchApp(dataDir, { sandboxed: true });

  const probes = [
    `import urllib.request\nurllib.request.urlopen("${url}/urllib", timeout=5).read()`,
    `import socket\nsocket.create_connection(("127.0.0.1", ${port}), 3).sendall(b"GET /socket HTTP/1.0\\r\\n\\r\\n")`,
    `from pyodide.http import open_url\nopen_url("${url}/open-url").read()`,
    `import js\nx = js.XMLHttpRequest.new()\nx.open("GET", "${url}/xhr", False)\nx.send()\nx.responseText`,
    `import js\njs.fetch("${url}/fetch")\nraise RuntimeError("fetch was only started")`,
    `import js\njs.WebSocket.new("ws://127.0.0.1:${port}/socket")\nraise RuntimeError("the socket was only started")`,
    `import js\njs.importScripts("${url}/script.js")`,
    `import js\njs.eval("1 + 1")`,
    `import js\njs.Function.new("return 1")()`,
    `open(${JSON.stringify(secret)}).read()`,
    `import os\nos.listdir(${JSON.stringify(secretFolder)})`,
    "import micropip",
    'import subprocess\nsubprocess.run(["ls"])',
  ];
  for (const code of probes) {
    const probe = await run(app, python(code));
    expect(probe.result.end, code).toMatchObject({ kind: "error" });
  }
  const names = await run(
    app,
    python(
      'import js\nprint([name for name in ("process", "require", "Buffer", "electron", "incarnamindAnalysis") if getattr(js, name, None) is not None])',
    ),
  );
  expect(names.result.output.printed).toBe("[]\n");
  const written = await run(
    app,
    python(
      `open(${JSON.stringify(marker)}, "w").write("left by an Analysis")\nprint(open(${JSON.stringify(marker)}).read())`,
    ),
  );
  expect(written.result.end).toEqual({ kind: "done" });
  expect(written.result.output.printed).toBe("left by an Analysis\n");
  expect(existsSync(marker)).toBe(false);

  expect(heard).toEqual([]);
  await app.close();
  server.close();
  await rm(secretFolder, { recursive: true, force: true });
});

test("each job runs in a fresh interpreter: what a job changes in Python, pandas or the helper, and what it read, never reach the next", async () => {
  test.setTimeout(180_000);
  const { app } = await launchApp(dataDir, { sandboxed: true });

  const first = await run(
    app,
    python(
      [
        "import builtins, pandas as pd, incarnamind",
        'builtins.kept = inputs["sales"]',
        "pd.Series.sum = lambda self, *args, **kwargs: 999",
        "incarnamind._numbers_written = lambda *args: ([], 0)",
      ].join("\n"),
      [SALES],
    ),
  );
  expect(first.result.end).toEqual({ kind: "done" });

  const next = await run(
    app,
    python(
      [
        "import builtins, pandas as pd",
        'print(hasattr(builtins, "kept"))',
        'result("sum", pd.Series([20, 22]).sum())',
        "rate = 0.07",
      ].join("\n"),
    ),
  );
  expect(next.result.end).toEqual({ kind: "done" });
  expect(next.result.output.printed).toBe("False\n");
  expect(next.result.output.results).toEqual([
    { kind: "figure", name: "sum", label: "sum", unit: null, value: 42 },
  ]);
  expect(next.result.output.literals.map((each) => each.text)).toEqual(["20", "22", "0.07"]);
  await app.close();
});

test("what a job's page could keep is cleared after it: the next job's IndexedDB starts empty", async () => {
  test.setTimeout(180_000);
  const { app } = await launchApp(dataDir, { sandboxed: true });
  const inPage = (script: string) =>
    app.evaluate(async ({ webContents }, code) => {
      const page = webContents
        .getAllWebContents()
        .find((each) => each.getURL().startsWith("incarnamind-analysis:"));
      return page ? page.executeJavaScript(code) : "no analysis window";
    }, script);
  expect((await run(app, python("print(1)"))).result.end).toEqual({ kind: "done" });

  const written = await inPage(`new Promise((resolve, reject) => {
    const open = indexedDB.open("kept", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("rows");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("rows", "readwrite");
      tx.objectStore("rows").put("left by a job", "row");
      tx.oncomplete = () => { open.result.close(); resolve("written"); };
    };
  })`);
  expect(written).toBe("written");
  expect((await run(app, python("print(2)"))).result.end).toEqual({ kind: "done" });

  const kept = await inPage(`new Promise((resolve) => {
    const open = indexedDB.open("kept");
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("rows")) { db.close(); resolve("nothing"); return; }
      const get = db.transaction("rows").objectStore("rows").get("row");
      get.onsuccess = () => { db.close(); resolve(get.result ?? "nothing"); };
    };
  })`);
  expect(kept).toBe("nothing");
  await app.close();
});

test("with Chromium's sandbox off for the app, no job runs: each ends as unavailable, for the sandbox", async () => {
  const { app } = await launchApp(dataDir, {
    sandboxed: true,
    extraEnv: { ELECTRON_DISABLE_SANDBOX: "1" },
  });

  const ran = await run(app, python('result("sum", 40 + 2)'));

  expect(ran.result.end).toMatchObject({ kind: "unavailable", reason: "no-sandbox" });
  expect(ran.result.output.results).toEqual([]);
  await app.close();
});
