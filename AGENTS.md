# IncarnaMind: how to work on it

These rules are for everyone who changes this repository, people and coding agents alike (Claude Code, Codex, Cursor or any other). They are short; the detail lives in the files they point to. When you brief another agent, pass this file on.

## Words and decisions

- Use the words in [`CONTEXT.md`](CONTEXT.md) (a Passage, not a chunk; a Connector, not a plugin), in code, strings, tests and issues.
- Decisions that are hard to reverse are ADRs in [`docs/adr/`](docs/adr/). Read the ones your change touches, and say so in the pull request when a change goes against one.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `IncarnaMind/IncarnaMind`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five labels: `needs-triage`, `needs-info`, `ready-to-build`, `needs-owner`, `wontfix`, and one of `priority:P0` to `priority:P3` on every triaged issue. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Writing code

1. **Read before you write.** Read the issue, the ADRs it touches and the code around the change. Use an existing module, helper or shared building block before adding one; when something is needed a second time, move it somewhere shared rather than copying it. When you take a work item (`docs/agents/issue-tracker.md`), read each member once and build them in one branch.
2. **Make the smallest change that fully does the job.** Don't add abstractions, options or flags that nothing needs yet. Don't take a shortcut that leaves the User a worse experience either.
3. **Respect the layers.**
   - `src/core` is the product and never imports Electron; Biome enforces this. Pass a capability in as an adapter instead.
   - `src/main` is the Electron shell.
   - The renderer reaches the core only through the bridge (`src/shared/bridge.ts`).
   - Keep the core portable to other hosts and ready for sync ([`docs/agents/portability.md`](docs/agents/portability.md)). Node built-ins go through adapters, `fetch` is passed in, the core API stays structured-clone-safe, OAuth takes its redirect from the host, and secrets never sync.
4. **Keep files focused.** Put a new feature in its own component, hook or core module rather than growing `App.tsx` or another long file.
5. **Fix types; don't silence them.** TypeScript is strict. No `any`, no `@ts-ignore`, and no `!` assertion just to quiet the compiler.
6. **Never swallow an error.** A failure the User can act on becomes a problem in plain words, where it happened (`DESIGN.md`, Problems). Log the rest with enough context to find it.
7. **Data changes are migrations** (`src/core/storage/migrations.ts`).
   - Take the next free number after the highest on `main`, and check it again after merging `main`.
   - Never edit a migration that has shipped.
   - Keep tables ready to sync: random UUID ids, ISO 8601 UTC timestamps, and soft deletes with `deleted_at`.
8. **Add few dependencies.** A new one must be open source under a permissive licence, maintained and small, and the pull request says why it's needed. The one exception is Pyodide (MPL-2.0), shipped unmodified for Python analysis (ADR-0023). No LangChain (ADR-0005). The lockfile changes only through `npm install`.
9. **Keep secrets and the User's data safe.**
   - No keys or tokens in code, logs, tests, issues or pull requests. Store secrets only through `src/core/secrets.ts`.
   - Nothing leaves the computer without the User's consent, which they give where they choose the service (ADR-0022, `src/core/consent.ts`); background work never asks. Usage data follows ADR-0014.
10. **Every interface string comes in English and Simplified Chinese**, in `src/shared/i18n/`. Chinese strings follow [`docs/agents/zh-CN.md`](docs/agents/zh-CN.md). Every date and time the interface shows comes from `src/shared/dates.ts`.
11. **Write as few comments as possible.** Add one only when the code can't say it itself: a reason that isn't obvious, such as a workaround, a platform quirk, a constraint from an ADR or an issue (link it), or a trap the next reader would fall into. Prefer clearer names and smaller functions to a comment.
    - Don't write comments that restate what the code does, narrate a change ("now uses…", "fixed…"), label sections or address the reviewer.
    - No commented-out code. No TODO without an issue number.
    - A public function's doc comment is fine when its contract (inputs, units, errors) isn't clear from its types.
12. **Work in your own branch and worktree.**
    - Don't change another checkout or the User's data folder, and don't drive the User's apps.
    - Use temporary data folders and a temporary home folder for anything you run.
    - Run `npm ci` in your own worktree before anything that rebuilds native modules, rather than rebuilding a shared `node_modules`.
13. **Read your own diff before you open the pull request,** as a reviewer would, against the issue's acceptance criteria and these rules. Answer review comments, the automated reviewer's included, by fixing them or by saying why not.

## Tests and CI

Read [`docs/agents/testing.md`](docs/agents/testing.md). Work is done when the checks that matter for it pass on a clean machine (CI on the pull request, or your own run of the same commands), not when one test passes on your computer.

- On your computer, run the light checks: `npm run typecheck`, `npm run lint`, and the unit tests of the files you changed. CI runs the whole unit suite and every smoke spec on the pull request. Run a smoke spec locally only when you need to see the UI you changed or record it.
- Try the edge cases in `docs/agents/testing.md` that apply (empty and huge input, Chinese, broken files, offline, failing models, quitting halfway, twice and Undo), and say which in the pull request.
- Update or remove the tests for UI you changed.
- A feature with a real engine (transcription, OCR, embeddings, the reranker, Python analysis) also needs a test that loads the real module the way the built app does. The fake engines are for everything else.
- Watch `gh pr checks <number> --watch` and fix any red check before reporting.
- Tests must pass on any machine:
  - launch through `e2e/app.ts` and set the window size;
  - assert relations rather than exact pixels;
  - wait for states rather than times;
  - keep wall-clock limits out of unit tests.
- Test through the core's public interface, as the UI uses it, and assert what a User would see. Tests need no API keys and no network.
- Automated tests use the scripted chat model. Before calling an AI feature done, use it by hand with a real model: Claude Haiku 5.5 on an Anthropic API key (Sonnet 5.5 for a hard feature), plus a small local Ollama model whenever the feature runs in Local mode. The pull request says which models you used. Every provider is tried before a release (`docs/agents/testing.md`).

## UI

- Read `DESIGN.md` before visual work: the fonts, colours, spacing and direction. Ask before departing from it, and flag code that doesn't match it.
- Read [`docs/agents/interaction.md`](docs/agents/interaction.md) before building or changing any UI. The bar: easy to use and easy to pick up, not fewer features. In short:
  - borrow familiar conventions;
  - edit in place;
  - every drag has a non-drag alternative;
  - never replace the Mind the User is in;
  - Undo instead of confirmations;
  - one right-click menu order and one selection model;
  - the keyboard and ⌘K reach everything;
  - feedback within 100 ms;
  - motion only from the shared module (`src/renderer/src/motion.ts`), as `DESIGN.md` › Motion says, with no hand-written transitions;
  - layouts that hold at every width, in English and Chinese.
  - teach features where they live, not in onboarding, which only gets the User to a first checked Answer.
- Build to the interactive prototype's behaviour, not to a still design board: a board fixes the looks only.
- A UI pull request ticks the template's interaction checklist, shows before and after screenshots, and records the flow in the built app beside the same flow in the prototype, explaining every difference.

## Commits and pull requests

- Sign off every commit (`git commit -s`); see [`CONTRIBUTING.md`](CONTRIBUTING.md).
- One theme per pull request, under about 600 changed lines. A theme is one screen or one flow the User sees, not only one file: if its issues can't be shown in one recorded flow, split. It may close several small, related issues of the same priority tier and kind; list each issue's acceptance criteria with ticks, use "Closes #123" only for an issue whose criteria are all met, and "Part of #123" with a line "What is left" for any other. Never mix a P0 or P1 issue with a P2 or P3 one, or simple or medium work with hard, and a change to AI behaviour (a prompt, a tool description, a model choice) keeps its real-model numbers and doesn't ride with UI-only issues. A P0 or P1 issue never waits for a batch to fill. File one issue per theme, not one per finding: related small findings of the same theme, priority tier and difficulty go into one issue as a checklist, each part with its own criteria, and a new finding that fits an open issue of its theme is added there (`docs/agents/issue-tracker.md` › Filing an issue). Say what the User gets and why. One set of before and after screenshots and one recording of the built flow covers every issue in a UI theme.
- A pull request merges once its sign-off check passes and its CI checks are green (about 25 minutes), or each red one is a known flaky spec named with its issue. Open it as a draft while you work (a draft skips the heavy jobs) and push as few times as you can. The whole suite also runs on `main` every night; a red night is fixed before new work. A change to checks, privacy or the User's data is reviewed by someone else first. Merge `main` into your branch to resolve a conflict or to pick up something you need.
