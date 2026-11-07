---
status: decision 1, and decision 3 for Analyses, accepted (2026-10-31, #2346); decisions 2, 3 for run_code, 4 and 6 accepted as amended on 2026-11-01 (#2351); decision 5 proposed
---

# Deep analysis: more Python in the Analysis sandbox first, then code runs in the OS sandbox

Analysts ask for more than totals and group-bys: regressions, tests, clustering, forecasts and plots. They want the assistant to work as an agent harness works: write code, run it, read what it printed, and run again. Today an Analysis (ADR-0023) runs Python in Pyodide with numpy and pandas, in a hidden sandboxed window with no network and no files, on Inputs cited from Documents, on every system. A Skill script runs through the "os" Executor (#65): Seatbelt on macOS and bubblewrap on Linux, through `@anthropic-ai/sandbox-runtime`, with no network. Windows has no OS sandbox, so Skill scripts there ask every time. A User who has an agent harness of their own can already bring it (ADR-0013's addendum; #353); this record is about IncarnaMind's own assistant, which most Users will use.

The spike on `spike/run-code-sandbox` measured three ways to give the assistant more:
- Pyodide's own builds of scipy, statsmodels, scikit-learn and matplotlib, in the Analysis window as it is.
- A `run_code` Tool that runs bash or Python in the OS sandbox on copies of Documents.
- For that Tool's Python, a bundled CPython (python-build-standalone with wheels installed by uv), or the User's own `python3`.

The prototype is `src/core/runCode/`. Its tests are `tests/main/runCode*.test.ts`, and the probes and their results are in `spike/run-code/`, all on that branch.

What #2346 built is decision 1, and decision 3 as it applies to Analyses. #2351 builds decisions 2, 3 for `run_code`, 4 and 6 on macOS and Linux; Windows (decision 5) stays proposed.

## Amendment, 2026-11-01: `run_code`'s Python is IncarnaMind's own, downloaded on first use (#2351)

The project owner decided three things on 2026-11-01, which replace decision 2's "the User's own `python3`" and the Considered option that chose it:

1. **Python is IncarnaMind's own.** A pinned CPython from python-build-standalone, with a fixed set of wheels locked by their SHA-256: numpy, pandas, scipy, statsmodels, scikit-learn, matplotlib, pillow and openpyxl, and what they depend on. The User's own `python3` is never used.
   - **One lock, one build per platform.** `scripts/pythonNative/requirements.in` names the eight packages; `uv pip compile --universal --generate-hashes` writes `scripts/pythonNative/lock.txt`, with every wheel's hash for every platform. `scripts/pythonNative.ts` builds the runtime on the platform it runs on, as each platform's runner does: it fetches the pinned python-build-standalone archive and checks it against the SHA-256 recorded beside the lock, fetches this platform's wheels with pip's `--require-hashes`, then installs them with uv offline (`--offline --no-index --find-links`), so nothing is resolved from an index.
   - **The oldest systems the app runs on.** The wheels are chosen for macOS 12 on Apple silicon and for glibc 2.28 on Linux x86-64 (`manylinux_2_28`), not for the runner's own newer system. Those are the two platforms `run_code` is offered on (decision 5 covers Windows).
   - **What it records.** Each run records CPython's version, each package's version and the runtime's SHA-256, beside the helper's, as an Analysis in Pyodide records Pyodide's.
2. **It is downloaded on first use, as the speech model is,** so no installer grows.
   - **Where from.** The release workflow builds it on each platform's runner and uploads it to the same GitHub Release as the app, as `python-runtime-<platform>.tar.zst`. Its size and SHA-256 are written into the app at build time (`python-native/runtime.json` in the app's resources), so the app only accepts the file built with it. A version whose runtime is byte-for-byte the same as the last one's (the same lock, the same python-build-standalone, the same build script) keeps the copy already downloaded.
   - **When.** The first `run_code` call that runs Python, never at launch and never in the background. The step of that call says what is downloading, how big it is and how far it has got ("Downloading Python: 31 of 117 MB", then "Getting Python ready…" while it is unpacked and first imported), where the User asked. Stopping the Answer stops it once no other call waits on it; what was downloaded is kept, and the next call resumes it. bash needs no download.
   - **Checked and stored like a model.** The file downloads to `runtimes/` in the app's data folder, resumably, and is kept only when its size and SHA-256 are the ones built into the app (`embedding/download.ts`). It is unpacked there, never in the User's home, and imports its packages once, in the OS sandbox, before its first run. A runtime that fails its check is deleted.
   - **When it can't come.** Offline, a download that fails, or a file that doesn't match: the step says so in plain words, the model is told, and it runs the Analysis in Pyodide instead (decision 1), which needs no download. The next call that needs Python tries again.
   - **No consent card (ADR-0022).** ADR-0022 asks before anything of the User's goes to a service. The download sends nothing of the User's: one GET for a file IncarnaMind published, from the host its updates come from, carrying no Document, Question or setting, as the model downloads do. The Privacy page lists it with the other traffic that carries no User content.
   - **Signing.** The runtime is not part of the app bundle, so the app's signature and notarization don't cover it, and its 328 Mach-O files are not signed one by one. On Apple silicon each carries an ad-hoc signature, which is what macOS requires to load it: 259 the linker's own, 69 made after linking when their wheels were repaired (numpy's, Pillow's, scipy's and scikit-learn's bundled libraries). A file IncarnaMind writes itself carries no quarantine attribute (measured: none of the unpacked files has one), so Gatekeeper doesn't assess it. Importing every package once before the first run takes the first-load cost macOS adds while the step says Python is getting ready, rather than in the User's first analysis.
   - **Figures can be run again.** The runtime is pinned, so a figure from code without `of` can be run again to the same result with the same runtime, as an Analysis's can in Pyodide. The branch for "the User's own Python, which can't be run again" is dropped.
3. **python-build-standalone's MPL-2.0 is allowed, shipped unmodified** (`AGENTS.md` rule 8 names it beside Pyodide).
   - Its `install_only` archives carry only CPython's own `LICENSE.txt`. The licence texts of what CPython is built with (OpenSSL, SQLite, libffi, mpdecimal, expat, zlib and zlib-ng, bzip2, liblzma, zstd, libedit, ncurses, Tcl/Tk and Tix, libuuid, libX11, libXau, libxcb and Berkeley DB) are in the same release's full archive, under `python/licenses/`. The build copies them all, with the wheels' own licence files, into the runtime's `LICENSES/` folder, and checks that every library the build includes has its text.
   - **One module is left out** (the project owner agreed, 2026-11-01). On Linux, the `_dbm` module statically links Berkeley DB under the Sleepycat licence, which asks that the source of software using it be offered: not a licence rule 8 allows. No analysis needs `dbm.ndbm` (`dbm` falls back to SQLite), so `lib-dynload/_dbm*.so` and its licence text are left out of the Linux runtime. On macOS `_dbm` links the system's own ndbm, and stays. No other file of python-build-standalone's is changed.
   - **The wheels' own libraries are allowed too** (the project owner, 2026-11-01; `AGENTS.md` rule 8). scipy's wheels on every platform, numpy's on Linux and on macOS 12, and scikit-learn's on Linux bundle the GCC runtime (libgfortran, libgcc_s, libgomp: GPL-3.0-or-later with the GCC Runtime Library Exception 3.1) and libquadmath (LGPL-2.1-or-later), each as a library of its own that the package links to as it runs. No scipy wheel exists without them, and every numpy and scipy install ships them; Pyodide's own builds avoid them, which is why decision 1 needed no exception. They ship unmodified, as their wheels have them, each its own dynamically linked library, with their licence texts and a link to GCC's source. The build names them, and the packages each may come in (`COPYLEFT_ALLOWED` in `scripts/pythonNative.ts`), and fails when one turns up elsewhere; a change to the lock is a new runtime, read for what its wheels bundle, as an upgrade of Pyodide's wheels is (#2346).

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
     - the largest file it may write (100 MB);
     - how many processes it may start, counted over those the User's account already runs (64);
     - its memory (2 GB, its processes together);
     - the size of its folder (200 MB).
   - **What comes back:** what it leaves in `out/`, up to 20 files of 5 MB each, read once it has ended, after its working folder is moved where the sandbox can't write, and never through a link: an `out/` or a working folder it swapped for one comes back as nothing. Nothing it writes reaches a Linked folder or a Note by itself. The assistant adds a file or a figure the usual ways.
   - **Python is IncarnaMind's own** (amended 2026-11-01, above). bash is the system's own `/bin/bash`, with the tools the system has.
   - **What the sandbox denies reading:** the home and data folders as now, and also the shared temporary folder (`os.tmpdir()`) and removable and network volumes (`/Volumes` on macOS; `/media`, `/mnt` and `/run/media` on Linux). Each run's own folders are allowed again inside them. The spike found that the shared temporary folder was readable from the sandbox.
3. **A figure from code keeps the trust story of ADR-0021.** The model never types a number. Code gives a figure the app can check with `figure(name, column, how, label, unit)`, and any other number with `result(name, value, label, unit)`.
   - **For Analyses (accepted, #2346):**
     - **Where the column comes from.** An Input's rows keep their row number in the sheet as the DataFrame's index, named `row`, and the DataFrame knows which Input it is. `figure()` takes one column of an Input's rows, after any filtering; a column after a merge, a group-by, a concat or `reset_index()` has lost its rows, and `figure()` says so rather than name the wrong ones.
     - **What a figure records.** `how` is sum, mean, min, max or count. The helper works the value out itself, and records the Input, the column's heading, the rows (as runs of consecutive rows, at most 2,000 runs) and `how`.
     - **The check, when the Analysis runs.** IncarnaMind works the figure out again from the cells it read from the Document version and sent to the sandbox, with its own arithmetic, the way the helper reads a column (a mostly-numbers column skips its text cells), and compares the two to Excel's 15 digits. Only a match gets a marker. A mismatch or a reference it can't follow gets none, and the model reads why, and the number the cells come to. The figure card says what the figure is of, in which rows, and that IncarnaMind worked it out again from those cells when the Analysis ran. The outcome is kept with the run (`recalculations`).
     - **Figures without a way to work them out.** A regression coefficient, a p-value or a forecast is an Analysis figure, kept with its code, its Inputs' Document versions and hashes, and the runtime's versions, and shown as calculated by code and not recalculated. `result(..., of=rows)` names the rows and columns of an Input it was worked out from, such as those a model was fitted on, and its card shows them.
     - **A sentence's check (amended 2026-11-04, #2378).** An Analysis figure in a sentence is judged by its run, never against the Documents' text, which never holds it. Its number is IncarnaMind's: worked out again to the same number, while the Documents it read are as they were. Whether the sentence names it is the claim judge's, which reads the figure's label, its rule and rows, and the run's code, and says the sentence names that figure, names another, or can't tell. Code never upgrades a figure to Supported. It is Supported only when the judge says the sentence names it and a no-model filter, which can only take that away, finds the sentence's words around it, up to the figures beside it, hold every word of its label (words of one or two letters whole and in their case, words with a digit whole, Han in two-character words, never the figure's own digits), no word only another figure is named by, and no word but those, the Analysis's own words for its input, columns and unit, the words for its own way of working it out, and words that only link a figure to its name. A table cell's headings are read the same way. Amended 2026-11-06 (#2544): the filter also refuses a sign or symbol those words don't hold (a dash or the accounts' brackets that touch the figure among them), a target ("has to reach"), a total made one item's ("a North order's total"), and a scale, currency or percent that the sentence's paragraph, the heading above, the lines above it in its section or the opening lines of the sections it is under say, unless the figure's shown number, its unit or the Analysis's own words give it that. A sentence the judge reads as naming another figure is Unsupported ("The sentence doesn’t say this figure is {label}"); anything else is Not checked ("The sentence doesn’t clearly say this figure is {label}"). Until a check reads its sentence, and once the sentence's words change, the figure has no verdict of its own. A figure not worked out again reads Not checked ("From the Analysis · not recalculated"), and one whose record is gone reads Not checked ("The Analysis it came from is no longer available"). Every other assertion in the sentence is checked as usual. A table's column earns the note's ✓ only under its input column's own name. Working a `figure()` figure out again on Recalculate, with no sandbox, comes with `run_code`'s figures (#2351).
     - **Tables in PDF, Word and PowerPoint Documents (amended 2026-11-02, #448).** The index keeps each table of figures it reads with its Unit (`UnitLabel.tables`, processing version 23): a PDF page's from where its words sit, the same reader the Verify tables use (`src/core/documents/tables.ts`), a scanned page's from its recognized lines, and a Word file's or a deck's from the cells the file gives, a Word cell merged across columns or down rows keeping the grid's columns. A table that runs over pages, headed again on each or not at all, with only running lines or a "continued" line between, is one table. An Analysis names one by a Passage and, where the Passage shows several, its number, and reads it as a sheet's range: its headings row 1, its rows numbered on across pages, each row cited to the Unit it is on. Each cell is found again in its Unit's stored text before it is read, and one that isn't there, or that a scan's recognizer was unsure of, stays text, so a figure over it is never worked out again. A footnote mark after a figure ("17,347.75²") is left out of its value, never read as a digit. A table read from a scan gives no recalculated figure: its numbers are what a recognizer read, and working them out again would only agree with themselves. A second parser was not written: the index's own reading is what Citations are checked against.
   - **For `run_code` (proposed, #2351):**
     - **Where the column comes from.** `read_table(name, sheet)` gives a DataFrame whose rows carry their row number in the sheet, the headings being row 1. IncarnaMind reads the copy itself, with the reader its index uses, so the cells are the ones Citations are checked against, and hands the code those rows; past the index's 20,000 rows, up to 200,000 rows and 2,000,000 cells of a Document. Each row's number is kept in a column of its own, the frame's index, named `row`, as an Analysis's Inputs keep it, never among the data a sum or a model would take in. A merge, a group-by, a concat or `reset_index()` drops it, and `figure()` then refuses the column, so a check fails rather than name the wrong rows (measured in the spike: a merge resets the index; tested).
     - **What a figure records.** The column is taken from that DataFrame, after any filtering. `how` is sum, mean, min, max or count. The helper works the value out itself, so the value and its cells can't disagree. The figure keeps the column's heading and exact row numbers, its input's Document version, and `how`.
     - **The check.** The app reads those cells itself from its own reading of the Document version, works the figure out again with its own arithmetic, and compares the two to Excel's 15 digits. A match is "Inputs found · recalculated", and its Inputs are cited as a rows Citation. A mismatch is never shown as a figure, and the model is told the number the cells come to. The check needs no sandbox, so it can run again on Recalculate as `calculate`'s does; #2351 checks when the code runs, as Analyses do, and working it out again on Recalculate comes with the sentence's check of Analysis figures.
     - **Figures without `of`.** A regression coefficient, a p-value or a forecast is an Analysis figure. It is kept with its code, its Inputs' Document versions and hashes, and the runtime's versions, and shown as calculated by code and not recalculated. Both runtimes are pinned, so it can be run again to the same result (amended 2026-11-01).
     - **One contract for both runtimes.** `run_code`'s helper takes the same `figure()` an Analysis's does (above), and the check on Recalculate covers both.
     - **What run_code's figures go through.** They reach an Answer only as markers (`[=n]`), as an Analysis's do. A number the reply writes without a marker is caught as ADR-0021 already catches one (#1796).
     - **A number its code printed** (amended 2026-11-03, #2351). Models copy what code prints into their replies, and an instruction not to didn't stop Claude Haiku 5.5 on held-out requests, so the Answer does it structurally. A number the reply types that equals one an Analysis of the Answer printed, or wrote to a text file in `out/`, also before the run failed, becomes the figure it is: calculated by code and not checked, as a `result()` figure without a way to work it out is, kept with its run, its printed line as its label, in the Answer and in what it writes into a Note (content schema 49, as a bash run's record is new there). It matches as the figure check matches a sentence's number to a calculated figure (`agreesAtShownPrecision`): the same unit, scale, percent and sign as `src/shared/figures.ts` reads them, at the reply's own rounding, so "12.3" is the 12.345 printed, and "45.2%" isn't the 0.452 printed, a bare number. A whole number written plainly, or as approximate with one or two significant digits ("about 40", "below 100"), matches only the same number printed: rounded to a whole, every count and id in a reply would match some printed decimal. Where printed numbers of different values match, one printed exactly as written decides, else none. A number its sentence's Citation quotes stays the Citation's. A printed copy of a `figure()` figure whose cells came to another number ("differs"), in any of the Answer's runs and at the reply's rounding, is refused, never marked; a printed copy of one IncarnaMind couldn't work out again is marked "calculated by code, not checked": the code did work it out, and nothing checked it. It never reads as recalculated. A number cut off where a printed stream or an `out/` file's preview ends was never printed, so it matches nothing, nor does a printed table's index (0, 1, 2…); a table's headings and row labels stay text, as the checks read a table; and one whose characters would read differently as a figure stays as typed. A printed figure's marker is above every figure marker the reply wrote, so one it wrote with no figure never shows a printed number. Only `figure()` is worked out again: a printed number, bash's included, is never marked recalculated. One that matches nothing printed and nothing cited goes on to the net above.
4. **What asks.** The rules are approvals by Effect, as ADR-0013 sets out:
   - **Runs without asking.** `run_code` at level "os" is "sandboxed code", ADR-0023's Effect scope, which now covers both sandboxes. It reads only copies of Documents the Run may already read, writes only its own folder, and can't send anything. So it runs without asking, also after the Run has read third-party text (#78).
   - **Asks every time, Allow or Don't allow, never "always":** a call that names a folder outside the Library to read (a granted folder). #2351 builds none: `run_code` reads only Documents named by their Passages, so nothing it does asks.
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
6. **Linux.** The OS sandbox needs bubblewrap, socat and ripgrep, and unprivileged user namespaces. Ubuntu 24.04 restricts those through AppArmor. Where the sandbox can't start, `run_code` isn't offered, and the User reads why and how to fix it, as Analyses already say when Chromium's sandbox is off: Settings › Skills says the sandbox can't start, names the packages to install, and links to `docs/linux-sandbox.md`, which says how to allow user namespaces. The assistant then analyses in Pyodide alone.

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

**Numbers code printed, in the Answer** (#2351; Claude Haiku 5.5 on a direct Anthropic key, `run_code` offered on both sides for the run, in the OS sandbox with IncarnaMind's own Python; ten held-out requests whose code prints the numbers asked for, seven in English and three in Chinese, written and committed before any run, `eval/runCode/cases.ts`):

| | `main` | With printed numbers marked |
|---|---|---|
| Numbers the reply typed that its code printed, unmarked | 26, in 7 of 10 replies | none |
| Numbers its code printed, reaching the Answer as figures calculated by code | none | 23, in 9 of 10 replies, each checked by hand against what was printed: all 23 genuine |
| Spend | $0.033 | $0.037 |

- Both count by the marking's own rule, which on the marked side comes to none by construction; a check by digits alone found there only a number written before its own figure's marker and an IP address.
- An earlier pair, before the review's fixes, had 12 marks, 11 genuine: "below 100", the User's own threshold, was marked from a printed 74.5, which the rule for approximate numbers now refuses.
- Nine earlier runs, while the count and the rule were settled, cost $0.29; the eleven came to $0.36.

**Not measured:** Linux and Windows. On GitHub's ubuntu-24.04 runners, the OS sandbox's tests are skipped today (6 of 6 in the last green run on `main`), as `run_code`'s would be.

### Measured for #2351: IncarnaMind's own Python

On the same M2 Max, macOS 26.5, with other work holding the machine's 15-minute load between 8 and 26 (higher at times, as noted).

**The runtime** (`npm run python:native`, darwin-arm64, python-build-standalone 20261026, CPython 3.14.10, the lock's 27 distributions):

| | |
|---|---|
| Building it (fetch, check, install offline, compile, pack at zstd 19) | 220–237 s |
| The archive | 116.9 MB (116,939,661 bytes) |
| Unpacked | 527.8 MB in 19,258 entries |
| Two builds from different folders | the same SHA-256 |
| Unpacking it in the app (`unpackTarZst`) | 4.7–5.8 s |
| Its first import of every package, in the OS sandbox, on a fresh copy | 52–66 s |
| The same import afterwards | 2.3–3.4 s |
| Mach-O files | 328: 259 signed ad hoc by their linker, 69 ad hoc after it; none unsigned |
| Files with a quarantine attribute | none |

- The first import's minute is macOS checking each native library it loads for the first time (it happens once per copy, and not again). It happens while the step says Python is getting ready, never in an analysis. It also builds matplotlib's font cache beside the runtime, which each run starts from a copy of: built in each fresh run folder, it took about 8 s a plot.
- The stripped archives have no compiled standard library, and the runtime's folder can't be written when code runs, so each run would compile every standard module it imports again (0.4–0.7 s a run). The build compiles them (`unchecked-hash`, so the archive's times don't matter), which adds 3 MB to the archive.
- **getcwd() fails in the OS sandbox on macOS** (measured): it reads the folders above the working folder, which are inside denied ones (the shared temporary folder; the home and data folders in the app), so `os.getcwd()`, `os.path.abspath()` and `Path.resolve()` of a relative path raise `PermissionError`, and matplotlib can't start. Listing those folders would show other apps' temporary files' names, so instead the runner tells Python its folder (`os.getcwd`, kept in step with `os.chdir`), and bash gets `PWD`. A program that asks the system itself for its folder (`/bin/pwd -P`) still can't.

**`run_code` in the OS sandbox on macOS** (`tests/main/runCode.test.ts` on the real runtime, downloaded from a stand-in release, checked, unpacked and imported as the app does; the machine's load was 60–200 during the run, from other work):

- **Containment, in bash and in Python, every probe refused** (each beside one the same run is allowed, so a probe can't pass by failing for another reason): a canary in the home stand-in, in the data folder stand-in and in the real shared temporary folder; listing `/Volumes`; changing or adding to its input; writing in the home or the shared temporary folder; DNS, TCP to 1.1.1.1:443, and TCP to a server listening on 127.0.0.1 that the test itself reaches. A secret-looking variable was absent and a plain one present. A link left in `out/`, to the home canary or to `/etc/hosts`, came back as nothing, and so did an `out/` and a whole working folder swapped for a link to a folder of the User's. A `sleep` left running in the background ended with the run.
- **On Linux** (CI's Ubuntu 24.04 runner, bubblewrap), the same probes are refused in bubblewrap's own way. It puts an empty folder over each denied one, so a canary there isn't found rather than refused, and `/mnt` lists nothing. What is written in `/tmp` goes to the run's own empty folder and never reaches the real one. The working folder is mounted, so it can't be removed or swapped for a link.
- **After the security review**, the profile also denies LaunchServices (`open incarnamind-probe://x` reaches no application), the Keychain's server and distributed notifications, which `sandbox_check` confirms. Every account's home is denied (`/Users`; `/home`, `/root`), and on Linux so is `/run/user/<uid>`. Linux's masks hold 1 MB (a 3 MB write fails), and code gets only `PATH`, `LANG`, `LC_*` and `TZ` of the login environment. A perl daemon and a Python `start_new_session` child, each in a session of its own, ended with their runs. What stays readable is the system's own files.
- **Limits:** a loop and a bash fork bomb stopped at their time limit, leaving no process behind; output cut to 20,000 characters; 3 GB of random bytes stopped as out of memory at 2 GB; 300 MB written stopped at the 200 MB folder limit; a 120 MB file refused at 100 MB ("File too large").
- **A 50,000-row CSV** (read_table, three `figure()` figures, a `result()` table, a bar chart): all three figures recalculated by IncarnaMind to the same number, one table, one picture, cited as rows 1–50,001; the run took 1.9 s (its code 1.6 s). Before matplotlib's font cache was copied into each run it took 21 s.
- **A figure from rows a merge renumbered** is refused by `figure()` ("needs rows that still carry their row number"), and the same figure from the input's own rows is recalculated.
- **A figure over rows scattered into more than 2,000 runs** (a region on every fourth row of 50,000) is refused, as an Analysis's is, and the model is told to give it with `result()`.

## Considered options

- **Pyodide alone, as the whole answer.**
  - Kept as the first step.
  - Not enough alone: it has no shell, a 32-bit WebAssembly memory (a `MemoryError` near 4 GB), one thread, and Inputs limited to the rows the index keeps.
- **A bundled CPython (python-build-standalone, wheels installed by uv).** Chosen on 2026-11-01, downloaded on first use rather than in the installer (the amendment above). Its costs, as the spike measured them for a bundle:
  - 98–140 MB more per installer, for each platform: none, downloaded instead;
  - 336 native libraries to sign one by one with the hardened runtime on macOS: none, since they are outside the app bundle;
  - on Windows, SignPath Foundation's terms allow signing only what the project builds, so `python.exe` and every `.pyd` would ship unsigned, which Smart App Control blocks where it enforces: for decision 5;
  - 42 s for the first import on macOS: taken while the step says Python is getting ready.
  - What it gives: native speed, every package, and figures that can be run again.
- **The User's own `python3` for `run_code`.**
  - Chosen first, then rejected on 2026-11-01. It costs nothing to ship, but on a Mac out of the box it is Xcode's Python 3.9.6, without pandas, so most Users would have had bash only.
  - Its versions vary, so its figures without `of` couldn't be run again.
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

- **Offered where it was measured.** It shipped off, the catalog's `codeTool` fact on for no model, until a number its code prints was marked in the Answer (on the fresh held-out requests, Claude Haiku 5.5 wrote such numbers into every `run_code` reply). With them marked (#2351), the fact is on for Claude Haiku 5.5 and Sonnet 5.5, and off for every other model until a run measures it. It is the model's fact, as `calculates` is: the Claude account's sign-in serves the same two models and reads their facts.

- **The Executor.**
  - `ExecRequest` gains `limits`.
  - The local Executor measures memory and the folder's size every 250 ms and stops the program with every process it started. When the program ends, what it left running in its process group ends with it. What it left outside the group (a daemon, a worker pool, a process in a session of its own) is swept at the program's end, on a timeout and on Stop. A run's processes are found by what the code can't drop or fake. On macOS that is its Seatbelt profile: each run's profile allows looking up one Mach service name made from a fresh id, which nothing serves, and no other name. A process is the run's only when `sandbox_check` says it may look that name up, may not look up a name beside it and may not look up LaunchServices, and it is this User's, started no earlier than the run, and not the app or one of its parents. Nothing is asked of the run's folder, which the run can remove. An earlier version told a run's processes by "may write the run's folder and not the one above", which other programs' sandboxes answered too, and it stopped another program's sandboxed commands on the same computer. On Linux bubblewrap's PID namespace ends them with the program, and the sweep signals nothing. What is found is stopped (SIGSTOP), so none can fork while the rest are found, then found again the same way, and only then killed. Finding and stopping are apart, and a test lists every process of the computer with what the sweep would do to each, through a stopper that only records, before any stop is tried for real. Runs are recorded until swept, so the app sweeps a crash's leftovers at its next start, and refuses new runs while a process of an earlier one can't be stopped. In macOS's sandbox, loky can't read the system's semaphore limit, so scikit-learn's process pools fail. `run_code` sets `JOBLIB_MULTIPROCESSING=0`, so n_jobs runs in threads of the program and no pool outlives it.
  - What the memory and folder limits count: the program's processes, the run's processes launchd took over when their parents ended (a daemon, told as the sweep tells them), and every process under those; the folder's size also counts the files they hold open after unlinking them, on the folder's own disk (#2351). A run can't duplicate file descriptors without bound (`ulimit -n`), so unmeasured open files can't hide the unlinked ones the limit counts. One listing of the computer's processes a tick serves every run, and resident memory is judged from it before anything slower, so one run never waits on another's reads. Each run walks its own folder, and its open files are read with one read in flight: on macOS with one `lsof` for every run, each run reading its own when that fails; on Linux from `/proc`, for the User's processes alone. Those are the processes in the run's own PID namespace, two below the app's (counted from the app's own `NSpid`, so an app in a container reads the same), and in any below it, but for that namespace's first process. The sandbox's own processes are never read: bubblewrap and the seccomp helper's outer half sit in shallower namespaces, the helper's inner half is that first process, and no process can climb to a shallower namespace. Both halves of the helper make themselves non-dumpable, so their open files can't be read, and they hold none of the User's. A turn that doesn't find the helper's inner half leaves the disk unknown, so a changed layout can't hide the User's processes, and a process with no `NSpid` is an error; the OS sandbox doesn't start on a Linux without it. A process on its way out holds nothing and is no error. A turn whose User processes hold more than 8,192 descriptors in all counts them from their fd folders, follows none, and leaves the disk unknown: following 64k of them costs the app about a core while such a run goes. So a run that holds more than 8,192 descriptors for more than ten seconds is stopped as unmeasured, a legitimate one too. macOS's `lsof` reads 64k descriptors in about 170 ms, so it has no such cap. Likewise a turn reads at most 32 MiB of maps across a run's processes (a Python worker with the scientific stack maps about 320 KB, so 64 of them fit), and none past the first process that maps more than 6 MiB (about 65,000 mappings); past either the disk is unknown, so a run that stays over them for more than ten seconds is stopped too. A read that **fails** stops its run at once, told why: so a User program that makes itself non-dumpable (`prctl`, or an execute-only binary) hides its open files and is stopped as unmeasured, a legitimate one too. A read that is only **slow** leaves the disk unknown for that turn. A run whose disk stays unknown for more than ten seconds in a row is stopped, so its writes can go unseen for up to about ten seconds. The caps bound one read, not how often reads come, so a run's next read begins no sooner than four times its last read's cost after that read began. The cost is the longer of the read's wall time and the CPU time the app used meanwhile, on every thread, since a read of a run's maps uses more CPU than its wall time, and it counts up to the read's two-second deadline. So a run that makes its reads heavy keeps the app reading for at most a quarter of the time and a quarter of a core while a read costs no more than that (the caps keep them well under it), and an ordinary run's reads, a few milliseconds each, still come every turn. That wait lets a write go unseen for up to eight seconds. While the disk is unknown the time, memory and folder limits keep running, the folder limit on the files its walk names and the unlinked bytes last read. So a failed read never hides another run's files.
  - The "os" confinement sets `ulimit -f` and `ulimit -u`. The process limit counts per account on macOS and Linux, so it is set over the account's count when the run starts.
  - On Windows the Job Object will hold these limits.
- **The OS sandbox** also denies the shared temporary folder and removable and network volumes, for Skill scripts too.
- **sandbox-runtime.** It moves from 0.0.79 to the latest (0.0.81) in the same change. On Linux, 0.0.80 stops commands from creating namespaces and lets `denyWrite` win over `allowWrite`.
- **Effect scope "sandbox"** names sandboxed code in either sandbox. Its approvals don't change.
- **A word for the interface.** A run of `run_code` is an Analysis (数据分析) in the interface, as one in Pyodide is: which sandbox ran it makes no difference to the User (#2351). CONTEXT.md's Analysis runs "in a sandbox, with no network, reading only the files it was given". "Run code" appears only in the Details view, beside the code.
- **Linux in CI.** The jobs install bubblewrap, socat and ripgrep and lift Ubuntu's AppArmor restriction on user namespaces for the test step. Without that, the OS sandbox's tests and `run_code`'s are skipped; the real-runtime job fails instead when the sandbox can't start.
- **Windows.** The AppContainer helper is a new native component to build, sign with the app's certificate, and test on Windows 10 22H2 and Windows 11 with Smart App Control enforcing.
- **The hosted version** doesn't offer `run_code` until it has a remote sandbox (ADR-0013).
