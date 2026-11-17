---
status: accepted (2026-10-18)
---

# Python analysis runs in Pyodide, in a sandboxed hidden window

Analysts ask questions about spreadsheets and CSV files, such as "revenue by region and quarter: which grew fastest?". Models answer those badly in their heads and well with code. So the assistant writes code and runs it on data cited from the User's Documents. Running code a model wrote is only safe in a sandbox tested against escape and network access, on every system we ship. The spike in #444 tested one design on macOS, Windows and Linux; its report and rerunnable probes are on the branch `spike/444-pyodide` (`docs/adr/0023-python-sandbox-spike-report.md`, `spike/python/`).

## Decision

We run **Python first, offline, in Pyodide** (CPython compiled to WebAssembly), with numpy and pandas. Since 2026-10-31 (#2346, ADR-0025), scipy, statsmodels, scikit-learn and matplotlib are bundled too, and a job loads only those its code uses; the spare interpreter keeps numpy and pandas.

- **In a hidden, sandboxed renderer**, shaped like the meeting capture window (ADR-0015):
  - `sandbox: true` and `contextIsolation: true`, with no Node in the page, its Workers or its frames;
  - a preload that only passes messages;
  - a non-persistent session of its own;
  - every permission denied, and navigation, new windows and downloads refused.
- **Two walls against the network.** The page and its Worker get a Content-Security-Policy:
  `default-src 'none'; script-src <scheme>: 'wasm-unsafe-eval'; worker-src <scheme>:; connect-src <scheme>:; form-action 'none'; base-uri 'none'`.
  It allows no network and no `'unsafe-eval'`, and Pyodide runs under it. The session's own `webRequest` cancels every request but the bundled files' scheme, as a second wall.
- **What the code can't reach.** The spike tried each of these on all three systems, and each failed, while a control fetch from the main process reached the network:
  - Node, `require`, `process`, `Buffer` and the window's bridge, through Pyodide's `js` bridge and `pyodide.ffi`; `eval` and `new Function`; `import()` of `node:` and web modules, and `importScripts`;
  - the network: `fetch` (to a web host, to an unknown host name, to `file:`), XMLHttpRequest, WebSocket, EventSource, WebTransport; an image, a stylesheet, a form post, navigation, `window.open`, a download; Python's `urllib`, `socket`, `pyodide.http.pyfetch` and micropip;
  - the host's files: Python sees only Emscripten's in-memory file system, so it can't read them, and what it writes stays in memory;
  - storage carried from one run to the next: localStorage, sessionStorage, IndexedDB, the in-memory files.
- **A fresh interpreter for each job, with one spare kept ready** (amended 2026-10-18, #446's review: a warm interpreter shared by every job let one job change what the next ran with).
  - Python runs in module Workers in that window, which starts on the first analysis, never at launch, and closes after 5 minutes idle.
  - Each job runs in a Worker of its own, ended once the job is done. Nothing a job changes or reads reaches the next: not Python's modules, pandas or the helper, nor the rows it read.
  - Pyodide's memory snapshots are not used: they are experimental.
  - While a job runs, a spare Worker starts, so a job that comes once the spare is ready starts within tens of milliseconds; one straight after another waits 3–6 s for the spare to start.
  - The window's storage (IndexedDB, the file system and the rest) is cleared after each job and before each new window.
  - A time-out, a stop, a `MemoryError` or a page past 2 GB ends the window, and another starts at once.
- **Bundled, never fetched.** Pyodide's files and the wheels for numpy, pandas, python-dateutil, pytz and six ship in the app's resources and load from there. There is no CDN and no package index. They add about 14 MB to the installer compressed (21.4 MB unpacked), and the files are the same on every system. Since ADR-0025, scipy, statsmodels, scikit-learn and matplotlib ship too, for about 36 MB more.
- **Linux:** Chromium's sandbox needs its setuid helper (`chrome-sandbox` owned by root, mode 4755, as a .deb installs it) or unprivileged user namespaces. The app is never run with `--no-sandbox`. Started that way, or with `ELECTRON_DISABLE_SANDBOX`, every renderer is unsandboxed, so Analyses don't run: each ends as unavailable, and the User reads "Analyses need the app's sandbox, which is off · How to fix", which links to `docs/linux-sandbox.md`. Whether the AppImage gets a working sandbox on Ubuntu 24.04, where AppArmor restricts user namespaces, is a packaging question for the whole app, checked in #1116.

## Licences: an exception for Pyodide

`AGENTS.md` asks for permissive licences. Pyodide is MPL-2.0, a file-level copyleft licence. Accepting it is an exception, **approved by the project owner on 2026-10-17**, because nothing permissive runs Python in a sandbox. ADR-0016 already weighed an MPL-2.0 component and found it livable.

- Pyodide's files ship **unmodified, as their own files**: `pyodide.mjs`, `pyodide.asm.mjs`, `pyodide.asm.wasm`, `python_stdlib.zip` and `pyodide-lock.json`.
- They are **listed in the third-party licences**, with Pyodide's LICENSE at the shipped version and a link to its source. IncarnaMind stays Apache-2.0.
- If we ever change a Pyodide file, the changed file is shared under MPL-2.0.

The rest of what ships for data work (ADR-0025 lists what it adds):

| Part | Licence |
|---|---|
| CPython and its standard library, inside Pyodide | PSF-2.0 |
| Emscripten's runtime, inside Pyodide | MIT / University of Illinois NCSA |
| numpy | BSD-3-Clause, with the notices in its wheel's licence files |
| pandas | BSD-3-Clause |
| python-dateutil | Apache-2.0 or BSD-3-Clause |
| pytz | MIT |
| six | MIT |

## Measured

Pyodide 314.0.7 (Python 3.14.2), numpy 2.4.6 and pandas 3.0.2 on Electron 44.5.1, on an Apple M2 Max and on GitHub's macOS (arm64), Windows (x64) and Linux (x64) runners: in the spike, and again on 2026-10-18 with a fresh interpreter for each job, on a build for testing with Chromium's sandbox running on every system. The ranges run from the fastest system to the slowest.

- The first job, the window and Python started: 3.6–6.2 s.
- A job once the spare is ready: 14–37 ms. A job straight after another, waiting for the spare: 3.3–6.7 s.
- pandas on a 50,000-row CSV, parsed and grouped: 26–45 ms.
- The window's memory: about 320–510 MB with the spare ready, and at most about 700 MB while a job runs.
- An endless loop is ended and a new Worker ready in 2.7–5.4 s. Out of memory, Python raises `MemoryError` near 4 GB (3,968 MB), and the window lives.

## The runtime interface

Python is the first language behind an interface in the core, written for more than one language: code in, values and tables out, with a time limit and a memory cap. Each run records the SHA-256 of its code, of each input's values and of what it came to, and what it ran with: Pyodide's, Python's and each package's version, the SHA-256 of the helper every job runs through, and the app's version.

The helper takes the clock away where code reaches it as a matter of course (`datetime`, `time`, pandas' `Timestamp` and "today"), so an Analysis doesn't read the date by accident and gives the same result when run again. That is best-effort, not a boundary: code that means to can still find the time. JavaScript on QuickJS (MIT) comes later as a second language behind the same interface. The core never imports Electron: the desktop app supplies the sandboxed window as an adapter.

## Considered options

- **JavaScript on QuickJS first.** Smaller, faster to start, and permissive. Rejected as the first language because models write data-analysis code more reliably in Python with pandas. It stays the second language.
- **A worker thread or utility process.** Rejected: Electron's Node-side processes are not sandboxed, so model-written code there could reach the file system and the network.
- **A server that runs the code.** Rejected: nothing leaves the computer without the User's consent (ADR-0022), and analysis should work offline.
- **Loading Pyodide and packages from its CDN.** Rejected: it would need the network, and the code that runs could change under us.

## Consequences

- The installer grows by about 14 MB on every system.
- The third-party licence notices gain Pyodide (MPL-2.0) and the packages above.
- `AGENTS.md`'s dependency rule names this exception and this record.
- ADR-0013 is amended: code run in this sandbox is a new Effect scope, "sandboxed code", that runs without asking. It reads only inputs cited from the Documents, which already run without asking, and it can neither write a file nor reach the network.
- The runtime is not offered in the hosted version until that version has a sandbox of its own.
- The first analysis waits 3–6 s for the window and Python, and so does one that follows another straight away; one that comes once the spare is ready starts at once. While a job runs, two interpreters are in memory: up to about 700 MB.
