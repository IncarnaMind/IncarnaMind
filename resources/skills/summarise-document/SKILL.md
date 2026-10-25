---
name: summarise-document
description: Writes a structured summary of one Document, or of each Document in the Question's Search scope, with sections that suit the kind of Document (a paper's claims, method and limitations; an agreement's parties, term and obligations) and each point with a Citation. Use when the User asks to summarise, digest or give an overview of a paper, report, contract or other Document.
license: Apache-2.0
metadata:
  author: IncarnaMind
---

# Summarise a Document

Write a structured summary of a Document the User added, drawn only from what its Passages say.

## Which Documents

- If the Question names a Document, or its Search scope holds a single Document, summarise that one.
- If the Search scope holds several Documents and the Question doesn't pick one, summarise each in turn, each in the structure for its kind but shorter, then add a short paragraph on how they relate.
- If you can't tell which Document is meant, summarise the one the Passages point to and say which one you chose.

## Gather the material first

Search the Documents before writing anything (search_documents searches only the Documents in the Question's Search scope):

- Make several focused searches rather than one broad one: the Document's main subject and kind, its aims or purpose, then the parts that kind of Document turns on (a paper's methods or data, findings, limitations and conclusions; an agreement's parties, term, pay, duties and notice). Run several at once where you can.
- After the first results, search again with the Document's own terms, and with its name if several Documents are in scope.
- If you were given Passages instead of a search Tool, work from those.

## Write the summary

Where it goes: if the User asked for a page, a note or a section, and you have the Minds' Tools (create_mind, add_to_mind), write the summary there (create_mind for a new page, add_to_mind for the Mind they are in) and keep your reply to a sentence or two. Otherwise write it in your reply.

Write it in the language the Question is written in, even when the Document is in another language. Translate the headings below into that language too.

Start with a heading naming the Document, then one or two sentences on what it is (a paper, an agreement, a report, minutes, …), its subject, and its main point. Then the sections that fit its kind, each under its own heading:

**A research paper** gets these sections:

1. **Key claims**: three to seven bullet points, each one claim or finding of the Document, in your own words, each with a Citation. Keep the numbers, conditions and qualifications the Document gives.
2. **Methods or approach**: how the Document reaches its claims: its data, experiments, sources, analysis or line of argument.
3. **Limitations**: the limitations the Document states itself, with Citations. Limitations you notice yourself go after them, clearly labelled as your own assessment and without a Citation.
4. **Open questions**, only if the Document names future work, with Citations.

**A contract or agreement** gets **Parties**, **Term**, and then what the text sets out, such as **Obligations**, **Pay**, **Time off**, **Place of work**, **Notice and termination** and **Other terms**. Give the amounts, periods and conditions as written, each with a Citation.

**A report, minutes or an article** gets the sections its own structure suggests, such as Findings, Decisions, Actions, Figures or Recommendations. **Any other Document** gets the headings its own structure suggests.

Never give a Document the sections of another kind: a contract has no Methods or Limitations, and a paper has no Parties. A section the Passages found don't cover is left out whole: no heading, and no line saying it is missing or not stated.

Keep it short: a summary, not a rewrite. Bullet points are fine; don't use tables.

## Citations and honesty

- Cite every statement you take from a Document, the way your instructions for citing say: markers that point to the Passages you found. Don't write a list of sources or a bibliography, and never cite a Passage for something it doesn't say.
- If you were told not to write citation markers, name the Document in the sentence instead.
- Don't add details the Passages don't give: no names, numbers, dates or sample sizes from memory.
- If a search for something the kind of Document turns on (an agreement's term, a paper's method) finds nothing, search again with the Document's own words before you leave that section out; never guess it. If the Documents don't support what the Question assumes, say so plainly.
- Report the Document's views as the Document's. Keep your own views out, apart from the labelled assessment of a paper's limitations.
