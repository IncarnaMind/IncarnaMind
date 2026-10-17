# Tests and CI

Read this before writing code or tests, whether you are a person or a coding agent.

**The bar:** a change is done when its pull request's checks are green on GitHub, not when the tests pass on your computer. CI runs on clean machines that are slower than yours and have a different screen. A test that passes only on your computer is a broken test.

CI (`.github/workflows/ci.yml`) runs three checks on every pull request (`pull_request`), and again on each group the merge queue tests on top of `main` (`merge_group`). A push to `main` runs the first only, since the queue already ran the smoke test on that exact code:

| Check | Where | What it runs |
|---|---|---|
| Typecheck, lint and unit tests | Ubuntu | `npm ci`, `npm run typecheck`, `npm run lint`, `npm test` |
| Electron smoke test (Linux) | Ubuntu | `npm ci`, the Noto CJK fonts (the runner has no Chinese face), then `npm run test:smoke` on a virtual display (`xvfb-run`): builds the app and runs every spec in `e2e/`, split into eight shards that run at once, balanced by how long each spec takes (`scripts/smoke-shard.mjs`, `e2e/durations.json`; refresh it from a green run's log when specs are added or slow down) (`Smoke shard N/8`); this check passes when all eight do |
| Every commit is signed off (DCO) | Ubuntu | a `Signed-off-by:` line on each commit (`git commit -s`) |

`main` must stay green. A pull request merges through GitHub's merge queue once all three pass: the queue builds it together with `main` and the pull requests ahead of it, runs the checks again, and merges only if they pass. Nobody brings a branch up to date by hand. If `main` goes red, fixing it comes before new work.

Every night, and by hand from the Actions tab, the Electron smoke test (macOS) in `.github/workflows/nightly.yml` runs the same suite on macOS, in four shards (`Smoke shard N/4 (macOS)`), with the specs only macOS has, such as the traffic lights in the title bar. A failing night is fixed before new work, like a red `main`.

## Before you open a pull request

1. Merge `main` into your branch only to resolve a conflict or to pick up something you need; the merge queue tests your change on top of `main` anyway.
2. Run what CI runs: `npm run typecheck`, `npm run lint`, `npm test`.
3. Run `npm run test:smoke`: the whole suite, or at least every spec that touches what you changed. To find them, search `e2e/` for the test ids, labels and strings you changed or removed.
4. When you change or remove UI, update or remove the tests that used it in the same pull request. A test still looking for something your change removed is broken by your change.
5. Try the edge cases below that apply to your change, by test or by hand, and say in the pull request which you tried and which don't apply.

## After you open it

- Watch the checks until they finish: `gh pr checks <number> --watch`. Don't report the work as done, or ask for a merge, while a check is red or still running.
- When a check fails, read why: `gh run view <run id> --log-failed`, and for the smoke test, the failing shard's log and the Playwright traces uploaded as its `smoke-test-results-linux-N` artifact (`smoke-test-results-macos-N` from the nightly run). Fix it in this pull request, whether or not your change caused it, and say which in the pull request.
- "Flaky" is a claim that needs evidence: it failed, then passed on a rerun with nothing changed, and you can say what timing it depends on. Then fix the test. Don't hide it with more retries, longer timeouts or a skip.

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
- **Tests and the evaluation never touch the real home folder.** `tests/setup/home.ts` gives each test file a temporary HOME (and `USERPROFILE` and the XDG folders), and fails a test that writes under the real one outside the cache and report folders the run was given; the core takes its home and Documents folders from its host, so `startCore` and the evaluation pass temporary ones.
- **Write paths and text that work on every platform.** Use `path.join`, never assume `/` or a case-insensitive file system, and give the Chinese strings the same tests as the English ones.
- **Write each spec for Linux and macOS.** Pull requests run the smoke test on Linux; macOS runs it each night. Press shortcuts with `ControlOrMeta+…`, never `Meta+…`, and expect a shortcut's label in either form (`⌘J` or `Ctrl+J`). A spec for something only macOS has, such as the traffic lights or full screen, skips elsewhere with `test.skip(process.platform !== "darwin", "<why>")`, and the nightly run covers it.

## The interaction rules are checked for you

Three checks hold every object and command to `docs/agents/interaction.md`, reading the registries, so a new command is checked with no edit to them:

- `tests/renderer/conformance.test.ts`: every kind in `OBJECT_KINDS` has a registered menu, in the order of rule 5; every command has English and Chinese labels, a group, `reversible` set, and a shortcut or a ⌘K entry.
- `tests/renderer/conformanceStatic.test.ts`: no "Back to…" label, no confirmation of a delete that no irreversible command stands behind, no right-click listener outside `useObjectMenu`, no `draggable` outside the drag layer.
- `e2e/conformance.spec.ts`: for each kind, on the built app with a slid mouse: right-click and ⋯ open one menu, rename in place, and every reversible command from the menu followed by ⌘Z puts the core back, read through the bridge.

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

- **What it is.** A folder outside every checkout and data folder, `~/.incarnamind-chatgpt-profile`. A development build (`npm run dev`) or a test build started with `INCARNAMIND_CHATGPT_PROFILE` set to it keeps the ChatGPT sign-in there instead of in its data folder: encrypted by the system's keychain (`safeStorage`) like every secret, in a file only the owner's account can read. Everything else (Minds, Documents, settings) stays in the run's own temporary data folder. Release builds ignore the variable, and the smoke tests clear it.
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
- It starts signed in. GPT-6 Luna is the plan model to try first: choose it in the composer's model chip, or under Settings → Models (**Use for Questions** in the ChatGPT plan section, then the model in Chat model).
- Never read, copy, print or log anything in the profile folder, and never read another app's credentials (`~/.codex/auth.json` and the like). The app reads the profile; you don't.
- Never sign out in the profile: signing out ends the owner's session at OpenAI. Sign-out is covered by the unit tests' fake OpenAI.
- Keep checks small: they use the owner's plan, whose limits are shared with the owner's own ChatGPT.
- If the app says you're signed out of ChatGPT or can't store the sign-in, or macOS asks to allow access to the keychain, stop and ask the owner. Don't sign in or answer the prompt yourself.

## Edge cases

Most bugs a User meets sit at the edges, not on the path the feature was built for. Try each case that applies to your change, with an automated test where it can be one. The audit's fixtures (`e2e/audit/fixtures.ts`) already write many of these files.

- **Empty, one and many.** Nothing at all (an empty Mind, Folder, Library or field), a single item, and a lot: 2,000 Documents, a 300-page PDF, a 50,000-cell sheet, a Mind of about 300 Blocks.
- **Words.** Chinese, Chinese mixed with English, a very long name, emoji and unusual characters, and typing through a Chinese input method while it is still composing.
- **Broken input.** A damaged, empty, password-protected or oversized file; a scanned PDF with no text layer; a format IncarnaMind doesn't read; a file that disappears while it's being read.
- **No network and no consent.** Offline, the consent prompt declined, and Local mode.
- **Models that misbehave.** A slow model, one that fails or can't be reached, and one that returns no Citations or nonsense. Cancel halfway, and act while an Answer is still streaming.
- **Quitting halfway.** Force-quit in the middle of the action, then start again: nothing is lost, doubled or left half done.
- **Twice and back.** Do the action twice quickly (a double click, a held key), then Undo and Redo it.
- **Every way in.** Mouse and keyboard only, a narrow and a wide window, light and dark, English and Chinese.

## In a pull request

The template's "How it was tested" section asks for the commands you ran and a green CI run. Paste the run's link.
