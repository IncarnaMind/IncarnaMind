# Tests and CI

**The bar:** a change is done when its pull request's checks are green on GitHub, not when the tests pass on your computer. CI runs on clean machines that are slower than yours and have a different screen. A test that passes only on your computer is a broken test.

How the checks themselves work is in [`checks.md`](checks.md): each CI and nightly job, Run named specs, the packaged app's checks, one real engine in a test build, the feel check, and the checks by hand before a release (the ChatGPT test profile among them). Read the section you need when a check fails in a way you don't understand, or before you change a workflow.

## What runs where

- **On your computer:** `npm run typecheck`, `npm run lint`, and the unit test files that cover what you changed (`npx vitest run <files>`).
- **On a pull request:** typecheck and lint, the unit tests that import a file you changed, and only the smoke specs the pull request adds or changes. A draft runs nothing until it is marked ready. A change to a Markdown file runs every unit test, because tests read the documents as text; a change to ADRs or pictures only runs nothing.
- **Every night and before a release:** every test, the packaged app's checks and the real models. A red night is fixed before new work.
- **Specs your change reaches but doesn't edit:** `node scripts/run-specs.mjs --os macos --repeat 3 e2e/undoPill.spec.ts` runs them from your pushed branch on a clean GitHub machine (Linux, macOS or Windows). Use it for UI specs instead of your own computer, and always for behaviour only macOS or only Windows has.
- **A spec runs on a test build only:** `npx electron-vite build --mode test`, in your own worktree, right before the run. Any other build ignores the fakes, so a Meeting would record with the real microphone (#2941).

## When a check fails

- Read why: `gh run view <run id> --log-failed`, and for the smoke test, the failing shard's log and the Playwright traces in its `smoke-results-N` artifact.
- Fix it in this pull request, whether or not your change caused it, and say which. When `main` itself is broken, the fix lands on `main` at once, by itself.
- "Flaky" is a claim that needs evidence: it failed, then passed on a rerun with nothing changed, and you can say what timing it depends on. Then fix the test. Don't hide it with more retries, longer timeouts or a skip.

## Tests that pass on any machine

- **Launch through `launchApp` in `e2e/app.ts`.** It gives each test a temporary data folder and home folder (and refuses any other), test hooks, the stand-in search, text recognition and speech engines and, with `fakeChat`, the scripted chat model. No test uses the network, an API key or the User's own files. The app it launches opens nothing on the computer: a file, a link or a folder it is asked to open is recorded (`pathsOpened`, `urlsOpened`, `pathsShown`), and it finds only the agents the test set up (`agentApps`, or their settings in the test's home folder), never the computer's own apps.
- **Set the window size the test needs,** with `setWindowSize` in `e2e/app.ts`. Never depend on the screen's size, the display's scale, the window being in front, or the computer's fonts and language. CI's screens, a virtual one on Linux and a small one on macOS, are not yours.
- **Assert relations, not exact pixels.** For example, "the controls sit under the text", "it wraps by word", or "it fits inside the card". Exact sizes are for what `DESIGN.md` fixes, such as a 44px band.
- **Wait for a state, not a time.** Use `expect(locator).toBeVisible()`, a test id or a value from the bridge, never `waitForTimeout` in new tests.
- **Let the editor finish before a key or click moves its selection.** An update the editor makes by itself (the wash that ends after Add to note, ProseMirror's check 20 ms after it takes the focus) rewrites the page's selection from its own, which has not yet caught up with a key or click just before: that key or click is lost. Wait for the update first: `addToNote` waits out the wash, `focusSettled` the check.
- **Drive the app like a person.** Move the mouse to an element before clicking or dragging it (as `slideToHandle`, `dragBy` and `dragBlock` in `e2e/app.ts` do), and use the keyboard where a person would. A helper needed in a second spec moves into `e2e/app.ts` rather than being copied.
- **Keep wall-clock limits out of unit tests.** CI machines run two to five times slower than a laptop. A speed budget belongs in a dedicated speed test with headroom, not in a unit test with a tight millisecond limit. A `vi.waitFor` that names no limit gets 20 s from the suite's setup (`tests/setup/waits.ts`), not Vitest's one second, so write it bare and name a limit only when the test is about the limit.
- **Make each test stand alone.** It must pass on its own and in any order, and it cleans up what it made.
- **Unit tests run in plain Node.** They must not need the Electron binary (CI doesn't download it) or a model download.
- **Load each real engine at least once.** The fake engines (the fake embedding model, `--fake` transcription, the scripted chat model) keep tests fast and repeatable. But they never load the real module, so an import that only breaks in the built app goes unseen: meeting transcription failed in alphas 1 to 3 while every test passed (#1233).
  - A feature that runs a real engine (transcription, OCR, embeddings, the reranker, Python analysis) loads its native module through a loader made with `engineModule` (`src/core/engineModules.ts`), which lists the functions the app calls from it and fails naming the module when one is missing. `tests/core/engineModules.test.ts` loads the loaders the way the built processes import them, not through a copy of their imports; a new loader goes there, in its engine process's check list (`answerEngineCheck` in `src/main/*Process.ts`) and in `e2e/packaged/engines.packaged.ts`.
  - That test checks the module has what the code calls. It needs no model download.
  - The packaged app's engine check, and how to run it, are in `checks.md`.
- **Tests and the evaluation never touch the real home folder.** `tests/setup/home.ts` gives each test file a temporary HOME (and `USERPROFILE` and the XDG folders), and fails a test that writes under the real one outside the cache and report folders the run was given; the core takes its home and Documents folders from its host, so `startCore` and the evaluation pass temporary ones.
- **Write paths and text that work on every platform.** Use `path.join`, never assume `/` or a case-insensitive file system, and give the Chinese strings the same tests as the English ones.
- **Write each spec for Linux and macOS.** CI and the nightly run the smoke test on Linux only; run a spec on macOS or Windows with Run named specs (`checks.md`). Press shortcuts with `ControlOrMeta+…`, never `Meta+…`, and expect a shortcut's label in either form (`⌘J` or `Ctrl+J`). A spec for something only macOS has, such as the traffic lights or full screen, skips elsewhere with `test.skip(process.platform !== "darwin", "<why>")`; no scheduled check runs it, so run it there by name.
- **No real key reaches a launch.** A trace keeps the environment the app was launched with, so `launchApp` passes on only what an app needs to run. A test that needs a credential passes a made-up one by name: `launchApp(dataDir, { extraEnv: { OPENAI_API_KEY: "sk-proj-a-made-up-key" } })`.
- **When you change or remove UI,** update or remove the tests that used it in the same pull request: search `e2e/` for the test ids, labels and strings you changed.

## AI features

The scripted chat model (`fakeChat`) is for automated tests only: CI has no keys, and its runs must give the same result every time. Before you call an AI feature done (Answers, Citations, Organize, tagging, Tasks, anything a model does), use it by hand in the built app with **Claude Haiku 5.5** on an Anthropic API key. For a hard feature (labelled `complexity:hard`), or when Haiku fails at the task, use Claude Sonnet 5.5 instead.

- **Keep the bill small.** Use the cheapest model that answers the question, short test Documents, and stop as soon as the result is clear.
- Use a temporary data folder and test Documents, never your own files. Say in the pull request which models you used and what you checked with each.
- **A walk that judges figures, names or what was decided uses recorded human speech,** from a public set whose licence allows it, named in the evaluation's README; never a real private call and never an employer's data. This computer's voices are for walking the flow only, and never its novelty voices.

## Edge cases

Most bugs a User meets sit at the edges, not on the path the feature was built for. Try each case that applies to your change, with an automated test where it can be one. The audit's fixtures (`e2e/audit/fixtures.ts`) already write many of these files.

- **Empty, one and many.** Nothing at all (an empty Note, Folder, Library or field), a single item, and a lot: 2,000 Documents, a 300-page PDF, a 50,000-cell sheet, a Note of about 300 Blocks.
- **Words.** Chinese, Chinese mixed with English, a very long name, emoji and unusual characters, and typing through a Chinese input method while it is still composing.
- **Broken input.** A damaged, empty, password-protected or oversized file; a scanned PDF with no text layer; a format IncarnaMind doesn't read; a file that disappears while it's being read.
- **No network and no consent.** Offline, the consent prompt declined, and Local mode.
- **Models that misbehave.** A slow model, one that fails or can't be reached, and one that returns no Citations or nonsense. Cancel halfway, and act while an Answer is still streaming.
- **Quitting halfway.** Force-quit in the middle of the action, then start again: nothing is lost, doubled or left half done.
- **Twice and back.** Do the action twice quickly (a double click, a held key), then Undo and Redo it.
- **Every way in.** Mouse and keyboard only, a narrow and a wide window, light and dark, English and Chinese.
