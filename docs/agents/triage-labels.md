# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Role in mattpocock/skills  | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-to-build`     | Fully specified and ready to be built    |
| `ready-for-human`          | `needs-owner`        | Needs the owner or another person        |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Priority

Once an issue is triaged, it carries one priority label, which says what to take first. The labels above say what state it is in.

| Label         | Meaning                                                                                                                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `priority:P0` | Stops a tester or breaks trust now: a wrong result shown as right, a broken privacy promise, data loss, a crash or white window, cannot install or open. Done first; whoever is working drops other work for it.                         |
| `priority:P1` | What a first tester needs for the core job and a good first impression: install, first run to a checked Answer, the check and its trust, the Word path, privacy honesty, speed of the main flows. Taken after P0 and before anything P2. |
| `priority:P2` | Needed for the public alpha but not for the first testers. After P1; most issues are here.                                                                                                                                               |
| `priority:P3` | After the alpha, or nice to have. Taken only when there is nothing above it to do.                                                                                                                                                       |

- Take the highest priority you can do, then the order the issues are listed in within it. Work in progress finishes first.
- A new issue gets a priority when it is triaged, within a day. The default is P2; P0 only if it stops a tester.
- A priority moves when evidence moves it, with a line on the issue saying what changed.

## Complexity

A triaged issue also carries one complexity label, graded from what the work involves (the code it changes, the risks, what is still unknown), not from its title.

| Label               | Meaning                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `complexity:simple` | About 150 changed lines or fewer, one area, the cause and the fix are clear, and it changes no AI behaviour, data, privacy, file format, start-up or quit. A unit test or one e2e spec covers it.                          |
| `complexity:medium` | One pull request with a clear approach, across a few areas; it may carry one contained risk, such as a migration, consent wiring, a small reader or writer change, or a hand check with a real model. |
| `complexity:hard`   | Changes AI behaviour judged by real-model numbers, needs a new module or a design across several areas, touches start-up, quit, updates or concurrency, file-format fidelity or speed on large data, or its cause or design is still open. |

- When in doubt between two, take the higher one and say why on the issue.
- An epic is graded by its next slice.
