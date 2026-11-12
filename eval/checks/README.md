# Checks evaluation: Find support and verify

Labelled sets for Find support (#96) and verify (#97), and the run that scores them end to end (#86): claims extracted, searched for in a Folder, checked, and compared with the labels.

The labels are drafts, written on 2026-10-12, until a person confirms them. Each item has `confirmed: false` until then, and `review` records who confirmed the set and when. Figures from unconfirmed labels are provisional.

## The sets

Every label is in `labels.json`. A sentence or claim is labelled as `CONTEXT.md` defines the results: **supported** when a Passage of the Folder backs all of it, **contradicted** when one says otherwise (another figure, date, party or outcome), and **unsupported** when nothing in the Folder says it either way.

| Set | Language | Supported | Contradicted | Unsupported | All |
|---|---|---|---|---|---|
| Find support | English | 59 | 29 | 20 | 108 |
| Find support | Chinese | 55 | 25 | 20 | 100 |
| Verify | English | 22 | 27 | 36 | 85 |
| Verify | Chinese | 20 | 25 | 35 | 80 |

- **Find support:** 208 sentences as a User might write them about the Folder's Documents, in their own words. The contradicted ones change a figure, date, party or outcome a Document states, often to one that appears nearby for something else (Bag B's weight for Bag A's, the roof package's completion date for the children's library's). The unsupported ones are near misses: about something a Document covers, saying what none of them says. Each has a `note` on what the Folder does say. Eight state a figure no Document states but their numbers give (#707): a share, a fall, a sum and a difference, each right and wrong (`fs-201` to `fs-208`); their evidence is the Passage with the figures, and their `note` the working.
- **Find support by the kind of Document** (supported, contradicted, unsupported): Word 21, 11, 6; PDF 20, 8, 7; PowerPoint 16, 7, 5; Excel 14, 8, 4; web page 12, 4, 5; Transcript 9, 4, 3; Markdown 8, 4, 4; plain text 8, 4, 4; CSV 6, 4, 2.
- **Verify:** 10 documents someone else might send, each about the subject of one or two Folder Documents (see `ATTRIBUTION.md`): five in English and five in Chinese, five PDFs, four Word files and a deck. Each claim is a sentence of its document, quoted as the app extracts its text. The few sentences that claim nothing (thanks, requests, an opinion) have no label. Every contradicted claim has both quotes: the Folder's (`evidence`) and the document's own conflicting words (`contradiction`).

## The Folder

One Folder of 21 Documents, in English and Chinese: the every-format set's 16 files (Word, PowerPoint, Excel, CSV, Markdown, plain text, PDF and Transcripts), a deck and a workbook from `tests/fixtures/formats`, one Chinese Wikipedia article as a PDF, and two web pages saved by their address from the HTML in `web/`. Find support checks against all of them; each received document is checked against them too, never against itself. Sources and licences: `ATTRIBUTION.md`.

## labels.json

- `review`: who confirmed the labels (`by`) and when (`at`, ISO 8601); null until then.
- `folder` and `received`: each Document's `name` (a file's name, a web page's title), `path` from the repository's root, `format`, `language`, `source`, `licence` and the `sha256` of its file. A received document has an `id` and a `kind`; a web page has its `address`.
- `items`: one per sentence or claim:
  - `id` (`fs-001`…, or `vf-01-01`…: the received document, then the claim), `set` (`find-support` or `verify`), `language` (`en` or `zh`);
  - `document`: for Find support, the Folder Document the sentence is about; for verify, the received document, with the claim's `location` and `units` in it;
  - `sentence` or `claim`, and its `label`;
  - `evidence`: the Folder's `document`, `location`, `units` and `quote` that back the sentence or say otherwise; null when unsupported;
  - `contradiction`: for a contradicted claim, where its document says the conflicting words, and those words; null otherwise;
  - `note`: why the label, for the person checking it; `confirmed`.
- **Quotes** are short and exact: each is found, as the Citation check finds a quote (`findQuote`, `src/shared/quoteMatch.ts`), in the text processing stores for its Document, on the Units its Location names. Line breaks inside a PDF's line read as the check reads them.
- **Locations** are worded as the app words them in English (ADR-0011): "p. 1", "slide 4", "§ 2 Costs", "Staffing, row 22", "line 16", "0:12" in a Transcript, "§ Start, ¶ 1" in a web page. `units` are the Unit numbers the check reads.

## Checking the labels

`tests/eval/checkSet.test.ts`, part of `npm test`, processes each Document as the core does (a web page as `saveWebPage` saves it) and checks that every quote, claim and conflicting quote is found at its Location, that the sets have the sizes #86 asks for, and that each file's bytes are the ones labelled. To run it alone:

```sh
npx vitest run tests/eval/checkSet.test.ts
```

When a person changes a label or a quote, the test says which quote isn't found where its Location says. A changed Document fails until its labels are checked again and its `sha256` updated.

## The run

`npm run eval` runs it when a chat model is given (`INCARNAMIND_EVAL_CHAT_*`, see `eval/README.md`); without one, or when `INCARNAMIND_EVAL_QUESTIONS` asks for a short run of the other sets, it says so and stops. `npm run eval -- eval/checks` runs it alone.

1. A temporary data folder, as for the other evaluations. The Folder's files and the received documents are added and the web pages saved, then the Folder's Documents are moved into a Folder. Searches run as the app's do by default: keyword search's top 60, reranked by the built-in model, with embeddings off. The chat model is saved as the app's, and setting the variables is the consent for the "checks" flow.
2. **Find support:** each sentence is checked against the Folder by the app's claim check (`checkClaim`, #96), the check Run Find support runs.
3. **Verify:** each received document's stored text goes to claim extraction. Each claim extracted is checked the same way, with the received document left out (`checked`).
4. The results are scored and written to `eval/results/<start time>-checks/` (`report.md`, `report.json`, `replies.md`), and a summary is printed.

The check is the app's (`corePipeline` in `lib/pipeline.ts`). Claim extraction is still a baseline of one model call (`baselinePipeline`), until verify's extraction (#97) can be called on its own; the run's bars gate then (`GATING` in `checks.eval.ts`). A model that fails, refuses or replies with no verdict leaves the sentence "not checked", which never counts as supported.

Each run makes one extraction call per received document, and a check Run per sentence or claim, about 375 in all: a few requests each (search, cite, the verdict, and the confirmation of a contradiction).

## The judge's replies

Each sentence and claim keeps, beside its outcome, every request the app's check made to the model, in order (`lib/judge.ts`, #2910): the model's reply, its Tool calls (`search_documents`, `cite`, `calculate`) as it wrote them, and for `cite` and `calculate` what the app answered, which says why a record was turned away. The explanation asked for again in the interface's language is its own request (`restate`). A request carries only the model's words and the app's: no key, header or setting, and the Documents are the evaluation's own, made up.

- `report.json` holds them as `outcome.judge`, with each sentence's words and label, so a run reads without the set.
- `replies.md` has a section for each sentence and claim, headed by its id: what the check made of it, then each request with its calls and its reply.

A Not checked has the core's own reason in `outcome.code`. The report and the summary count them by cause, and split the core's "no evidence" by what the replies show:

- **Quote not found:** the app turned the judge's last `cite` away, or nothing shows a calculation was owed.
- **Calculation not made:** no usable calculation where the sentence needed one, and no quote the app turned away: the judge called `calculate` and its figure settled nothing, the app sent it back to calculate and it didn't, or its reply names a calculation it never made. The check turns a quote away before it asks for a calculation, so a quote comes first.
- **Malformed reply:** the core's "malformed", a reply with no verdict that could be read.
- **Other:** every other reason the core gives, such as a refusal, a failed request or a limit.

## Comparing two arms

Run `npm run eval -- eval/checks` on each commit once or more, then compare the results folders (it needs no model and no network):

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/tsResolve.mjs eval/checks/compare.ts \
  --arm main eval/results/<main run 1>-checks eval/results/<main run 2>-checks \
  --arm branch eval/results/<branch run 1>-checks eval/results/<branch run 2>-checks
```

It prints each arm's correct Supported and Contradicted-on-the-wrong-label per run, each arm's Not checked by cause over its runs, and the sentences that flip the same way in every run: one verdict in every run of the first arm, another in every run of the second. Each is listed under its direction (lost Supported first, then gained) with the replies of every run of both arms, and where to find them in `replies.md`. With one run for each arm, a flip may be the run-to-run spread. A results folder written before the replies were kept is refused, naming it.

## Scoring

`lib/scoring.ts`, tested in `tests/eval/checkScoring.test.ts` and, through a core with a scripted model, `tests/eval/checkPipeline.test.ts`.

- **Find support:** precision and recall of "supported" over the 208 sentences, in all, per language and per kind of Document. "Contradicted" is reported too, and how many of the sentences rightly found supported rest on the labelled Passage (its Document and Units).
- **Verify:** an extracted claim is matched to the labelled claim most like it, by its quoted source or its own words: the Dice coefficient of their character pairs, after the check's normalisation and with traditional characters read as simplified, at least 0.5. A labelled claim with no match wasn't extracted.
  - Claims extracted: the share of labelled claims matched.
  - "Contradicted" recall is over the labelled contradicted claims, and a claim that wasn't extracted is a miss. Precision is over the claims a check called contradicted, each labelled claim once; a claim that matches no label counts against it.
- **Bars**, reported only until #96 and #97 exist:

  | Figure | Bar |
  |---|---|
  | Verify: claims extracted | at least 90% |
  | Verify: "contradicted" precision | at least 90% |
  | Verify: "contradicted" recall | at least 70% |
  | Find support: "supported" precision | at least 90% |
  | Find support: "supported" recall | at least 80% |

- **Misses:** `report.md` lists every sentence whose result differs from its label, and every labelled claim not extracted or checked otherwise, with what was found and the labelled evidence; then each claim called contradicted that matches no label, so a person can see whether a label is missing.

## Files

- `labels.json`: the labels. `received/`: the documents to verify. `web/`: the web pages' HTML. `make-fixtures.py`: writes both (see its header for the libraries). `ATTRIBUTION.md`: sources and licences.
- `checks.eval.ts`: the run. `lib/set.ts`: reads and checks `labels.json`. `lib/pipeline.ts`: extraction, search and the check. `lib/scoring.ts`: the scores and bars. `lib/judge.ts`: the replies kept and the causes of a Not checked. `lib/report.ts`: the reports. `compare.ts` and `lib/compare.ts`: the comparison of two arms.
