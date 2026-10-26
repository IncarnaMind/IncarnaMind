# Sample PDFs

The seven PDFs in this folder are the Documents the evaluations and some tests read
(`eval/README.md`, `tests/core/sampleDocuments.test.ts`).

All seven were made for this repository, each in the voice of a fictional organisation. No real
company, agency or body is named or described in them — in the text, the running heads, the file
names or the documents' metadata (Title, Author, Subject and Keywords) — and their figures are
illustrative. Nothing in them is third-party content: no sentence, table or figure is quoted from
another work, and each file is licensed under the repository's licence, Apache-2.0.

`npm run samples:generate` writes all seven from `scripts/sampleDocuments/`, and
`tests/core/sampleDocuments.test.ts` checks that each file in this folder is what the generator
writes, that every sentence the tests and evaluations quote is stored on the page they cite, and
that it is on no other page. It also checks that no Document repeats a run of twelve words from the
four third-party papers this folder held before 2026-10-25:
`tests/fixtures/old-paper-12-word-runs.txt` holds a digest of every such run.

| File | Fictional publisher | Title | Pages | Licence |
|---|---|---|---|---|
| `MPMA Code of Practice for the Pharmaceutical Industry 2021.pdf` | Marlowmere Pharmaceutical Manufacturers Association | Code of Practice for the Pharmaceutical Industry 2021 | 68 | Apache-2.0 |
| `Weighted Keys Shorter Paths.pdf` | Calventis Institute for Machine Intelligence | Weighted Keys, Shorter Paths | 15 | Apache-2.0 |
| `Tuning the Tuner.pdf` | Torvane Laboratory for Optimisation Research | Tuning the Tuner | 12 | Apache-2.0 |
| `What a Corpus Teaches.pdf` | Wrennick Research | What a Corpus Teaches | 24 | Apache-2.0 |
| `Demonstrations Not Weights.pdf` | Brellan AI Research | Demonstrations, Not Weights | 75 | Apache-2.0 |
| `Vantrell Financial Group 2022 ESG Report.pdf` | Vantrell Financial Group | 2022 Environmental, Social and Governance Report | 74 | Apache-2.0 |
| `Norvath Assembly Annual Report 2022.pdf` | The Norvath Assembly | Annual Report of the Norvath Assembly 2022 | 67 | Apache-2.0 |

## What was here before

Until 2026-10-25 this folder held seven third-party PDFs: published research papers, a trade
association's code of practice, a bank's ESG report and an international organisation's annual
report. None of their publishers' terms allowed this repository to redistribute the file, so on
2026-10-25 they were removed and replaced with the fictional documents above, each the same number
of pages and shape, with tables, charts and the text the tests and evaluations read.

The original files remain only in the repository's history. Removing them from the history would
take a rewrite, which the repository's audit of 2026-10-25 advised against.
