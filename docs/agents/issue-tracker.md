# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Filing an issue

One issue per theme, not one per finding. A theme is one screen, one flow or one part of the product the User sees.

- **Before filing,** search the open issues for the theme (`gh issue list --state open --search "<words> in:title"`). If one fits and has the same priority tier and difficulty, add the finding to it as a checklist line with its criteria, and say so in a comment, instead of opening a new issue.
- **A new issue** that covers several findings has a line on the theme, then a checklist with one line per part, each with its acceptance criteria, then the criteria that hold for all of them (Undo, keyboard and ⌘K, English and Chinese, real-model numbers for AI behaviour).
- **Split** only when parts differ in who would build them (their difficulty), in priority tier, or in risk class (secrets, privacy and consent, legal, the User's stored data, which need their own reviewer), or when a part is a different screen or flow. Size and file count are never reasons: one feature is one issue and one pull request. Then a tracker issue lists the parts.
- **P0 and a lone P1** are filed on their own the day they are found, so nothing waits for a theme to fill.
- Issues filed before this rule follow it too: an open issue that shares its theme, tier, difficulty and risk class with another is folded into that one as a part (its criteria kept under "### Part … (was #N)") and closed with a pointer. Issues with an open pull request are folded only after it merges.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Work items

A work item is an issue that lists small issues one agent should do together, so the agent reads the context once and opens one pull request.

- **Title and labels:** "Work item: <theme>" with `work-item`, the group's `priority:` label and the highest `complexity:` of its members (`complexity:simple` or `complexity:medium`). Members keep their own labels. All members share one priority tier, and no member is hard.
- **Body:** a line on the theme and the files or screens it touches, then a checklist with one link per member: `- [ ] #1350 Library: ⌘A also highlights the page's text`.
- **Taking it:** claim the work item, read each member once, and build them in one branch and one pull request that closes the work item and every member ("Closes #1350, closes #1354"). Use `Closes`, not `Part of`, for a member that is done.
- **Dropping a member:** one that turns out hard, blocked or undecided comes off the list with a comment saying why, and stays open on its own.
- **P0 and P1 never wait for a batch to fill:** a stray P1 starts the day it is ready, with or without a work item.
- **Members stay separate issues** once filed (people report them and search finds them); new findings follow Filing an issue above. An issue belongs to one work item, and work items don't nest. A wayfinding map is for exploring; a work item is for building.
- **Standing work items** collect the recurring kinds (flaky specs and CI, feel-check findings, wrong names and wording): a finding that isn't P0, P1 or hard adds a line there instead of opening its own issue and pull request.
- **When a pull request that says "Part of" merges,** close the issue or tick its line within a day, so finished issues don't stay open.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
