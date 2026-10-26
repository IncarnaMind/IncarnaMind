# The hard tier

`npm run eval:hard` checks how retrieval holds up where the gating set (`eval/README.md`) is easy: Questions worded unlike their Documents, numbers read from tables, answers spread over pages or Documents, Questions the library can't answer, Questions in the other language, and two versions of one Document. It asks them of a library at scale, across domains, in every retrieval mode, with embeddings on, so the default keyword search reranked by the built-in model can be compared with hybrid search reranked. It is reported, and never gates.

Why: embeddings are off by default (ADR-0009, 2026-10-10), and search is keyword search (FTS5's BM25), the built-in cross-encoder over keyword search's top 20 (its top 60 until 2026-10-12), and a translated second query for Questions in another language. That was decided on small, easy sets: on the gating set, keyword, vector and hybrid search tie (32, 31 and 32 of 40), and the every-format set is all hits. This tier is where vector search should earn its place if it ever does.

## Running it

```sh
npm run eval:hard
```

1. **Fetch.** The library's files are fetched into the evaluation's cache, `~/.cache/incarnamind-eval/hard/` (or `$INCARNAMIND_EVAL_CACHE/hard/`), and each is checked against the SHA-256 in `library.json`. A later run fetches nothing that's already there and unchanged. A file that has changed at its source, or can't be fetched, is left out and listed in the report, with the Questions that need it; the run goes on.
2. **Index, in two passes** (`lib/indexing.ts`). A new temporary data folder, never the User's, gets every Document with `addDocuments`, processed by the core with embeddings off, as by default: each Document is ready once its text is extracted, its Passages built and its keyword index written, and the time until every Document is ready is what a User with embeddings off waits for. Then embeddings are turned on with the built-in model, as a User can in Settings, and the run waits until every Passage has a vector, timed apart, so the dense modes can be compared. It stops with a message if no Passage was embedded.
3. **Check.** Each Question is checked against the text the app stored (`textProblems` in `lib/questions.ts`): each quote on its expected Units, on no other Unit of its Document, inside a Passage that covers them, and, for a near-duplicate, in no other version. A Question that fails is left out and listed.
4. **Search.** Each Question is searched with keyword, vector and hybrid search, then reranked by the built-in reranking model over keyword search's top 20 (what the search Tool does by default, with the app's own parameter), over keyword search's top 60 (the default before 2026-10-12, and the gating set's gate until then), and over hybrid search's candidates (what it does with embeddings on: the mode to compare the default with). A cross-lingual Question is searched again with its hand-written translation.
5. **Time keyword search.** Each Question's query (and translation) runs again on the run's data folder with the app's own keyword SQL, keeping the top 60 the search Tool asks for, ordered by `bm25(passages_fts)` as `keywordSearch` orders it, and ordered by FTS5's `rank` column (bm25() with the same weights), each timed once after a warm-up pass (`lib/keywordTiming.ts`). FTS5 has no top-k pruning, so this is the cost that grows with the library. Measurement only, at this library's size (about 48,000 Passages; the tier doesn't reach 100,000).
6. **Ask** (with a chat model). Embeddings are turned off again first, so Answers search as Users' do by default, as in `npm run eval`. Each Question is asked once, in a Mind of its own, and the Citations are scored per difficulty.
7. **Report** into `eval/results/<start time>-hard/`: `report.md`, `report.json` and, with a chat model, `reviewer-sheet.csv` and `answers.md` (each Answer's full text, under its Question).

With a chat model, set the same variables as `npm run eval` (setting them is the consent to send the Questions and Passages to it):

```sh
INCARNAMIND_EVAL_CHAT_KIND=anthropic \
INCARNAMIND_EVAL_CHAT_MODEL=claude-sonnet-5-5 \
INCARNAMIND_EVAL_CHAT_KEY=sk-ant-... \
npm run eval:hard
```

**Cost and time, roughly, on an Apple silicon Mac:**

- **Download:** 0.71 GB the first time (the manifest's total is checked to stay under 3 GB), a few minutes; arXiv's 50 papers come one every 3 seconds, as its terms ask.
- **Indexing:** about 48,000 Passages. With embeddings off, every Document should be ready within minutes; embedding them all then takes most of the run, at the built-in model's 20 to 28 Passages a second: about 30 to 40 minutes. The report gives both times.
- **Searching and reranking:** about 10 minutes.
- **Memory:** the run reports its peak; expect a few GB (the embedding and reranking models are about 1 GB each while loaded; the vectors about 75 MB).
- **Without a chat model:** about an hour all told, with nothing sent anywhere once the models are cached.
- **With a chat model:** 225 Answers more, each with up to 5 searches: two to three hours. At `claude-sonnet-5-5`'s $2 and $10 per million input and output tokens, with 25,000 to 50,000 input and about 1,000 output tokens an Answer, that is about $12 to $25.

`INCARNAMIND_EVAL_KEEP_DATA=1` keeps the data folder; `INCARNAMIND_EVAL_CACHE` moves the cache.

## The library

`library.json` lists 400 Documents (319 English, 81 Chinese) from 37 sources, each with its source, URL (or archive member, or repository path), SHA-256, size and page count, its domain and language, and, where it has them, its versions (`group`, `edition`) and its translation (`translationOf`). They are never committed.

| Domain | Where from |
|---|---|
| Contracts | 100 commercial contracts from CUAD v1 (one 106 MB archive, from which the run takes them out); Chinese model contracts from the State Administration for Market Regulation's model-contract library |
| Company reports and filings | FinanceBench's open sample (10-Ks, 10-Qs, 8-Ks and earnings releases), several companies in two or more years; Chinese companies' annual reports from the Shenzhen Stock Exchange; the gating set's Vantrell ESG report |
| Academic papers | 50 arXiv papers from Qasper's test set; Chinese open-access papers (Hans Publishers, CC BY 4.0); the gating set's papers and Chinese Wikipedia articles |
| Government and international reports | UN, UN SDG Reports, IPCC, FAO, World Bank, UNDP, in English and Chinese; Federal Reserve, Census, IRS, USDA ERS; HM Treasury and other gov.uk reports; People's Bank of China and SAFE reports |
| Technical manuals | NIST, FAA, NASA, OCC, CISA, USGS, ready.gov; WHO's biosafety manual in both languages; Chinese environmental monitoring standards |
| Medical and regulatory | FDA drug labels and guidance; UKHSA patient group directions and training slides; VA/DoD guidelines; WHO guidelines in both languages; NMPA notices, guidelines and statistics; the gating set's MPMA Code |

| Domain | English | Chinese |
|---|---|---|
| Contracts | 100 | 10 |
| Company reports and filings | 41 | 9 |
| Academic papers | 54 | 21 |
| Government and international reports | 52 | 23 |
| Technical manuals | 33 | 6 |
| Medical and regulatory | 39 | 12 |

351 PDFs (16,494 pages), 27 Word, 14 Excel, 6 PowerPoint and 2 CSV files. 42 Documents are linked to their translation in the other language, and 50 groups hold versions of one Document (two years of a report or a company's filings, two quarters, two revisions of a standard or a label, with their translations). `report.md` gives what was added, per domain, language and format.

**Licences.** Each source records its licence or terms, the page they're on, and their own words permitting the download (`sources` in `library.json`); `tests/eval/hardLibrary.test.ts` checks each against an allowed list:

- CC BY 4.0 (CUAD, Hans Publishers), CC BY 3.0 IGO (World Bank, UNDP), Open Government Licence v3.0 (gov.uk), works of the US federal government (17 U.S.C. 105), and official documents of Chinese state organs (Copyright Law of the PRC, art. 5).
- arXiv's terms, which allow retrieving e-prints for personal use or research, at one request every 3 seconds.
- Non-commercial use only: FinanceBench (CC BY-NC 4.0), WHO and FAO (CC BY-NC-SA 3.0 IGO), the World Bank's China Economic Update (CC BY-NC 3.0 IGO), and the terms of the UN, the IPCC and the Shenzhen Stock Exchange (download for personal or non-commercial use). The evaluation of a free, open-source app (ADR-0002) is non-commercial; revisit these if that changes.
- FDA's drug labels are the makers' labelling, published by FDA, whose website policy says its content isn't copyrighted unless noted; they are filed under US government works with that caveat.
- The files are downloaded to the User's own cache and read there; nothing is redistributed.

**Left out on purpose:**

- SEC EDGAR and Wikimedia's APIs, whose access policies ask for contact details in each request: requests here name no one (the User-Agent is "IncarnaMind document evaluation"). FinanceBench's filings are fetched where FinanceBench publishes them instead.
- HKEXnews, whose terms allow no use they don't list; NICE, whose terms bar use in retrieval systems outside the UK; gov.cn's English site, whose content "shall not be republished or used in any form" without authorization; and the IMF and cninfo, whose terms couldn't be read.
- Hosts that refuse requests from scripts or answer with a JavaScript challenge, which a run mustn't get round: GAO, CBO, CRS, FEMA, CDC, BLS, NOAA and others; the Shanghai Stock Exchange's files (its terms would allow them); the State Council Information Office's white papers; the CDE's drug-review guidelines.

**Known to change:** a few US government URLs aren't versioned (Medicare & You; FDA guidance at `fda.gov/media/<id>/download`). When they are replaced, their checksums stop matching and the run leaves them out, saying so.

## The Questions

`questions.json`: each Question has one difficulty, a domain, a language, and the Passages its answer needs (`expected`: Document, Units, and a quote from them).

| Difficulty | What it tests | Expected |
|---|---|---|
| `easy` | The answer is in the Documents' own words | One Passage |
| `paraphrase` | Asked in words unlike the passage's | One Passage |
| `table-number` | A number read from a table (PDF, Word, Excel or CSV) | The row with its label |
| `multi-page` | Two facts on two pages of one Document | Two Passages |
| `cross-document` | Facts from two Documents | Two Passages |
| `unanswerable` | The library doesn't say | None: an Answer should cite nothing |
| `cross-lingual` | Asked in the other language from its Document's, with `translatedQuery` | One Passage, in a Document with no translation in the Question's language |
| `near-duplicate` | Two versions of a Document differ, and the Question names which | One Passage, whose quote is in no other version |
| `false-premise` | The Question takes for granted what the Documents don't say: an approval, a figure, a cause (`premise` says what) | The Passage that says what the Documents do say |
| `disagreeing` | Two Documents disagree, one newer and one older, and the Question doesn't say which it means | Two Passages, the newer first; `newer` and `older` give what each says, in the forms an Answer may write it |

225 Questions:

| Difficulty | English | Chinese |
|---|---|---|
| easy | 24 | 5 |
| paraphrase | 24 | 8 |
| table-number | 19 | 7 |
| multi-page | 18 | 5 |
| cross-document | 15 | 5 |
| unanswerable | 19 | 6 |
| cross-lingual | 8 (about Chinese Documents) | 18 (about English Documents) |
| near-duplicate | 16 | 8 |
| false-premise | 5 | 5 |
| disagreeing | 5 | 5 |

Per domain: contracts 34, filings 50, papers 32, reports 65, manuals 19, medical 25. 17 of them ask about Word, Excel, PowerPoint or CSV files; 64 come from benchmarks (CUAD 25, FinanceBench 24, Qasper 15).

**Sources.** CUAD's clause annotations (contracts), Qasper's evidence (papers) and FinanceBench's evidence pages (filings), each mapped to the pages the app stores and reworded where the original assumed the Document was in front of the reader (`benchmark` names the original). The rest were written for this library, in English and Chinese, from the Documents' text.

**Checks.**

- `tests/eval/hardQuestions.test.ts` checks the rules above, at least 15 Questions per difficulty (10 for `false-premise` and `disagreeing`) with both languages in each, and every domain.
- Every quote was checked against the text the app's own processing extracts (`processFile`, pdf.js), one Document at a time: on its expected Units, on no other, inside a covering Passage; near-duplicates against their other versions. The run checks again on what it stored.
- Unanswerable Questions were checked by searching the whole library's extracted text for their subject.

## Scoring

- **Hit:** every Passage a Question needs is among the top 5 of a search, each by the gating set's rule (the expected Document, covering the expected Units, holding the quote). Multi-page and cross-document Questions also report how many were found in part.
- **Cross-lingual:** a Passage found by either the Question's own search or its translation's counts, as an Answer is told to search again in the Documents' language; the Question's own query alone is reported too.
- **Modes:** keyword; keyword top 20 + rerank (the search Tool's default, with embeddings off); keyword top 60 + rerank (the default until 2026-10-12); hybrid; hybrid + rerank (the search Tool with embeddings on, the one to compare the default with); vector.
- **Reported:** per difficulty, per domain, per language, and per domain × difficulty in each mode; ranks per Question; indexing time in two passes (every Document ready with embeddings off; then embedding every Passage, and the embedding model's own time), Passages and peak memory after each; keyword search's time per query (median, 95th percentile) beside the reranker's.
- **Citations,** with a chat model, per difficulty: the gating set's figures, how many Answers cite a Document the Question needs (for a near-duplicate, the right version, and how many cite another), and, for unanswerable Questions, how many are answered without a Citation and how many decline (the Answer says the Documents don't answer the Question), with or without Citations, per language. A phrase rule in English and Chinese judges the decline (`eval/lib/declines.ts`: the app's own wording, "isn't in your Documents", "the Documents don't say", "the closest they come", 文档中没有提到, 文档未说明, 没有找到相关, and so on). A nearby fact cited without saying so is not a decline. The reviewer sheet lists the Answers the rule missed for a person to mark.
- **The Answer rules** (#548), with a chat model, reported per model and not gating:
  - **Premise flagged first:** of the Answers to `false-premise` Questions, those whose first paragraph says the premise doesn't hold: the decline rule, or a negation or a word naming the premise ("didn't", "hasn't", "in fact", "assumes"; 没有, 并非, 不是…而是, 实际上, 不支持). A phrase rule on the opening, not a judgement of the whole Answer.
  - **Newer source leads:** of the Answers to `disagreeing` Questions, those that cite the newer Document and give what it says before what the older one says (or only the newer's), each found in the forms `newer` and `older` list, standing on its own ("4.8" isn't found in "14.8"), with grouped digits read alike. How many name the older one too is reported beside it.
  - `report.md` lists each of these Answers with what the rules found and how it opens; `answers.md` has the whole text.

## Dumps, and scoring other orders offline

`npm run eval:hard` takes most of an hour, so studying the order of results (a different reranker, a blend, top 8 or 10) needs the search kept: `npm run eval:dump` runs the hard tier with keyword search only, as the app does by default, and writes `hard.json` (the format and the scorer are in `../README.md`, "Offline scoring"; `INCARNAMIND_EVAL_DUMP_SETS=hard` dumps only this set, and `INCARNAMIND_EVAL_QUESTIONS=<ids>` a chosen subset of Questions, over the whole library).

```sh
INCARNAMIND_EVAL_DUMP_SETS=hard npm run eval:dump
npm run eval:score -- eval/results/<start time>-dumps/hard.json --blend 0.5
```

It fetches the library into the cache as above (a later run fetches nothing), adds the Documents with embeddings off, checks the Questions against the stored text as the hard tier does, and for each query of each of the 180 Questions with something to find (the Question, and its translation for a cross-lingual one) keeps keyword search's best 150 Passages, the built-in model's score for the first 60, each candidate's `rerankText`, a hit flag for each Passage the answer needs, and the Passages the search Tool hands the model. No embedding model runs. `INCARNAMIND_EVAL_KEEP_DATA=1` keeps the data folder. The scorer's `--by` takes `difficulty` (the default), `domain` or `language`.

The run scores the same Questions as `npm run eval:hard` scores keyword search and keyword top 20 + rerank, and fails unless the dump's top 5 are the same numbers. The scorer reproduces them from the file; the **search Tool** row is new: how many Questions have every Passage they need among the Passages the Tool hands the model, which is what an Answer sees, where the top 5 is the order of the search before the Tool groups it into windows.

**Measured** on 2026-10-10, when the Tool reranked keyword search's top 60 and handed 8 Passages, on an Apple M2 Max (12 cores) with other work running on it, library already cached: indexing 400 Documents (47,897 Passages) with embeddings off took 138 s, and writing the dump 17 minutes, which is the built-in model scoring 60 candidates for each of the 206 queries; the check against the run's own scoring took 13 minutes more. `hard.json` is 62 MB, and the scorer reads it and prints the table in under a second. The figures it gave, top 5, which the run's own scoring matched:

| | keyword | keyword + rerank | search Tool |
|---|---|---|---|
| Easy | 22/29 | 24/29 | 21/29 |
| Paraphrase | 14/32 | 23/32 | 21/32 |
| Table number | 17/26 | 18/26 | 18/26 |
| Multi-page | 3/23 | 11/23 | 4/23 |
| Cross-document | 3/20 | 4/20 | 5/20 |
| Cross-lingual, with the translation | 20/26 | 24/26 | 20/26 |
| Near-duplicate | 19/24 | 20/24 | 18/24 |
| **All** | **98/180** | **124/180** | **107/180** |

Keyword + rerank at the top 8 and 10 is 135 and 143 of 180. The search Tool's figure is lower than the reranked top 5 because it hands the model whole windows of three Passages, at most 12 Passages from at most 4 Documents for a one-search Answer (8 until 2026-10-12, and still 8 in the Tool loop), so a Question that needs many Passages (multi-page) can lose some to the limits.

## Results

### 2026-10-14: sentences written without markers (#760)

The Citation part only, with the library added as by default (embeddings off) and no retrieval modes, asking the 20 false-premise and disagreeing Questions once each. "No Citation of its own": an Answer whose Citations were all added by the check of sentences written without markers, or that has none, which is how the Answer looked before #760. An Apple M2 Max with other work running.

| | Haiku 5.5 | Sonnet 5.5 |
|---|---|---|
| No Citation of its own | 0/20 | 0/20 |
| No Citation after the check | 0/20 | 0/20 |
| Citations added for sentences quoted without one | 0 | 9, all found |
| Asked once more for Citations | 0 | 0 |

On this set both models cite. The failure #760 came from is on the example Documents (the tea articles), asked in the app with twelve Questions in English and Chinese: Haiku 5.5 answered one of twelve with no Citation of its own (all six of its quotations added after checking), and quoted without Citations in two more of six in an earlier run; Sonnet 5.5 answered none uncited, and the check added 4 Citations to sentences it quoted without one.

### 2026-10-13: a note on Documents of different dates (#660)

The 10 disagreeing Questions, twice each (20 Answers per cell), as above: before is #548's rules alone, after adds the note the search Tool appends when the Passages it hands come from Documents of different dates. "Handed both": Answers whose searches handed the model the newer and the older Document (or a translation of either).

| | Haiku 5.5 before | Haiku 5.5 after | GPT-6 Luna before | GPT-6 Luna after |
|---|---|---|---|---|
| Newer source leads, cited | 18/20 | 18/20 | 15/20 | 16/20 |
| Names the older one too | 16/20 | 17/20 | 6/20 | **11/20** |
| Handed both, then led and named the older | 16 of 18 | 17 of 18 | 4 of 15 | **9 of 17** |
| Quotes found | 45 of 45 | 48 of 48 | 23 of 23 | 35 of 36 |

- Luna now names the older Document in about half its Answers that were handed both. The rest still give only the newer figure.
- Luna's quote not found cites page 9 of the December 2024 China Economic Update for a sentence on page 8.
- Worse with that first note: on the NIST question Luna answered six Functions both times before and five both times after, naming CSF 1.1's five as the older figure. CSF 2.0's text speaks of GOVERN and "the other five Functions". Haiku answered six both ways.

The note then gained a line: "Take each Document's figure only from a sentence that states it for that Document, never from a passing mention." Asked again, the NIST Question 4 times and the 10 disagreeing Questions once each:

| | Haiku 5.5 | GPT-6 Luna |
|---|---|---|
| NIST Question right (six Functions, CSF 2.0 first) | 4/4 | 4/4 |
| Newer source leads, cited (the 10) | 9/10 | 10/10 |
| Names the older one too (the 10) | 9/10 | 7/10 |
| Handed both, then led and named the older (the 10) | 8 of 9 | 7 of 8 |
| Quotes found (the 10) | 25 of 25 | 18 of 18 |

### 2026-10-13: the Answer rules (#548), before and after

The Citation part only, with the library added as by default (embeddings off) and no retrieval modes, at `main` 3125b9cd without and with the rules and the Passages' dates. "Before" asked 60 Questions: 5 of each earlier difficulty, spread evenly through each, and the 20 new ones, asked a second time. "After" asked all 25 unanswerable Questions once and the 20 new ones twice, so each cell of the new difficulties counts 20 Answers. Scored with the rules in `lib/answerRules.ts` as committed, from each run's `report.json`. An Apple M2 Max with other work running.

| | Haiku 5.5 before | Haiku 5.5 after | GPT-6 Luna before | GPT-6 Luna after |
|---|---|---|---|---|
| Premise flagged first | 19/20 | 20/20 | 14/20 | 17/20 |
| Newer source leads, cited | 17/20 | 18/20 | 13/20 | 16/20 |
| Names the older one too | 15/20 | 17/20 | 7/20 | 6/20 |
| Unanswerable: adds a figure from outside the Documents | 3/5, labelled | 0/25 | 3/5, unlabelled | 0/25 |

- Claude Haiku 5.5 already flagged the premises and led with the newer source. GPT-6 Luna gains on both.
- Before, both models answered an unanswerable Question from their own knowledge after saying the Documents didn't cover it (Amazon's 2021 net income, a chikungunya vaccine's dose, Moutai's 2024 revenue); Luna didn't say the figure wasn't from the Documents. Now an Answer says so and stops, adding at most what the Passages say that comes closest, cited.
- Luna leaves the older Document out. Its searches handed it both Documents in 13 of the 20 Answers, and it led with the newer one and named the older in 2 of those. Before, part of its 7 was Answers that gave only the older figure (five Functions for the NIST CSF Core, 4.8% for China in 2024).
- The Lockheed Martin Question fails for both models before and after: their searches don't reach the 10-Ks' headcount Passages.
- A Passage's date is often its file's creation date, which can differ from the date printed on the page: Haiku called the FDA draft "dated 3 January 2025" (the PDF's metadata) where its cover says it was issued on 7 January.

### 2026-10-10: the first run

At commit `0d10635`, on an Apple M2 Max (12 cores, 32 GB), with no chat model. All 400 Documents were fetched (710 MB in 528 s) and added, and none of the 205 Questions was left out. The run took 55 minutes, with 47,897 Passages and a peak of 2.29 GB. The reranked keyword mode then was keyword search's top 20, the default of its time; keyword search's top 60 wasn't run.

The 180 Questions with something to find, top 5 (unanswerable Questions are scored only with a chat model):

| | keyword | keyword top 20 + rerank | hybrid | hybrid + rerank | vector |
|---|---|---|---|---|---|
| Easy | 21/29 | 22/29 | 21/29 | 24/29 | 21/29 |
| Paraphrase | 14/32 | 21/32 | 22/32 | 23/32 | 20/32 |
| Table number | 17/26 | 18/26 | 18/26 | 19/26 | 13/26 |
| Multi-page | 3/23 | 11/23 | 6/23 | 12/23 | 8/23 |
| Cross-document | 2/20 | 4/20 | 6/20 | 4/20 | 4/20 |
| Cross-lingual, with the translation | 20/26 | 24/26 | 22/26 | 25/26 | 21/26 |
| Cross-lingual, its own query only | 1/26 | 2/26 | 1/26 | 2/26 | 0/26 |
| Near-duplicate | 18/24 | 19/24 | 17/24 | 19/24 | 13/24 |
| **All** | **95/180 (53%)** | **119/180 (66%)** | **112/180 (62%)** | **126/180 (70%)** | **100/180 (56%)** |

- **Keyword search's time,** at 47,897 Passages keeping the top 20: 31 ms median and 72 ms at the 95th percentile, the same ordered by `rank`, with the same Passages for all 231 queries. Reranking took 664 ms (median) a search over keyword search's top 20, and 511 ms over hybrid search's candidates.
- **Indexing,** as that run measured it, can't be read apart: it gave 2,450 s both for keyword search covering every Document and for every Document embedded, because it timed them from Documents' statuses with embeddings on. The embedding model itself spent 2,408 s (19.9 Passages a second). The run now indexes in two passes (see Running it).

## Files

- `run.hard.ts` and `vitest.config.ts`: the run. `../dumps/run.dump.ts` and `../score.ts`: the dumps and the offline scorer (see above).
- `library.json`: the Documents and their sources; `lib/manifest.ts` reads and checks it.
- `lib/fetch.ts`: fetching into the cache, with checksums.
- `questions.json`: the Questions; `lib/questions.ts` reads and checks them, and checks them against the stored text.
- `lib/scoring.ts`: searches, reranking, hits and tallies; `lib/keywordTiming.ts`: keyword search's time per query; `lib/stored.ts`: the stored text each Question is checked against; `lib/citations.ts`: Citations per difficulty; `lib/report.ts`: the reports.
- Tests (`npm test`, no network, no models): `tests/eval/hardLibrary.test.ts`, `tests/eval/hardQuestions.test.ts`, `tests/eval/hardScoring.test.ts`.
