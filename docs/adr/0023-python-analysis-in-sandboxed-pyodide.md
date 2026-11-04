---
status: accepted (2026-10-18)
---

# Python analysis runs in Pyodide, in a sandboxed hidden window

**Amended 2026-10-31 (#2346, ADR-0025): scipy, statsmodels, scikit-learn and matplotlib are bundled too, and a job loads only those its code uses.** The spare interpreter keeps numpy and pandas, as below; ADR-0025 records the rest, with its measurements.

**Amended 2026-10-18 (#446's review): each job runs in a fresh interpreter, with one spare kept ready.** A warm interpreter shared by every job let one job change what the next ran with: Python's modules, pandas and the helper, and the rows it had read. Below, "A fresh interpreter for each job" replaces "One Worker", and the measurements are taken again.

Analysts ask questions about spreadsheets and CSV files, such as "revenue by region and quarter: which grew fastest?". Models answer those badly in their heads and well with code. So the assistant will write code and run it on data cited from the User's Documents. Running code a model wrote is only safe in a sandbox tested against escape and network access, on every system we ship.

The spike in #444 measured one design on macOS, Windows and Linux. Its report and its rerunnable probes are on the branch `spike/444-pyodide`, in `docs/adr/0023-python-sandbox-spike-report.md` and `spike/python/`.

We run **Python first, offline, in Pyodide** (CPython compiled to WebAssembly), with numpy and pandas:

- **In a hidden, sandboxed renderer**, shaped like the meeting capture window (ADR-0015):
  - `sandbox: true` and `contextIsolation: true`, with no Node in the page, its Workers or its frames;
  - a preload that only passes messages;
  - a non-persistent session of its own;
  - every permission denied, and navigation, new windows and downloads refused.
- **Two walls against the network.** The page and its Worker get a Content-Security-Policy:
  `default-src 'none'; script-src <scheme>: 'wasm-unsafe-eval'; worker-src <scheme>:; connect-src <scheme>:; form-action 'none'; base-uri 'none'`.
  It allows no network and no `'unsafe-eval'`, and Pyodide runs under it. The session's own `webRequest` cancels every request but the bundled files' scheme, as a second wall.
- **What the spike tried, which failed on all three systems:**
  - Node, `require`, `process`, `Buffer`, the window's bridge, through Pyodide's `js` bridge and `pyodide.ffi`;
  - `eval` and `new Function`;
  - `import()` of `node:` and web modules, and `importScripts`;
  - `fetch` (to a web host, to an unknown host name, to `file:`), XMLHttpRequest, WebSocket, EventSource, WebTransport;
  - an image, a stylesheet, a form post, navigation, `window.open`, a download;
  - Python's `urllib`, `socket`, `pyodide.http.pyfetch` and micropip;
  - reading host files, which Python can't see: it has only Emscripten's in-memory file system;
  - writing files, which stay in memory;
  - storage carried from one run to the next (localStorage, sessionStorage, IndexedDB, the in-memory files).
  - In every case nothing left the window, and a control fetch from the main process reached the network.
- **A fresh interpreter for each job, with one spare kept ready.** Python runs in module Workers in that window, which starts on the first analysis, never at launch, and closes after 5 minutes idle.
  - Each job runs in a Worker of its own, which is ended once the job is done. Nothing a job changes or reads reaches the next: not Python's modules, pandas or the helper, nor the rows it read.
  - Pyodide's memory snapshots are not used: they are experimental.
  - While a job runs, a spare Worker starts, so a job that comes once the spare is ready starts within tens of milliseconds. A job straight after another waits for the spare to start, 3–6 s (below).
  - The window's storage (IndexedDB, the file system and the rest) is cleared after each job and before each new window.
  - A time-out, a stop, a `MemoryError` or a page past 2 GB ends the window, and another starts at once.
- **Bundled, never fetched.** Pyodide's files and the wheels for numpy, pandas, python-dateutil, pytz and six ship in the app's resources and load from there. There is no CDN and no package index. They add about 14 MB to the installer compressed (21.4 MB unpacked), and the files are the same on every system. scipy, statsmodels and matplotlib were not bundled at first; since ADR-0025 they are, with scikit-learn, for about 36 MB more.
- **Linux:** Chromium's sandbox needs its setuid helper (`chrome-sandbox` owned by root, mode 4755, as a .deb installs it) or unprivileged user namespaces. The app is never run with `--no-sandbox`. When it is started that way, or with `ELECTRON_DISABLE_SANDBOX`, every renderer is unsandboxed, so Analyses don't run: each ends as unavailable, and the User reads "Analyses need the app's sandbox, which is off · How to fix", which links to `docs/linux-sandbox.md`. Whether the AppImage gets a working sandbox on Ubuntu 24.04, where AppArmor restricts user namespaces, is a packaging question for the whole app, checked in #1116.

## Licences: an exception for Pyodide

`AGENTS.md` asks for permissive licences. Pyodide is MPL-2.0, a file-level copyleft licence. Accepting it is an exception, **approved by the project owner on 2026-10-17**, because nothing permissive runs Python in a sandbox. ADR-0016 already weighed an MPL-2.0 component and found it livable.

- Pyodide's files ship **unmodified, as their own files**: `pyodide.mjs`, `pyodide.asm.mjs`, `pyodide.asm.wasm`, `python_stdlib.zip` and `pyodide-lock.json`.
- They are **listed in the third-party licences**, with Pyodide's LICENSE at the shipped version and a link to its source. IncarnaMind stays Apache-2.0.
- If we ever change a Pyodide file, the changed file is shared under MPL-2.0.

The rest of what ships for data work:

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

The spike used Pyodide 314.0.7 (Python 3.14.2), numpy 2.4.6 and pandas 3.0.2 on Electron 44.5.1. It ran on a local Apple M2 Max and on GitHub's macOS (arm64), Windows (x64) and Linux (x64) runners.

| | M2 Max (local) | macOS runner | Windows runner | Linux runner |
|---|---|---|---|---|
| Cold start, Worker to numpy + pandas imported | 3.0 s | 5.1 s | 6.1 s | 5.0 s |
| A new Worker in the same window | 2.9 s | 3.9 s | 5.9 s | 5.0 s |
| A call to a running Worker | ~1 ms | ~1 ms | ~1 ms | ~1 ms |
| pandas, 50,000-row CSV: parse + group-by | 14 + 12 ms | 19 + 18 ms | 21 + 24 ms | 19 + 21 ms |
| Renderer memory before Pyodide / after it | 90 / 460 MB | 89 / 448 MB | 69 / 269 MB | 95 / 288 MB |
| An endless loop: ended and a new Worker ready | 2.7 s | 3.6 s | 5.4 s | 4.1 s |
| Out of memory | `MemoryError` at 3,968 MB, then the Worker answers; the window lives | the same | the same | the same |

Measured again on 2026-10-18 with a fresh interpreter for each job, on a build for testing, with Chromium's sandbox running on every system:

| | M2 Max (local) | macOS runner | Windows runner | Linux runner |
|---|---|---|---|---|
| The first job: the window and Python started | 3.6 s | 4.1 s | 6.2 s | 6.0 s |
| A job once the spare is ready | 37 ms | 26 ms | 14 ms | 16 ms |
| A job straight after another, waiting for the spare | 3.3 s | 4.2 s | 6.7 s | 6.5 s |
| The window's memory with the spare ready | 508 MB | 504 MB | 323 MB | 323 MB |
| The window's memory while a job runs, at most | 690 MB | 670 MB | 463 MB | 455 MB |

## The runtime interface

Python is the first language behind an interface in the core, written for more than one language: code in, values and tables out, with a time limit and a memory cap. Each run records the SHA-256 of its code, of each input's values and of what it came to, and what it ran with: Pyodide's, Python's and each package's version, the SHA-256 of the helper every job runs through, and the app's version.

The helper takes the clock away where code reaches it as a matter of course (`datetime`, `time`, pandas' `Timestamp` and "today"), so an Analysis doesn't read the date by accident and gives the same result when run again. That is best-effort, not a boundary: code that means to can still find the time. JavaScript on QuickJS (MIT) comes later as a second language behind the same interface. The core never imports Electron: the desktop app supplies the sandboxed window as an adapter.

## Considered options

- **JavaScript on QuickJS first.** It is smaller and faster to start, and permissive. Rejected as the first language because models write data-analysis code more reliably in Python with pandas. It stays the second language.
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
