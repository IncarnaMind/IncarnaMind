# The Word corpus

Issue #84, for the Word work in #74: the files that #104 (import) and #105 (export back into the original) are checked against, from simple memos to 125-page agreements, in ten languages, with the Word features a round-trip has to keep.

- **Core set, committed (92 files, 1.7 MB):**
  - `documents/`: 32 realistic documents, in English and Chinese, two of them résumés laid out with tables, shading and tab stops (#735).
  - `tracked-changes/`: 20 files with someone else's tracked changes.
  - `breadth/`: 36 files for more domains, languages and complexity: 14 synthetic domain documents, 4 Chinese and Taiwanese official documents, 18 real test documents.
  - `saved/`: files re-saved by hand in Word for Mac and Google Docs (2 each); the 2 WPS ones are the step left, see [`TO-SAVE.md`](TO-SAVE.md).
- **Extended set, not committed (148 files, 2.8 MB when fetched):** listed in [`extended.json`](extended.json) and [`EXTENDED.md`](EXTENDED.md) with a commit-pinned URL, SHA-256, licence and features each; `npm run eval:word:fetch` puts them in a cache. 127 are real test documents; 21 are synthetic documents generated on the same run.
- **Together:** 240 files. The coverage table below says what is where.

Domains: legal (contracts, a court filing, policies), finance (annual reports, a prospectus, an audit letter), medical and pharma (protocols, SOPs), academic (papers with equations, a thesis), government (notices, regulations, forms), engineering (specifications and standards with numbered requirements), HR, education, and general business memos. Languages: English, Simplified and Traditional Chinese, Japanese, Korean, German, French, Spanish, Arabic (right-to-left), Hebrew (right-to-left) and files that mix languages.

## Where the files come from

| Origin | Licence | Notes |
|---|---|---|
| `synthetic` | Apache-2.0 (written for this repository) | Invented text and names, written by [`generate-synthetic.py`](generate-synthetic.py) (18 contracts, memos and reports, and 2 résumés) and [`generate-domains.py`](generate-domains.py) (domain documents; standard library only, same script gives the same bytes), with [`ooxml.py`](ooxml.py) writing the packages and [`domain_text.py`](domain_text.py) holding the text. Equations, charts, text boxes, shapes, comment threads, form fields and content controls are hand-written OOXML and have only been opened in LibreOffice, not Word. |
| `libreoffice` | MPL-2.0 | Test documents from [LibreOffice core](https://github.com/LibreOffice/core) (`sw/qa/extras/ooxmlexport/data`, `ooxmlimport/data`), pinned to commit `7094a2f2`. |
| `apache-poi` | Apache-2.0 | Test documents from [Apache POI](https://github.com/apache/poi) (`test-data/document`), pinned to `f3688f45`. |
| `apache-tika` | Apache-2.0 | Test documents from [Apache Tika](https://github.com/apache/tika). |
| `open-xml-sdk` | MIT | Test files from Microsoft's [Open-XML-SDK](https://github.com/dotnet/Open-XML-SDK). |
| `open-xml-powertools` | MIT | Test files from [Open-XML-PowerTools](https://github.com/OpenXmlDev/Open-XML-PowerTools). |
| `docx-js` | MIT | Layout-probe documents from [docx](https://github.com/dolanmiu/docx) (`scripts/layout-probes`), including a 150-page one and files saved from Word. |
| `docx-preview`, `mammoth`, `python-docx` | Apache-2.0, BSD-2-Clause, MIT | A few test files from [docxjs](https://github.com/VolodymyrBaydalka/docxjs), [mammoth.js](https://github.com/mwilliamson/mammoth.js) and [python-docx](https://github.com/python-openxml/python-docx), in the extended set. |
| `government` | Not copyrightable | Four official documents of Chinese and Taiwanese state organs. The basis for each is below. |
| `word-mac`, `google-docs` | Apache-2.0 | Re-saves of synthetic files by the application named (`saved/`): Word for Mac, and Google Docs (web) saved as a Google Doc then exported as .docx, both on 2026-10-12. |

Real files are byte for byte as published (`sha256` in [`manifest.json`](manifest.json) and `extended.json`), except the four official documents, which have their file properties cleaned (below).

**Licence caveats, for the owner.**
- The repositories above are licensed as the table says, but none of their test files carries a licence of its own. They were contributed with bug reports or written for tests, and fall under the repository's licence; that is the best statement available, not a per-file one. Some test files (Open-XML-SDK's and PowerTools' especially) may have been copied from elsewhere. MPL-2.0 is file-level copyleft, which is fine for fixtures that are copied unchanged and never linked into the app; each keeps its licence and this README keeps the attribution.
- No Pandoc test files (GPL) were used.
- Not used: Google, UK government (OGL v3) and EU (CC BY 4.0) documents. The EU's Official Journal texts on EUR-Lex are published as PDF and XHTML, not .docx, and EUR-Lex and gov.uk did not serve a scripted request for a Word file. Nothing was scraped without a licence. UK and EU documents can be added as `government` files with their licence and URL if someone finds a .docx.
- US federal government (public domain): the one candidate found, an NIH institute's study-manual template, was left out because its file properties name a contractor, and a contractor's work is not automatically in the public domain.

**Chinese and Taiwanese official documents** (`breadth/government/`), whose basis for reuse is that they are not copyrightable:
- `pbc-fujian-normative-documents.docx` (the People's Bank of China Fujian branch's list of normative documents), `nmpa-tcm-drafting-note.docx` and `nmpa-device-gcp-drafting-note.docx` (National Medical Products Administration drafting notes to draft rules): PRC Copyright Law Art. 5(1) puts laws and regulations, resolutions, decisions and orders of state organs, and other documents of a legislative, administrative or judicial nature, outside copyright. Each is an attachment to an official notice, published on the organ's own website (URL in the table).
- `moa-taiwan-draft-notice-sample.docx` (the Ministry of Agriculture's sample notice of a draft regulation): Taiwan's Copyright Act Art. 9(1) leaves the constitution, laws, regulations and official documents outside copyright.
- Their file properties named people and a company (the author and last editor, an e-mail address in one). Those fields were replaced with "redacted" or emptied, and nothing else was changed; `manifest.json` has the original file's SHA-256 (`originalSha256`) and says what was changed.
- Only Chinese-language *official* documents carry this basis. Chinese documents from the test repositories are under those repositories' licences.

**Why not 3GPP change requests.** The issue suggested them for the tracked-changes set. 3GPP's documents state "© 3GPP Organizational Partners (ARIB, ATIS, CCSA, ETSI, TSDSI, TTA, TTC). All rights reserved", and that no part may be reproduced except as authorised by written permission, in all media; [3gpp.org/about-us/legal-matters](https://www.3gpp.org/about-us/legal-matters) sends anyone who wants to reuse its material to its Copyright Form. There is no open licence, so committing them is not allowed here (3gpp.org also answered a scripted request with HTTP 403). Instead the tracked-changes set is public test documents with other authors' insertions, deletions, moves and formatting changes: 20 of the 45 with tracked changes among the 1,100 .docx files in the LibreOffice and POI test folders, picked for having no personal names in the authors. If 3GPP ever grants written permission, its change requests can be added as a set.

**Personal data.** The files carry no e-mail addresses (checked for every file, including the extended ones). The real files may carry handles or aliases of the people who wrote the test documents, in tracked changes and file properties (the last column of each table lists the change authors). Files whose authors or creators look like a full personal name were left out of both sets, the official documents' properties were cleaned, and the synthetic files name no real person. If someone asks for a file to go, remove it.

## What a feature count is

Per file, the tables count what a round-trip has to keep (`features.ts`): tracked changes (insertions, deletions, moves and formatting changes), comments and replies, footnotes and endnotes (not Word's separators), fields (and how many are TOC, cross-references and SEQ captions), bookmarks, header and footer parts, further sections and columns, tables (nested, with merged cells), list paragraphs, content controls, legacy form fields, images (and anchored ones that text wraps), equations (OMML), SmartArt, charts, text boxes and shapes, embedded objects, right-to-left paragraphs, a compatibility mode older than Word 2013's, and a length of about 100 pages or more (the file's own page count, or an estimate from its text). "Kinds" is how many of these the file has at least one of. `manifest.json` and `extended.json` hold the same counts, and `npm run eval:word` fails when a file no longer has them. A language of `n/a` is a file with little or no prose.

## Running it

```sh
npm run eval:word                          # the core set
npm run eval:word:fetch                    # fills the cache with the extended set
INCARNAMIND_WORD_SET=all npm run eval:word # both
```

For each file it runs these steps, and prints one line per file:

1. **package**: reads the file with the app's own ZIP and XML readers, and checks the things Word's repair prompt is about, since LibreOffice repairs silently and tells you nothing: every XML part is well-formed, every relationship points at a part that is there, every part has a content type, and the feature counts match the list.
2. **imports as a Mind** (#104, `imports.ts`): imports the file as the app does, and checks that every node is one the editor's schema takes and that nothing is dropped without a word: the text of every paragraph of the body, as the Document reader reads it, is kept in the Mind (its text, or what an atom kept as is shows or holds; another person's deleted or moved-away text struck), and the line says what became editable and what was kept as is, by count. A file of a kind #104 refuses on purpose (Strict Open XML, macros, a password) passes as refused. `npm test` runs the same check on the core set (`tests/core/wordCorpus.test.ts`).
3. **opens in LibreOffice**: converts the file to PDF with `soffice --headless`, using a profile in a temporary folder. If it writes a PDF, the file opened. "Opens" here means LibreOffice loads it; it is not a promise that Word does, which is why a person re-saves some files in Word and Google Docs.
4. **exports back** (#105, `exports.ts`): imports the file as a Mind and exports it back into itself. Unchanged, every entry of the export is the file's, byte for byte. After a scripted edit (a word changed in the first paragraph that has one, a paragraph with a Citation added after it), the edit is in the file and the Citation is a footnote; only the parts the edit needs are written (the document, footnotes, styles, relationships and content types); every other paragraph and table of the body, and everything before the body (the root's namespaces, `mc:Ignorable` among them), is byte for byte the file's; the package has none of the problems of step 1 the file didn't have; nothing is reported as lost; and the export imports again with the edit. `npm test` runs it on the core set, and also edits of every kind (a paragraph deleted and one moved, a word made bold, a link, a heading's level, a list item and a table row added, a new list and table) through `checkEdits`.
5. **export opens in LibreOffice**: step 3 on the edited export. With `INCARNAMIND_WORD_PDFS` set to a folder, the PDF LibreOffice makes of each is kept there, for a person to look at; CI keeps them as the `word-exports` artifact.
6. **exports for review** (#107, `checkReview`): the edits of every kind again, now as the User's tracked edits, with a word replaced by a change still waiting, a paragraph a change adds and one it removes, and an AI paragraph with a Citation whose quote wasn't found, exported with every review choice on. The package has none of the problems of step 1 the file didn't have; nothing is reported lost but an edit next to a field; every comment's range has its end, its mark and its comment; IncarnaMind's changes and comments are in the file; and the text Word shows with every change accepted (read as Word reads it) is the text the Mind has with every change accepted, paragraph by paragraph. `npm test` runs it on the core set.
7. **review export opens in LibreOffice**: step 3 on the review export, its PDF kept as `<file>-review.pdf`.
8. **resolves someone's changes** (#108, `checkTheirChanges`): of the tracked changes of someone else's that the file has, which import as changes to accept or reject, every third is accepted, the next rejected and the next left, and the file is exported with the User's edits tracked. No change is out of date as imported; the package has none of the problems of step 1 the file didn't have; nothing is reported lost; nothing is tracked as the User's or IncarnaMind's; the changes left import again with their kind, author, date and text; and the text Word shows with every change accepted is the Mind's with every change accepted. `npm test` runs it on the core set.
9. **that export opens in LibreOffice**: step 3 on it, its PDF kept as `<file>-resolved.pdf`.
10. **exports with the Citations in a list** (#1600, `checkListExport`): the scripted edit again, with the User's choice of a list at the end: the added Citation is `[1]` in its paragraph, its source is the list's one entry under the Bibliography's heading, no footnote is added, and the package passes step 1's checks.
11. **list export opens in LibreOffice**: step 3 on it, its PDF kept as `<file>-list.pdf`.

After the files, a fixture made for it (headings, paragraphs and a table) is exported for review and opened in LibreOffice, which accepts every change in it with a Basic macro (in its temporary profile) and saves its text: that text's words, paragraph by paragraph, must be the Mind's with every change accepted.

A file someone else wrote, with their tracked insertion and their comment on a claim, is verified (#110) with the scripted model: its export, with each Unsupported and Contradicted claim as IncarnaMind's comment, must pass step 1's checks and open in LibreOffice (its PDF kept as `verified-report.pdf`).

A Mind of to-dos (nested, one done, one empty) is exported to Word, opened in LibreOffice and imported again: its nesting is the indent, and every box and its text comes back as text, not a to-do, since Word has no to-do.

LibreOffice is found as `INCARNAMIND_SOFFICE`, then `soffice`, then `libreoffice` on the PATH. When it isn't there the LibreOffice steps are skipped and say so, unless `INCARNAMIND_WORD_REQUIRE_LIBREOFFICE=1`, which CI sets: then a missing LibreOffice fails the run.

An input package that is known to fail inspection is marked `known` with the reason in `sources.json` (or `extended.json`); its package failure is reported and does not fail the run. Feature-metadata drift, import, export and LibreOffice failures still fail the run, including for a file with a known input-package defect.

**The extended set.** `npm run eval:word:fetch` downloads each real file from its pinned URL into `INCARNAMIND_WORD_CACHE` (default `~/.cache/incarnamind-eval/word-extended`), refuses one whose SHA-256 differs, and runs `generate-domains.py extended` for the generated ones (needs Python 3). Downloads are untrusted data: nothing opens them except the check. CI's pull request job runs the core set; a nightly job (`.github/workflows/nightly.yml`) runs both.

## Adding or changing a file

1. Put the file under `documents/`, `tracked-changes/`, `breadth/` or `saved/<app>/` and add its line to `sources.json` (origin, language, domain, licence, source URL pinned to a commit; `known` if it fails a check). An extended file is a line in `extended.json`.
2. `INCARNAMIND_WORD_UPDATE=1 npm run eval:word` (after the fetch) rewrites `manifest.json`, the extended features and the tables below.
3. After changing a generator, run `python3 eval/word/generate-synthetic.py` and `python3 eval/word/generate-domains.py core`, and commit the files they write.

## Coverage

<!-- coverage:start -->

Each cell is the number of files, and in brackets how many of them are committed (the core set), when not all.

**Domain by language**

| Domain | en | zh | zh-TW | ja | ko | de | fr | es | ar | he | mixed | n/a | All |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| legal | 7 | 6 (5) | · | · | · | 2 (1) | 1 | · | 1 | · | · | · | 17 (15) |
| finance | 5 (4) | 1 | · | 1 (0) | · | 1 (0) | · | 1 (0) | · | · | · | · | 9 (5) |
| medical | 2 (1) | 2 | 1 (0) | · | 1 | · | · | · | · | · | · | · | 6 (4) |
| academic | 1 | 1 (0) | · | · | · | · | · | · | · | 1 (0) | · | · | 3 (1) |
| government | 1 (0) | 2 | 2 | 1 (0) | · | · | 1 (0) | · | · | · | · | · | 7 (4) |
| engineering | 3 (2) | · | · | · | · | 1 (0) | · | · | · | · | · | · | 4 (2) |
| hr | 4 (3) | 2 | · | 1 | · | · | · | · | · | 1 | · | · | 8 (7) |
| education | 1 (0) | · | · | · | · | · | · | 1 (0) | 1 (0) | · | · | · | 3 (0) |
| business | 2 | 2 | · | · | · | · | · | · | · | · | 3 (1) | · | 7 (5) |
| test | 74 (20) | 8 (1) | · | 7 (1) | 2 (0) | 11 (0) | 7 (2) | 4 (1) | 8 (1) | · | 2 | 53 (21) | 176 (49) |
| All | 100 (40) | 24 (15) | 3 (2) | 10 (2) | 3 (1) | 15 (1) | 9 (3) | 6 (1) | 10 (2) | 2 (1) | 5 (3) | 53 (21) | 240 (92) |

**Feature by language** (files with at least one)

| Feature | en | zh | zh-TW | ja | ko | de | fr | es | ar | he | mixed | n/a | All |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Tracked changes | 17 (13) | 4 (3) | · | · | · | 1 (0) | 2 (1) | · | · | 1 | 1 | 15 (12) | 41 (31) |
| Comments | 12 (7) | 6 (5) | · | · | · | 1 (0) | · | · | 1 (0) | · | 1 (0) | 2 (1) | 23 (13) |
| Comment replies | 3 (1) | 2 (1) | · | · | · | 1 (0) | · | · | · | · | 1 (0) | 1 (0) | 8 (2) |
| Footnotes | 28 (14) | 6 (5) | 1 | · | 1 | 3 (0) | 6 (2) | 1 (0) | 1 | 1 (0) | · | 5 (3) | 53 (27) |
| Endnotes | 14 (8) | 4 (3) | · | · | 1 | 2 (0) | 2 (1) | 1 (0) | 1 | 1 (0) | · | 3 (1) | 29 (15) |
| Fields | 48 (26) | 14 (12) | 3 (2) | 3 (1) | 1 | 5 (0) | 4 (2) | 2 (0) | 2 (1) | 2 (1) | 3 (1) | 12 (9) | 99 (56) |
| TOC | 15 (8) | 2 (1) | · | · | · | · | · | · | · | · | · | 4 (3) | 21 (12) |
| Cross-references | 13 (4) | · | · | · | · | · | 1 | · | · | · | · | 3 | 17 (8) |
| SEQ captions | 20 (9) | 2 (0) | 2 (1) | 3 (1) | 1 | 2 (0) | 2 (1) | 2 (0) | 2 (1) | 2 (1) | 3 (1) | · | 41 (16) |
| Bookmarks | 46 (24) | 5 (3) | 3 (2) | 3 (1) | 1 | 9 (1) | 6 (2) | 3 (0) | 5 (2) | 2 (1) | 3 (1) | 22 (15) | 108 (53) |
| Headers and footers | 43 (28) | 15 (13) | 3 (2) | 3 (1) | 1 | 7 (1) | 3 (1) | 2 (0) | 3 (1) | 2 (1) | 3 (1) | 15 (10) | 100 (60) |
| Several sections | 18 (7) | 3 (0) | · | · | 1 (0) | 1 (0) | 1 (0) | · | 1 (0) | · | · | 6 (5) | 31 (12) |
| Columns | 9 (3) | 1 (0) | · | · | · | · | · | · | · | · | · | 2 (1) | 12 (4) |
| Tables | 39 (18) | 10 (8) | 3 (2) | 5 (1) | 1 | 8 (0) | 5 (1) | 3 (1) | 2 (1) | 1 | 3 (1) | 9 (5) | 89 (40) |
| Nested tables | 6 (2) | · | · | 1 (0) | · | · | · | · | · | · | · | 3 (2) | 10 (4) |
| Merged cells | 17 (9) | · | · | · | 1 | 2 (0) | · | · | 1 (0) | · | · | 3 (2) | 24 (12) |
| Lists | 40 (19) | 9 (7) | 1 (0) | 3 (1) | 1 | 5 (1) | 3 (1) | 2 (0) | 3 (1) | 2 (1) | 3 (1) | 4 | 76 (37) |
| Content controls | 16 (7) | 4 | 1 (0) | 2 (1) | · | 1 (0) | · | · | · | · | · | 8 (5) | 32 (17) |
| Form fields | 6 (2) | 1 (0) | 1 (0) | 1 (0) | 1 | · | 1 | · | · | · | · | 1 (0) | 12 (4) |
| Images | 19 (5) | 1 (0) | · | 2 (0) | 1 (0) | · | · | 1 (0) | · | · | · | 6 (2) | 30 (7) |
| Images with wrap | 8 (3) | · | · | 2 (0) | · | 1 (0) | · | · | · | · | · | 6 (1) | 17 (4) |
| Equations | 7 (3) | · | · | · | · | 1 (0) | · | · | · | 1 (0) | · | 4 (1) | 13 (4) |
| SmartArt | 2 (0) | · | · | · | · | · | · | · | · | · | · | 4 (1) | 6 (1) |
| Charts | 2 (0) | · | · | 1 (0) | · | · | · | 1 (0) | · | · | 1 | 6 (1) | 11 (2) |
| Text boxes | 10 (5) | · | · | 2 (0) | · | 2 (0) | · | 1 (0) | · | · | 1 (0) | 4 (2) | 20 (7) |
| Shapes | 13 (5) | · | · | 2 (0) | · | 3 (0) | · | 3 (0) | · | · | 1 (0) | 8 (3) | 30 (8) |
| Embedded objects | 3 (0) | · | · | · | · | · | · | · | · | · | · | 6 (1) | 9 (1) |
| Right-to-left | 3 (2) | · | · | · | 1 (0) | · | · | · | 10 (2) | 2 (1) | 1 (0) | 1 | 18 (6) |
| Older compatibility mode | 67 (17) | 10 (3) | 1 | 7 (1) | 2 (0) | 3 (1) | 4 (1) | 3 (0) | 5 (0) | · | 2 | 41 (18) | 145 (44) |
| 100+ pages | 4 (2) | 1 (0) | · | · | · | · | · | · | · | · | · | · | 5 (2) |

**Feature by domain**

| Feature | legal | finance | medical | academic | government | engineering | hr | education | business | test | All |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Tracked changes | 3 (2) | 1 (0) | 1 (0) | · | 1 | · | 3 | · | 3 | 29 (22) | 41 (31) |
| Comments | 6 (5) | 1 (0) | 1 (0) | · | 1 | · | 4 (3) | · | 1 (0) | 9 (4) | 23 (13) |
| Comment replies | 1 (0) | 1 (0) | 1 (0) | · | 1 | · | 1 (0) | · | 1 (0) | 2 (1) | 8 (2) |
| Footnotes | 12 (11) | 7 (4) | 1 | 3 (1) | 2 (1) | 1 (0) | 2 | · | · | 25 (7) | 53 (27) |
| Endnotes | 10 (9) | 5 (2) | 1 | 3 (1) | 1 (0) | 1 (0) | · | · | · | 8 (2) | 29 (15) |
| Fields | 16 (14) | 9 (5) | 6 (4) | 3 (1) | 7 (4) | 4 (2) | 6 (5) | 3 (0) | 5 (3) | 40 (18) | 99 (56) |
| TOC | 3 | 5 (4) | 1 | 1 (0) | · | 1 (0) | 1 (0) | · | · | 9 (4) | 21 (12) |
| Cross-references | 2 | 2 | · | · | · | · | · | · | · | 13 (4) | 17 (8) |
| SEQ captions | 7 (5) | 4 (1) | 3 (2) | 3 (1) | 4 (1) | 3 (1) | 3 (2) | 3 (0) | 3 (1) | 8 (2) | 41 (16) |
| Bookmarks | 10 (8) | 7 (3) | 6 (4) | 3 (1) | 6 (3) | 3 (1) | 3 (2) | 3 (0) | 3 (1) | 64 (30) | 108 (53) |
| Headers and footers | 17 (15) | 9 (5) | 6 (4) | 3 (1) | 7 (4) | 4 (2) | 6 (5) | 3 (0) | 7 (5) | 38 (19) | 100 (60) |
| Several sections | · | 1 | · | 1 | · | 1 | · | · | · | 28 (9) | 31 (12) |
| Columns | · | 1 | · | 1 | · | · | · | · | · | 10 (2) | 12 (4) |
| Tables | 12 (10) | 7 (4) | 3 (2) | 1 (0) | 6 (3) | 3 (1) | 4 | 3 (0) | 7 (5) | 43 (11) | 89 (40) |
| Nested tables | · | · | 1 | · | · | · | · | · | · | 9 (3) | 10 (4) |
| Merged cells | 4 (3) | 1 | 2 | · | · | 1 | · | 2 (0) | · | 14 (5) | 24 (12) |
| Lists | 16 (14) | 5 (1) | 4 (2) | 3 (1) | 3 (0) | 4 (2) | 4 (3) | 3 (0) | 6 (4) | 28 (10) | 76 (37) |
| Content controls | 5 | 2 | 3 (1) | · | 2 (0) | · | 2 (1) | · | · | 18 (8) | 32 (17) |
| Form fields | 1 (0) | · | 4 (2) | · | 2 (0) | · | · | · | · | 5 (2) | 12 (4) |
| Images | · | · | · | 1 | · | · | 1 (0) | 1 (0) | · | 27 (6) | 30 (7) |
| Images with wrap | · | · | · | 1 | · | · | 1 (0) | 1 (0) | · | 14 (3) | 17 (4) |
| Equations | · | · | · | 2 (1) | · | 2 (1) | · | · | · | 9 (2) | 13 (4) |
| SmartArt | · | · | · | · | · | · | · | · | · | 6 (1) | 6 (1) |
| Charts | · | 2 (0) | · | · | · | · | · | · | 1 | 8 (1) | 11 (2) |
| Text boxes | 1 | · | · | · | · | 1 | · | 2 (0) | 1 (0) | 15 (5) | 20 (7) |
| Shapes | 1 | · | · | · | · | 1 | · | 2 (0) | 1 (0) | 25 (6) | 30 (8) |
| Embedded objects | · | · | · | · | · | · | · | · | · | 9 (1) | 9 (1) |
| Right-to-left | 1 | · | · | 1 (0) | · | · | 1 | 1 (0) | 1 (0) | 13 (4) | 18 (6) |
| Older compatibility mode | 2 | 1 | 1 | · | 2 | 1 | 1 | · | · | 137 (36) | 145 (44) |
| 100+ pages | 1 | 1 (0) | · | 1 (0) | · | 1 (0) | · | · | · | 1 | 5 (2) |

92 committed files (1.7 MB) and 148 in the extended set (2.6 MB when fetched): 240 in all.

<!-- coverage:end -->

## The committed files

Lang: `en`, `zh` (Simplified), `zh-TW`, `ja`, `ko`, `de`, `fr`, `es`, `ar`, `he`, `mixed` or `n/a`. The extended files are in [EXTENDED.md](EXTENDED.md).

<!-- files:start -->

### Documents (32)

| File | Lang | Domain | Licence | Source | Kinds | Features (count) |
|---|---|---|---|---|---|---|
| `libreoffice/FDO76312.docx` | en | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/FDO76312.docx) | 13 | Fields 2, Bookmarks 1, Headers and footers 2, Tables 1, Merged cells 4, Lists 5, Content controls 7, Images 1, Images with wrap 1, Text boxes 2, Shapes 2, Right-to-left 18, Older compatibility mode 1 |
| `libreoffice/tdf124637_sectionMargin.docx` | en | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/tdf124637_sectionMargin.docx) | 10 | Footnotes 1, Fields 6, TOC 1, Cross-references 4, Bookmarks 5, Headers and footers 6, Several sections 6, Columns 1, Lists 7, Content controls 2 |
| `libreoffice/tdf103976.docx` | n/a | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/tdf103976.docx) | 7 | Fields 1, Bookmarks 1, Headers and footers 1, Tables 2, Nested tables 1, Lists 2, Older compatibility mode 1 |
| `libreoffice/fdo69649.docx` | n/a | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/fdo69649.docx) | 8 | Fields 24, TOC 1, Cross-references 21, Bookmarks 27, Headers and footers 6, Content controls 1, Right-to-left 4, Older compatibility mode 1 |
| `libreoffice/NumberedList.docx` | n/a | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/NumberedList.docx) | 7 | Fields 1, Bookmarks 1, Headers and footers 1, Tables 2, Nested tables 1, Lists 2, Older compatibility mode 1 |
| `libreoffice/multi-page-toc.docx` | n/a | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/multi-page-toc.docx) | 8 | Fields 5, TOC 1, Cross-references 2, Bookmarks 2, Headers and footers 1, Several sections 1, Content controls 1, Older compatibility mode 1 |
| `libreoffice/tdf126994_lostPageBreak.docx` | n/a | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/tdf126994_lostPageBreak.docx) | 7 | Fields 9, TOC 1, Cross-references 7, Bookmarks 8, Headers and footers 1, Several sections 1, Content controls 2 |
| `libreoffice/fdo79008.docx` | en | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/fdo79008.docx) | 8 | Comments 1, Fields 2, SEQ captions 1, Bookmarks 7, Headers and footers 1, Text boxes 1, Shapes 1, Older compatibility mode 1 |
| `libreoffice/tdf170236.docx` | n/a | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlimport/data/tdf170236.docx) | 4 | Comments 1, Bookmarks 1, Headers and footers 6, Equations 1 |
| `apache-poi/form_footnotes.docx` | en | test | Apache-2.0 | [apache-poi](https://github.com/apache/poi/blob/f3688f45b0de8934fb32736ba14efc5bbca4a580/test-data/document/form_footnotes.docx) | 10 | Footnotes 1, Fields 69, Bookmarks 36, Headers and footers 1, Tables 6, Merged cells 56, Lists 10, Form fields 69, Images 1, Older compatibility mode 1 |
| `apache-poi/Bug54849.docx` | en | test | Apache-2.0 | [apache-poi](https://github.com/apache/poi/blob/f3688f45b0de8934fb32736ba14efc5bbca4a580/test-data/document/Bug54849.docx) | 7 | Footnotes 1, Endnotes 1, Bookmarks 1, Headers and footers 2, Tables 2, Content controls 13, Older compatibility mode 1 |
| `apache-poi/testComment.docx` | en | test | Apache-2.0 | [apache-poi](https://github.com/apache/poi/blob/f3688f45b0de8934fb32736ba14efc5bbca4a580/test-data/document/testComment.docx) | 2 | Comments 1, Images 1 |
| `synthetic/en-contract-lease.docx` | en | legal | Apache-2.0 | synthetic | 8 | Footnotes 1, Endnotes 1, Fields 4, SEQ captions 1, Headers and footers 2, Tables 2, Merged cells 2, Lists 2 |
| `synthetic/en-contract-nda.docx` | en | legal | Apache-2.0 | synthetic | 6 | Comments 3, Fields 3, Cross-references 1, Bookmarks 1, Headers and footers 2, Lists 11 |
| `synthetic/en-contract-redline.docx` | en | legal | Apache-2.0 | synthetic | 5 | Tracked changes 11, Comments 1, Fields 2, Headers and footers 2, Lists 9 (change authors: Counterparty Counsel, Reviewer A) |
| `synthetic/en-contract-services.docx` | en | legal | Apache-2.0 | synthetic | 10 | Footnotes 1, Endnotes 1, Fields 3, TOC 1, Bookmarks 1, Headers and footers 2, Tables 2, Merged cells 1, Lists 18, Content controls 2 |
| `synthetic/en-memo-board.docx` | en | business | Apache-2.0 | synthetic | 5 | Tracked changes 5, Fields 2, Headers and footers 2, Tables 1, Lists 3 (change authors: Finance Lead) |
| `synthetic/en-memo-plain.docx` | en | business | Apache-2.0 | synthetic | 2 | Headers and footers 2, Tables 1 |
| `synthetic/en-memo-policy.docx` | en | hr | Apache-2.0 | synthetic | 5 | Tracked changes 4, Comments 1, Footnotes 1, Fields 2, Headers and footers 2 (change authors: HR, Legal) |
| `synthetic/en-policy-numbered.docx` | en | engineering | Apache-2.0 | synthetic | 3 | Fields 2, Headers and footers 2, Lists 7 |
| `synthetic/en-report-quarterly.docx` | en | finance | Apache-2.0 | synthetic | 9 | Footnotes 1, Endnotes 1, Fields 4, TOC 1, Cross-references 1, Bookmarks 1, Headers and footers 2, Tables 1, Content controls 1 |
| `synthetic/en-report-sections.docx` | en | finance | Apache-2.0 | synthetic | 3 | Footnotes 1, Fields 1, Headers and footers 4 |
| `synthetic/en-resume-layout.docx` | en | hr | Apache-2.0 | synthetic | 1 | Tables 1 |
| `synthetic/zh-bilingual-contract.docx` | zh | legal | Apache-2.0 | synthetic | 6 | Comments 1, Footnotes 1, Fields 2, Headers and footers 2, Tables 1, Content controls 1 |
| `synthetic/zh-contract-redline.docx` | zh | legal | Apache-2.0 | synthetic | 5 | Tracked changes 7, Comments 1, Fields 2, Headers and footers 2, Lists 6 (change authors: 审核人甲, 对方律师) |
| `synthetic/zh-contract-sale.docx` | zh | legal | Apache-2.0 | synthetic | 5 | Comments 2, Footnotes 1, Fields 2, Headers and footers 2, Lists 6 |
| `synthetic/zh-contract-service.docx` | zh | legal | Apache-2.0 | synthetic | 7 | Footnotes 1, Endnotes 1, Fields 2, Headers and footers 2, Tables 2, Lists 9, Content controls 2 |
| `synthetic/zh-memo-meeting.docx` | zh | business | Apache-2.0 | synthetic | 4 | Fields 2, Headers and footers 2, Tables 2, Lists 2 |
| `synthetic/zh-memo-notice.docx` | zh | business | Apache-2.0 | synthetic | 4 | Tracked changes 2, Headers and footers 2, Tables 1, Lists 3 (change authors: 财务负责人) |
| `synthetic/zh-policy-rules.docx` | zh | hr | Apache-2.0 | synthetic | 4 | Comments 1, Fields 2, Headers and footers 2, Lists 8 |
| `synthetic/zh-report-annual.docx` | zh | finance | Apache-2.0 | synthetic | 6 | Footnotes 1, Endnotes 1, Fields 4, TOC 1, Headers and footers 2, Tables 1 |
| `synthetic/zh-resume-layout.docx` | zh | hr | Apache-2.0 | synthetic | 1 | Tables 2 |

### Files with someone else's tracked changes (20)

| File | Lang | Domain | Licence | Source | Kinds | Features (count) |
|---|---|---|---|---|---|---|
| `libreoffice/tdf123054.docx` | n/a | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/tdf123054.docx) | 6 | Tracked changes 138, Bookmarks 1, Tables 1, Merged cells 1, Lists 15, Older compatibility mode 1 (change authors: Szerző) |
| `libreoffice/bnc821804.docx` | en | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlimport/data/bnc821804.docx) | 2 | Tracked changes 12, Older compatibility mode 1 (change authors: unknown1, unknown10, unknown11, unknown12, unknown2, unknown3, unknown4, unknown5, unknown6, unknown7, unknown8, unknown9) |
| `libreoffice/tdf104797.docx` | en | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/tdf104797.docx) | 2 | Tracked changes 7, Bookmarks 1 (change authors: Tekijä) |
| `libreoffice/tdf121784.docx` | n/a | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/tdf121784.docx) | 4 | Tracked changes 6, Footnotes 1, Endnotes 1, Older compatibility mode 1 (change authors: User2 ) |
| `libreoffice/tdf125894.docx` | en | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/tdf125894.docx) | 4 | Tracked changes 4, Fields 1, Bookmarks 1, Headers and footers 6 (change authors: Szerző) |
| `libreoffice/tdf116084.docx` | en | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/tdf116084.docx) | 3 | Tracked changes 2, Bookmarks 1, Headers and footers 6 (change authors: Szerző) |
| `libreoffice/tdf121176.docx` | en | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/tdf121176.docx) | 3 | Tracked changes 2, Bookmarks 1, Headers and footers 6 (change authors: Szerző) |
| `libreoffice/tdf127814.docx` | n/a | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/tdf127814.docx) | 9 | Tracked changes 2, Fields 1, Bookmarks 1, Headers and footers 2, Several sections 1, Tables 1, Merged cells 28, Content controls 1, Older compatibility mode 1 (change authors: Szerző) |
| `libreoffice/tdf128156.docx` | n/a | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/tdf128156.docx) | 7 | Tracked changes 2, Fields 2, Bookmarks 1, Headers and footers 9, Several sections 1, Content controls 2, Older compatibility mode 1 (change authors: Szerző) |
| `libreoffice/groupshape-trackedchanges.docx` | n/a | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/groupshape-trackedchanges.docx) | 5 | Tracked changes 4, Bookmarks 1, Text boxes 2, Shapes 4, Older compatibility mode 1 (change authors: vmiklos) |
| `libreoffice/fdo65265.docx` | en | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/fdo65265.docx) | 3 | Tracked changes 2, Bookmarks 1, Older compatibility mode 1 (change authors: JL) |
| `libreoffice/fdo65632.docx` | n/a | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/fdo65632.docx) | 3 | Tracked changes 1, Footnotes 1, Older compatibility mode 1 (change authors: vmiklos) |
| `libreoffice/n789482.docx` | n/a | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/n789482.docx) | 3 | Tracked changes 1, Fields 1, Older compatibility mode 1 (change authors: John) |
| `libreoffice/fdo79668.docx` | en | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/fdo79668.docx) | 4 | Tracked changes 14, Bookmarks 1, Lists 4, Older compatibility mode 1 (change authors: Pashupati) |
| `libreoffice/fdo79535.docx` | n/a | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/fdo79535.docx) | 3 | Tracked changes 2, Bookmarks 1, Older compatibility mode 1 (change authors: Pashupati) |
| `libreoffice/tdf107969.docx` | n/a | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/tdf107969.docx) | 5 | Tracked changes 6, Footnotes 1, Bookmarks 1, Images 1, Older compatibility mode 1 (change authors: Ooker) |
| `libreoffice/n830205.docx` | n/a | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/n830205.docx) | 8 | Tracked changes 1027, Fields 1, Headers and footers 4, Several sections 8, Columns 2, Tables 3, Lists 30, Older compatibility mode 1 (change authors: JimBob) |
| `libreoffice/bnc837302.docx` | n/a | test | MPL-2.0 | [libreoffice](https://github.com/LibreOffice/core/blob/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/bnc837302.docx) | 2 | Tracked changes 1, Older compatibility mode 1 |
| `apache-poi/delins.docx` | en | test | Apache-2.0 | [apache-poi](https://github.com/apache/poi/blob/f3688f45b0de8934fb32736ba14efc5bbca4a580/test-data/document/delins.docx) | 4 | Tracked changes 82, Fields 14, Lists 19, Older compatibility mode 1 (change authors: pavel) |
| `apache-poi/Tika-792.docx` | n/a | test | Apache-2.0 | [apache-poi](https://github.com/apache/poi/blob/f3688f45b0de8934fb32736ba14efc5bbca4a580/test-data/document/Tika-792.docx) | 4 | Tracked changes 6, Bookmarks 1, Headers and footers 6, Older compatibility mode 1 (change authors: Author) |

### Breadth: more domains, languages and complexity

| File | Lang | Domain | Licence | Source | Kinds | Features (count) |
|---|---|---|---|---|---|---|
| `apache-poi/rtl.docx` | ar | test | Apache-2.0 | [apache-poi](https://raw.githubusercontent.com/apache/poi/f3688f45b0de8934fb32736ba14efc5bbca4a580/test-data/document/rtl.docx) | 2 | Bookmarks 28, Right-to-left 75 |
| `docx-js/word-stops-grid-indents.docx` | ja | test | MIT | [docx-js](https://raw.githubusercontent.com/dolanmiu/docx/c9be7acae6146b3176443522fd5b87bcf6b48c53/scripts/layout-probes/stops2/word-stops-grid-indents.docx) | 1 | Older compatibility mode 1 |
| `docx-js/word-stops-compress-kana2.docx` | mixed | test | MIT | [docx-js](https://raw.githubusercontent.com/dolanmiu/docx/c9be7acae6146b3176443522fd5b87bcf6b48c53/scripts/layout-probes/stops2/word-stops-compress-kana2.docx) | 1 | Older compatibility mode 1 |
| `open-xml-sdk/A5.docx` | zh | test | MIT | [open-xml-sdk](https://raw.githubusercontent.com/dotnet/Open-XML-SDK/431ab05cf160248cc3885a4a766026d4f8243792/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/wordprocessing/page layout/page layout(big file)/A5.docx) | 1 | Older compatibility mode 1 |
| `open-xml-powertools/Contract.docx` | de | legal | MIT | [open-xml-powertools](https://raw.githubusercontent.com/OpenXmlDev/Open-XML-PowerTools/536ca1fb4bcdce1f4c920658bd66807b970393d7/OpenXmlPowerToolsExamples/HtmlConverter01/Contract.docx) | 4 | Bookmarks 18, Headers and footers 6, Lists 5, Older compatibility mode 1 |
| `open-xml-powertools/RP038-Inserted-Paras-at-End.docx` | fr | test | MIT | [open-xml-powertools](https://raw.githubusercontent.com/OpenXmlDev/Open-XML-PowerTools/536ca1fb4bcdce1f4c920658bd66807b970393d7/TestFiles/RP/RP038-Inserted-Paras-at-End.docx) | 2 | Tracked changes 22, Footnotes 1 (change authors: Acien, Clara, Jones, Jacqueline, Zzzzzzzz, Eee, wwwwwwwwwwwwwwwww) |
| `apache-poi/table-indent.docx` | es | test | Apache-2.0 | [apache-poi](https://raw.githubusercontent.com/apache/poi/f3688f45b0de8934fb32736ba14efc5bbca4a580/test-data/document/table-indent.docx) | 1 | Tables 7 |
| `docx-js/word-stops-strict2.docx` | mixed | test | MIT | [docx-js](https://raw.githubusercontent.com/dolanmiu/docx/c9be7acae6146b3176443522fd5b87bcf6b48c53/scripts/layout-probes/stops2/word-stops-strict2.docx) | 1 | Older compatibility mode 1 |
| `docx-js/word-stops-equations3.docx` | en | test | MIT | [docx-js](https://raw.githubusercontent.com/dolanmiu/docx/c9be7acae6146b3176443522fd5b87bcf6b48c53/scripts/layout-probes/stops2/word-stops-equations3.docx) | 2 | Equations 138, Older compatibility mode 1 |
| `libreoffice/smartart.docx` | n/a | test | MPL-2.0 | [libreoffice](https://raw.githubusercontent.com/LibreOffice/core/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/smartart.docx) | 3 | Bookmarks 1, SmartArt 1, Older compatibility mode 1 |
| `libreoffice/chart-size.docx` | n/a | test | MPL-2.0 | [libreoffice](https://raw.githubusercontent.com/LibreOffice/core/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/chart-size.docx) | 5 | Bookmarks 1, Images with wrap 1, Charts 1, Text boxes 2, Shapes 2 |
| `libreoffice/tdf106132.docx` | en | test | MPL-2.0 | [libreoffice](https://raw.githubusercontent.com/LibreOffice/core/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/tdf106132.docx) | 7 | Fields 2, SEQ captions 2, Images 1, Images with wrap 1, Text boxes 2, Shapes 2, Older compatibility mode 1 |
| `open-xml-sdk/Comment003.docx` | en | test | MIT | [open-xml-sdk](https://raw.githubusercontent.com/dotnet/Open-XML-SDK/431ab05cf160248cc3885a4a766026d4f8243792/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/O15Conformance/WD/CommentExTest/Comments-Sample-15-12-01/Comment003.docx) | 4 | Comments 6, Comment replies 4, Bookmarks 1, Right-to-left 10 |
| `docx-js/word-nested-tables.docx` | en | test | MIT | [docx-js](https://raw.githubusercontent.com/dolanmiu/docx/c9be7acae6146b3176443522fd5b87bcf6b48c53/scripts/layout-probes/word-nested-tables.docx) | 4 | Several sections 11, Tables 25, Nested tables 13, Older compatibility mode 1 |
| `apache-tika/EmbeddedDocument.docx` | n/a | test | Apache-2.0 | [apache-tika](https://raw.githubusercontent.com/apache/tika/49e40e6ddaf44910111f6b8c44db1f768d39098b/tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/tika-parser-microsoft-module/src/test/resources/test-documents/EmbeddedDocument.docx) | 4 | Images 1, Shapes 1, Embedded objects 1, Older compatibility mode 1 |
| `open-xml-powertools/RA001-Tracked-Revisions-02.docx` | en | test | MIT | [open-xml-powertools](https://raw.githubusercontent.com/OpenXmlDev/Open-XML-PowerTools/536ca1fb4bcdce1f4c920658bd66807b970393d7/TestFiles/RA001-Tracked-Revisions-02.docx) | 9 | Tracked changes 280, Fields 1, Bookmarks 1, Headers and footers 4, Several sections 1, Tables 4, Merged cells 7, Lists 1, Older compatibility mode 1 (change authors: Author) |
| `docx-js/word-character-widths.docx` | en | test | MIT | [docx-js](https://raw.githubusercontent.com/dolanmiu/docx/c9be7acae6146b3176443522fd5b87bcf6b48c53/scripts/layout-probes/word-character-widths.docx) | 3 | Several sections 2, Older compatibility mode 1, 100+ pages 1 |
| `libreoffice/tdf108505.docx` | fr | test | MPL-2.0 | [libreoffice](https://raw.githubusercontent.com/LibreOffice/core/7094a2f2374c6b68c4038d9f05019942ba2caa09/sw/qa/extras/ooxmlexport/data/tdf108505.docx) | 4 | Fields 3, Bookmarks 3, Form fields 3, Older compatibility mode 1 |
| `government/pbc-fujian-normative-documents.docx` | zh | government | Not copyrightable (official document) | [government](https://fuzhou.pbc.gov.cn/fuzhou/126805/126820/126789/5850754/2025092316012977612.docx) | 4 | Fields 2, Headers and footers 2, Tables 1, Older compatibility mode 1 |
| `government/nmpa-tcm-drafting-note.docx` | zh | medical | Not copyrightable (official document) | [government](https://www.nmpa.gov.cn/directory/web/nmpa/images/1674013535292043222.docx) | 3 | Fields 4, Bookmarks 1, Headers and footers 2 |
| `government/nmpa-device-gcp-drafting-note.docx` | zh | medical | Not copyrightable (official document) | [government](https://www.nmpa.gov.cn/directory/web/nmpa/images/1620611781701002332.docx) | 5 | Fields 1, Bookmarks 1, Headers and footers 1, Content controls 1, Older compatibility mode 1 |
| `government/moa-taiwan-draft-notice-sample.docx` | zh-TW | government | Not copyrightable (official document) | [government](https://www.moa.gov.tw/upload/files/web_structure/11414/3-1-5-2-4.docx) | 6 | Footnotes 2, Fields 2, Bookmarks 1, Headers and footers 1, Tables 3, Older compatibility mode 1 |
| `domains/academic-en-paper.docx` | en | academic | Apache-2.0 | synthetic | 12 | Footnotes 1, Endnotes 1, Fields 4, SEQ captions 2, Bookmarks 3, Headers and footers 4, Several sections 2, Columns 1, Lists 3, Images 1, Images with wrap 1, Equations 3 |
| `domains/engineering-en-spec.docx` | en | engineering | Apache-2.0 | synthetic | 12 | Fields 5, SEQ captions 3, Bookmarks 3, Headers and footers 3, Several sections 2, Tables 2, Merged cells 4, Lists 3, Equations 3, Text boxes 3, Shapes 3, Older compatibility mode 1 |
| `domains/finance-en-prospectus.docx` | en | finance | Apache-2.0 | synthetic | 11 | Fields 6, TOC 1, Cross-references 2, SEQ captions 1, Bookmarks 3, Headers and footers 4, Several sections 2, Columns 1, Tables 1, Merged cells 4, Lists 3 |
| `domains/gov-zh-TW-announcement.docx` | zh-TW | government | Apache-2.0 | synthetic | 5 | Fields 3, SEQ captions 1, Bookmarks 3, Headers and footers 2, Tables 1 |
| `domains/gov-zh-notice.docx` | zh | government | Apache-2.0 | synthetic | 6 | Tracked changes 15, Comments 3, Comment replies 2, Fields 2, Bookmarks 3, Headers and footers 2 (change authors: 对方律师, 编辑) |
| `domains/hr-he-contract.docx` | he | hr | Apache-2.0 | synthetic | 8 | Tracked changes 15, Fields 3, SEQ captions 1, Bookmarks 3, Headers and footers 2, Tables 2, Lists 3, Right-to-left 38 (change authors: הצד שכנגד, עורך) |
| `domains/hr-ja-contract.docx` | ja | hr | Apache-2.0 | synthetic | 7 | Fields 3, SEQ captions 1, Bookmarks 3, Headers and footers 2, Tables 2, Lists 3, Content controls 5 |
| `domains/legal-ar-contract.docx` | ar | legal | Apache-2.0 | synthetic | 9 | Footnotes 1, Endnotes 1, Fields 3, SEQ captions 1, Bookmarks 3, Headers and footers 2, Tables 2, Lists 3, Right-to-left 29 |
| `domains/legal-en-court-complaint.docx` | en | legal | Apache-2.0 | synthetic | 10 | Footnotes 1, Endnotes 1, Fields 3, SEQ captions 1, Bookmarks 3, Headers and footers 2, Tables 2, Lists 3, Text boxes 1, Shapes 1 |
| `domains/legal-en-msa-long.docx` | en | legal | Apache-2.0 | synthetic | 11 | Footnotes 12, Endnotes 12, Fields 15, TOC 1, SEQ captions 12, Bookmarks 12, Headers and footers 2, Tables 12, Lists 60, Older compatibility mode 1, 100+ pages 1 |
| `domains/legal-fr-contrat.docx` | fr | legal | Apache-2.0 | synthetic | 9 | Footnotes 1, Endnotes 1, Fields 5, Cross-references 2, SEQ captions 1, Bookmarks 3, Headers and footers 2, Tables 2, Lists 3 |
| `domains/medical-en-clinical-protocol.docx` | en | medical | Apache-2.0 | synthetic | 10 | Fields 8, TOC 1, SEQ captions 1, Bookmarks 3, Headers and footers 2, Tables 3, Nested tables 1, Merged cells 4, Lists 3, Form fields 4 |
| `domains/medical-ko-protocol.docx` | ko | medical | Apache-2.0 | synthetic | 10 | Footnotes 1, Endnotes 1, Fields 8, SEQ captions 2, Bookmarks 3, Headers and footers 2, Tables 2, Merged cells 4, Lists 3, Form fields 4 |
| `domains/mixed-en-zh-report.docx` | mixed | business | Apache-2.0 | synthetic | 8 | Tracked changes 15, Fields 4, SEQ captions 2, Bookmarks 3, Headers and footers 2, Tables 1, Lists 3, Charts 1 (change authors: Counterparty, Editor) |

### Files saved in Word for Mac, WPS and Google Docs

| File | Lang | Domain | Licence | Source | Kinds | Features (count) |
|---|---|---|---|---|---|---|
| `word-mac/en-contract-services.docx` | en | legal | Apache-2.0 | documents/synthetic/en-contract-services.docx, saved in Word for Mac, 2026-10-12 | 10 | Footnotes 1, Endnotes 1, Fields 3, TOC 1, Bookmarks 1, Headers and footers 2, Tables 2, Merged cells 1, Lists 18, Content controls 2 |
| `word-mac/zh-contract-service.docx` | zh | legal | Apache-2.0 | documents/synthetic/zh-contract-service.docx, saved in Word for Mac, 2026-10-12 | 7 | Footnotes 1, Endnotes 1, Fields 2, Headers and footers 2, Tables 2, Lists 9, Content controls 2 |
| `google-docs/en-memo-policy.docx` | en | hr | Apache-2.0 | documents/synthetic/en-memo-policy.docx, Google Docs (web), saved as Google Doc then exported .docx, 2026-10-12 | 6 | Tracked changes 4, Comments 1, Footnotes 1, Fields 2, Headers and footers 2, Older compatibility mode 1 (change authors: HR, Legal) |
| `google-docs/en-report-quarterly.docx` | en | finance | Apache-2.0 | documents/synthetic/en-report-quarterly.docx, Google Docs (web), saved as Google Doc then exported .docx, 2026-10-12 | 8 | Footnotes 2, Fields 3, TOC 1, Bookmarks 1, Headers and footers 2, Tables 1, Content controls 1, Older compatibility mode 1 |

<!-- files:end -->
