# IncarnaMind: how to work on it

Rules for everyone who changes this repository, people and coding agents alike. The detail lives in the files they point to. When you brief another agent, pass this file on.

## Words and decisions

- Use the words in [`CONTEXT.md`](CONTEXT.md) (a Passage, not a chunk; a Connector, not a plugin), in code, strings, tests and issues.
- Decisions that are hard to reverse are ADRs in [`docs/adr/`](docs/adr/). Read the ones your change touches, and say so in the pull request when a change goes against one.

## Agent skills

- **Issue tracker:** GitHub Issues on `IncarnaMind/IncarnaMind`, through the `gh` CLI. Read [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md) before you file or take an issue.
- **Triage labels:** [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).
- **Domain docs:** `CONTEXT.md` and `docs/adr/` at the repo root; [`docs/agents/domain.md`](docs/agents/domain.md).

## Writing code

1. **Read before you write.** Read the issue and the code around the change. Use an existing module, helper or shared building block before adding one; when something is needed a second time, move it somewhere shared rather than copying it.
2. **Make the smallest change that fully does the job.** Don't add abstractions, options or flags that nothing needs yet. Don't take a shortcut that leaves the User a worse experience either. Plan it as a short list of the concrete changes, not as a planning document.
3. **Respect the layers.**
   - `src/core` is the product and never imports Electron; Biome enforces this. Pass a capability in as an adapter instead.
   - `src/main` is the Electron shell, and the renderer reaches the core only through the bridge (`src/shared/bridge.ts`).
   - The core stays portable to other hosts and ready for sync. Read [`docs/agents/portability.md`](docs/agents/portability.md) before `src/core` gains a Node built-in, a storage feature, a model call, a sign-in or a change to its API.
4. **Keep files focused.** Put a new feature in its own component, hook or core module rather than growing `App.tsx` or another long file.
5. **Fix types; don't silence them.** No `any`, no `@ts-ignore`, and no `!` assertion just to quiet the compiler.
6. **Never swallow an error.** A failure the User can act on becomes a problem in plain words, where it happened (`DESIGN.md`, Problems). Log the rest with enough context to find it.
7. **Data changes are migrations** (`src/core/storage/migrations.ts`).
   - Take the next free number after the highest on `main`, and check it again after merging `main`.
   - Never edit a migration that has shipped.
   - Keep tables ready to sync: random UUID ids, ISO 8601 UTC timestamps, and soft deletes with `deleted_at`.
8. **Add few dependencies.** A new one must be open source under a permissive licence, maintained and small, and the pull request says why it's needed. The named exceptions, each shipped unmodified with its licence texts: Pyodide (MPL-2.0, ADR-0023), and python-build-standalone (MPL-2.0) with the libraries its wheels bundle, as ADR-0025 lists them. No LangChain (ADR-0005). The lockfile changes only through `npm install`.
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
13. **Read your own diff before you open the pull request,** as a reviewer would, against the issue's acceptance criteria and these rules.

## Tests and CI

Work is done when its pull request's CI is green, not when one test passes on your computer. Read [`docs/agents/testing.md`](docs/agents/testing.md) before you write or change a test: what CI runs, tests that pass on any machine, the edge cases to try, real engines, and trying an AI feature by hand.

- On your computer, run `npm run typecheck`, `npm run lint` and the unit tests of the files you changed; CI runs the rest.
- Test through the core's public interface, as the UI uses it, and assert what a User would see. Tests need no API keys and no network.
- Automated tests use the scripted chat model. A change to AI behaviour (a prompt, a tool description, a model choice) is proven on a real model, Claude Haiku 5.5 (Sonnet 5.5 for a hard feature), and its pull request gives the numbers and the models. Where the change moves no check's verdict, one small run is enough: a dozen or so runs of everyday requests.

## UI

- Read `DESIGN.md` before visual work: the fonts, colours, spacing and direction. Ask before departing from it, and flag code that doesn't match it.
- Read [`docs/agents/interaction.md`](docs/agents/interaction.md) before building or changing any UI. The bar: easy to use and easy to pick up, not fewer features, built to the interactive prototype's behaviour.

## Commits and pull requests

- Sign off every commit (`git commit -s`); see [`CONTRIBUTING.md`](CONTRIBUTING.md).
- One pull request per feature, built whole: push when it is finished and fully tested, and open it ready, so CI starts at once. A part that is decided and finished ships at once as its own pull request, and so does a fix for a broken `main`.
- Say what the User gets and why, in about ten lines. List each issue's acceptance criteria with ticks: "Closes #123" only when all are met, otherwise "Part of #123" with a line "What is left".
- A bug you find in the screen or flow you are building is fixed in that pull request and named in its description. File an issue only when it belongs to another screen or flow, or needs something the pull request doesn't have: a paid model run, a migration, a decision or a second reader.
- Merge your own pull request when its sign-off check and CI are green (`gh pr checks <number> --watch --interval 300`), or each red check is a known flaky spec named with its issue, and you have read your own diff (rule 13).
- One other person reads a change to the User's data, privacy or consent, a check's verdict or a Citation, AI behaviour, the sandbox, CI's checks, a migration or a dependency, once and in one round. Only a wrong mark, lost data or something sent without consent blocks it. Nothing else waits for a reader, and of the automated reviewer's comments only Major and Critical ones need a reply.
