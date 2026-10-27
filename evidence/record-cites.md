# #1709 record-cite checks: root constraint and cases

## Root design constraint

Resolve every supported record cite to one explicit Document and exact Location, check only that Location, return `choose` with candidate Document ids when it is ambiguous and `not-found` when none matches, and never let a filename, first match, or whole-Document search invent certainty.

## State × input cases

| State | Input | Required result |
|---|---|---|
| Deposition page and lines | `Smith Dep. 45:3–12`, `Dep. Tr. 45:3-12` | Resolve the deponent and map exactly page 45 lines 3–12, including an en dash or hyphen. |
| Exhibit and page | `Ex. 7 at 3`, `Pl.'s Ex. 7, p. 3` | Resolve exhibit 7 and check only its page 3. |
| Docket entry and page | `ECF No. 41 at 5`, `Dkt. 41 at 5` | Resolve docket entry 41 and check only page 5. |
| Recording time | A transcript time in the supported existing shape | Keep the existing exact transcript-Time Citation behavior; do not confuse it with a printed page. |
| Bates identifier | `PL-000123` | Resolve the Document and page carrying that exact identifier. |
| Bates range | `DEF 0045–0049` | Check the ordered exact pages 0045–0049, never an unrelated page containing similar digits. |
| Paragraph cite | `Compl. ¶ 14` | Resolve the complaint and check paragraph 14 only. |
| Paragraph range | `Smith Decl. ¶¶ 3–5` | Resolve the declaration and check paragraphs 3–5 in order. |
| `Id.` | After a valid record cite | Reuse that cite's Document and Location, with no new source choice. |
| `Id. at 7` | After a valid record cite | Reuse that cite's Document, replace only its page/line Location with 7, and check there. |
| `supra` | After a valid record item | Reuse the earlier item's Document and Location; if the referent is missing or ambiguous, say Not found. |
| No earlier referent | `Id.` or `supra` before any resolvable cite | Say Not found; never guess from the Library. |
| Page break | A quote or range spanning two numbered transcript pages | Preserve both pages and their exact line bounds; do not merge in text from a third page. |
| Digital transcript | Numbered pages and lines in source text | Build the page/line map from the transcript's own numbering, not from the viewer's pagination. |
| Scanned transcript | Numbered pages and lines in the scan layout/OCR order | Map the same source numbers without depending on PDF text-run order alone; a page break stays exact. |
| Exact match | The named Location supports the sentence | Supported, with the passage and exact Location in the result. |
| Partial match | Only part of the sentence is supported | Partly, with the uncovered part and the exact passage read. |
| No match | The named Location does not contain or support the sentence | Not found, with the named Location and no whole-Document rescue. |
| Better evidence nearby | Adjacent lines support the point instead | Offer the nearby passage and its Location, clearly as a suggestion rather than changing the cited result. |
| One possible Document | The source identity resolves to exactly one live Document | Use it without a question. |
| Two possible Documents | Name, exhibit, docket or Bates could refer to either | Return `choose` with both Document ids; the card asks once, stores the choice in `content.editSettings`, and only that cite is re-checked and remembered for this Mind and later `Id.`/`supra`. Background and no-Note checks return the same state. |
| Source choice changed | The User chooses the other candidate | Replace the remembered choice for this Mind and re-check only that cite against the new source; no global preference is created. |
| Deleted or unreadable source | The chosen Document is gone or its text cannot be read | Say Not found with why; never silently select another Document. |
| Citation recheck | A stored cite is checked again later | Read its saved Document and saved Location only; no relocation by a new whole-Document search. |
| Fixture coverage | Ten record cites of every accepted shape | Each resolves to its intended Document and exact lines/page; every miss is listed individually. |
| Public court records | The #1612-compatible public evaluation set with its key | Save sources and expected outcomes; report every miss and do not make an accuracy claim from fixtures. |
| Unsupported input | Malformed, out-of-range or unlocated cite | Say Not found in the same vocabulary, never crash or widen to an arbitrary match. |
| Interface strings | Every new User-facing result and source-choice label | English and Simplified Chinese, using the existing result vocabulary; Chinese court-cite syntax itself is a later extension. |
| Word result | A checked imported `.docx` with record cites | Each result comment carries the supporting passage and Document/page; the Check record lists every cite, and the file opens without repair. |
| Real models | The full detection, source-choice and nearby-evidence flows | Use the scripted model for CI and the required real models for manual evidence, with EN/ZH, time and spend recorded. |
