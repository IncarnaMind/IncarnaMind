import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { hasEntry, NATIVE_CODE, noticesFor } from "../../scripts/pythonNotices.mjs";
import { PYODIDE_FILES, packagesFor } from "../../scripts/pythonRuntime";

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

  test("every native library compiled into the wheels has its entry and licence text in the notice", async () => {
    const notice = await read("resources/notices/python.txt");
    const named = new Set(NATIVE_CODE.flatMap((each) => each.notices));

    for (const name of named) expect(hasEntry(notice, name), name).toBe(true);
    expect(noticesFor("matplotlib", "matplotlib/_qhull.cpython-314-wasm32-emscripten.so")).toEqual([
      "matplotlib",
      "Qhull",
    ]);
    expect(noticesFor("scipy", "scipy.libs/libopenblas.so")).toEqual([
      "OpenBLAS",
      "LAPACK",
      "libf2c",
    ]);
    expect(noticesFor("scipy", "scipy/linalg/_flapack.cpython-314-wasm32-emscripten.so")).toEqual([
      "scipy",
    ]);
    expect(noticesFor("scipy", "scipy.libs/libsomething.so")).toBeNull();
    expect(notice).toContain("The FreeType Project LICENSE");
    expect(notice).toContain("Independent JPEG Group");
    expect(notice).toContain("Qhull, Copyright (c) 1993-2020");
    expect(notice).toContain("OpenBLAS");
  });

  test("the build's folder is packaged beside app.asar and never committed", async () => {
    expect(await read("electron-builder.yml")).toMatch(
      /- from: resources\/python\n\s+to: python\n/,
    );
    expect(await read(".gitignore")).toMatch(/^resources\/python\/$/m);
  });
});
