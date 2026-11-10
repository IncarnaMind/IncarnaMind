# UI audit

Scripts that walk the app as a person does and measure how fast it is. They aren't tests: they save screenshots and numbers for a person to read, and a step that fails is recorded rather than stopping the walk. Their files end in `.audit.ts`, so `npm run test:smoke` (`*.spec.ts`) never runs them.

Every launch uses the test build on a temporary data folder and a temporary HOME, with test hooks on. Chat is the scripted fake model (or, to show a model that can't be reached, a local address nothing answers on), and the embedding, reranking and text recognition models are the fakes (`INCARNAMIND_TEST_EMBEDDER=fake`, `INCARNAMIND_TEST_OCR=fake`), so nothing is downloaded, no local model runs and nothing leaves the machine. Links, files to open and save dialogs are intercepted.

## What each script measures

| File | What it measures |
|---|---|
| `walk.audit.ts` | A screenshot of every surface: first run with and without the examples, chat setup, every Settings page, a Linked folder, Answers with Citations, the Citation card, the viewer on every format, a Document's menus and Tags, the Library, export, shortcuts, approvals and consent, an unreachable model, Missing and Unavailable Documents, an error toast, macOS dark mode, Chinese, three window sizes, and the window while it starts. Probes on each: text and icon contrast (WCAG), a Tab walk that says whether each stop shows its focus, text cut off or spilling out, hover and pressed styles, and whether Escape closes each layer. |
| `speed.audit.ts` | Startup: bare Electron's own time as a floor, the main process's marks and slowest requires (`startup-hook.cjs`), cold and warm starts (3 each). Typing latency, keydown to the next frame and to the presented frame, in a short Mind (also with suggestions as the User writes turned on, pausing every 40 keys) and a long one (about 300 blocks and many Citations), with CPU profiles. With 2,000 Documents: linking and indexing them while typing, Settings and the Library opened meanwhile, the main process's event-loop lag and IPC round trips, the sidebar's scroll, hover and view switches, the Library's open, scroll and search, Organize (frames, stalls, memory), and warm starts. The viewer: a 300-page PDF, a 50,000-cell sheet and a Word file with images opened 3 times each, then scrolled and zoomed. Motion: frames while a menu opens and closes, with motion on, reduced and off, and typing with motion on and off. An outside agent (#351, B6): with 2,000 Documents in a Folder it may read, an MCP client starts the shim as an agent would (the app's binary as Node) and times `search` (p50, p95), pings through the shim against pings straight to the socket (the shim's overhead), and the size of the Tool definitions. |
| `canvas.audit.ts` | Screenshots of design boards (`*.dc.html` in `CANVAS_DIR`) at 1440×900, to set beside the app's. Fonts come from `node_modules`; other requests are refused. Skipped without `CANVAS_DIR`. |
| `bundle.mjs` | The renderer's chunks and what the first one holds by package, the main process's and the preload's chunks, from a build with source maps. |
| `fixtures.ts` | Writes the files the audit links: every format, a 300-page PDF, a 50,000-cell sheet, a Word file with figures, a Chinese Document, a very long name, and 2,000 small Documents in nested folders. Seeded, so every run writes the same files. |
| `harness.ts` | Launching, the person-like mouse and keyboard, and the probes. |

## Running it

```sh
npx electron-vite build --mode test --sourcemap
AUDIT_OUT=/tmp/ui-audit npx playwright test -c e2e/audit/playwright.audit.config.ts   # everything
AUDIT_OUT=/tmp/ui-audit npx playwright test -c e2e/audit/playwright.audit.config.ts walk.audit.ts -g A3
node e2e/audit/bundle.mjs out /tmp/ui-audit/bundle.json
```

- `AUDIT_OUT`: where screenshots (`screenshots/`, Tab-walk crops in `screenshots/focus/`) and `results.json` go. The default is `test-results/ui-audit`. Each run merges its numbers into `results.json` by key (`walk.*`, `speed.*`), so copy it aside between runs you want to compare.
- The walk takes about 3 minutes and the speed script about 10, most of it with 2,000 Documents (it allows an hour, for an Organize that stalls). Run one test with `-g`, such as `-g B2`.
- Timings depend on the machine's load: note the load average beside them, and compare runs made under the same conditions.
- The renderer is minified, so its CPU profiles name functions only from source maps, hence `--sourcemap`; a build without them runs the audit the same way. The profiles and `bundle.mjs` read source maps with `source-map-js`, which comes with Vite.

The canvas boards, with Playwright's Chromium installed (or `AUDIT_CHROMIUM` set to a Chromium):

```sh
CANVAS_DIR=/path/to/boards npx playwright test -c e2e/audit/playwright.audit.config.ts canvas.audit.ts
```

`npm run typecheck` and `npm run lint` check these files with the rest of `e2e/`.
