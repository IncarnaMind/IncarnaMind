---
name: deposition-summary
description: Summarises a deposition by topic, with every point cited to the page and line of the transcript. Use when the User asks for a deposition summary, what a witness said on particular issues, or the testimony a deposition gives on a matter.
license: Apache-2.0
metadata:
  author: IncarnaMind
---

# Deposition summary

Summarise a deposition by topic, and cite every point to the page and line where the witness said it.

## Which Documents

- The deposition transcript is the source. Name the deponent, the date and the matter as the transcript gives them.
- If the Question names topics or issues, summarise the testimony on those. If it doesn't, find the topics the testimony turns on.
- If several transcripts are in scope, summarise each in turn, or the one the Question names, saying which.
- If the transcript is an excerpt, say which pages it covers.

## Gather the material first

Search the Documents before writing anything (search_documents searches only the Documents in the Question's Search scope):

- Search for each topic in the Question, and for the issues the matter turns on: the agreement or events in dispute, the key names and dates, the documents shown to the witness, admissions, and changes in the witness's account.
- Cover the whole transcript, not only the topics you first find: search its headings or page ranges, and its later pages (termination, damages, re-examination) as well as its beginning, so no topic the transcript covers is left out.
- Work through the transcript in order: after each search, record the Citations for the quotes you will use from that search's Passages before the next search, so each quote keeps the Passage it came from.
- Search for the witness's own words, including "I don't recall", "I don't know", objections and corrections, since an evasive answer is testimony too.
- Make several searches at once where you can. If you were given Passages instead of a search Tool, work from those.

## Write the summary

Where it goes: if the User asked for a page, a note or a section, and you have the note's Tools (create_mind, add_to_mind), write the summary there (create_mind for a new page, add_to_mind for the note they are in) and keep your reply to a sentence or two. Otherwise write it in your reply. A request to write a note means the note holds the text: don't answer with the whole text in the panel.

Write it in the language the Question is written in, even when the Documents are in another language. Translate the headings below into that language too.

Start with a heading naming the deponent, the date and the matter, then two or three sentences on who the witness is and what the testimony covers. Then one section per topic:

1. **The topic**: a heading that names it.
2. **The points**: what the witness said on it, in the witness's words where the exact words matter. Give each point the transcript's page and line as the transcript numbers them, in the language of the Question, in the form the Question uses: "p. 42, ll. 3–7" or "第 42 页第 3–7 行". The transcript's page need not be the page the Citation itself shows: the Citation only has to point at the Passage that holds the quoted words.
3. **Conflicts**: where the testimony conflicts with itself or with a Document shown to the witness, give both places with their page and line and cite both.

Keep the testimony as testimony: report what the witness said, not what it proves, and don't decide the issue. Never give a page or line the transcript doesn't show, and never paraphrase so as to change what was said. If the transcript doesn't cover a topic the Question assumes, say so plainly.

## Citations and honesty

- Cite every point, the way your instructions for citing say: markers that point to the Passages you found. Don't write a list of sources or a bibliography.
- Record a Citation from the Passage that holds the quoted words, copied word for word, and keep the quote to the words the item needs; one Citation for an item is enough, and don't repeat one you have already given.
- If the check does not find a Citation, don't keep it: search again for the Passage that holds the words, record that Passage, and drop the one that failed.
- Never cite a Passage for something it doesn't say, and never invent testimony, a page, a line or a name.
- Give quotations and page and line numbers as the transcript writes them.
- If the Documents don't support what the Question assumes, say so plainly.
