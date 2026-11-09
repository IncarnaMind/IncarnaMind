# Repeated checks on main of the sentences the 2026-11-04 relabel added or changed

Commit c4ff0f379 with the check of `main` (e2dda3770) in place of the stacked one. Claude Haiku 5.5, 3 checks, spent $0.06; Claude Sonnet 5.5, 1 check, spent $0.20. The sentences the relabel left as they were keep their checks in `repeats-main-haiku.md` and `repeats-main-sonnet.md`, scored under the new labels.

## Claude Haiku 5.5

| Set | Sentence | Expected | Checks |
|---|---|---|---|
| en | own-words-kept | supported | supported, supported, supported |
| en | staff-home | partly | partly, partly, partly |
| en-control | employees-home | partly | partly, partly, partly |
| en-control | named-kept | supported | supported, supported, supported |
| en-control | same-subject-kept | supported | supported, supported, supported |
| en-control | staff-home | partly | partly, partly, partly |
| en-licence-faithful | passive | supported | supported, supported, supported |
| zh | own-words-kept | supported | supported, supported, supported |
| zh | staff-home | partly | partly, partly, partly |
| zh-control | employees-home | partly | partly, differs, partly |
| zh-control | named-kept | supported | supported, supported, supported |
| zh-control | same-subject-kept | supported | supported, not-checked, supported |
| zh-control | staff-home | partly | partly, partly, partly |

## Claude Sonnet 5.5

| Set | Sentence | Expected | Checks |
|---|---|---|---|
| en | own-words-kept | supported | supported |
| en | staff-home | partly | partly |
| en-control | employees-home | partly | partly |
| en-control | named-kept | supported | supported |
| en-control | same-subject-kept | supported | supported |
| en-control | staff-home | partly | partly |
| en-licence-faithful | passive | supported | supported |
| zh | own-words-kept | supported | supported |
| zh | staff-home | partly | partly |
| zh-control | employees-home | partly | partly |
| zh-control | named-kept | supported | supported |
| zh-control | same-subject-kept | supported | supported |
| zh-control | staff-home | partly | partly |
