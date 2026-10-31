---
status: proposed (2026-10-31)
---

# Deep analysis: more Python in the Analysis sandbox first, then code runs in the OS sandbox

Analysts ask for more than totals and group-bys: regressions, tests, clustering, forecasts and plots. They want the assistant to work as an agent harness works: write code, run it, read what it printed, and run again. Today an Analysis (ADR-0023) runs Python in Pyodide with numpy and pandas, in a hidden sandboxed window with no network and no files, on Inputs cited from Documents, on every system. A Skill script runs through the "os" Executor (#65): Seatbelt on macOS and bubblewrap on Linux, through `@anthropic-ai/sandbox-runtime`, with no network. Windows has no OS sandbox, so Skill scripts there ask every time.

The spike on `spike/run-code-sandbox` measured three ways to give the assistant more:
- Pyodide's own builds of scipy, statsmodels, scikit-learn and matplotlib, in the Analysis window as it is.
- A `run_code` Tool that runs bash or Python in the OS sandbox on copies of Documents.
- For that Tool's Python, a bundled CPython (python-build-standalone with wheels installed by uv), or the User's own `python3`.

The prototype is `src/core/runCode/`. Its tests are `tests/main/runCode*.test.ts`, and the probes and their results are in `spike/run-code/`. The research behind the options, with dated sources, is `docs/research/run-code-sandbox-2026-10-31.md`.

## Decision

In this order:

1. **Analyses gain scipy, statsmodels, scikit-learn and matplotlib.**
   - They are Pyodide's own wheels, from its lock file, fetched at build time and checked against the SHA-256 the lock records, as numpy and pandas are now.
   - They load and run under ADR-0023's Content-Security-Policy as it is. In 18 fresh Workers, no request was cancelled and no policy was violated (below).
   - A job loads only the packages its code imports. The spare interpreter keeps only numpy and pandas, so an Analysis that uses only pandas starts as fast as it does now.
   - matplotlib draws with its Agg backend into PNG bytes. These come back as an image the Note keeps. `chart()` stays the way to draw the charts a Note can restyle.
   - Nothing else changes: the same Inputs cited to their cells, the same `result()`, no clock, and the versions recorded with each run.
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
3. **A figure from code keeps the trust story of ADR-0021.** The model never types a number. Code gives each figure with `result(name, value, label, unit, of=column, how=…)`:
   - **Where `of` comes from.** `read_table` gives a DataFrame indexed by each row's number in its sheet, the headings being row 1. In the shipped version it reads the rows as the app's index read them, the same Units Citations are checked against. In the spike it reads the copied CSV.
   - **What a figure records.** `of` is a column taken from that DataFrame, after any filtering. The figure keeps that column's heading and exact row numbers, its input's Document version, and `how`: one of sum, mean, min, max or count.
   - **The check.** The app reads those cells itself from its own reading of the Document version, works the figure out again with its own arithmetic, and compares the two to Excel's 15 digits. A match is "Inputs found · recalculated", and its Inputs are cited as a rows Citation. A mismatch is never shown as a figure, and the model is told the number the cells come to. The check needs no sandbox, so it runs again on Recalculate as `calculate`'s does.
   - **Figures without `of`.** A regression coefficient, a p-value or a forecast is an Analysis figure. It is kept with its code, its Inputs' Document versions and hashes, and the runtime's versions, and shown as calculated by code and not recalculated. It can be run again only where its runtime is pinned: Pyodide, or a bundled CPython. With the User's own Python it is marked as one that can't be run again.
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

**A real model** (Claude Haiku 5.5, a direct Anthropic key, 3 questions on a 9-row CSV):
- 3 of its 4 figures named their cells and were recalculated: two sums and a maximum. The fourth, an average, didn't name them and stayed unchecked.
- Its first call failed in all 3 questions, and its second in 2 of them, before a call worked.
- Tokens: 11 requests, 26,210 uncached input, 0 cache reads or writes, 3,261 output, about $0.004.

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

- **Installer size.** It grows by about 36.5 MB (Pyodide's wheels) on every system, so Python's files total about 51 MB compressed.
- **Licences.** The third-party licences list gains: scipy, statsmodels, scikit-learn, joblib, threadpoolctl and contourpy (BSD-3-Clause); patsy (BSD-2-Clause); kiwisolver and cycler (BSD); packaging (Apache-2.0 or BSD-2-Clause); fonttools and pyparsing (MIT); pillow (MIT-CMU); and matplotlib (the Matplotlib License, PSF-based, with its fonts' notices). All are permissive.
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
