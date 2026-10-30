# How the check works

**English** · [简体中文](how-the-check-works.zh-CN.md)

IncarnaMind checks in two ways. It checks each Citation's quote on this computer, word for word, against the text of the Document where the Citation points: no model is involved. It checks a sentence's claim with the AI model you chose, which searches your Documents and quotes the Passage that decides it where one does. A result shows as a Mark beside the sentence, or on the Citation's card.

## A Citation's quote

`Quote found on p. 68` means the quoted words are in the text at that place. `Quote not found on p. 68` means they are not. This is a test of the words and their place, not of whether the claim is true. A Citation whose Document is gone from IncarnaMind, or whose cited place has no text it can read, says `Can’t check`.

When a sentence with a Citation puts words in quotation marks, those words are checked too: a span of at least 4 words, or 6 characters in Chinese or Japanese, must be in the text at the places the sentence cites.

## A sentence's claim

`Check against Documents`, `Check someone else’s file…`, and the Note's `Check` ask the model for one result:

- `Supported`: the checked Passages, or the whole Documents read for an absence, together establish what the sentence says, down to each figure, date, name and outcome, who does it and to whom, and must where it says must, may where it says may. It means your Documents state it, not that it is true.
- `Needs a look · Unsupported`: no Passage states it either way. A near miss is unsupported, not contradicted: a Passage about another party, period or detail, one that states only part of the sentence, a forecast the Document does not say will happen, or two events stated without the causal link the sentence asserts. It is not a finding that the sentence is wrong.
- `Needs a look · Not found`: the sentence has no Citation and nothing in the check's search was about it, after one more search with other words. The card says where it looked: `I didn’t find this in “Leases”.` It is a fact about the search, never a finding that the sentence is wrong, and not the same as `Quote not found`.
- `Needs a look · Contradicted`: a Passage gives another value for the very thing the sentence states — the same subject and detail with a different figure, date, party, place or outcome, the parties the other way round, or may for must — so the Document and the sentence can't both be true. It says the two disagree, not which is right, and it is not the same as unsupported.
- `Not checked`: there is no result to show. The card says why: `The model declined to check it.`, `The model’s reply couldn’t be read.`, `Verdict hidden: the model’s quote isn’t in that Document.`, a monthly cap, a plan's limit or the provider's credit stopped it, `Not checked: you turned off sending to this service.`, or `Not checked: everything stays on this computer.`
- `Needs a look · Needs re-check`: the sentence, a Document it was checked against, its Folder or Search scope, or a record cite it refers back to changed since the check, so the result is no longer known to hold. The card says which change, as in `The sentence has changed since it was checked.`, and `Check again` runs it again.

One more count is separate from these: a sentence the model could not tell whether it makes a claim is not examined, and the Note counts it as in `1 sentence not examined`. The next Check asks about it again.

A check also leaves a sentence's opinions out of what it judges, and counts them, as in `1 opinion left out`; a record cite inside a sentence has its own result, as in `Needs a look · Record cite`.

## What the check never promises

- A found quote is not support: `“Quote found” means the words are there, not that they support the sentence.`
- Supported means your Documents state the sentence. The check reads only the Documents in its search, and only text it could read; it doesn't search a file it couldn't read.
- Unsupported and Not found are not findings that the sentence is wrong; Contradicted is not a verdict on which side is right.
- It can miss a change of obligation: `Can miss a change of obligation, such as should for may`.
- A small model's verdicts can be wrong: `Small model: its verdicts may be wrong. A larger one is more reliable.`
- It doesn't check the law: `IncarnaMind can’t check that this case exists or says this. Check it in your legal research service before you rely on it.` A quote found in a court opinion also says it has not checked whether the case was overruled or changed.
- The Calculation check tests a Calculated figure's Inputs and formula, not whether the right numbers were used, and never says a figure is correct.
