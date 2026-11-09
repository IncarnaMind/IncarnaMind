# Tags from content

`npm run eval:tagging` measures the Tags automatic tagging gives Documents now that the chat model names them from what the Documents say (#2308), and the Folders Organize proposes where there are none.

## What it runs

The app's own code: each group tagged as one run of the app's (`tagInRun` in `src/core/tags/run.ts`, with `chatClassifier` in `src/core/tags/classify.ts`), as a Re-tag sends it (#2339): one kind each from the fixed list (`src/core/tags/kinds.ts`), named in the group's interface language, and a new topic Tag only where 3 Documents of the group share it, with none of the User's own Tags yet. The walk's files then go through Organize in a core on a temporary data folder, with no Folders (`organizeLibrary`), and what it proposes is read from the Review before anything is confirmed.

## The set

`set.json`, synthetic, as the tagger reads each Document (name, type, the start of its text):

- `tune`, 64 Documents whose results have been read (22 English, 42 Chinese): quotes, estimates, price lists, orders, registrations and notes that mention money, beside real invoices and receipts, donation acknowledgements, contracts, pitch and review decks, plans in workbooks, minutes and more. Tune prompts on these only.
- `heldout`, 40 more, none paired with a tuning Document, fixed before any model read them: they are the measurement.
  - 20 English: a contract, a spec sheet, minutes, lab notes, a tax summary, a recipe, a syllabus, a pitch deck, a hosting invoice, a donation receipt, a purchase order, a packing slip, an itinerary, a job description, a vaccination record, an inspection checklist, a podcast outline, a grant budget, a privacy policy and a talk abstract.
  - 20 Chinese, of other kinds and subjects than the English: a thesis proposal, a product requirements document, a school notice, a sign-up sheet, a takeaway order, parking and taxi e-invoices, a year-end deck, a weekly report, interview notes, an installation guide, a health check report, an adoption agreement, a fund sheet, an essay, a tender notice, a wedding invitation, driving-test notes, a mortgage schedule and a film review.
- `walk`: the 14 files of the 2026-10-31 walk on two subjects, a kitchen renovation and a marathon, four with Chinese names: a countertop quote, notes on tile samples, a race registration and a training-plan workbook among them.

Each Document says whether the Invoice kind fits it (`invoice`), as the preset Invoice Tag's description reads: a bill or receipt for goods or services supplied. So a donation receipt, which says nothing was supplied, is not one and the words one of which in a Tag's name makes its Tags fitting (`fits`). The labels and the split were fixed before any model ran.

## Scores and bars

Per group: non-invoices given the Invoice kind (bar: none), invoices and receipts given it, Documents with a fitting Tag (bar: 90%), new topic Tags named in the interface's language (bar: 95%), Chinese Documents with a Tag in the interface's language (reported), the most Tags on one Document, and the new topic Tags. Each report lists the Documents the word list scored as misses, with their Tags, to read by hand. On the walk: the quote, the notes and the registration not given the Invoice kind, the workbook with a fitting Tag, the Folders Organize proposes (it aims at 3 to 7), and 90% of the Documents in a Folder of their own subject.

## Running it

With no model, to check a run goes through (the scores mean nothing then):

```sh
INCARNAMIND_TAGGING_ROUTE=scripted npm run eval:tagging
```

With a model, as `npm run eval` reads it; setting it is the consent to send the set to it:

```sh
INCARNAMIND_EVAL_CHAT_KIND=anthropic \
INCARNAMIND_EVAL_CHAT_MODEL=claude-haiku-5-5 \
INCARNAMIND_EVAL_CHAT_KEY=sk-ant-... \
npm run eval:tagging
```

`INCARNAMIND_TAGGING_SPLIT` is `heldout` (default), `tune` (or `tuning`) or `all`; the walk always runs. Each run writes `eval/results/tagging/<start time>/report.md` and `results.json` (ignored).
