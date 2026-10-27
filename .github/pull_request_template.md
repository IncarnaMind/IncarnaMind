## What and why

<!-- What this changes, and why. Link the issue: "Closes #123". -->

## How it was tested

<!-- Commands run, and what you checked by hand in the built app. -->

- [ ] `npm run typecheck`, `npm run lint` and the unit tests of the files I changed pass
- [ ] Tests for changed or removed UI are updated; a smoke spec was run locally only where I needed to see the UI I changed (CI runs every spec)
- [ ] The edge cases in [the testing guide](https://github.com/IncarnaMind/IncarnaMind/blob/main/docs/agents/testing.md#edge-cases) that apply were tried: <!-- list them, and which don't apply -->
- [ ] CI is green on this pull request: <!-- link the run -->

## If this changes UI

Delete this section if the change has no UI. Otherwise check each line against [the interaction rules](https://github.com/IncarnaMind/IncarnaMind/blob/main/docs/agents/interaction.md):

- [ ] Each gesture follows a named app's convention (Claude, ChatGPT, Cursor, VS Code, Finder, Notion, Granola, or a Chinese app), or this says why none fits
- [ ] Names shown rename in place (double-click or F2; Enter saves, Esc cancels; safe with a Chinese input method); Enter on a focused item opens it
- [ ] Every drag has a menu and a keyboard way to do the same thing; targets highlight only while they accept
- [ ] Nothing replaces the Note the User is in; no "Back to…" label
- [ ] Reversible actions offer Undo (⌘Z and the undo line) instead of a confirmation; deleting goes to Recently deleted
- [ ] Objects have the shared right-click and ⋯ menu, in the shared order
- [ ] Selection works as everywhere: click opens, ⌘/Ctrl-click and Shift-click select, ⌘A, Esc
- [ ] Every action works by keyboard and is in ⌘K; focus is visible; Esc closes the innermost thing
- [ ] Responds within 100 ms; anything over a second shows progress where it happens
- [ ] One primary action and one visible way to do it; no new setting without a reason given here
- [ ] Problems show in place as one line with one action; words from `CONTEXT.md`, in English and Chinese
- [ ] Layout holds at a narrow and a wide window, with and without the viewer; text never breaks by letter
- [ ] Uses the shared building blocks where they exist, and no one-off where they don't
- [ ] Adds nothing to first run or onboarding; a tip, if any, appears once at the moment it helps and goes away for good
- [ ] Tested like a person in the built app, with the mouse and the keyboard
- [ ] Before and after screenshots attached (narrow and wide)
- [ ] A short recording of the flow in the built app beside the same flow in the prototype, with the mouse and the keyboard, with every difference in behaviour or looks listed and explained

## Sign-off

Each commit carries a `Signed-off-by:` line (`git commit -s`). See [CONTRIBUTING.md](https://github.com/IncarnaMind/IncarnaMind/blob/main/CONTRIBUTING.md).
