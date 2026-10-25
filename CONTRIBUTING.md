# Contributing to IncarnaMind

Thank you for helping. Code, testing with your own documents, translations and ideas are all welcome.

## Issues and questions

- Found a bug, or want a feature? [Open an issue](https://github.com/IncarnaMind/IncarnaMind/issues/new/choose). For a bug, say what you did, what you expected and what happened, and your operating system.
- Questions and ideas: [Discussions](https://github.com/IncarnaMind/IncarnaMind/discussions).
- Looking for something to work on? Issues labelled [good first issue](https://github.com/IncarnaMind/IncarnaMind/labels/good%20first%20issue) are a good start. Say in the issue that you're taking it.

## Labels

New issues are triaged with five labels:

| Label | Meaning |
| --- | --- |
| `needs-triage` | The maintainer needs to evaluate it |
| `needs-info` | Waiting on the reporter for more information |
| `ready-to-build` | Fully specified, so anyone can pick it up without further questions |
| `needs-owner` | Needs the owner or another person: an account, signing, a decision or hand-checked data |
| `wontfix` | Won't be actioned |

Every triaged issue also has a priority label, `priority:P0` (do first) to `priority:P3` (after the alpha); [`triage-labels.md`](docs/agents/triage-labels.md) says what each means. Anyone is welcome to take an issue labelled `ready-to-build`. A `needs-owner` issue needs an account, a decision or hand-checked data, so ask on it first. [`AGENTS.md`](AGENTS.md) holds the rules for working on the code, for people and coding agents alike, and `docs/agents/` holds the detail: the issue tracker and its `gh` commands ([`issue-tracker.md`](docs/agents/issue-tracker.md)), the labels ([`triage-labels.md`](docs/agents/triage-labels.md)), how to use the domain docs ([`domain.md`](docs/agents/domain.md)), the rules every UI change follows ([`interaction.md`](docs/agents/interaction.md)), and how to test so CI passes ([`testing.md`](docs/agents/testing.md)).

## Setting up

You need Node.js 24 or newer. Clone the repository, then run `npm install` and `npm run dev`. [docs/development.md](docs/development.md) covers the scripts, the tests, the evaluation and how the code fits together.

## When you change code

- Changing UI? Follow the [interaction rules](docs/agents/interaction.md): easy to use and easy to pick up is the bar. The pull request template has a checklist for it.
- Use the words defined in [`CONTEXT.md`](CONTEXT.md) (a Passage, not a chunk; a Connector, not a plugin), and say so when a change goes against an ADR in [`docs/adr/`](docs/adr/).
- Test through the core's public interface, as the UI uses it, and assert what a User would see. The core tests need no API keys and no network.
- Keep `src/core` free of Electron imports; Biome enforces it.
- Run `npm run typecheck`, `npm run lint`, `npm test` and the smoke tests your change touches before opening a pull request. CI runs all of them on every pull request as feedback, and the whole suite runs on `main` every night. A pull request merges once its sign-off check passes; merge `main` into your branch to resolve a conflict or to pick up something you need. The [tests and CI rules](docs/agents/testing.md) say how to write tests that pass on any machine.
- The interface is in English and Simplified Chinese: a new string goes into both dictionaries in `src/shared/i18n/`.
- Keep each pull request to one feature or theme, built whole rather than split into small pull requests, and say what it changes and why.

## Licence and sign-off

By contributing, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), like the rest of the project.

Each commit in a pull request carries a sign-off line, which says you wrote the change or have the right to submit it under this licence, as the [Developer Certificate of Origin](https://developercertificate.org/) describes. Add it with `git commit -s`; it looks like this:

```
Signed-off-by: Your Name <you@example.com>
```

Commits carry your own name and sign-off, so the author line and the `Signed-off-by:` line name you. To add it to commits you've already made, run `git rebase --signoff main` and push again. A check on every pull request looks for it. There's no contributor licence agreement to sign.
