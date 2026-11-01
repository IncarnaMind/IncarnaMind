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

/**
 * A test workbook's sheet of monthly ad spend and revenue from row 2: revenue grows with spend
 * and with time, and one revenue isn't a number.
 */
const MARKETING: AnalysisInput = {
  kind: "table",
  name: "marketing",
  columns: ["Month", "Region", "AdSpend", "Revenue"],
  firstRow: 2,
  rows: Array.from({ length: 24 }, (_, at) => {
    const spend = 10 + (at % 7) * 2.5;
    const revenue = Math.round((50 + 3.2 * spend + 4 * Math.sin(at / 2) + at * 0.8) * 100) / 100;
    return [
      `${2024 + Math.floor(at / 12)}-${String((at % 12) + 1).padStart(2, "0")}`,
      ["North", "South", "East"][at % 3] ?? "",
      spend,
      at === 5 ? "n/a" : revenue,
    ];
  }),
};

/** Every package Analyses bring beyond numpy and pandas, imported as code imports them. */
const SCIENCE = "import scipy.stats, statsmodels.api, sklearn.cluster, matplotlib.pyplot";

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

test("a regression, a forecast and a clustering run offline with scipy, statsmodels, scikit-learn and matplotlib, each figure traced to the rows it used, each plot a picture", async () => {
  test.setTimeout(300_000);
  const { app } = await launchApp(dataDir, { sandboxed: true });

  const regression = await run(
    app,
    python(
      [
        "import statsmodels.formula.api as smf",
        "import matplotlib.pyplot as plt",
        'df = inputs["marketing"].dropna(subset=["Revenue"])',
        'fit = smf.ols("Revenue ~ AdSpend", data=df).fit()',
        'used = df[["AdSpend", "Revenue"]]',
        'result("slope", fit.params["AdSpend"], "Revenue per unit of ad spend", of=used)',
        'result("p", fit.pvalues["AdSpend"], "p-value", of=used)',
        'figure("total", df["Revenue"], "sum", "Total revenue")',
        "fig, ax = plt.subplots()",
        'ax.scatter(df["AdSpend"], df["Revenue"])',
        'ax.set_title("Revenue against ad spend")',
        "plt.savefig('fit.png')",
        "plt.close(fig)",
        "plt.figure()",
        // A less common character of GB2312 (level 2), which the bundled font keeps.
        'plt.bar(["北区", "南区"], [3, 1])',
        'plt.title("各地区收入（鄞州）")',
        "plt.figure()",
        'plt.bar(["서울", "부산"], [3, 1])',
        'plt.title("매출 지역별")',
      ].join("\n"),
      [MARKETING],
    ),
  );
  expect(regression.result.end).toEqual({ kind: "done" });
  // savefig() in the code itself prints nothing for the model to read past.
  expect(regression.result.output.printed).toBe("");
  expect(regression.versions?.packages).toMatchObject({
    scipy: "1.18.0",
    statsmodels: "0.14.6",
    "scikit-learn": "1.8.0",
    matplotlib: "3.10.8",
  });
  const [slope, p, total] = regression.result.output.results;
  const fitted = {
    input: "marketing",
    rows: [
      [2, 6],
      [8, 25],
    ],
    count: 23,
  };
  expect(slope).toMatchObject({ kind: "figure", name: "slope", of: { ...fitted, how: null } });
  expect(slope?.kind === "figure" && slope.value).toBeCloseTo(3.3649, 3);
  expect(slope?.kind === "figure" && slope.of?.columns).toEqual(["AdSpend", "Revenue"]);
  expect(p?.kind === "figure" && p.value).toBeLessThan(0.001);
  expect(total).toMatchObject({
    kind: "figure",
    of: { ...fitted, columns: ["Revenue"], how: "sum" },
  });
  // pandas' own sum, which IncarnaMind works out again to Excel's 15 digits.
  expect(total?.kind === "figure" && total.value).toBeCloseTo(2590.7, 9);
  // Closed after it was saved, the plot still comes back, and so does one in Chinese, drawn with
  // the bundled font; one in Korean, which no font here has, doesn't.
  expect(regression.result.output.pictures).toEqual([
    expect.objectContaining({ title: "Revenue against ad spend" }),
    expect.objectContaining({ title: "各地区收入（鄞州）" }),
  ]);
  expect(regression.result.output.withoutGlyphs).toEqual(["매출 지역별"]);
  const [picture] = regression.result.output.pictures ?? [];
  expect(picture?.png.startsWith("iVBORw0KGgo")).toBe(true);
  expect(Math.max(picture?.width ?? 0, picture?.height ?? 0)).toBeLessThanOrEqual(1600);
  expect(picture?.width).toBeGreaterThan(600);

  const forecast = await run(
    app,
    python(
      [
        "from statsmodels.tsa.holtwinters import ExponentialSmoothing",
        'df = inputs["marketing"]',
        'fit = ExponentialSmoothing(df["Revenue"].interpolate().to_numpy(), trend="add").fit()',
        "for month, value in enumerate(fit.forecast(3), start=1):",
        '    result(f"month_{month}", value, f"Forecast, month {month} ahead", of=df[["Revenue"]])',
      ].join("\n"),
      [MARKETING],
    ),
  );
  expect(forecast.result.end).toEqual({ kind: "done" });
  const values = forecast.result.output.results.map((each) =>
    each.kind === "figure" ? each.value : null,
  );
  expect(values).toHaveLength(3);
  expect(values[1]).toBeGreaterThan(values[0] ?? Number.POSITIVE_INFINITY);
  expect(forecast.result.output.results[0]).toMatchObject({
    of: { input: "marketing", columns: ["Revenue"], rows: [[2, 25]], count: 24, how: null },
  });

  const clusters = await run(
    app,
    python(
      [
        "from sklearn.cluster import KMeans",
        'df = inputs["marketing"].dropna(subset=["Revenue"])',
        'X = df[["AdSpend", "Revenue"]]',
        "km = KMeans(n_clusters=3, n_init=10, random_state=0).fit(X)",
        'result("sizes", df.assign(cluster=km.labels_).groupby("cluster").size())',
        'result("inertia", km.inertia_, "Within-cluster sum of squares", of=X)',
        'df.plot.scatter(x="AdSpend", y="Revenue", c=km.labels_, title="Clusters")',
      ].join("\n"),
      [MARKETING],
    ),
  );
  expect(clusters.result.end).toEqual({ kind: "done" });
  const [sizes, inertia] = clusters.result.output.results;
  expect(
    sizes?.kind === "table" && sizes.table.rows.reduce((n, row) => n + Number(row[1]), 0),
  ).toBe(23);
  expect(inertia).toMatchObject({ of: { count: 23, how: null } });
  expect(clusters.result.output.pictures?.map((each) => each.title)).toEqual(["Clusters"]);
  expect(clusters.result.output.printed).toBe("");
  await app.close();
});

test("a job loads only the packages its code uses: one that needs only pandas loads none of the others", async () => {
  test.setTimeout(240_000);
  const { app } = await launchApp(dataDir, { sandboxed: true });
  const loaded =
    'import sys\nprint(sorted(name for name in ("scipy", "statsmodels", "sklearn", "matplotlib") if name in sys.modules))';

  const pandasOnly = await run(
    app,
    python(`${loaded}\nresult("n", len(inputs["sales"]))`, [SALES]),
  );
  expect(pandasOnly.result.output.printed).toBe("[]\n");
  expect(pandasOnly.result.output.results).toEqual([
    { kind: "figure", name: "n", label: "n", unit: null, value: 7 },
  ]);

  const correlation = await run(
    app,
    python(
      `r = inputs["sales"]["Revenue"].rank().corr(inputs["sales"]["Revenue"], method="spearman")\n${loaded}`,
      [SALES],
    ),
  );
  expect(correlation.result.end).toEqual({ kind: "done" });
  expect(correlation.result.output.printed).toBe("['scipy']\n");

  // Rows keep their row number in the sheet: a position taken for one says to use .iloc.
  const position = await run(app, python('inputs["sales"].loc[0, "Revenue"]', [SALES]));
  expect(position.result.end.kind === "error" && position.result.end.message).toContain(
    "An input's rows are indexed by their row number in the sheet, from row 2: take a row by its position with .iloc.",
  );
  const row = await run(app, python('result("first", inputs["sales"].loc[2, "Revenue"])', [SALES]));
  expect(row.result.output.results).toEqual([
    { kind: "figure", name: "first", label: "first", unit: null, value: 120 },
  ]);

  // Two names the same once cut to a label's length are one result, the later.
  const long = "x".repeat(250);
  const cut = await run(app, python(`result("${long}a", 1)\nresult("${long}b", 2)`));
  expect(cut.result.output.results).toEqual([
    expect.objectContaining({ kind: "figure", value: 2 }),
  ]);

  // A library's own import the code can't show: the error says how to load it.
  const hidden = await run(app, python('import importlib\nimportlib.import_module("scipy")'));
  expect(hidden.result.end).toMatchObject({ kind: "error" });
  expect(hidden.result.end.kind === "error" && hidden.result.end.message).toContain(
    "scipy comes with Analyses, but this run didn't load it: import it at the top of the code (import scipy)",
  );
  await app.close();
});

test("with scipy, statsmodels, scikit-learn and matplotlib loaded, nothing leaves the sandbox and nothing carries from one job to the next", async () => {
  test.setTimeout(240_000);
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
  const { app } = await launchApp(dataDir, { sandboxed: true });

  // The spike's probes, with every package loaded: each must fail, and the network hear nothing.
  const probes = [
    `import urllib.request\nurllib.request.urlopen("${url}/urllib", timeout=5).read()`,
    `import socket\nsocket.create_connection(("127.0.0.1", ${port}), 3).sendall(b"GET /socket HTTP/1.0\\r\\n\\r\\n")`,
    `from pyodide.http import open_url\nopen_url("${url}/open-url").read()`,
    `import js\nx = js.XMLHttpRequest.new()\nx.open("GET", "${url}/xhr", False)\nx.send()`,
    `import js\njs.fetch("${url}/fetch")\nraise RuntimeError("fetch was only started")`,
    `import js\njs.WebSocket.new("ws://127.0.0.1:${port}/socket")\nraise RuntimeError("the socket was only started")`,
    `import js\njs.importScripts("${url}/script.js")`,
    `import js\njs.eval("1 + 1")`,
    `import js\njs.Function.new("return 1")()`,
    `open(${JSON.stringify(secret)}).read()`,
    `import os\nos.listdir(${JSON.stringify(secretFolder)})`,
    "import micropip",
    'import subprocess\nsubprocess.run(["ls"])',
    // matplotlib reads a font or an image by its path; pandas and scipy a data file or a URL.
    `import matplotlib.image\nmatplotlib.image.imread(${JSON.stringify(secret)})`,
    `import pandas as pd\npd.read_csv(${JSON.stringify(secret)})`,
    `import pandas as pd\npd.read_csv("${url}/data.csv")`,
    `import scipy.io\nscipy.io.loadmat(${JSON.stringify(secret)})`,
  ];
  const probed = await run(
    app,
    python(
      [
        SCIENCE,
        `probes = ${JSON.stringify(probes)}`,
        "refused = []",
        "for probe in probes:",
        "    try:",
        "        exec(probe, {})",
        "    except Exception:",
        "        refused.append(probe)",
        "print(len(probes), [probe for probe in probes if probe not in refused])",
      ].join("\n"),
    ),
  );
  expect(probed.result.end).toEqual({ kind: "done" });
  expect(probed.result.output.printed).toBe(`${probes.length} []\n`);
  const first = await run(
    app,
    python(
      [
        SCIENCE,
        "import matplotlib, builtins",
        'matplotlib.rcParams["lines.linewidth"] = 9',
        "builtins.kept = statsmodels.api",
        'open("/tmp/left.txt", "w").write("left by a job")',
        "matplotlib.pyplot.plot([1, 2])",
      ].join("\n"),
    ),
  );
  expect(first.result.end).toEqual({ kind: "done" });
  expect(first.result.output.pictures).toHaveLength(1);
  const next = await run(
    app,
    python(
      [
        SCIENCE,
        "import matplotlib, builtins, os",
        'print(matplotlib.rcParams["lines.linewidth"], hasattr(builtins, "kept"), os.path.exists("/tmp/left.txt"))',
      ].join("\n"),
    ),
  );
  expect(next.result.output.printed).toBe("1.5 False False\n");
  expect(next.result.output.pictures).toEqual([]);

  expect(heard).toEqual([]);
  await app.close();
  server.close();
  await rm(secretFolder, { recursive: true, force: true });
});
