---
name: earnings-review
description: Reviews a quarter's results against the prior period and the guidance the company gave, with every figure cited. Use when the User asks for an earnings review, a quarter compared with the prior quarter or the year before, or whether a company met its guidance.
license: Apache-2.0
metadata:
  author: IncarnaMind
---

# Earnings review

Write an earnings review of one quarter: the figures, what they were the period before, and how they compare with the guidance the company gave.

## Which Documents

- The results announcement or statement for the quarter gives the figures and, often, the comparatives and the guidance.
- The prior period's results give the comparison: the previous quarter, the same quarter a year earlier, or both. Prefer the Document's own comparative columns when it gives them.
- The guidance may be in the same announcement, an earlier results statement or a trading update. Name the Document and the date it gave the guidance.
- If the Question names a company or a quarter, use it. If several are in scope, review each in turn, saying which.

## Gather the material first

Search the Documents before writing anything (search_documents searches only the Documents in the Question's Search scope):

- Search for the quarter's figures by measure: revenue, gross margin, operating profit, EBITDA, profit, cash, net debt, and each segment the Documents report.
- Search for the prior period's same measures, and for "guidance", "outlook", "expects" and "full year" in the earlier statements.
- Keep the periods apart: a quarter, a half year and a full year are different measures, and a year-to-date figure is not a quarter's figure.
- Make several searches at once where you can. If you were given Passages instead of a search Tool, work from those.

## Write the review

Where it goes: if the User asked for a page, a note or a section, and you have the note's Tools (create_mind, add_to_mind), write the review there (create_mind for a new page, add_to_mind for the note they are in) and keep your reply to a sentence or two. Otherwise write it in your reply. A request to write a note means the note holds the text: don't answer with the whole text in the panel.

Write it in the language the Question is written in, even when the Documents are in another language. Translate the headings below into that language too.

Start with a heading naming the company and the quarter, then a short summary of the quarter in two or three sentences. Then:

1. **The quarter**: the main figures, each with its period, unit and Citation.
2. **Against the prior period**: each figure beside the prior period's, with the change in amount and percent. Say "calculated from" and cite both figures when you calculate a change the Document doesn't give.
3. **Against guidance**: each measure the company guided, what it guided, what it delivered, and whether that is in line, above or below. Give a change to guidance, and the date it was given, where the Documents show one.
4. **What drove it**: the reasons the Documents give for the changes, as the Documents state them.
5. **What to watch**: the risks and next steps the Documents name, each cited.

Don't compare measures with different definitions without saying so. A figure the Documents don't give is left out, not estimated: say plainly that it isn't in the Documents.

## Citations and honesty

- Cite every figure and every statement you take from a Document, the way your instructions for citing say: markers that point to the Passages you found. Don't write a list of sources or a bibliography.
- Record a Citation from the Passage that holds the quoted words, copied word for word, and keep the quote to the words the item needs; one Citation for an item is enough, and don't repeat one you have already given.
- If the check does not find a Citation, don't keep it: search again for the Passage that holds the words, record that Passage, and drop the one that failed.
- Never cite a Passage for something it doesn't say, and never invent a figure, a period, a guidance or a driver.
- Give amounts, percents and periods as the Documents write them; keep a percent and a percentage point apart.
- If the Documents don't support what the Question assumes, say so plainly.
