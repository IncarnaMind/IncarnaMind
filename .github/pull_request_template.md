## What and why

<!-- What this changes, and why. Link the issue: "Closes #123". -->

## How it was tested

<!-- Commands run, and what you checked by hand in the built app. -->

- [ ] `npm run typecheck`, `npm run lint` and the unit tests of the files I changed pass
- [ ] Tests for changed or removed UI are updated; a smoke spec was run locally only where I needed to see the UI I changed (CI runs the specs this pull request changes; every spec runs nightly)
- [ ] The edge cases in [the testing guide](https://github.com/IncarnaMind/IncarnaMind/blob/main/docs/agents/testing.md#edge-cases) that apply were tried: <!-- list them, and which don't apply -->
- [ ] CI is green on this pull request: <!-- link the run -->

## If this changes UI

Delete this section if the change has no UI. It follows [the interaction rules](https://github.com/IncarnaMind/IncarnaMind/blob/main/docs/agents/interaction.md); name any it breaks, and why.

- [ ] Tested like a person in the built app, with the mouse and the keyboard
- [ ] Before and after screenshots attached (narrow and wide)
- [ ] When behaviour changed: a short recording of the built flow, and where it differs from the prototype, why

## Sign-off

Each commit carries a `Signed-off-by:` line (`git commit -s`). See [CONTRIBUTING.md](https://github.com/IncarnaMind/IncarnaMind/blob/main/CONTRIBUTING.md).
