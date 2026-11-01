import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { AUDITED_WHEELS, noticeProblems } from "../../scripts/pythonNotices.mjs";
import { PYODIDE_FILES, packagesFor } from "../../scripts/pythonRuntime";
import { PLOT_FONT } from "../../src/shared/analysisWindow";

/*
 * What Analyses run with ships with the app (ADR-0023): Pyodide's files and the wheels the build
 * fetches into resources/python, each named in the licence notice, with where Pyodide's source is.
 */

const REPO_ROOT = resolve(__dirname, "../..");
const read = (path: string) => readFile(join(REPO_ROOT, path), "utf8");

describe("the files Analyses run with", () => {
  test("numpy, pandas, scipy, statsmodels, scikit-learn and matplotlib come with every package they depend on, each with the names code imports it by", async () => {
    const lock = JSON.parse(await read("node_modules/pyodide/pyodide-lock.json"));
    const packages = packagesFor(lock);

    expect(packages.map((each) => each.name)).toEqual([
      "contourpy",
      "cycler",
      "fonttools",
      "joblib",
      "kiwisolver",
      "matplotlib",
      "numpy",
      "packaging",
      "pandas",
      "patsy",
      "pillow",
      "pyparsing",
      "python-dateutil",
      "pytz",
      "scikit-learn",
      "scipy",
      "six",
      "statsmodels",
      "threadpoolctl",
    ]);
    expect(packages.find((each) => each.name === "scikit-learn")?.imports).toEqual(["sklearn"]);
    expect(packages.find((each) => each.name === "matplotlib")?.imports).toContain("matplotlib");
    expect(packages.find((each) => each.name === "pillow")?.imports).toEqual(["PIL"]);
  });

  test("each is named in the notice at its version, with Pyodide's source at the version that ships", async () => {
    const lock = JSON.parse(await read("node_modules/pyodide/pyodide-lock.json"));
    const { version } = JSON.parse(await read("node_modules/pyodide/package.json"));
    const notice = await read("resources/notices/python.txt");

    for (const each of packagesFor(lock))
      expect(notice).toContain(`- ${each.name} ${each.version}:`);
    for (const file of PYODIDE_FILES) expect(notice).toContain(file);
    expect(notice).toContain(`- Pyodide ${version}: Mozilla Public License 2.0`);
    expect(notice).toContain(`https://github.com/pyodide/pyodide/tree/${version}`);
    expect(notice).toContain(`CPython ${lock.info.python}`);
    expect(notice).toContain("Mozilla Public License Version 2.0");
    expect(notice).toContain("PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2");
  });

  test("the font plots draw Chinese with is committed beside them, named in the notice with its licence", async () => {
    const font = await readFile(join(REPO_ROOT, "resources/fonts/NotoSansSC-GB2312.otf"));
    const notice = await read("resources/notices/python.txt");

    expect(font.subarray(0, 4).toString("latin1")).toBe("OTTO");
    expect(notice).toContain(
      "- Noto Sans SC 2.004, the font plots draw Chinese with: SIL Open Font License 1.1",
    );
    expect(notice).toContain("SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007");
  });

  test("every wheel that ships is audited, and the notice credits all it bundles with its licence text", async () => {
    const notice = await read("resources/notices/python.txt");
    const lock = JSON.parse(await read("node_modules/pyodide/pyodide-lock.json"));
    const packages = packagesFor(lock);

    expect(noticeProblems(notice, packages, [PLOT_FONT])).toEqual([]);
    expect(noticeProblems(notice.replaceAll("\n", "\r\n"), packages, [PLOT_FONT])).toEqual([]);
    expect(AUDITED_WHEELS["scipy 1.18.0"]).toEqual(
      expect.arrayContaining([
        "SuperLU",
        "ARPACK",
        "PROPACK",
        "HiGHS",
        "UNU.RAN",
        "PRIMA",
        "MINPACK",
      ]),
    );
    expect(AUDITED_WHEELS["scikit-learn 1.8.0"]).toEqual(["scikit-learn", "libsvm", "liblinear"]);
    // FreeType's licence text gone, its line in the list kept: the build fails.
    const freeType = notice.indexOf("The FreeType Project LICENSE");
    const withoutText = notice.slice(0, freeType) + notice.slice(notice.indexOf("\n=", freeType));
    expect(noticeProblems(withoutText, packages, [PLOT_FONT])).toEqual([
      'notices/python.txt has no licence text for FreeType ("The FreeType Project LICENSE")',
    ]);
    // An upgraded wheel fails until someone audits what it bundles.
    const upgraded = packages.map((each) =>
      each.name === "pillow" ? { ...each, version: "12.3.0" } : each,
    );
    expect(noticeProblems(notice, upgraded, [PLOT_FONT])).toEqual([
      "pillow 12.3.0 isn't audited: list the libraries compiled into its modules in scripts/pythonNotices.mjs, with their notices",
    ]);
  });

  test("the build's folder is packaged beside app.asar and never committed", async () => {
    expect(await read("electron-builder.yml")).toMatch(
      /- from: resources\/python\n\s+to: python\n/,
    );
    expect(await read(".gitignore")).toMatch(/^resources\/python\/$/m);
  });
});
