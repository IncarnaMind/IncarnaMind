# How the check works

**English** · [简体中文](how-the-check-works.zh-CN.md)

IncarnaMind checks in two ways. A Citation's quote is checked on this computer, word for word, against the text of the Document where the Citation points: no model is involved. A sentence's claim is checked by a model: the decision model your checks use reads it first, and where that leaves it undecided, the AI model you chose searches your Documents and quotes the Passage that decides it, where one does. A result shows as a Mark beside the sentence, or on the Citation's card.

## A Citation's quote

`Quote found on p. 68` means the quoted words are in the text at that place. `Quote not found on p. 68` means they are not. This tests the words and their place, not whether the claim is true. Three other results:

- `Can’t check`: the Citation's Document is gone from IncarnaMind, or the cited place has no text it can read.
- `Picture, not checked`: the Citation points at a picture.
- `Check the page`: the text recognition may have misread a word the quote covers. You compare the quote with the page.

When a sentence with a Citation puts words in quotation marks, those words are checked too: a span of at least 4 words, or 6 characters in Chinese or Japanese, must be in the text at the places the sentence cites. The name of a Document the sentence cites, or a part of it, in quotation marks is a name, not a quote: the card says `This is the Document’s name, not a quote from its pages`.

## A sentence's claim

The model reads the sentence whole, in its paragraph and under the heading above it, with the Passages its own Citations quote. It gives the verdict; nothing in IncarnaMind changes it. IncarnaMind confirms one thing itself: that the quote a `Supported` or `Needs a look · Contradicted` result rests on is in its Document.

`Check against Documents`, `Check someone else’s file…`, and the Note's `Check` ask the model for one result:

- `Supported`: the checked Passages together establish what the sentence says, down to each figure, date, name and outcome, who does it and to whom, and must where it says must, may where it says may. It means your Documents state it, not that it is true.
- `Needs a look · Unsupported`: no Passage states it either way. A near miss is unsupported, not contradicted: a Passage about another party, period or detail, one that states only part of the sentence, a forecast the Document does not say will happen, or two events stated without the causal link the sentence asserts. It is not a finding that the sentence is wrong.
- `Needs a look · Not found`: the sentence has no Citation and nothing in the check's search was about it, after one more search with other words. The card says where it looked: `I didn’t find this in “Leases”.` It is a fact about the search, never a finding that the sentence is wrong, and not the same as `Quote not found`.
- `Needs a look · Contradicted`: a Passage gives another value for the very thing the sentence states (the same subject and detail with a different figure, date, party, place or outcome, the parties the other way round, or may for must), so the Document and the sentence can't both be true. It says the two disagree, not which is right, and it is not the same as unsupported.
- `Not checked`: there is no result to show. The card says why: `The model declined to check it.`, `The model’s reply couldn’t be read.`, `Verdict hidden: the model’s quote isn’t in that Document.`, `The model didn’t reply within 180 seconds.`, a monthly cap, a plan's limit or the provider's credit stopped it, `Not checked: you turned off sending to this service.`, or `Not checked: everything stays on this computer.` A service that asks for fewer requests is waited out first: the sentence is sent again after 1, 2, 4, 8 and 16 seconds, and says `The model’s service is busy for now. Check again in a moment.` only if it is still busy then. A monthly cap or a plan's limit stops the whole check: nothing more is sent, and every sentence it hadn't checked yet says why.
- `Needs a look · Needs re-check`: the sentence, a Document it was checked against, its Folder or Search scope, or a record cite it refers back to changed since the check, so the result is no longer known to hold. The card says which change, as in `The sentence has changed since it was checked.`, and `Check again` runs it again.

When the model can't tell whether a sentence makes a claim, a sentence with a figure, a Citation, a record cite or a court decision is checked all the same. Any other is counted, as in `Couldn’t tell whether 1 sentence needs checking`, and the next Check asks about it again.

In a table, the model judges a cell with its row's label and its column's heading. A cell after its row's label, or the only filled cell of its row, that gives a figure is checked whatever the model said. A figure in a row's first cell, beside other filled cells, is read as part of the row's label: it is checked only when the model finds a claim in it, or says nothing of it.

A sentence is judged as one: it has one result, not one for each of its parts or numbers. A record cite inside a sentence has its own result, as in `Needs a look · Record cite`.

### A table or figure from an Analysis

- A table an Analysis made is never checked against your Documents: its cells are the Analysis's. The marker at the end of its caption opens how each column was worked out.
- A column is recalculated only when one sum, average, lowest value or highest value of one column, over the rows whose label its row names, reproduces every cell, as in `Amount: sum of 40 rows, by Region · recalculated`. A count, and any other column, reads as in `Share: from the Analysis · not recalculated`.
- A cell whose text is no longer the Analysis's needs a look, with the reason `Differs from the Analysis`.
- A sentence whose figure an Analysis gave, or IncarnaMind calculated, is not looked for in the text: the model is given that figure's own record, its label and how it was worked out, and judges whether the sentence says of the figure what its record says.
- A figure IncarnaMind couldn't work out again, such as a slope, shows `From the Analysis · not recalculated`, and no check can change that. A column that isn't recalculated is counted in the Note's line, as in `1 figure not recalculated`; the Note reads checked only when something else in it was backed.

## What the check never promises

- A found quote is not support: `“Quote found” means the words are there, not that they support the sentence.`
- The check reads only the Documents in its search, and only text it could read; it doesn't search a file it couldn't read.
- A file can't support itself. Checking a file leaves out the file, its earlier versions and any Document that holds 90% or more of its text, whatever its format: a resaved copy, a PDF of it, a bundle it is in. A card names each one that matched, as in `Also in “Services Agreement.pdf”, which holds nearly all of the checked document’s text: not counted`. A file under about 200 words, or 200 Chinese characters, is left out only as the same bytes. A Note imported from a file is treated as that file: the copies left out are those of the file as it was imported, which IncarnaMind keeps with the Note, whether or not the original is in the Library. If the kept file is missing or can't be read, only byte-for-byte copies are left out.
- It can miss a change of obligation: `Can miss a change of obligation, such as should for may`.
- A small model's verdicts can be wrong: `Small model: its verdicts may be wrong. A larger one is more reliable.`
- It doesn't check the law: `IncarnaMind can’t check that this case exists or says this. Check it in your legal research service before you rely on it.` A quote found in a court opinion also says it has not checked whether the case was overruled or changed.
- The Calculation check tests a Calculated figure's Inputs and formula, not whether the right numbers were used, and never says a figure is correct.
