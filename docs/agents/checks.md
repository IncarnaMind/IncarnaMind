# How the checks work

The machinery behind [`testing.md`](testing.md). Read the section you need when a check fails in a way you don't understand, or before you change a workflow. Each workflow file and script says how it runs; this page says what each check is for, and the traps.

## What CI runs on a pull request

`.github/workflows/ci.yml` runs on every pull request, except one that changes only ADRs (`docs/adr/`) or pictures (`docs/images/`). Every other document counts as code: unit tests read the READMEs, `CONTEXT.md` and the guides in `docs/` as text. A draft runs nothing until it is marked ready, and a push to `main` runs nothing. There is no merge queue: the sign-off check is the only required check, and the others report.

| Check | What it runs |
|---|---|
| Typecheck and lint | `npm run typecheck` and `npm run lint` |
| Unit tests (N/8) | Only the tests that import, directly or through other modules, a file the pull request changes: a renderer change runs few or none, a `src/core` or `src/shared` change about half. A change to `package.json`, the lockfile, `vitest.config.ts`, `tests/setup/`, `ci.yml` or a Markdown file runs them all: a test reads a document as text and never imports it, so nothing else would pick that test. The tests that read source files as text run by name (`ci.yml` lists them) |
| Smoke specs to run, then Smoke tests (N/M, Linux) | Only the specs the pull request adds or changes. A change to app code, to what every spec runs on (`e2e/app.ts`, `playwright.config.ts`) or to the dependencies runs no other spec; every spec runs nightly. To check the specs such a change reaches, use [Run named specs](#run-named-specs). A failed shard uploads its traces as `smoke-results-N` |
| Every commit is signed off (DCO) | Its own workflow, `dco.yml`, on every pull request: a `Signed-off-by:` line on each commit (`git commit -s`). No author, committer or sign-off at anthropic.com, and no `Co-Authored-By:` trailer naming Claude or an anthropic.com address: a commit carries its contributor's own name |

- Both test jobs are split into shards balanced by how long each file takes. Refresh `tests/durations.json` with `node scripts/unitDurations.ts <run id>` from a green nightly run, and `e2e/durations.json` from a green run's log, when files are added or slow down. A unit test file the table doesn't know yet counts by its size.
- CI runs the smoke specs with two workers, each on its own virtual display, because windows on one display take the keyboard focus from each other and share a clipboard. Locally and on macOS a run has one worker: keep `--workers=1` when you run a spec by hand.

## Nightly

`.github/workflows/nightly.yml` runs at 02:23 UTC on `main`, and by hand from the Actions tab. It runs CI's checks with every smoke spec, on whatever merged that day, and the checks that need the app packaged as the User installs it, which no pull request runs. A red night is fixed before new work, like a red `main`, and shows itself in an issue (below).

| Job | What it checks |
|---|---|
| Packaged app (macOS) | Ad-hoc signed: every engine module loads the way the app runs it (#1239), the real OCR reads upright and rotated scans (#1819), and the real speech engine and model transcribe a meeting |
| Packaged app (Windows) | `npm run check:package`; the engines load; speech runs on the app's own ONNX Runtime library (#2152); an outside agent connects; secrets are kept |
| Packaged app (Linux) | The engines load and an outside agent connects |
| Packaged startup, quit and updates (Windows) | One instance, startup, quitting and the update between two packaged versions (below) |
| run_code with its real Python (Linux) | `run_code` on the Python built as the release builds it; the OS sandbox's tests, with the sandbox required to start (the unit shards' newer image can't start it, so they skip them); and the Python and pandas the app bundles |
| The sweep and the OS sandbox (macOS) | The tests of the sweep and the Seatbelt profile, which run only on macOS. `INCARNAMIND_TEST_ATTACH_VOLUME=1` lets the sandbox test attach a disk image; it is off by default, so a local run never mounts anything |
| A red night shows itself | Keeps the "Nightly is red" issue true (below) |

No check runs the smoke specs on macOS or Windows: run the ones a change needs there with [Run named specs](#run-named-specs).

**Packaged startup, quit and updates** packages one built main twice, at the old and updated versions in `tests/fixtures/lifecycle-versions.json`, and checks both hold the same main before it runs the specs. Only these test packages start through `e2e/lifecycleMain.cjs`, which loads the test fixtures before the unchanged main; release builds keep `out/main/index.js`. Every launch gets temporary home and app-data folders, and cleanup touches only processes with the run's own tag. Installers and native dialogs are still fixtures.

The Windows mapped-SHM probe is an expected failure for [#2067](https://github.com/IncarnaMind/IncarnaMind/issues/2067). Check it on each Electron update: an unexpected pass may mean the runtime has the upstream SQLite fix, and the marker can go once that is verified. A crash handover without the mapping helper must capture extended code `1546` before it is called that bug.

## The real-model night

`.github/workflows/nightly-real-model.yml` asks real models every night, since the scripted model can't tell whether an AI feature works: the live tests (`tests/live`) and the everyday requests (`eval/everyday`) on Claude Haiku 5.5, a live test of Kimi International, and the everyday requests in Chinese on Kimi K2.6. Kimi sees only the evaluation's own public and made-up Documents. `scripts/nightlyRealModel.ts` says how the run picks a key and what it writes. A failing night is fixed like a red `main`.

- **Secrets (the owner sets them; use capped API keys):** `NIGHTLY_ANTHROPIC_KEY_1`, `NIGHTLY_ANTHROPIC_KEY_2` and `NIGHTLY_KIMI_KEY`. A missing secret fails the job at once, naming it. When key 1 is out of credit, the run moves to key 2 for good and the summary says so.
- **Limits:** a step past its time is stopped, and a night that has spent over `NIGHTLY_MAX_USD` (10 by default) starts no further step. A cancelled night leaves a report headed "Unfinished".
- **Not measured is not failed.** Each key is first asked for one token, and only the status is read (under a cent); a refused key counts as out of credit. A step with no key left, one whose last key ran out part way, and one that a cancel or the spend limit stopped are **not measured**, in their own column of `summary.md`. A step that ran no case counts as failed.
- **What is public:** anyone who can see a run can download its artifact and read its log. So the artifact holds only `summary.md` (each case's result, the key used and the spend), `status.json` and each step's `usage.jsonl` (token counts). A step's own reports hold what the providers answered, account and key ids included, and stay on the runner: to read an everyday reply, run that request by hand. The summary and the log name a failed request by its status in our words (`refused: out of credit`); the log rewrites only the shapes of provider text it knows, so a provider's words in any other shape would still show.
- **By hand:** Actions › Nightly real models › Run workflow, or `NIGHTLY_ANTHROPIC_KEY_1=… NIGHTLY_ANTHROPIC_KEY_2=… NIGHTLY_KIMI_KEY=… npm run nightly:real-model`. `NIGHTLY_STEPS` (`live`, `everyday`, `claim-probes`, `kimi-live`, `kimi-everyday`, separated by commas) runs only those, and `INCARNAMIND_EVAL_EVERYDAY` only some everyday requests (`eval/everyday/README.md`). Keep to a few requests for a check: the whole night costs a few dollars.

**A red night shows itself.** The last job of both nightly workflows (`scripts/nightlyIssue.ts`) keeps one issue, "Nightly is red" (`priority:P1`, `ready-to-build`). It reports only for the scheduled run on `main`, never for a run by hand, from another branch or on a pull request.

- It opens the issue or updates the open one, so there is never one issue per night. The first night after which both workflows are green comments "green again" and closes it.
- A night is **green** (everything ran and passed), **red** (a test failed) or **not measured** (a check couldn't run). Not measured is never green, and the issue says since which date nothing was measured.
- Each failing Playwright or Vitest test keeps the date it first failed, until it passes for a night. A failed job whose log names no test is listed by its name and its failed step.
- The issue holds only our own words (test, job and step names, dates, the commit, run links, a provider's name), never a log line, a request or a provider's answer. The job's only write access is `issues: write`, no other job has it, and it gets no secret.
- To see what it would write for a saved run: `gh run view <id> --json createdAt,headSha,url,jobs > run.json`, then `node scripts/nightlyIssue.ts nightly --dry-run --run run.json` (the script lists its other options).

## Run named specs

`.github/workflows/specs.yml` runs the specs you name on a clean GitHub-hosted machine, Linux, macOS or Windows, set up as the smoke test is. Playwright loads your own computer, and several runs at once overload the owner's; some failures also show only on macOS or Windows (the traffic lights, full screen, a shortcut). It is apart from `ci.yml`, so it never runs or blocks a required check.

```sh
git push
node scripts/run-specs.mjs --os macos --repeat 3 e2e/undoPill.spec.ts e2e/scans.spec.ts:144
```

- **When:** by default for UI specs, instead of running them yourself. Always, on that system, for a behaviour only macOS or only Windows has (a spec that skips elsewhere with `test.skip(process.platform ...)`). Run locally only to look at the UI by hand or to record a flow.
- **Inputs:** spec paths under `e2e/` (`path` or `path:line`), `--os` (`linux` by default), `--repeat` (1 to 10, to tell a flaky spec from a broken one) and `--grep`. By hand they are Actions › Run named specs › Run workflow. Anything else is refused before anything is installed, and no input reaches a shell as code.
- **What you get:** the helper runs your branch's pushed commit (it stops if the branch isn't pushed) and prints pass, fail or skip for each spec; a spec that skips on that system shows as skip, not pass.
  - On a failure it downloads the results to `test-results/specs-<os>-<run>/`. Read them before your next local Playwright run, which clears `test-results/`.
  - Every test's trace, video and window picture is kept, passed or not, in the `specs-<os>-<run id>` artifact for 7 days: `npx playwright show-trace <trace-….zip>`.
  - The recording slows the app a little, so a feel check time that fails only here is worth one run in CI before you chase it.
- **Limits:** one run per branch and system at a time; a new dispatch cancels the one still going. macOS runners are few and the Nightly shares them, so ask for macOS only for what needs it. A run stops after 45 minutes. A green run here doesn't replace the pull request's checks.

A spec, here or on your computer, runs only on a test build made in your own worktree right before the run (`npx electron-vite build --mode test`), never on an `out/` you didn't just build. Any other build ignores the fakes, so a Meeting would record with the real microphone and download the real speech model; the launchers refuse to start one (#2941).

## What a launched app's environment holds

A trace keeps the environment the app was launched with and the arguments of every call, so no key may reach a launch.

- Every launch, in a spec, the packaged checks or the UI audit, builds its environment with `launchEnvironment` (`e2e/launchEnvironment.ts`). It passes on from your shell only what an app needs to run, as that file lists. Everything else stays out, whatever its name: API keys, tokens, proxy URLs, `CI`, `NODE_OPTIONS`, and any `INCARNAMIND_*` flag the launch doesn't set itself. `e2e/launchEnvironment.spec.ts` checks a real trace and the app's log for planted keys.
- A test that needs a credential passes a made-up one by name: `launchApp(dataDir, { extraEnv: { OPENAI_API_KEY: "sk-proj-a-made-up-key" } })`. The trace keeps it, so never pass a real one. Electron's own debug variables (`ELECTRON_ENABLE_LOGGING` and the like) also go by name through `extraEnv`.
- The real-model checks (`tests/live`, the evaluation, the nightly run) run in plain Node and record no trace. The README recorder, the one recording with a real key, stops if its app keeps a trace.

## The packaged app's engine check

**The engine check** (`e2e/packaged/engines.packaged.ts`, #1239) starts the packaged app with `--check-engines=<report file>`. With no window and a data folder of its own, the app starts each engine process as it does for the User and loads its native modules (ONNX Runtime, the tokenizers, `@napi-rs/canvas`, sherpa-onnx-node, and the OS sandbox's module on macOS and Linux). It also runs a regression, a forecast, a clustering and a plot in the Analyses window. The spec fails naming each module that didn't load, and when the app checked other modules than the spec expects. No model is downloaded. The release runs it on each system's app before it uploads, and the nightly run every night.

- **To run it:** `npm run dist:dir`, then `npm run test:packaged -- engines.packaged.ts`. It finds the app `dist:dir` made on this computer; `INCARNAMIND_PACKAGED_APP` names another executable. On Linux it needs a display (`xvfb-run -a`) and Chromium's sandbox helper owned by root and setuid, without which Analyses don't run: `sudo chown root:root dist/linux-unpacked/chrome-sandbox && sudo chmod 4755 dist/linux-unpacked/chrome-sandbox`.
- **The other packaged checks** read upright and rotated scans with the real OCR (#1819), and transcribe a meeting with the real speech engine and model through Chromium's fake microphone (#1239). The release runs them on macOS before it uploads, and the nightly run every night. To run them: `npm run dist:dir`, then `npm run test:packaged`. Set `INCARNAMIND_MODEL_CACHE` to a folder to keep the models between runs.

## One real engine in a test build

A test build runs three engines as stand-ins, so a spec needs no download: the search model (with the reranker), text recognition (OCR) and speech-to-text. The launcher sets `INCARNAMIND_TEST_EMBEDDER=fake`, `INCARNAMIND_TEST_OCR=fake` and `INCARNAMIND_TEST_TRANSCRIBER=fake`; an engine whose flag is left out runs as the User's copy does. Only a test build reads the flags.

To try one real engine by hand, name it: `launchApp(dataDir, { real: ["ocr"] })`, or `"embedder"` or `"transcriber"` (several may be named together). Its model downloads into the test's data folder the first time something needs it: about 21 MB for OCR, 135 MB for the search model and 990 MB for speech. Without `real`, a test build reaches no host outside this computer; with it, only the model hosts (Hugging Face, its CDN and its mirror).

- **Smoke specs never use `real`.** The packaged app's checks (above) load the real engines.
- **Check the disk first** (`df -h /System/Volumes/Data`). A fresh data folder downloads the models again; copy them in first, as `seedModels` in `e2e/demo/workspace.ts` does.
- **Only temporary folders:** `launchApp` refuses a data folder or a `home` outside `os.tmpdir()`, so a check by hand never touches the User's own data or home. Make the data folder with `createDataFolder()`.
- **To run one by hand:** put a throwaway spec in `e2e/` that launches with `real`, add a Document and read what the engine made; build with `npx electron-vite build --mode test`; run `npx playwright test e2e/<spec> --workers=1`; delete the spec afterwards. For OCR, `(await coreOf(window)).evaluate((core, id) => core.readScannedText(id), documentId)` gives each page's text and `label.scan.reader`, which is "PP-OCRv5 mobile/2" for the real model. `getTextRecognitionModel()`, `getEmbeddingModel()` and `getTranscriptionModel()` say which models downloaded.

## The feel check

The feel check (`e2e/feel.ts`, and the specs `e2e/feel*.spec.ts`) holds the main flows to DESIGN.md › Feel. It runs each flow step by step in the built app and measures, in the window, what the User would feel. It fails a step on:

- **Shift:** layout shifts that no recent input caused sum to more than 0.001. The table names what moved.
- **Focus:** after a close, a create or a delete, focus isn't on the target the step names (the opener, the new thing's name, the next item).
- **Time:** input to next paint over 500 ms, or a long task over 1 s. The target is 100 ms on a laptop; CI's runners are two to five times slower, so these ceilings fail only a real freeze. Only CI fails on time, since a busy laptop varies too much: a local table marks a slow step "fails on CI".

What it can't see (#1331 adds what it can):

- **Shifts in the 500 ms after an input.** Chromium counts those as the User's own, so a shift the User's action set off elsewhere, or a jump while typing, goes unseen. A green check doesn't mean nothing moved: watch the video too.
- **A flash or a lost scroll position,** since nothing moves. The videos show both.
- Times on CI read a little high, because the check films every frame while it measures.

To run it on what you touch, build once, then run each matching spec on its own:

```sh
npx electron-vite build --mode test
npx playwright test e2e/feelSidebar.spec.ts --workers=1
```

Each flow's table goes to `test-results/feel/<flow>.md` and its video to `<flow>.mp4` (without ffmpeg, its frames to `<flow>-frames/`). Each Playwright run clears `test-results/`, so read a spec's tables before you run the next. On CI the tables are also in the job summary.

When it fails:

1. Read the flow's table and watch its video at that step.
2. Fix it if your change caused it.
3. If `main` does it too, file it as its own issue, then add an entry for it to `KNOWN` in `e2e/feel.ts`, bounded by what was measured: anything worse, or in another step, still fails.
   - Focus: where it landed.
   - Shift: what moved, and the largest score. The bound holds under 0.001 too, so a listed shift that grows fails even while it is small.
   - Time: twice the slowest measured on CI, since runners vary two to five times.
   - Mark it `sometimes` when it depends on timing and doesn't happen on every run.
4. The pull request that fixes a known problem removes its entry. A shift or focus entry whose problem no longer happens fails the check, so the list stays true. A known time, or an entry marked `sometimes`, may simply not happen on a run: each run lists those in `test-results/feel/<flow>.unseen.txt` without failing, so remove their entries once their issues close.

## The interaction rules are checked for you

Three checks hold every object and command to [`interaction.md`](interaction.md). They read the registries, so a new command is checked with no edit to them:

- `tests/renderer/conformance.test.ts`: every kind in `OBJECT_KINDS` has a registered menu, in the order of rule 5; every command has English and Chinese labels, a group, `reversible` set, and a shortcut or a ⌘K entry.
- `tests/renderer/conformanceStatic.test.ts`: no "Back to…" label, no confirmation of a delete that no irreversible command stands behind, no right-click listener outside `useObjectMenu`, no `draggable` outside the drag layer.
- `e2e/conformance.spec.ts`: for each kind, on the built app with a slid mouse, right-click and ⋯ open one menu, rename works in place, and every reversible command from the menu followed by ⌘Z puts the core back. A command that only makes a Note is the exception: it leaves nothing for ⌘Z, and the check takes the Note back by deleting it.

A new kind of object needs a menu (`registerMenu`) and a stage in the e2e (how to make one and show it); the type-check fails until it has both. A reversible command that changes the core returns an `Undoable`. What `main` doesn't do yet is listed with its issue (`NO_MENU_YET`, `NO_UNDO_YET`, the known lists in the static test), never skipped: a fix takes its line out, and a stale line fails.

## Before a release, by hand

**Before a release,** try each first-class provider (ADR-0019) by hand once, with the cheapest model that answers: the ChatGPT plan (through the ChatGPT test profile below), Anthropic, OpenAI, Google, OpenRouter, Ollama (a local model and a cloud model), and, for mainland China, DeepSeek, Qwen (Alibaba Cloud Model Studio) and SiliconFlow. The `support` field in `src/core/providers/catalog/providers.ts` says which are first-class. Best-effort providers (Mistral, xAI, Kimi, GLM and an OpenAI-compatible server) have no release check. Models differ in how they follow instructions, cite and format, so this pass is where a problem with one provider shows up; file each as an issue.

Before each release tag, also try the Copilot plan's sign-in through IncarnaMind's own GitHub app (#876), with a real GitHub account that has a Copilot plan, in a temporary home and data folder: sign in with the device code, see the models the plan lists, ask a Question and check the Answer cites, and watch the sign-in renew. A plan holder told "no Copilot plan" (GitHub answering `no_copilot_access`) means the check failed. #876 stays open until this check has run once.

### Outside agents before a release

Settings → AI sets IncarnaMind up in the agents in wide use (`src/core/agents/clients.ts`, ADR-0019). `tests/core/agentClients.test.ts` checks the exact line, file entry or pasted settings each is given against its documentation, cited beside each agent. Before a release, try these by hand with a temporary HOME and a test Folder: connect it, ask it something the Folder answers, and check the answer carries Citations that IncarnaMind finds. Disconnect afterwards.

- the Claude desktop app (one click; a Free plan is enough), and Claude Code;
- the ChatGPT desktop app and Codex, which share one configuration;
- Cursor;
- Antigravity, and in China WorkBuddy.

Try "Other agent" with any one agent that takes pasted settings. The agents' own configuration formats change under us: when one stops working, or its documentation changes, fix it there, or move it to "Other agent".

**A check on Codex in the background** (ADR-0035) was measured on Codex 0.170.0, and any later Codex runs it once its preflight lists the check's Tools alone. Codex can keep accepting a setting it no longer honours, which nothing at run time catches, so before each release take the measurement again on the current Codex, with a test sign-in in a profile of its own and a temporary HOME and data folder: list the profile (names, sizes and times, never contents), then press Check on a Note in the background, once to the end, once stopped from the Note and once failing (a sign-out, or a 400 on a local test endpoint), listing the profile after each. Anything that differs beyond Codex's launcher folder (`tmp/arg0-…`) stops the release until the run holds it off, or ADR-0035 and the privacy page say what is kept.

### The ChatGPT test profile

The owner signs in with ChatGPT once, in a test profile. Agents then use that sign-in for checks by hand on the owner's ChatGPT plan, without signing in themselves and without ever seeing a token.

- **What it is:** a folder outside every checkout and data folder, `~/.incarnamind-chatgpt-profile`. A development build (`npm run dev`) or a test build started with `INCARNAMIND_CHATGPT_PROFILE` set to it keeps the ChatGPT sign-in there instead of in its data folder, encrypted by the system's keychain like every secret, in a file only the owner's account can read. Everything else (Notes, Documents, settings) stays in the run's own temporary data folder. Release builds ignore the variable, and the smoke tests clear it.
- **Several agents at once:** the tokens rotate when they are refreshed, so a lock file in the folder makes processes take turns.

**The owner's one-time sign-in** (and again if it ever ends, for example after 30 days without use):

```sh
export INCARNAMIND_CHATGPT_PROFILE="$HOME/.incarnamind-chatgpt-profile"
export INCARNAMIND_DATA_DIR="$(mktemp -d)"
npm run dev
```

No temporary HOME here: on macOS the app finds the login keychain, which encrypts the sign-in, through HOME (`~/Library/Keychains`); with an empty HOME, the app can't store the sign-in. `INCARNAMIND_DATA_DIR` already keeps this run out of the owner's data folder. In the app, choose **ChatGPT plan** in the first window (or Settings → Models), then **Continue with ChatGPT**. Sign in with the ChatGPT Plus account in the browser, approve IncarnaMind and allow it to use the plan, then quit. In ChatGPT → Settings → Usage, the owner can cap IncarnaMind's weekly share of the plan.

**Using it as an agent** (on macOS):

```sh
export INCARNAMIND_CHATGPT_PROFILE="$HOME/.incarnamind-chatgpt-profile"
export INCARNAMIND_DATA_DIR="$(mktemp -d)"
TEMP_HOME="$(mktemp -d)"
mkdir -p "$TEMP_HOME/Library" && ln -s "$HOME/Library/Keychains" "$TEMP_HOME/Library/Keychains"
HOME="$TEMP_HOME" npm run dev
```

- **Why the link:** HOME stays temporary, so nothing the app writes there is the owner's. Only the keychains folder is linked, so the app reaches the login keychain, where macOS still decides what it may read. Don't link anything else.
- **No keychain prompt per worktree:** macOS knows the development app by its code signature, which is the same for every worktree on the same Electron version. After an Electron upgrade, macOS asks once to allow the new one; the owner answers that, not you.
- It starts signed in. GPT-6 Luna is the plan model to try first: choose it in the composer's model chip, or under Settings → Models (**Use for Questions** in the ChatGPT plan card, then the model under **Defaults › Answers**).
- Never read, copy, print or log anything in the profile folder, and never read another app's credentials (`~/.codex/auth.json` and the like). The app reads the profile; you don't.
- Never sign out in the profile: signing out ends the owner's session at OpenAI. The unit tests' fake OpenAI covers sign-out.
- Keep checks small: they use the owner's plan, whose limits are shared with the owner's own ChatGPT.
- If the app says you're signed out of ChatGPT or can't store the sign-in, or macOS asks to allow access to the keychain, stop and ask the owner. Don't sign in or answer the prompt yourself.
