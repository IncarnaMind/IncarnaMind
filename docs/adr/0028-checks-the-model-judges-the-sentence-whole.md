# Checks: a model judges the sentence whole, and code only confirms the quote

A check of a sentence had grown into layers of code between the model's verdict and the Mark: the sentence was sorted into parts and each part checked apart; each number was taken out and checked as a figure of its own, with rules for units, scales and signs; a sentence that says something is absent went down a path of its own with a whole read; a sentence about the Library or a file's properties had rules of its own; and guards read extra lines of the reply (roles, duty, condition, scope, time) and lowered a verdict they disagreed with. Each layer was added for a real miss, and each made new ones. A sentence with a right Citation, "58.com — Senior Design Manager (Apr 2016–Jul 2025).", read Unsupported because 58 was checked alone as a figure (#3081). A User couldn't predict the check, and a fix in one layer moved the fault to the next.

## Decision

A check is one judgement of the whole sentence by a model, and nothing in code changes its verdict.

- **The sentence goes to a model whole**, in its paragraph and under the heading above it, with the Passages its own Citations quote. A table cell goes with its row and column headings, and a chart as its title, series and values.
- **A decision model reads it first**, where the User's checks use one. A sentence it leaves undecided goes to the User's AI model, which may search the Documents for more, records each quote that decides the sentence with `cite`, and gives one verdict: supported, contradicted or unsupported. The step that judges is sent to that model asked to think.
- **Code confirms one thing**: a Supported or Contradicted verdict rests on a quote that its Document holds, by the Citation check. A verdict with no such quote is Not checked, never a ✓.
- **No rule in code overturns the verdict.** The check may ask the model once more for something its reply lacks (a search before a verdict, a second search before "unsupported", the quote it rests on). It never reads the sentence's numbers, units, parties or conditions itself.
- **What a model needs to judge well is said in its instructions**, in words: that a number inside a name is part of the name, that an amount is its number with its unit and scale, that a word for a direction is part of the claim.

Removed with this decision: parts of a sentence and their separate checks; figure-by-figure verdicts and the unit, scale and calculation gates of a check; the absence path and "Check against a Document…"; the Library's facts and file properties as a check's evidence; the reply's guard lines and the looks that followed a verdict; "Rewrite with what the Documents say". Marks made before keep their parts and figures and still show.

## What this changes in earlier decisions

- **ADR-0021** stands for Answers: a figure an Answer works out is calculated by a program. A check no longer offers `calculate` or refuses a sentence whose number needs working out: the model judges whether the Passages' numbers give the sentence's, and says so in its verdict. A figure IncarnaMind worked out itself (a saved calculation, an Analysis's figure) is told to the check's model with its label and rule, as context.
- **ADR-0022**: the checks flow sends less. It no longer sends the Library's counts and names, file properties or whole Documents, and the separate "document-check" flow is gone.

## Considered options

- **Keep the layers and mend each fault.** Rejected: five days and 118 commits of that gave a check of 27,800 lines that still marked a rightly cited sentence Unsupported.
- **Keep code rules as a floor under the model** (a number the quote doesn't hold lowers a ✓). Rejected: a rule that reads a sentence is right about most sentences and wrong about the rest in ways no User can see, and the model already reads the sentence. Where a model misses a kind of detail, its instructions are changed and the change is measured on a real model.

## Consequences

- Measured on Claude Haiku 5.5 over 274 sentences in English and Chinese, each a right sentence or its wrong twin, one round against `main`: right sentences Supported 132 of 132 (`main` 106), wrong sentences Supported 1 of 142 (`main` 3, that one among them), in 940 requests (`main` 1,626).
- A wrong ✓ can now only be the model's own misreading. The sets of right sentences and their wrong twins (`tests/live/exampleSentences.live.test.ts`) are run against `main` before a change to the check's instructions or model lands.
- A sentence that says something is absent, or states a fact about the Library itself, is judged from the Passages a search finds, and reads Unsupported where they don't say it.
