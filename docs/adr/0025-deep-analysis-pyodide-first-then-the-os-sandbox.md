---
status: decision 1, and decision 3 for Analyses, accepted (2026-10-31, #2346); decisions 2 and 4–6, and decision 3 for run_code, proposed (#2351)
---

# Deep analysis: more Python in the Analysis sandbox first, then code runs in the OS sandbox

Analysts ask for more than totals and group-bys: regressions, tests, clustering, forecasts and plots. They want the assistant to work as an agent harness works: write code, run it, read what it printed, and run again. Today an Analysis (ADR-0023) runs Python in Pyodide with numpy and pandas, in a hidden sandboxed window with no network and no files, on Inputs cited from Documents, on every system. A Skill script runs through the "os" Executor (#65): Seatbelt on macOS and bubblewrap on Linux, through `@anthropic-ai/sandbox-runtime`, with no network. Windows has no OS sandbox, so Skill scripts there ask every time. A User who has an agent harness of their own can already bring it (ADR-0013's addendum; #353); this record is about IncarnaMind's own assistant, which most Users will use.

The spike on `spike/run-code-sandbox` measured three ways to give the assistant more:
- Pyodide's own builds of scipy, statsmodels, scikit-learn and matplotlib, in the Analysis window as it is.
- A `run_code` Tool that runs bash or Python in the OS sandbox on copies of Documents.
- For that Tool's Python, a bundled CPython (python-build-standalone with wheels installed by uv), or the User's own `python3`.

The prototype is `src/core/runCode/`. Its tests are `tests/main/runCode*.test.ts`, and the probes and their results are in `spike/run-code/`, all on that branch.

What #2346 built is decision 1, and decision 3 as it applies to Analyses. `run_code` and everything else here waits for #2351, and stays proposed until it is built.

## Decision

In this order:

1. **Analyses gain scipy, statsmodels, scikit-learn and matplotlib** (#2346, accepted).
   - They are Pyodide's own wheels, from its lock file, fetched at build time and checked against the SHA-256 the lock records, as numpy and pandas are (`scripts/pythonRuntime.ts`). `packages.json` lists each with the names code imports it by.
   - They load and run under ADR-0023's Content-Security-Policy as it is. In 18 fresh Workers of the spike, no request was cancelled and no policy was violated (below), and ADR-0023's probes still fail with every package loaded (`e2e/analysis.spec.ts`).
   - **A job loads only the packages its code uses.** The spare interpreter keeps only numpy and pandas, so an Analysis that uses only pandas starts as fast as it did. Before the code runs, the helper reads its imports, and the two places pandas imports one itself: plotting (`.plot`, `.hist`, `.boxplot`) loads matplotlib, and a Spearman or Kendall correlation loads scipy. The job's time limit runs from when those are loaded; loading them is bounded by the start limit. A package a library imports that the code didn't name ends the run with an error that says to import it at the top.
   - **matplotlib draws with its Agg backend into PNGs.** Every figure pyplot makes while the code runs comes back as a picture, closed or saved or not, at twice its size in points, no longer than 1,600 pixels and no larger than 1.5 MB, as a Note keeps a pasted picture (#1937). A figure wider than 5 inches is drawn 5 inches wide, so its text, sized in points, stays legible where the assistant panel shows it about 400 px wide. Until the Analysis block (#448), the Answer shows it where it writes `[=picture n]` on a line of its own, as a picture Block; a chart or picture the reply never places is added at the Answer's end. `chart()` stays the way to draw a bar, line, pie or scatter chart the app draws and a Note can restyle, and the Answer's instructions say to use it where it can.
   - **Chinese in a plot.** matplotlib's own fonts (DejaVu, STIX) have no Chinese. Noto Sans SC 2.004 (SIL Open Font License 1.1), cut to GB2312's 6,763 characters with its punctuation, ASCII and Latin-1 (`scripts/plotFont.py`), ships beside the packages. A job that draws loads it into its file system and adds it after matplotlib's own family, so Latin text looks as it did and each character DejaVu lacks is drawn with it. The renderer never loads it. A plot with a character neither has (Japanese, Korean, a Chinese character outside GB2312) would show boxes, so it is left out, and the model reads why and to use `chart()` or other labels.
   - Nothing else changes: the same Inputs cited to their cells, the same `result()`, no clock, and the versions of every bundled package recorded with each run.
2. **A `run_code` Tool runs bash, or Python, in the OS sandbox, on macOS and Linux.**
   - **Inputs.** It names the Documents it reads by the ids of Passages the model was given. Each is copied (a copy-on-write clone where the disk has them) into an `inputs` folder the code can read but not write. The copy must have the SHA-256 the index recorded as the Document's content hash. A file that changed since is refused, and the model is told to read it again.
   - **Where it writes.** The code runs in a working folder of its own, which is also its TMPDIR and the only folder it may write. It has no network.
   - **Limits:**
     - a time limit (120 s);
     - 64 KiB of each output stream kept;
     - the largest file it may write;
     - how many processes it may start, counted over those the User's account already runs;
     - its memory;
     - the size of its folder.
   - **What comes back:** what it leaves in `out/`, up to 20 files of 5 MB each. Nothing it writes reaches a Linked folder or a Note by itself. The assistant adds a file or a figure the usual ways.
   - **Python is the User's own `python3`,** when it can import what the code needs: pandas at least, checked once in the sandbox at startup. Otherwise `run_code` offers bash only, and the assistant uses an Analysis for Python. A bundled CPython is not shipped now (Considered options).
   - **What the sandbox denies reading:** the home and data folders as now, and also the shared temporary folder (`os.tmpdir()`) and removable and network volumes (`/Volumes` on macOS; `/media`, `/mnt` and `/run/media` on Linux). Each run's own folders are allowed again inside them. The spike found that the shared temporary folder was readable from the sandbox.
3. **A figure from code keeps the trust story of ADR-0021.** The model never types a number. Code gives a figure the app can check with `figure(name, column, how, label, unit)`, and any other number with `result(name, value, label, unit)`.
   - **For Analyses (accepted, #2346):**
     - **Where the column comes from.** An Input's rows keep their row number in the sheet as the DataFrame's index, named `row`, and the DataFrame knows which Input it is. `figure()` takes one column of an Input's rows, after any filtering; a column after a merge, a group-by, a concat or `reset_index()` has lost its rows, and `figure()` says so rather than name the wrong ones.
     - **What a figure records.** `how` is sum, mean, min, max or count. The helper works the value out itself, and records the Input, the column's heading, the rows (as runs of consecutive rows, at most 2,000 runs) and `how`.
     - **The check, when the Analysis runs.** IncarnaMind works the figure out again from the cells it read from the Document version and sent to the sandbox, with its own arithmetic, the way the helper reads a column (a mostly-numbers column skips its text cells), and compares the two to Excel's 15 digits. Only a match gets a marker. A mismatch or a reference it can't follow gets none, and the model reads why, and the number the cells come to. The figure card says what the figure is of, in which rows, and that IncarnaMind worked it out again from those cells when the Analysis ran. The outcome is kept with the run (`recalculations`).
     - **Figures without a way to work them out.** A regression coefficient, a p-value or a forecast is an Analysis figure, kept with its code, its Inputs' Document versions and hashes, and the runtime's versions, and shown as calculated by code and not recalculated. `result(..., of=rows)` names the rows and columns of an Input it was worked out from, such as those a model was fitted on, and its card shows them.
     - **Not yet.** A sentence's check still treats every Analysis figure as not checked, so none gets the green check; working a `figure()` figure out again on Recalculate, with no sandbox, comes with `run_code`'s figures (#2351).
   - **For `run_code` (proposed, #2351):**
     - **Where the column comes from.** `read_table` gives a DataFrame whose rows carry their row number in the sheet, the headings being row 1. In the shipped version it reads the rows as the app's index read them, the same Units Citations are checked against, and keeps each row's number in a column of its own, since a merge resets a DataFrame's index (measured). In the spike it reads the copied CSV and numbers the index.
     - **What a figure records.** The column is taken from that DataFrame, after any filtering. `how` is sum, mean, min, max or count. The helper works the value out itself, so the value and its cells can't disagree. The figure keeps the column's heading and exact row numbers, its input's Document version, and `how`.
     - **The check.** The app reads those cells itself from its own reading of the Document version, works the figure out again with its own arithmetic, and compares the two to Excel's 15 digits. A match is "Inputs found · recalculated", and its Inputs are cited as a rows Citation. A mismatch is never shown as a figure, and the model is told the number the cells come to. The check needs no sandbox, so it runs again on Recalculate as `calculate`'s does.
     - **Figures without `of`.** A regression coefficient, a p-value or a forecast is an Analysis figure. It is kept with its code, its Inputs' Document versions and hashes, and the runtime's versions, and shown as calculated by code and not recalculated. It can be run again only where its runtime is pinned: Pyodide, or a bundled CPython. With the User's own Python it is marked as one that can't be run again.
     - **One contract for both runtimes.** `run_code`'s helper takes the same `figure()` an Analysis's does (above), and the check on Recalculate covers both.
     - **What run_code's figures go through.** They reach an Answer only as markers (`[=n]`), as an Analysis's do. A number the reply writes without a marker is caught as ADR-0021 already catches one (#1796).
4. **What asks.** The rules are approvals by Effect, as ADR-0013 sets out:
   - **Runs without asking.** `run_code` at level "os" is "sandboxed code", ADR-0023's Effect scope, which now covers both sandboxes. It reads only copies of Documents the Run may already read, writes only its own folder, and can't send anything. So it runs without asking, also after the Run has read third-party text (#78).
   - **Asks every time, Allow or Don't allow, never "always":** a call that names a folder outside the Library to read (a granted folder).
   - **Not offered:** network for code, writing outside its own folder, and `run_code` wherever the OS sandbox can't start. ADR-0013's rule for a Shell is that it fails closed and never gets Tool-level "always", and bash on the User's computer is a Shell.
5. **Windows.**
   - **Until Windows has an "os" level,** `run_code` isn't offered there. Analyses run there now, in Chromium's sandbox.
   - **That level will be an AppContainer with no capabilities inside a Job Object,** started by a small signed helper. It needs no administrator rights or UAC prompt, and runs on Windows 10 22H2 and Windows 11.
   - **What it gives:**
     - no network, loopback and DNS included;
     - writes only to the folders granted to its container;
     - limits on processes, memory and CPU time;
     - kill-on-close for every process it started.
   - **Its limits:** system folders stay readable, and writing to `NUL` fails (below).
   - **MXC replaces it** once most Users run Windows 11 24H2 build 26100.9278 or later. MXC is Microsoft's container SDK, which Codex prefers.
6. **Linux.** The OS sandbox needs bubblewrap and socat, and unprivileged user namespaces. Ubuntu 24.04 restricts those through AppArmor. Where the sandbox can't start, `run_code` isn't offered, and the User reads why and how to fix it, as Analyses already say when Chromium's sandbox is off.

## Measured

On the M2 Max used for ADR-0023, with macOS 26.5, Electron 44.9.1 and Pyodide 314.0.7. Another app's work kept the machine's 15-minute load between 17 and 29, so the times are noisy and higher than ADR-0023's. Each Pyodide row is the median of 3 fresh module Workers. Each OS-sandbox row is the median of 10 warm runs.

**More of Python in Pyodide** (`spike/run-code/pyodide-probe`):

| Packages loaded and imported, then a small task with each | Wheels added (zip) | Fresh Worker, ready and run | Renderer at most |
|---|---|---|---|
| numpy, pandas (today) | — | 4.3 s | 0.36–0.57 GB |
| + scipy (`stats.linregress`, `ttest_ind`) | 14.0 MB | 7.6 s | 0.48–0.72 GB |
| + statsmodels (OLS from a formula), with patsy and packaging | 22.4 MB (with scipy) | 8.6 s | 0.53–0.68 GB |
| + scikit-learn (LinearRegression, KMeans), with joblib and threadpoolctl | 18.7 MB (with scipy) | 9.2 s | 0.56–0.61 GB |
| + matplotlib (a bar chart with a Chinese title as PNG), with its 7 dependencies | 9.6 MB | 6.4 s (6.2–9.6) | 0.46–0.57 GB |
| all four | 36.5 MB | 12.1 s | 0.59–0.79 GB |

- In Pyodide's file system, the four packages and their dependencies unpack to 119 MB more. The whole set, numpy and pandas included, is 148 MB.
- Every load fetched only the bundled scheme: 0 requests cancelled and 0 policy violations in 18 Workers.

**In the built app** (#2346: a build for testing, with Chromium's sandbox on, on the same M2 Max, beside `main`'s build measured the same way; each the median of 3, with the machine's 1-minute load between 7 and 15):

| | `main` | With the four packages |
|---|---|---|
| The first job: the window and Python started, a pandas job | 3.1 s | 3.2–3.4 s |
| A pandas job once the spare is ready | 18 ms | 22–30 ms |
| A pandas job straight after another, waiting for the spare | 3.0 s | 2.9 s |
| A scipy job (`stats.linregress`), once the spare is ready | — | 2.6 s |
| A statsmodels job (OLS from a formula) | — | 3.6 s |
| A scikit-learn job (KMeans) | — | 4.1 s |
| A matplotlib job (a bar chart, as a PNG) | — | 1.8 s |
| A job that imports all four | — | 6.8 s |

- A job's time is its packages loading, then its code: of a scipy job's 2.6 s, its code (the import and the work) took 1.9 s. matplotlib is imported before the code starts, so its code took 0.15 s.
- With Claude Haiku 5.5 driving the built app on a made-up workbook (five questions: a regression, a forecast, a clustering with a plot, a total and a region's part of it, and averages asked in Chinese), in six runs while the instructions were worded: IncarnaMind worked out again every `figure()` figure the model gave, 22 of 22, and refused none. A model's figures named their rows (`of=`) in 0 of 8 before the instructions gave an example, and in 2 of 8 to 5 of 5 after; the final wording's run named 5 of 5. Asking again for the rows of figures that named none made the model run again and once turn a right share into a wrong one, so it isn't asked. At most 1 call in a run failed.
- Python's files (`resources/python`) are 21.4 MB unpacked and 13.0 MB compressed today (`xz -9`, as installers compress), and 57.9 MB and 48.7 MB with the four packages: 35.8 MB more compressed. The plot font adds 1.6 MB unpacked, 1.1 MB compressed. Built from `main` and from #2346 on the same Mac, the macOS installers grew from 229.9 MB to 267.4 MB (the dmg, 37.5 MB more) and from 223.1 MB to 260.4 MB (the zip, 37.2 MB more).

**The OS sandbox and `run_code`** (`tests/main/runCode.bench.test.ts`, python-build-standalone 3.14.10 with numpy 2.5.4 and pandas 3.1.0):

| | Plain | In the OS sandbox |
|---|---|---|
| `bash -c true` | 5 ms | 53 ms |
| `python3 -c pass` | 21 ms | 58 ms |
| `python3 -c "import pandas"` | 343 ms | 372 ms |
| `run_code` on a 50,000-row CSV: copy it, read it, a sum and a group-by, check the figure | — | 498 ms (copy 2 ms, run 470 ms, collect and check 26 ms) |

- All six packages, imported warm in that CPython: 5.2–6.8 s. Imported for the first time after they were installed: 42 s, which fits macOS assessing each of the 336 native libraries on first load, though the cause isn't confirmed. A signed build was not measured.

**What `run_code` held to on macOS** (`tests/main/runCode.test.ts`, 7 tests passing):
- Reading the home canary was refused. So was changing or adding an input, and so were DNS, TCP to the internet and TCP to loopback. A secret-looking variable was not in its environment.
- The limits:
  - a loop was stopped at its time limit;
  - output was cut to 65,536 bytes;
  - 3 GB of allocations were stopped at a 1 GB memory limit;
  - an 80 MB file stopped at a 50 MB file limit with "File too large";
  - 400 MB of files were stopped at a 100 MB folder limit;
  - a bash fork bomb, limited to 64 processes over the account's own, ran to its time limit, and nothing of it was left running.
- Figure checks: of four figures, the two a sum of named rows gave were recalculated. A figure 10% above its cells was caught as differing, and one without `of` stayed unchecked.

**A real model** (Claude Haiku 5.5 on a direct Anthropic key, AI SDK 7, up to 4 steps; held-out questions on a 9-row CSV, with no examples in the prompt):

| Helper | Questions | Figures recalculated | Calls that failed | Requests | Uncached input | Output | Spend |
|---|---|---|---|---|---|---|---|
| `result(…, of=, how=)` (run 1) | 3 | 3 of 4 | 5 of 8 | 11 | 26,210 | 3,261 | $0.0043 |
| `result(…, of=, how=)` (run 2) | 3 | 3 of 4 | 6 of 9 | 11 | 26,094 | 3,230 | $0.0042 |
| `figure(name, column, how)` (run 3) | 5 | 6 of 6 | 2 of 10 | 14 | 21,120 | 2,817 | $0.0035 |

- No request read or wrote the prompt cache. Prices: $0.10 per million input tokens and $0.50 per million output.
- With `result()`, most failed calls were refused by the helper's own check of `of=`, or passed a DataFrame as the value; the average was given without `of` and stayed unchecked.
- With `figure()`, one failure was the column's name given in place of the column, which the helper's message fixed on the next call.
- The replies wrote markers where the figures go. One also wrote "about 33.5%" without one, which #1796's line marks.
- The check shows the arithmetic over the cited cells, not that they were the right cells: "the highest in Q3" came back as the maximum of East's Q3 row alone. As ADR-0021 says, that is for the User to judge from the Inputs.

**Not measured:** Linux and Windows. On GitHub's ubuntu-24.04 runners, the OS sandbox's tests are skipped today (6 of 6 in the last green run on `main`), as `run_code`'s would be.

## Considered options

- **Pyodide alone, as the whole answer.**
  - Kept as the first step.
  - Not enough alone: it has no shell, a 32-bit WebAssembly memory (a `MemoryError` near 4 GB), one thread, and Inputs limited to the rows the index keeps.
- **A bundled CPython (python-build-standalone, wheels installed by uv).** Deferred until Users ask for more than Pyodide gives. Its costs:
  - 98–140 MB more per installer, for each platform;
  - 336 native libraries to sign one by one with the hardened runtime on macOS;
  - on Windows, SignPath Foundation's terms allow signing only what the project builds, so `python.exe` and every `.pyd` would ship unsigned, which Smart App Control blocks where it enforces;
  - 42 s for the first import on macOS.
  - What it gives: native speed, every package, and figures that can be run again.
- **The User's own `python3` for `run_code`.**
  - Chosen. It costs nothing to ship, and the people who need more than Pyodide often have their own.
  - On a Mac out of the box it is Xcode's Python 3.9.6, without pandas, so `run_code` offers bash only there.
  - Its versions vary, so its figures without `of` can't be run again, and they are marked so.
- **No sandbox, asking before every run.** This is the classic Open Interpreter and Cline. Rejected:
  - ADR-0013's rule for a Shell;
  - Anthropic found users approve about 93% of permission prompts;
  - a prompt can't bound what an approved program does.
- **A cloud interpreter** (OpenAI's Code Interpreter; the Claude API's code execution tool). Rejected:
  - the User's Documents would go to a service the User didn't choose (ADR-0022);
  - it wouldn't work offline;
  - Local mode couldn't use it.
  - Its results contract is worth copying, and was: an output folder whose files come back.
- **Windows:**
  - A sandbox account with firewall filters (Codex's elevated mode; sandbox-runtime's Windows alpha). Rejected for the first run: it needs one UAC prompt.
  - Windows Sandbox: needs an administrator, isn't on Home, has the network on by default, and gives no output back.
  - WSL2 (Claude Code, Cursor, Zed): needs an administrator to install, and runs Linux, not the User's Windows Python.
  - A restricted token at low integrity (Gemini CLI): doesn't confine reads or the network.
  - MXC: needs Windows 11 24H2 build 26100.9278 or later, is a 108 MB package, has no resource limits, and reached 1.0 on 2026-10-07. It replaces the AppContainer helper later.

## Consequences

Of what #2346 built:

- **Installer size.** It grows by about 37.5 MB on every system (the macOS dmg, measured above), so Python's files and the font total about 50 MB compressed. `scripts/check-package.mjs` gives each installer its own limit: its size in 0.1.0-alpha.5, these 37.5 MB, and about 5 MB (AppImage 275, dmg 270, zip 263, exe 242, deb 226 MB).
- **Licences.** `resources/notices/python.txt` gains, with their licence texts from the wheels: scipy, statsmodels, scikit-learn, joblib, threadpoolctl, contourpy, kiwisolver and cycler (BSD-3-Clause); patsy (BSD-2-Clause); packaging (Apache-2.0 or BSD-2-Clause); fonttools and pyparsing (MIT); pillow (MIT-CMU); and matplotlib (the Matplotlib License, PSF-based, with the DejaVu and STIX fonts' notices). It points to the licence files scipy, statsmodels and scikit-learn carry in their wheels for the code they bundle. It credits the native libraries compiled into the wheels' modules, with their texts:
  - FreeType (matplotlib's `ft2font`, pillow's `_imagingft`), under the FreeType License with its credit line, not the GPL it is also offered under;
  - IJG libjpeg, libtiff and zlib (pillow's `_imaging`), with the IJG's acknowledgement;
  - libwebp (pillow's `_webp`, BSD-3-Clause with Google's patent grant);
  - Anti-Grain Geometry 2.4 (matplotlib's `_backend_agg`, `_image`, `_path`);
  - Qhull 2020.2 (matplotlib's `_qhull`), whose text matplotlib's wheel lacks;
  - OpenBLAS 0.3.31 with reference LAPACK and libf2c (scipy's `libopenblas.so`);
  - inside scipy's own modules, whose wheel carries only scipy's own licence: SuperLU, ARPACK, PROPACK, HiGHS, UNU.RAN, PRIMA and MINPACK (with Argonne's acknowledgement), with their texts; QUADPACK, FITPACK and ODRPACK (public domain) and Boost.Math (whose licence asks no notice of a program); and scipy 1.18.0's and xsf's lists of what they bundle, in full;
  - inside scikit-learn's: libsvm and liblinear.

  And Noto Sans SC 2.004 under the SIL Open Font License 1.1, as a Modified Version. All are permissive, and none is taken under the LGPL or GPL. `scripts/pythonNotices.mjs` lists each wheel, by name and version, with the notices its code needs, and a line each notice's own text must hold. `scripts/check-package.mjs` fails a build with a wheel not listed, so an upgrade is audited for what it bundles, or with a notice whose text is gone.
- **A job that uses them waits for them.** A job that imports one of the four takes 2–7 s more on this Mac than a pandas job, most of it importing the package; more on a slower computer.
- **A Chinese font ships.** GB2312's second level, which holds characters common in people's and companies' names, costs about 0.5 MB more than its first level alone; the whole set is worth it. Japanese, Korean and rarer Chinese characters still leave a plot out.
- **Content schema 46.** A Note keeps an Analysis figure's rows with its kept value, so an older version opens a Note written since read-only.
- **The packaged app's engine check** runs a regression, a forecast, a clustering and a plot in the Analyses window, on macOS, Windows and Linux.

Of the rest, once built (#2351):

- **The Executor.**
  - `ExecRequest` gains `limits`.
  - The local Executor measures memory and the folder's size every 250 ms and stops the program with every process it started. macOS refuses a memory rlimit, so a fast allocation can run past the limit for up to that long.
  - The "os" confinement sets `ulimit -f` and `ulimit -u`. The process limit counts per account on macOS and Linux, so it is set over the account's count when the run starts.
  - On Windows the Job Object will hold these limits.
- **The OS sandbox** also denies the shared temporary folder and removable and network volumes, for Skill scripts too.
- **sandbox-runtime.** It moves from 0.0.79 to the latest (0.0.81) in the same change. On Linux, 0.0.80 stops commands from creating namespaces and lets `denyWrite` win over `allowWrite`.
- **Effect scope "sandbox"** names sandboxed code in either sandbox. Its approvals don't change.
- **A word for the interface.** CONTEXT.md gains a word for a run of `run_code`. It is not an Analysis, which runs with no files, and not a Skill script. The word is decided with the interface's wording.
- **Linux in CI.** The jobs install bubblewrap and socat and lift Ubuntu's AppArmor restriction on user namespaces for the test step. Without that, the OS sandbox's tests and `run_code`'s stay skipped, as now.
- **Windows.** The AppContainer helper is a new native component to build, sign with the app's certificate, and test on Windows 10 22H2 and Windows 11 with Smart App Control enforcing.
- **The hosted version** doesn't offer `run_code` until it has a remote sandbox (ADR-0013).
