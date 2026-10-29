# Tests and CI

Read this before writing code or tests, whether you are a person or a coding agent.

**The bar:** a change is done when its pull request's checks are green on GitHub, not when the tests pass on your computer. CI runs on clean machines that are slower than yours and have a different screen. A test that passes only on your computer is a broken test.

CI (`.github/workflows/ci.yml`) runs three checks on every pull request (`pull_request`), (there is no merge queue; the sign-off check is the only one that has to pass before a pull request merges, and the other two report what the pull request did). A push to `main` doesn't run CI. Every night at 01:30 UTC (`schedule`), and by hand (`workflow_dispatch`), the same jobs run on `main` whatever the last change was: a failing night shows its failed specs in the run's summary and is fixed before new work, like a red `main`. A draft pull request runs only the light checks, which report as passed, until it is marked ready for review:

| Check | Where | What it runs |
|---|---|---|
| Typecheck, lint and unit tests | Ubuntu | `npm ci`, then `npm test -- --shard=N/3` in three shards that run at once (`Unit tests shard N/3`; Vitest deals the files out evenly); the first also runs `npm run typecheck` and `npm run lint`. This check passes when all three do |
| Electron smoke test (Linux) | Ubuntu | `npm ci`, the Noto CJK fonts (the runner has no Chinese face) and ffmpeg (for the feel check's videos; a failed install doesn't fail the check), then `npm run test:smoke -- --workers=2` on two virtual displays (`Xvfb`), one for each worker (`INCARNAMIND_DISPLAYS`, read in `e2e/app.ts`; windows on one display take the keyboard focus from each other and share a clipboard): builds the app and runs every spec in `e2e/`, the feel check's among them, split into ten shards that run at once, balanced by how long each spec takes (`scripts/smoke-shard.mjs`, `e2e/durations.json`; refresh it from a green run's log when specs are added or slow down) (`Smoke shard N/10`); this check passes when all ten do. Locally and on macOS a run has one worker (`playwright.config.ts`); keep `--workers=1` when you run a spec by hand. Each shard uploads the feel check's tables and videos as `feel-linux-N`, kept 14 days |
| Every commit is signed off (DCO) | Ubuntu | a `Signed-off-by:` line on each commit (`git commit -s`), and no commit with an author, committer or sign-off at anthropic.com or a `Co-Authored-By:` trailer naming Claude or with an anthropic.com address (a commit carries its contributor's own name) |

`main` should stay green. A pull request merges once its sign-off check passes and its CI checks are green, or each red one is a known flaky spec named with its issue; the full suite also runs on `main` every night. If a night goes red, fixing it comes before new work.

Every night, and by hand from the Actions tab, the Electron smoke test (macOS) in `.github/workflows/nightly.yml` runs the same suite on macOS, in eight shards (`Smoke shard N/8 (macOS)`), with the specs only macOS has, such as the traffic lights in the title bar. A failing night is fixed before new work, like a red `main`.

Startup and update changes also run **Packaged startup, quit and updates (Windows)**. This job builds the main once, then packages it twice in `dist/lifecycle-old` and `dist/lifecycle-updated` with the real old and target versions in `tests/fixtures/lifecycle-versions.json`. It verifies both `app.asar` files contain the identical built main before driving the executables, SQLite ownership and quit guard through `singleInstance.spec.ts`, `startupProgress.spec.ts` and the lifecycle specs. These test artifacts alone use `e2e/lifecycleMain.cjs` to load the requested fixtures before the unchanged built main, without depending on packaged Electron’s command-line preload support. The job selects that entry with `extraMetadata.main`; release builds keep `out/main/index.js`. Local update tests use two temporary app directories with those real package versions and the same built main. Temporary HOME, USERPROFILE, application-data and XDG folders isolate every launch. Process inventory and cleanup require the run's exact tag and cover both owned executable folders. The packaged identity, underlying main path and saved data are checked; installers and native dialogs remain controlled fixtures.

The deterministic Windows mapped-SHM probe is an expected failure for [#2067](https://github.com/IncarnaMind/IncarnaMind/issues/2067). Check it on each Electron update: an unexpected pass signals that the released runtime may contain the upstream SQLite fix and the marker can be removed after verification. Ordinary crash handover stays a normal test; a recurrence without the mapping helper must capture extended code `1546` before it is classified as that bug.

Every night too, `.github/workflows/nightly-real-model.yml` asks real models, since the scripted one can't tell whether an AI feature works: the live tests (`tests/live`) and the everyday requests (`eval/everyday`) on Claude Haiku 5.5, a live test of Kimi International, and the everyday requests in Chinese on Kimi K2.6 (Kimi sees only the evaluation's own public and made-up Documents). It runs once a night on one runner and writes `summary.md` to the `nightly-real-model` artifact: a result for every case, which key it used, and what it spent, counted from every request's tokens at the catalog's prices. A failing night is fixed like a red `main`.

- **Secrets (the owner sets them; use capped API keys):** `NIGHTLY_ANTHROPIC_KEY_1`, `NIGHTLY_ANTHROPIC_KEY_2` and `NIGHTLY_KIMI_KEY`. The run moves to key 2 for good when key 1 is out of credit, and says so in the summary. A missing secret fails the job at once, with one line naming it. A step that takes longer than its time is stopped, a night that has spent over `NIGHTLY_MAX_USD` (10 by default) starts no further step, a step that ran no case counts as failed, and `summary.md` is written after every step. A night that is cancelled stops the step it was running and leaves a report headed "Unfinished", with the steps that never ran listed.
- **By hand:** Actions › Nightly real models › Run workflow, or `NIGHTLY_ANTHROPIC_KEY_1=… NIGHTLY_ANTHROPIC_KEY_2=… NIGHTLY_KIMI_KEY=… npm run nightly:real-model`. `NIGHTLY_STEPS` (`live`, `everyday`, `claim-probes`, `kimi-live`, `kimi-everyday`, separated by commas) runs only those, and `INCARNAMIND_EVAL_EVERYDAY` only some everyday requests (`eval/everyday/README.md`). Keep to a few requests when you run it for a check: the whole night costs a few dollars.

The packages CI installs (the Noto CJK fonts, ffmpeg, LibreOffice) come from a cache of their downloaded files. On some runners the package mirror serves them at about 50 kB/s, and one install held a runner for up to 30 minutes (#1731). The `apt-install` action (`.github/actions/apt-install`) restores the files and apt downloads only what the cache lacks. A run with no matching cache downloads from archive.ubuntu.com, drops a download still going after 5 minutes to try the Azure mirror, and waits as long as it takes on the last try, as the install always did. Only a run on `main` saves a cache that every pull request reads, so `.github/workflows/warm-ci-caches.yml` saves them every day and when it changes; a package CI installs with the action also goes in its matrix.

## Before you open a pull request

1. Merge `main` into your branch to resolve a conflict or to pick up something you need.
2. Run the light checks on your computer: `npm run typecheck`, `npm run lint`, and the unit test files that cover what you changed (`npx vitest run <files>`). The whole unit suite and the smoke suite run on CI, on GitHub's machines, so they don't load yours.
3. Find the smoke specs that touch what you changed (search `e2e/` for the test ids, labels and strings you changed or removed) and update them. Run them on a clean machine (below) rather than on yours; run one locally only when you need to see the UI or record it.
4. When you change or remove UI, update or remove the tests that used it in the same pull request. A test still looking for something your change removed is broken by your change.
5. Try the edge cases below that apply to your change, by test or by hand, and say in the pull request which you tried and which don't apply.

## After you open it

- Watch the checks until they finish: `gh pr checks <number> --watch`. Don't report the work as done, or ask for a merge, while a check is red or still running.
- When a check fails, read why: `gh run view <run id> --log-failed`, and for the smoke test, the failing shard's log and the Playwright traces uploaded as its `smoke-test-results-linux-N` artifact (`smoke-test-results-macos-N` from the nightly run). Fix it in this pull request, whether or not your change caused it, and say which in the pull request.
- "Flaky" is a claim that needs evidence: it failed, then passed on a rerun with nothing changed, and you can say what timing it depends on. Then fix the test. Don't hide it with more retries, longer timeouts or a skip.

## Run the specs you changed on a clean machine

Playwright on your own computer loads it, and several runs at once overload the owner's. Some failures also show only on macOS or Windows (the traffic lights, full screen, a shortcut). `.github/workflows/specs.yml` runs the specs you name on a clean GitHub-hosted machine, Linux, macOS or Windows, set up as the smoke test is. It is apart from `ci.yml`, so it never runs or blocks a required check.

```sh
git push
node scripts/run-specs.mjs --os macos --repeat 3 e2e/undoPill.spec.ts e2e/scans.spec.ts:144
```

- **When.** By default for UI specs, instead of running them yourself. Always, on that system, for a behaviour only macOS or only Windows has (a spec that skips elsewhere with `test.skip(process.platform ...)`). Run locally only to look at the UI by hand or to record a flow.
- **Inputs.** `specs`: the paths of specs under `e2e/`, each `path` or `path:line`. `os`: `linux` (the default), `macos` or `windows`. `repeat`: 1 to 10, passed as `--repeat-each`; use it to tell a flaky spec from a broken one. `grep`: passed as `--grep`. The helper takes them as flags; by hand they are Actions › Run named specs › Run workflow. Anything else, such as a path outside `e2e/`, is refused with a message, by the helper before it dispatches and by the workflow before it installs anything, and no input reaches a shell as code.
- **What you get.** The helper runs the pushed commit of your branch (it stops if the branch isn't pushed), asks GitHub once a minute at most, and prints pass, fail or skip for each spec. A spec that skips on that system (a macOS-only one on Linux) shows as skip, not pass. On a failure it downloads the results to `test-results/specs-<os>-<run>/`; a later Playwright run on your computer clears `test-results/`, so read them first. Every test's trace, video and window picture is kept, passed or not (`INCARNAMIND_KEEP_ARTIFACTS`, read in `e2e/app.ts`), in the `specs-<os>-<run id>` artifact for 7 days: `npx playwright show-trace <trace-….zip>`. The recording slows the app a little, so a feel check's time that fails only here is worth one run in CI before you chase it.
- **Limits.** One run for each branch and system at a time: a new dispatch cancels the one still going. macOS runners are few and the Nightly shares them, so ask for macOS only for what needs it. A run stops after 45 minutes. A green run here doesn't replace the pull request's checks.

## What a launched app's environment holds

A trace of the app keeps the environment it was launched with (`trace.trace`, `context-options`) and the arguments of every call. So no key may reach a launch.

- **Every launch builds its environment with `launchEnvironment` (`e2e/launchEnvironment.ts`):** `launchApp`, the lifecycle copies, the packaged specs, the UI audit and the packaged classification check. From your shell it takes only what an app needs to run: `PATH`, `HOME`, the temporary folders, `LANG`, `LANGUAGE`, `LC_*` and `TZ`, the display and session bus on Linux, and on Windows `SystemRoot`, `windir`, `ComSpec`, `PATHEXT`, `APPDATA`, `LOCALAPPDATA` and `USERPROFILE`. Everything else stays out, whatever its name: API keys, tokens, proxy URLs, `CI`, `NODE_OPTIONS`, and any `INCARNAMIND_*` flag the launch doesn't set itself. `e2e/launchEnvironment.spec.ts` plants keys under several names, then reads a real trace and the app's log for them.
- **A test that needs a credential passes a made-up one by name:** `launchApp(dataDir, { extraEnv: { OPENAI_API_KEY: "sk-proj-a-made-up-key" } })`. The trace keeps it, so never pass a real one. Electron's own debug variables (`ELECTRON_ENABLE_LOGGING`, `ELECTRON_ENABLE_STACK_DUMPING` and the like) go the same way, by name through `extraEnv`, and `ELECTRON_DISABLE_SANDBOX` and `ELECTRON_RENDERER_URL` reach the app only when a launch sets them (`sandboxNotice` sets the first). The real-model checks (`tests/live`, the evaluation, the nightly run) run in plain Node and record no trace; the README recorder, the one recording with a real key, stops if its app keeps a trace.
- **Don't share a trace made before #2164.** Those kept every variable of the shell they ran in, real keys included. Delete them (`test-results/`, and every `trace*.zip` you saved or downloaded) and record again; don't attach one to an issue or a pull request.

## Tests that pass on any machine

- **Launch through `launchApp` in `e2e/app.ts`.** It gives each test a temporary data folder and home folder, test hooks, the fake embedding model and, with `fakeChat`, the scripted chat model. No test uses the network, an API key or the User's own files.
- **Set the window size the test needs,** with `setWindowSize` in `e2e/app.ts`. Never depend on the screen's size, the display's scale, the window being in front, or the computer's fonts and language. CI's screens, a virtual one on Linux and a small one on macOS, are not yours.
- **Assert relations, not exact pixels.** For example, "the controls sit under the text", "it wraps by word", or "it fits inside the card". Exact sizes are for what `DESIGN.md` fixes, such as a 44px band.
- **Wait for a state, not a time.** Use `expect(locator).toBeVisible()`, a test id or a value from the bridge, never `waitForTimeout` in new tests.
- **Let the editor finish before a key or click moves its selection.** An update the editor makes by itself (the wash that ends after Add to note, ProseMirror's check 20 ms after it takes the focus) rewrites the page's selection from its own, which has not yet caught up with a key or click just before: that key or click is lost. Wait for the update first: `addToNote` waits out the wash, `focusSettled` the check.
- **Drive the app like a person.** Move the mouse to an element before clicking or dragging it (as `slideToHandle`, `dragBy` and `dragBlock` in `e2e/app.ts` do), and use the keyboard where a person would. A helper needed in a second spec moves into `e2e/app.ts` rather than being copied.
- **Keep wall-clock limits out of unit tests.** CI machines run two to five times slower than a laptop. A speed budget belongs in a dedicated speed test with headroom, not in a unit test with a tight millisecond limit.
- **Make each test stand alone.** It must pass on its own and in any order, and it cleans up what it made.
- **Unit tests run in plain Node.** They must not need the Electron binary (CI doesn't download it) or a model download.
- **Load each real engine at least once.** The fake engines (the fake embedding model, `--fake` transcription, the scripted chat model) keep tests fast and repeatable. But they never load the real module, so an import that only breaks in the built app goes unseen: meeting transcription failed in alphas 1 to 3 while every test passed (#1233).
  - A feature that runs a real engine (transcription, OCR, embeddings, the reranker, Python analysis) has at least one unit test that loads the installed module through the app's own loader, not a copy of its import.
  - That test checks the module has what the code calls. It needs no model download.
  - The packaged app reads upright and rotated scans with its real OCR (`e2e/packaged/`, #1819), and transcribes a meeting with its real speech engine and model through Chromium's fake microphone (#1239). The release runs these on macOS before it uploads, the nightly run every night, and CI on a pull request that changes what they cover. To run them yourself: `npm run dist:dir`, then `npm run test:packaged`. Set `INCARNAMIND_MODEL_CACHE` to a folder to keep the models between runs.
- **Tests and the evaluation never touch the real home folder.** `tests/setup/home.ts` gives each test file a temporary HOME (and `USERPROFILE` and the XDG folders), and fails a test that writes under the real one outside the cache and report folders the run was given; the core takes its home and Documents folders from its host, so `startCore` and the evaluation pass temporary ones.
- **Write paths and text that work on every platform.** Use `path.join`, never assume `/` or a case-insensitive file system, and give the Chinese strings the same tests as the English ones.
- **Write each spec for Linux and macOS.** Pull requests run the smoke test on Linux; macOS runs it each night. Press shortcuts with `ControlOrMeta+…`, never `Meta+…`, and expect a shortcut's label in either form (`⌘J` or `Ctrl+J`). A spec for something only macOS has, such as the traffic lights or full screen, skips elsewhere with `test.skip(process.platform !== "darwin", "<why>")`, and the nightly run covers it.

## The feel check

The feel check (`e2e/feel.ts`, and the specs `e2e/feel*.spec.ts`) holds the main flows to DESIGN.md › Feel. It runs each flow step by step in the built app and measures, in the window, what the User would feel. It fails a step:

- **Shift:** the layout shifts that no recent input caused sum to more than 0.001, and the table names what moved.
- **Focus:** after a close, a create or a delete, focus isn't on the target the step names (the opener, the new thing's name, the next item).
- **Input to next paint** over 500 ms, or a **long task** over 1 s. The target is 100 ms on a laptop. CI's runners are two to five times slower, so these ceilings fail only a real freeze. Every run reports both times for every step. Only CI fails them: a busy laptop varies too much, so a local table marks a slow step "fails on CI".

It can't see everything (#1331 adds what it can):

- **The 500 ms after an input.** Chromium marks every shift in the 500 ms after a click or a key as the User's own, and the check doesn't count those. So a shift the User's action set off somewhere else, or a jump while typing, goes unseen. A green feel check doesn't mean nothing moved: look at the video too.
- **A flash or a lost scroll position**, since nothing moves. The videos show both.
- **Slightly high times.** The check films every frame while it measures, so times on CI read a little high.

To run it on what you touch, build once, then run each matching spec on its own:

```sh
npx electron-vite build --mode test
npx playwright test e2e/feelSidebar.spec.ts --workers=1
```

Each flow's table goes to `test-results/feel/<flow>.md`, and its video to `<flow>.mp4`. Without ffmpeg, the frames are kept in `<flow>-frames/` instead. Each Playwright run clears `test-results/`, so read a spec's tables before you run the next. On CI, the tables are also in the job summary.

When it fails:

1. Read the flow's table and watch its video at that step.
2. Fix it if your change caused it.
3. If `main` does it too, file it as its own issue. Then add an entry for it to `KNOWN` in `e2e/feel.ts`, bounded by what was measured. Anything worse, or in another step, still fails.
   - Focus: where it landed.
   - Shift: what moved, and the largest score. The bound holds under 0.001 too, so a listed shift that grows fails even while it is small.
   - Time: twice the slowest measured on CI, since runners vary two to five times.
   - Mark it `sometimes` when it depends on timing and doesn't happen on every run.
4. The pull request that fixes a known problem removes its entry. A shift or focus entry whose problem no longer happens fails the check, so the list stays true. A known time, or a problem marked `sometimes`, may not happen on every run. The non-required job "Feel check, known problems that didn't happen" lists those on each run, so their entries go once their issues close.

## The interaction rules are checked for you

Three checks hold every object and command to `docs/agents/interaction.md`, reading the registries, so a new command is checked with no edit to them:

- `tests/renderer/conformance.test.ts`: every kind in `OBJECT_KINDS` has a registered menu, in the order of rule 5; every command has English and Chinese labels, a group, `reversible` set, and a shortcut or a ⌘K entry.
- `tests/renderer/conformanceStatic.test.ts`: no "Back to…" label, no confirmation of a delete that no irreversible command stands behind, no right-click listener outside `useObjectMenu`, no `draggable` outside the drag layer.
- `e2e/conformance.spec.ts`: for each kind, on the built app with a slid mouse: right-click and ⋯ open one menu, rename in place, and every reversible command from the menu followed by ⌘Z puts the core back, read through the bridge. A command that only makes a Note is the exception: it says nothing and leaves nothing for ⌘Z, and the check takes the Note back by deleting it.

A new kind of object needs a menu (`registerMenu`) and a stage in the e2e (how to make one and show it); the type-check fails until it has one. A reversible command that changes the core returns an `Undoable`. What `main` doesn't do yet is listed with its issue (`NO_MENU_YET`, `NO_UNDO_YET`, the known lists in the static test), never skipped: a fix takes its line out, and a stale line fails.

## Trying AI features by hand

The scripted chat model (`fakeChat`) is for automated tests only: CI has no keys, and its runs must give the same result every time. Before you call an AI feature done (Answers, Citations, Organize, tagging, Tasks, anything a model does), use it by hand in the built app with **Claude Haiku 5.5** on an Anthropic API key. For a hard feature (labelled `complexity:hard`), or when Haiku fails at the task, use Claude Sonnet 5.5 instead. When the feature runs in Local mode, also try a small local model through Ollama, for example `qwen3.5:4b`, with the context at 8,192 tokens or less, one model loaded at a time, and unloaded afterwards.

**Before a release,** the first-class providers (ADR-0019) are each tried by hand once, with the cheapest model that answers: the ChatGPT plan (through the ChatGPT test profile below), Anthropic, OpenAI, Google, OpenRouter, Ollama (a local model and a cloud model), and, for mainland China, DeepSeek, Qwen (Alibaba Cloud Model Studio) and SiliconFlow. Their `support` field in `src/core/providers/catalog/providers.ts` says which they are. Best-effort providers (Mistral, xAI, Kimi, GLM and an OpenAI-compatible server) have no release check. Models differ in how they follow instructions, cite and format, so this pass is where a problem with one provider shows up; file each one as an issue.

**Keep the bill small.** These keys are paid by the person, not a company. Use the cheapest model that answers the question, run each check once per model rather than many times, use short test Documents, and stop as soon as the result is clear. Large or "pro" models need a reason in the pull request.

Use a temporary data folder and test Documents, never your own files. Say in the pull request which models you used and what you checked with each: that the Answer cites, the quotes are found, the feature reads well in Chinese, and it copes with a slow or failing model.

### Outside agents before a release

Settings → Agents sets IncarnaMind up in a few first-class agents (`src/core/agents/clients.ts`). Before a release, try each by hand with a temporary HOME and a test Folder: connect it, ask it something the Folder answers, and check the answer carries Citations that IncarnaMind finds. Disconnect afterwards.

- the Claude desktop app (one click, a Free plan is enough), and Claude Code;
- the ChatGPT desktop app (in its Work or Codex mode) and Codex, which share one configuration;
- Cursor;
- Antigravity, and in China WorkBuddy.

"Other agent" is tried with any one agent that takes pasted settings. The agents' own configuration formats change under us: when one stops working, fix it here or move it to "Other agent" (ADR-0019).

### The ChatGPT test profile

The owner signs in with ChatGPT once, in a test profile; agents then use that sign-in for checks by hand on the owner's ChatGPT plan, without signing in themselves and without ever seeing a token.

- **What it is.** A folder outside every checkout and data folder, `~/.incarnamind-chatgpt-profile`. A development build (`npm run dev`) or a test build started with `INCARNAMIND_CHATGPT_PROFILE` set to it keeps the ChatGPT sign-in there instead of in its data folder: encrypted by the system's keychain (`safeStorage`) like every secret, in a file only the owner's account can read. Everything else (Notes, Documents, settings) stays in the run's own temporary data folder. Release builds ignore the variable, and the smoke tests clear it.
- **Several agents at once.** The tokens rotate when they are refreshed; a lock file in the folder makes processes take turns, so one refreshes and the others use its result.

**The owner's one-time sign-in** (and again if it ever ends, e.g. after 30 days without use):

```sh
export INCARNAMIND_CHATGPT_PROFILE="$HOME/.incarnamind-chatgpt-profile"
export INCARNAMIND_DATA_DIR="$(mktemp -d)"
npm run dev
```

No temporary HOME here: on macOS the app finds the login keychain, which encrypts the sign-in, through HOME (`~/Library/Keychains`). With an empty one there is no keychain, and the app says it can't store the sign-in before it opens OpenAI's page. `INCARNAMIND_DATA_DIR` already keeps this run out of the owner's data folder.

In the app, choose **ChatGPT plan** in the first window (or Settings → Models), then **Continue with ChatGPT**. Sign in with the ChatGPT Plus account in the browser, approve IncarnaMind and allow it to use the plan, then quit. In ChatGPT → Settings → Usage, the owner can cap IncarnaMind's weekly share of the plan.

**Using it as an agent** (on macOS):

```sh
export INCARNAMIND_CHATGPT_PROFILE="$HOME/.incarnamind-chatgpt-profile"
export INCARNAMIND_DATA_DIR="$(mktemp -d)"
TEMP_HOME="$(mktemp -d)"
mkdir -p "$TEMP_HOME/Library" && ln -s "$HOME/Library/Keychains" "$TEMP_HOME/Library/Keychains"
HOME="$TEMP_HOME" npm run dev
```

- **Why the link.** HOME stays temporary, so nothing the app writes there (Documents, dotfiles, other apps' settings) is the owner's. Only the keychains folder is linked, so the app reaches the login keychain, where macOS still decides what it may read. Don't link anything else.
- **No keychain prompt per worktree.** macOS knows the development app by its code signature, and every worktree on the same Electron version has the same Electron binary. After an Electron upgrade, macOS asks once to allow the new one; the owner answers that, not you.
- It starts signed in. GPT-6 Luna is the plan model to try first: choose it in the composer's model chip, or under Settings → Models (**Use for Questions** in the ChatGPT plan card, then the model under **Defaults › Answers**).
- Never read, copy, print or log anything in the profile folder, and never read another app's credentials (`~/.codex/auth.json` and the like). The app reads the profile; you don't.
- Never sign out in the profile: signing out ends the owner's session at OpenAI. Sign-out is covered by the unit tests' fake OpenAI.
- Keep checks small: they use the owner's plan, whose limits are shared with the owner's own ChatGPT.
- If the app says you're signed out of ChatGPT or can't store the sign-in, or macOS asks to allow access to the keychain, stop and ask the owner. Don't sign in or answer the prompt yourself.

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

## In a pull request

The template's "How it was tested" section asks for the commands you ran and a green CI run. Paste the run's link.
