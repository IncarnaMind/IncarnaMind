# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues, through the `gh` CLI (`gh issue create`, `view <number> --comments`, `list`, `comment`, `edit --add-label`, `close`). `gh` finds the repo from the clone. The labels are in [`triage-labels.md`](triage-labels.md).

When a skill says "publish to the issue tracker", create a GitHub issue. When it says "fetch the relevant ticket", run `gh issue view <number> --comments`.

## Filing an issue

One issue per theme, not one per finding. A theme is one screen, one flow or one part of the product the User sees.

A bug found in the screen or flow you are building is fixed in that pull request and not filed: [`AGENTS.md`](../../AGENTS.md) › Commits and pull requests says when an issue is still right.

- **Before filing,** search the open issues for the theme (`gh issue list --state open --search "<words> in:title"`). If one fits, add the finding to it as a checklist line with its acceptance criteria, and say so in a comment, instead of opening a new issue.
- **A new issue** that covers several findings has a line on the theme, then a checklist with one line per part, each with its acceptance criteria.
- **P0 and a lone P1** are filed on their own the day they are found, so nothing waits for a theme to fill.

## Taking an issue

Two people or agents must never build the same issue. Check before you start, and claim the issue the moment you do.

- **Before starting,** look for anyone already on it: the issue's comments and linked pull requests (`gh issue view <n> --comments`), `gh pr list --search <n>`, and `git ls-remote origin '*<n>*'` for a branch named after it. If anything shows work under way, stop and ask who owns it.
- **The moment you start,** claim it: push your branch from `main` (`git push -u origin <branch>`) and post one line on the issue, "Being built on branch `<branch>`", with no names.
- **If you stop without a pull request,** say so on the issue and delete the branch, so the issue is free again.

## Work items

A work item is an issue that lists small issues one agent does together: read each member once, and build them in one branch and one pull request that closes the work item and every member ("Closes #1350, closes #1354").

- A member that turns out hard, blocked or undecided comes off the list with a comment saying why, and stays open on its own.
- The standing work items (flaky specs and CI, feel-check findings) collect small findings of their kind: add a line there instead of opening an issue.
