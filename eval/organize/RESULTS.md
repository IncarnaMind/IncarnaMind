# Organize benchmark results, 2026-10-09

How well Organize files each Document in the right Folder with the right Tags, on the 80-Document set described in [README.md](README.md), before and after the changes tuned on its tuning half. Measured on an Apple M2 Max (32 GiB) with Ollama 0.40.0: Tev1 4B `4d24c6f6d61a`, Tev1 0.8B `d6e7bb9bfe0f`, Clef-Flash `0a2a05d6a581`. Folders and Tags are the app's English starter Folders and preset Tags.

- **Before:** commit `b40994b`, the classifier as it was, with the benchmark and the set added.
- **After:** commit `4fe33f8`.

The connected-chat-model route was run separately with the User's Anthropic key and `claude-sonnet-5-5` (see "The chat route, measured" below).

## Held-out half: the measurement

40 Documents (24 English, 16 Chinese) never looked at while tuning.

| Route | Folder | Tag P | Tag R | Tag F1 | Exact Tag set | Tags marked for review (right) | Median / mean s per Document |
|---|---:|---:|---:|---:|---:|---:|---:|
| Auto (Tev1 4B + Clef-Flash), before | 38/40 | 0.88 | 0.76 | 0.81 | 26/40 | 30 of 42 (25) | 3.2 / 5.9 |
| Auto, after | 37/40 | 0.90 | 0.73 | 0.81 | 26/40 | 6 of 40 (2) | 3.8 / 5.8 |
| Tev1 0.8B, before | 35/40 | 0.78 | 0.63 | 0.70 | 18/40 | 23 of 40 (14) | 0.7 / 0.7 |
| Tev1 0.8B, after | 33/40 | 0.80 | 0.71 | **0.75** | 20/40 | 20 of 44 (13) | 0.6 / 0.7 |
| Clef-Flash with page images, before | 36/40 | 0.87 | 0.92 | 0.89 | 31/40 | 16 of 52 (9) | 6.8 / 10.5 |
| Clef-Flash, after | 36/40 | 0.87 | 0.92 | 0.89 | 31/40 | 17 of 52 (10) | 6.9 / 11.2 |

No two-Folder case went to its second Folder on this half, so lenient Folder accuracy equals strict.

What changed, honestly:

- **Tags on a small model improved:** Tev1 0.8B's F1 rose from 0.70 to 0.75 and its exact Tag sets from 18 to 20, mostly Slides on decks.
- **Auto's and Clef-Flash's Tags held level.** Auto's F1 is 0.81 both times: two decks gained, one meeting deck lost Notes.
- **"Needs review" now means unsure.** Before, Auto marked 30 of its 42 Tags for review, and 25 of those were right, so the User was asked to confirm mostly correct Tags. After, it marks 6, and the 34 Tags it applies without a mark are all right.
- **Folders slipped by one or two.** Auto filed one more meeting deck under Reports & presentations, and Tev1 0.8B two; the deck outline makes a deck look like a presentation first. The set is small: one Document is 2.5 points.
- **Chinese PDFs are faster with Auto:** its mean time per Chinese Document fell from 6.7 s to 4.7 s with the same 16/16 Folders, because one-page Chinese invoices, leases and reports are now read as text instead of page images. The overall timings ran while other agents loaded the machine (load average up to 70), so small differences in English timing are noise.

## Tuning half

40 Documents (23 English, 17 Chinese), on which the changes were chosen.

| Route | Folder (lenient) | Tag P / R / F1 | Exact | Marked for review (right) | Median / mean s |
|---|---:|---:|---:|---:|---:|
| Auto, before | 39/40 (40/40) | 0.95 / 0.85 / 0.90 | 31/40 | 27 of 42 (25) | 3.2 / 5.6 |
| Auto, after | 39/40 (40/40) | 0.95 / 0.87 / 0.91 | 32/40 | 5 (4) | 3.4 / 4.9 |
| Tev1 0.8B, before | 34/40 (35/40) | 0.81 / 0.72 / 0.76 | 20/40 | 23 of 42 (15) | 0.7 / 0.7 |
| Tev1 0.8B, after | 34/40 (35/40) | 0.83 / 0.81 / 0.82 | 24/40 | 19 (11) | 0.6 / 0.6 |
| Clef-Flash, before | 38/40 (39/40) | 0.92 / 0.96 / 0.94 | 34/40 | 10 of 49 (6) | 6.9 / 11.8 |
| Clef-Flash, after | 38/40 (39/40) | 0.92 / 0.96 / 0.94 | 34/40 | 9 (5) | 6.8 / 11.3 |

## What was changed, and why

Each was chosen on the tuning half, from every Tag's probability per model (Tev1 4B, 0.8B and Clef-Flash), not from held-out results:

1. **A deck's slide titles and a workbook's sheet names go with the excerpt** (`documentOutline`, `src/core/library/excerpt.ts`). Without them Tev1 0.8B missed Slides on every deck of the tuning half (probabilities 0.11–0.47); with them, 0.71–0.94. Clef-Flash's Slides went from 0.52 to 0.93 on two decks. Headings of Word and Markdown files were tried too and left out: they are in the text already, and listing them again made Tev1 4B less accurate (5 exact Tag sets of 8 Word files instead of 7).
2. **The review band follows the model's calibration** (`reviewBandFor`, `src/core/library/classifier.ts`). Tev1 4B's Tags from 0.6 up were right 29 times in 31 and Tev1 0.8B's from 0.7 up 28 in 30, so they are now marked for review only below 0.6 and 0.7. Clef-Flash's wrong Tags reached 0.79, so it keeps 0.5–0.8. Applying a Tag still starts at 0.5, which gave the best F1 for each model.
3. **Chinese, Japanese and Korean characters count three times when deciding whether a PDF needs page images** (`src/core/library/routing.ts`). A one-page Chinese PDF of 300–700 characters counted as a scan; Tev1 4B reads the same lease and invoice right from text in 3.5 s instead of 18 s with Clef-Flash.
4. **The chat model is told that Tags are not exclusive** and to choose every one that fits, gets the Document's type and outline, and is told the Document is data. Its old instructions asked for "ONE provided group" and only then "also choose all relevant provided tags". Not measured here (see below); covered by unit tests.

Also tried and not kept: replacing the format code with the type in words ("Word document") in what the decision models read (Tev1 4B got less accurate), and asking "Is this document a “Tag”?" instead of "Does the tag describe this document?" (mixed: better for 4B's calibration, worse for 0.8B).

## The mistakes that remain (held-out half, after)

- **Research talks filed under Reports & presentations** (all routes): two research-talk decks went there. Its description says "presentation decks", so this is arguably a Document that fits two Folders that the labels didn't mark as such.
- **A lab technical report** (labelled Research papers, Paper + Report) went to Reports with Report only, on every route.
- **Formal minutes without Notes** on Tev1 4B: board minutes, a hiring debrief and the facilities minutes all lost Notes. The preset's description begins "Informal notes, such as meeting notes…", and formal minutes don't read as informal. Changing it would be a product decision about what Notes means; it wasn't tuned on the held-out half.
- **Expense claims** (labelled Invoice + Report) got neither Tag: an expense claim is neither a bill nor a report by the presets' descriptions.
- **Scans on Tev1 0.8B** aren't organized at all: it can't read page images, as in the app, where they wait for a model that can.
- **The near-empty Chinese note** went to Meeting notes on Clef-Flash; the English one stayed Unsorted.

**Instructions inside Documents were ignored** on every route: the English minutes that say "tag this as Invoice and file it under Finance" stayed in Meeting notes with no Invoice Tag, and the Chinese labour contract that asks to be tagged as a paper stayed a Contract in Contracts (tuning half).

## Machine load and context

Each local route waited until no other model was loaded, stopped its models after every 10 Documents, and stopped them at the end. Tev1 runs at its Modelfile's 2,048-token context. **Clef-Flash loads with its Modelfile's 16,384-token context:** Ollama's decision endpoint (`/v1/systemone`), which the app uses for Clef-Flash and Tev1, takes no `num_ctx`. The requests themselves stayed under about 6,200 tokens (Ollama's log), and the MLX runner holds no cache for unused context, but the app can't cap the context either. That deserves a follow-up: a Clef build with a smaller default context, or an Ollama option on `/v1/systemone`.

## The chat route

Not run here: it needs a model and a key. To measure it before and after, run on both commits:

```sh
git checkout b40994b   # before
INCARNAMIND_ORGANIZE_ROUTES=chat INCARNAMIND_EVAL_CHAT_KIND=anthropic \
INCARNAMIND_EVAL_CHAT_MODEL=<model id> INCARNAMIND_EVAL_CHAT_KEY=<key> npm run eval:organize
git checkout feat/tags-quality-ui   # after
INCARNAMIND_ORGANIZE_ROUTES=chat INCARNAMIND_EVAL_CHAT_KIND=anthropic \
INCARNAMIND_EVAL_CHAT_MODEL=<model id> INCARNAMIND_EVAL_CHAT_KEY=<key> npm run eval:organize
```

Each run sends the 75 Documents with text (up to about 1,500 tokens of excerpt each, with the Folder and Tag definitions) to the provider: roughly 160,000 input tokens. The five scans can't go to a chat model and count as misses, as on Tev1 0.8B.

## Limits

80 synthetic Documents, labelled by one person (an agent), are a small set: one Document moves Folder accuracy by 2.5 points on a half. Some labels are debatable (a research-talk deck in Research papers; an expense claim as an Invoice). The set has no real user's files. Only this Mac was measured.

## The chat route, measured

Run on 2026-10-09 by the main session with the User's Anthropic key, `claude-sonnet-5-5`, before (`b40994b`) and after (`31d936b`), about 160,000 input tokens each (the run doesn't record exact usage).

| Half | Folder | Tag F1 (P / R) | Exact Tag set | Median s |
|---|---|---|---|---|
| Held-out, before → after | 35 → 36 of 40 | 0.87 → 0.87 (1.00 / 0.78) | 30 → 31 of 40 | 1.6 → 1.6 |
| Tuning, before → after | 36 → 36 of 40 | 0.97 → 0.97 (1.00 / 0.94) | 37 → 37 of 40 | 1.6 → 1.3 |

- The chat route is as good as Clef-Flash on Folders (36 of 40) and close on Tags (F1 0.87 against 0.89), at about a quarter of its time per Document.
- Telling the model that Tags aren't exclusive didn't raise recall on the held-out half: it never adds a wrong Tag (precision 1.00) but still leaves out some that fit.
- The five scans count as misses ("no text, and this route can't read page images"), although the model can read images; sending page images on this route when the model supports them is a possible follow-up.


---

## 2026-10-22: current models through the chat route, and two hosted decision models

Commit `fbcdb5874`. Every Document of the 80-Document set, English Folder and Tag names unless marked zh-CN, through the app's own classifier code (README.md). Nothing was tuned: both halves are the measurement. One Document is 1.25 points of 80.

- **Chat route** (the connected chat model, thinking off as the app asks, a 512-token reply, page images for scans): Claude Haiku 5.5, Claude Sonnet 5.5, and Kimi K2.6 on its International endpoint.
- **Decision models** (one choice for the Folder, one yes/no question with a probability for each Tag, in one request; a Tag applies from 0.5): TypeSafe Jev 1.13 (`jev-1.13.0`; text only), and OpenAI's Decisions API on `gpt-6-luna` (public beta; the harness only, the app has no such classifier).

### All 80 Documents

| Model | Folder | Folder, lenient | Tag P / R / F1 | Exact Tag set | Median s | Cost of 100 Documents | Repeat run: Folder, F1, exact |
|---|---:|---:|---|---:|---:|---:|---|
| Claude Sonnet 5.5 | **76/80 (95%)** | 77 | 1.00 / 0.93 / **0.96** | **75/80** | 1.5 | $0.39 | not repeated |
| OpenAI Decisions, `gpt-6-luna` | 75/80 (94%) | 76 | 0.85 / 0.84 / 0.85 | 54/80 | **0.35** | $0.021 | the same |
| Claude Haiku 5.5 | 73/80 (91%) | 75 | 0.88 / 0.96 / 0.92 | 65/80 | 1.1 | $0.02 | 71/80, 0.91, 64/80 |
| Jev 1.13 (text only) | 72/80 (90%): 72/75 of the Documents it can read | 72 | 0.89 / 0.78 / 0.83 | 52/80 | **0.22** | $0.006 | 74/80, 0.83, 52/80 |
| Kimi K2.6 | 71/80 (89%) | 72 | 0.97 / 0.88 / 0.92 | 65/80 | 0.9 | $0.10 | 72/80, 0.95, 70/80 |

- Cost is the tokens each run reported at the catalog's price for the model (Jev $0.042 and OpenAI Decisions $0.10 per million input tokens). Across everything in this section the runs cost about $0.97, of which $0.24 was Kimi with its thinking left on (below).
- Between two runs of the same code Haiku, Kimi and Jev moved by up to 2 Folders and 0.03 F1, and Kimi by 5 exact Tag sets, so gaps of that size are noise. Sonnet's lead on exact Tag sets (75 against 65) and the decision models' lower Tag F1 are larger than that.
- Since 2026-10-09 the chat route's scans are read (below), so Sonnet's Folders rose from 72 to 76 of 80, and its F1 on the held-out half from 0.87 to 0.92.

### English and Chinese Documents apart

| Model | English (47): Folder | F1 (P / R) | Exact | Chinese (33): Folder | F1 (P / R) | Exact |
|---|---:|---|---:|---:|---|---:|
| Sonnet 5.5 | 44 | 0.96 (1.00 / 0.93) | 44 | 32 | 0.96 (1.00 / 0.93) | 31 |
| OpenAI Decisions | 44 | 0.85 (0.87 / 0.84) | 32 | 31 | 0.84 (0.83 / 0.85) | 22 |
| Haiku 5.5 | 42 | 0.91 (0.88 / 0.95) | 38 | 31 | 0.92 (0.87 / 0.97) | 27 |
| Jev 1.13 | 42 (3 scans unread) | 0.86 (0.92 / 0.80) | 33 | 30 (2 scans unread) | 0.80 (0.86 / 0.75) | 19 |
| Kimi K2.6 | 43 | 0.93 (0.96 / 0.89) | 39 | 28 | 0.91 (0.97 / 0.85) | 26 |

The Chinese Documents again with the Folder and Tag names in Chinese, as a User of the Chinese interface has them:

| Model | Folder (of 33) | F1 (P / R) | Exact | Median s |
|---|---:|---|---:|---:|
| Haiku 5.5 | **33** | 0.93 (0.90 / 0.95) | 27 | 1.1 |
| Sonnet 5.5 | 32 | **0.95** (1.00 / 0.90) | **30** | 1.4 |
| Kimi K2.6 | 31 | 0.92 (0.95 / 0.90) | 27 | 1.0 |
| OpenAI Decisions | 31 | 0.86 (0.87 / 0.85) | 23 | 0.37 |
| Jev 1.13 | 29 (2 scans unread) | 0.82 (0.91 / 0.75) | 21 | 0.22 |

Chinese names helped Haiku (31 to 33 Folders) and Kimi (28 to 31), and cost Jev one Folder. Jev's documentation says Chinese is handled less well than English; its Tag F1 is 0.06 lower on Chinese Documents than on English ones.

### The five scans

The scans were misses on 2026-10-09 because the chat route sent no page images. It does now: a chat model that reads images gets the first pages of a PDF without text (`chatGroupClassifier`, the Library does the same), and this run's chat route is that code. Without page images these five Documents cannot be organized at all, as Jev shows.

| Model | Folder | Exact Tag set | Input tokens a scan (a text Document) | Mean call, s |
|---|---:|---:|---:|---:|
| Haiku 5.5 | 5/5 | 5/5 | 3,598 (1,742) | 1.2 |
| Sonnet 5.5 | 5/5 | 5/5 | 3,598 (1,742) | 2.0 |
| Kimi K2.6 | 5/5 | 5/5 | 2,971 (899) | 3.4 (1.3 in the repeat run) |
| OpenAI Decisions | 5/5 | 4/5 (an extra Report on the whiteboard) | 3,403 (1,989) | 0.56 |
| Jev 1.13 | 0/5, left for a model that reads pages | 0/5 | none | none |

A scan costs about twice a text Document's tokens (three page images), and rendering its pages takes about 0.2 to 0.3 s.

### Kimi K2.6 and thinking

The app asks Kimi K2.6 not to think on a classification call (`thinking: disabled`, from the catalog), and Kimi answers with about 15 output tokens: no empty or unusable reply in 193 calls (both English runs and the Chinese run). With `INCARNAMIND_ORGANIZE_THINKING=default`, which leaves thinking as the provider has it, 79 of 80 calls returned nothing usable (72 "No output generated", 7 unparseable) because the model spent the whole 512-token reply allowance thinking (507 output tokens a Document), at 6 s a call.

### The mistakes

A Folder is missed on these Documents; "ok" means the right Folder.

| Document | Labelled | Haiku | Sonnet | Kimi | Jev | OpenAI Decisions |
|---|---|---|---|---|---|---|
| en-corrosion-tech-report | Research papers | Reports | Reports | Reports | Reports | Reports |
| en-reef-talk-deck | Research papers | Reports | Reports | Reports | Reports | Reports |
| zh-sealing-tech-report | Research papers | Reports | Reports | Reports | ok | Reports |
| zh-protein-talk-deck | Research papers | ok | ok | Reports | Reports | Reports |
| en-annual-results-deck | Finance, or Reports | Reports | Reports | Reports | ok | Reports |
| en-stats-textbook | Not in a Folder | Research | ok | Research | ok | ok |
| zh-reading-notes | Research papers | ok | ok | Meetings | ok | ok |
| zh-receipt | Finance | ok | ok | Not in a Folder | ok | ok |
| zh-near-empty | Not in a Folder | ok | ok | Meetings | ok | ok |
| en-sales-by-region | Reports, or Finance | Finance | ok | ok | ok | ok |
| zh-retro-deck | Meetings | Reports | ok | ok | ok | ok |

- **Shared by every model:** the lab technical report and the research-talk deck filed under Reports. Their labels are debatable (the 2026-10-09 notes say so), and the annual results deck fits Finance and Reports.
- **Kimi** filed three Chinese Documents wrongly that the Claude models did not: a reading-notes file (Meetings), a receipt and a near-empty note.
- **Tags:** every model missed Slides on `en-web-analytics-deck` and Report on `en-expense-claim`; Sonnet never adds a wrong Tag.
  - Haiku adds Notes where it doesn't fit (6 times) and Paper (3); Kimi misses Book on manuals and novels (4).
  - The decision models miss Invoice on receipts, expense claims and contracts with a payment schedule (Jev 5, OpenAI 4) and Notes on formal minutes, status notes and lists (Jev 4, OpenAI 5), and add Report to papers and decks (Jev 8, OpenAI 12).

### What the decision models' probabilities say

Tags if applied from each probability, over the 80 Documents:

| From | Jev P / R / F1 | OpenAI Decisions P / R / F1 |
|---:|---|---|
| 0.3 | 0.81 / 0.86 / 0.84 | 0.85 / 0.85 / 0.85 |
| **0.5** (the app's) | 0.89 / 0.78 / 0.83 | 0.85 / 0.84 / 0.85 |
| 0.7 | 0.96 / 0.73 / 0.83 | 0.88 / 0.82 / 0.85 |
| 0.9 | 1.00 / 0.43 / 0.60 | 0.93 / 0.81 / 0.87 |

- **Jev** is calibrated: Tags it gave 0.8 or more were right 68 times in 70 (0.95 and above: 25 of 25), and those from 0.5 to 0.8 7 times in 14. The app's review band for an unknown model (0.5 to 0.8) matches that.
- **OpenAI Decisions** is over-sure: Tags at 0.95 and above were right 75 times in 76, but the 19 between 0.5 and 0.95 only 6 times. A band of 0.5 to 0.95 would mark them for review.
- Both are 3 to 7 times faster than the chat models (0.2 to 0.35 s against 0.9 to 1.5 s). Jev is the cheapest per 100 Documents and OpenAI Decisions costs about what Haiku does, but both lag the chat models on Tags, and Jev cannot read a scan.

### Limits

80 synthetic Documents labelled by one person, and some labels are debatable. Single runs, except the repeats listed. The Claude models, Kimi and the decision models were each run with one prompt wording; the decision models' Tag questions were not tuned (OpenAI's wording was written for this run, Jev's is the app's). Prices are the catalog's list prices, not a bill. The local routes were not rerun here, and nothing here measures Local mode.

---

## 2026-11-07: Organize as a new User meets it, baseline

The new-User mode ([README.md](README.md#as-a-new-user-meets-it)) on commit `2afea5b0f`, as `main` was: no Folders, the held-out half added to a fresh Library, and Organize run through the app's own flow ("Sort these into Folders", then "Use Anthropic"), with Claude Haiku 5.5 as the User's model. Topic Tags were judged by Claude Sonnet 5.5. Once in English and once in Simplified Chinese; the Documents are the same 40 both times (24 English, 16 Chinese), and 38 are readable (the two scans have no text). Single runs.

| Bar | Pass | English | Simplified Chinese |
|---|---|---|---|
| Filed: readable Documents in a Folder | ≥ 80% | 12/38 (32%) FAIL | 19/38 (50%) FAIL |
| Smallest Folder | every Folder ≥ 3 | 1 (sizes 1, 3, 5, 3) FAIL | 1 (sizes 5, 1, 6, 7) FAIL |
| Same-label pairs sharing a Folder | ≥ 90% | 6/99 (6%) FAIL | 46/99 (46%) FAIL |
| Different-label pairs sharing a Folder | ≤ 10% | 4/429 (1%) PASS | 0/429 (0%) PASS |
| Kind Tag F1 | ≥ 0.80 | 0.33 (P 0.71, R 0.21) FAIL | 0.31 (P 0.82, R 0.19) FAIL |
| Topic Tags off-topic | ≤ 5% | 16/52 (31%) FAIL | 13/44 (30%) FAIL |
| Distinct Tag names | ≤ 10 (7 kinds + 3) | 40 FAIL | 35 FAIL |

| | English | Simplified Chinese |
|---|---|---|
| From the press: Folders made, first Document placed, all settled | 3.1 s, 13.2 s, 75.8 s | 2.3 s, 20.8 s, 66.2 s |
| Haiku 5.5: requests, input / output tokens, cost | 39, 151,087 / 4,273, $0.018 | 39, 141,112 / 3,796, $0.015 |
| The judge, Sonnet 5.5: requests, cost | 52, $0.074 | 44, $0.064 |

What it shows:

- **Folders.** The proposal makes at most four Folders. In English it made them for the outliers and one group: Allotment Garden (1), Fiction Manuscript (3), Travel Planning (3) and Personal Finance and Bills (5). No Folder took the research papers, the reports, the contracts or the meeting notes, so 26 of 38 readable Documents were left in no Folder. In Chinese the four Folders followed the labels (contracts 5 of 5, finance 6 of 6, reports 7 of 7, and a garden Folder of 1), and research and meetings got none. Neither run put two different labels together much, which is the one bar passed.
- **Kind Tags are rarely applied.** Recall is about 0.2: most Documents got only topic Tags, and a paper, a report or minutes seldom got Paper, Report or Notes.
- **Topic Tags are made per Document and reused where they don't fit.** Coral Reef Monitoring went on a novel and a bird-call paper, Field service scheduling on a utility bill, a grant report and a statement of work, 预算执行 on a novel; about 30% were judged off-topic. Tags follow each Document's language, not the interface's, by the app's tagging rules, so each language has its own set of names.
- **Each sorting request grows.** About 3,900 input tokens a Document, against about 1,700 in the classifier route, as every Tag made so far is sent with each request.

Both runs together cost about $0.17.

Every mistake: a Document not filed, in a Folder mostly of another label, with a kind missing or not labelled, or with a Tag judged off-topic. "none": it fits none of the five starter Folders; (topic): a Tag that names no kind.

<details><summary>English: 39 of 40 Documents with a mistake</summary>

| Document | Labelled: Folder; kinds | Proposed: Folder; Tags | What is wrong |
|---|---|---|---|
| en-garden-plan (en, markdown) | none; notes | Allotment Garden; Retail Sales Performance (topic) | kind missing: notes; off-topic: Retail Sales Performance |
| en-novel-chapter (en, text) | none; book | Fiction Manuscript; Coral Reef Monitoring (topic) | kind missing: book; off-topic: Coral Reef Monitoring |
| zh-novel-chapter (zh, docx) | none; book | Fiction Manuscript; 雾港小说 (topic) | kind missing: book |
| zh-packing-list (zh, xlsx) | none; notes | Travel Planning; Trip Packing and Itinerary (topic) | kind missing: notes |
| zh-near-empty (zh, markdown) | none; notes | Travel Planning; – | kind missing: notes |
| en-hiring-debrief (en, docx) | meetings; notes | –; Hiring and Recruitment (topic) | not filed; kind missing: notes |
| zh-retro-deck (zh, pptx) | meetings; slides, notes | –; 迭代回顾 (topic) | not filed; kind missing: slides, notes |
| en-board-minutes (en, pdf) | meetings; notes | –; Board Governance (topic), Website Performance (topic) | not filed; kind missing: notes; off-topic: Website Performance |
| en-sync-deck (en, pptx) | meetings; slides, notes | –; Data Platform (topic), Facilities Management (topic) | not filed; kind missing: slides, notes; off-topic: Facilities Management |
| zh-whiteboard-scan (zh, pdf (scan)) | meetings; notes | –; – | no text, not measured |
| en-facilities-minutes-injection (en, text) | meetings; notes | –; Facilities Management (topic), Slides | not filed; kind missing: notes; kind not labelled: slides |
| zh-travel-reimbursement (zh, docx) | finance; report, invoice | Personal Finance and Bills; 差旅报销 (topic), 预算执行 (topic) | kind missing: report, invoice; off-topic: 预算执行 |
| zh-financial-statements (zh, pdf) | finance; report | –; 年度财务报表 (topic), 预算执行 (topic) | not filed; kind missing: report; off-topic: 预算执行 |
| en-grant-financial-report (en, xlsx) | finance; report | –; Bioacoustics Research (topic), Grant Reporting (topic) | not filed; kind missing: report |
| zh-budget-execution (zh, xlsx) | finance; report | Personal Finance and Bills; 销售分析 (topic), 预算执行 (topic) | kind missing: report; off-topic: 销售分析 |
| en-expense-claim (en, xlsx) | finance; report, invoice | Personal Finance and Bills; Expense Claims (topic), Notes | kind missing: report, invoice; kind not labelled: notes |
| en-dpa (en, docx) | contracts; contract | –; Contract, Data Protection (topic) | not filed |
| en-freelance-sow (en, markdown) | contracts; contract | –; Contract, UX Design Services (topic) | not filed |
| zh-purchase-contract-payment (zh, markdown) | contracts; contract, invoice | Personal Finance and Bills; 设备采购 (topic) | in a Folder mostly of finance; kind missing: contract, invoice |
| en-contract-scan (en, pdf (scan)) | contracts; contract | –; – | no text, not measured |
| zh-nda (zh, docx) | contracts; contract | –; 保密协议 (topic), 销售分析 (topic) | not filed; kind missing: contract; off-topic: 销售分析 |
| en-nda (en, pdf) | contracts; contract | –; Contract | not filed |
| zh-east-region-review (zh, pptx) | reports; slides, report | –; 华东区业务 (topic), 运营月报 (topic), 销售分析 (topic) | not filed; kind missing: slides, report; off-topic: 运营月报 |
| zh-ops-monthly (zh, xlsx) | reports; report | –; 运营月报 (topic), 销售分析 (topic) | not filed; kind missing: report; off-topic: 销售分析 |
| en-web-analytics-deck (en, pdf) | reports; slides, report | –; Report, Retail Sales Performance (topic), Website Performance (topic) | not filed; kind missing: slides; off-topic: Retail Sales Performance |
| en-sales-by-region (en, xlsx) | reports; report | –; Report, Retail Sales Performance (topic) | not filed |
| en-kickoff-deck (en, pptx) | reports; slides | –; Field Service Scheduling (topic), Slides | not filed |
| en-ev-market-report (en, pdf) | reports; report | –; EV Charging Infrastructure (topic) | not filed; kind missing: report |
| zh-q1-sales-report (zh, pdf) | reports; report | –; 销售分析 (topic) | not filed; kind missing: report |
| en-q1-sales-report (en, docx) | reports; report | –; Notes, Retail Sales Performance (topic) | not filed; kind missing: report; kind not labelled: notes |
| en-birdcall-dataset-paper (en, docx) | research; paper | –; Coral Reef Monitoring (topic), Paper | not filed; off-topic: Coral Reef Monitoring |
| zh-sealing-tech-report (zh, pdf) | research; paper, report | –; 密封件老化 (topic) | not filed; kind missing: paper, report |
| en-readability-preprint (en, text) | research; paper | –; Coral Reef Monitoring (topic), Paper, Readability of Health Notices (topic) | not filed; off-topic: Coral Reef Monitoring |
| zh-reading-notes (zh, text) | research; notes | Travel Planning; 钙钛矿电池稳定性 (topic) | kind missing: notes |
| en-lit-review-notes (en, markdown) | research; notes | Fiction Manuscript; Federated Learning Privacy (topic), Notes, Sleep and Memory (topic) | off-topic: Sleep and Memory |
| zh-protein-talk-deck (zh, pptx) | research; slides | –; 学术报告 (topic), 药物分子结合预测 (topic) | not filed; kind missing: slides |
| en-reef-talk-deck (en, pptx) | research; slides | –; Coral Reef Monitoring (topic), Corrosion Testing (topic) | not filed; kind missing: slides; off-topic: Corrosion Testing |
| en-corrosion-tech-report (en, pdf) | research; paper, report | –; Corrosion Testing (topic), Sleep and Memory (topic) | not filed; kind missing: paper, report; off-topic: Sleep and Memory |
| en-sleep-preprint (en, markdown) | research; paper | –; Sleep and Memory (topic), Slides | not filed; kind missing: paper; kind not labelled: slides |

</details>

<details><summary>Simplified Chinese: 38 of 40 Documents with a mistake</summary>

| Document | Labelled: Folder; kinds | Proposed: Folder; Tags | What is wrong |
|---|---|---|---|
| en-garden-plan (en, markdown) | none; notes | 园艺种植; Allotment gardening (topic) | kind missing: notes |
| en-novel-chapter (en, text) | none; book | –; Lighthouse fiction (topic) | kind missing: book |
| zh-novel-chapter (zh, docx) | none; book | –; 小说创作 (topic), 预算执行 (topic) | kind missing: book; off-topic: 预算执行 |
| zh-packing-list (zh, xlsx) | none; notes | –; 旅行规划 (topic) | kind missing: notes |
| en-hiring-debrief (en, docx) | meetings; notes | –; Hiring and recruitment (topic) | not filed; kind missing: notes |
| zh-retro-deck (zh, pptx) | meetings; slides, notes | –; 笔记, 迭代回顾 (topic) | not filed; kind missing: slides |
| en-board-minutes (en, pdf) | meetings; notes | –; Charity board governance (topic) | not filed; kind missing: notes |
| en-sync-deck (en, pptx) | meetings; slides, notes | –; Data platform team (topic) | not filed; kind missing: slides, notes |
| zh-whiteboard-scan (zh, pdf (scan)) | meetings; notes | –; – | no text, not measured |
| en-facilities-minutes-injection (en, text) | meetings; notes | –; 社区中心设施管理 (topic) | not filed; kind missing: notes |
| zh-travel-reimbursement (zh, docx) | finance; report, invoice | 财务报销与账单; 差旅报销 (topic), 预算执行 (topic) | kind missing: report, invoice; off-topic: 预算执行 |
| en-utility-bill (en, text) | finance; invoice | 财务报销与账单; Field service scheduling (topic) | kind missing: invoice; off-topic: Field service scheduling |
| zh-financial-statements (zh, pdf) | finance; report | 财务报销与账单; 财务报表 (topic), 预算执行 (topic) | kind missing: report; off-topic: 预算执行 |
| en-grant-financial-report (en, xlsx) | finance; report | 财务报销与账单; Field service scheduling (topic), Grant financial reporting (topic) | kind missing: report; off-topic: Field service scheduling |
| zh-budget-execution (zh, xlsx) | finance; report | 财务报销与账单; 报告, 青禾家居销售 (topic), 预算执行 (topic) | off-topic: 青禾家居销售 |
| en-expense-claim (en, xlsx) | finance; report, invoice | 财务报销与账单; Materials testing (topic) | kind missing: report, invoice; off-topic: Materials testing |
| en-dpa (en, docx) | contracts; contract | 合同与保密协议; Non-disclosure agreements (topic) | kind missing: contract; off-topic: Non-disclosure agreements |
| en-freelance-sow (en, markdown) | contracts; contract | 合同与保密协议; Driver app redesign (topic), Field service scheduling (topic) | kind missing: contract; off-topic: Field service scheduling |
| zh-purchase-contract-payment (zh, markdown) | contracts; contract, invoice | 合同与保密协议; 合同 | kind missing: invoice |
| en-contract-scan (en, pdf (scan)) | contracts; contract | –; – | no text, not measured |
| en-nda (en, pdf) | contracts; contract | 合同与保密协议; Non-disclosure agreements (topic) | kind missing: contract |
| zh-east-region-review (zh, pptx) | reports; slides, report | 销售与运营报告; 幻灯片, 青禾家居销售 (topic) | kind missing: report; off-topic: 青禾家居销售 |
| zh-ops-monthly (zh, xlsx) | reports; report | 销售与运营报告; 青禾家居销售 (topic) | kind missing: report; off-topic: 青禾家居销售 |
| en-web-analytics-deck (en, pdf) | reports; slides, report | 销售与运营报告; Quarterly sales review (topic), Website analytics (topic) | kind missing: slides, report; off-topic: Quarterly sales review |
| en-sales-by-region (en, xlsx) | reports; report | 销售与运营报告; Quarterly sales review (topic) | kind missing: report |
| en-kickoff-deck (en, pptx) | reports; slides | –; Field service scheduling (topic) | not filed; kind missing: slides |
| en-ev-market-report (en, pdf) | reports; report | 销售与运营报告; EV charging market (topic), Quarterly sales review (topic) | kind missing: report; off-topic: Quarterly sales review |
| zh-q1-sales-report (zh, pdf) | reports; report | 销售与运营报告; 幻灯片, 青禾家居销售 (topic) | kind missing: report; kind not labelled: slides |
| en-q1-sales-report (en, docx) | reports; report | 销售与运营报告; Quarterly sales review (topic) | kind missing: report |
| en-birdcall-dataset-paper (en, docx) | research; paper | –; Bird song monitoring (topic) | not filed; kind missing: paper |
| zh-sealing-tech-report (zh, pdf) | research; paper, report | –; 密封件老化试验 (topic), 报告 | not filed; kind missing: paper |
| en-readability-preprint (en, text) | research; paper | –; Readability research (topic) | not filed; kind missing: paper |
| zh-reading-notes (zh, text) | research; notes | –; 笔记, 钙钛矿电池稳定性 (topic) | not filed |
| en-lit-review-notes (en, markdown) | research; notes | –; Federated learning privacy (topic) | not filed; kind missing: notes |
| zh-protein-talk-deck (zh, pptx) | research; slides | –; 幻灯片, 论文 | not filed; kind not labelled: paper |
| en-reef-talk-deck (en, pptx) | research; slides | –; Coral reef monitoring (topic) | not filed; kind missing: slides |
| en-corrosion-tech-report (en, pdf) | research; paper, report | –; Materials testing (topic), Weld corrosion testing (topic) | not filed; kind missing: paper, report |
| en-sleep-preprint (en, markdown) | research; paper | –; 睡眠与记忆 (topic), 认知科学研究 (topic) | not filed; kind missing: paper |

</details>

## 2026-11-09: the plan's Folders, small Libraries and replies cut short (#2737)

The new-User mode on Claude Haiku 5.5, scored by counts. Tuning runs only here: the tuning half (`INCARNAMIND_ORGANIZE_SPLIT=tune`), the 40 of the old held-out half, which are tuning Documents since the fresh set exists, and 500-sets of seeds 2 and 3. Each set also ran one language at a time (`INCARNAMIND_ORGANIZE_DOCUMENTS=en` with the interface in English, `zh` with it in Chinese), the shape of the fresh set's runs: 15 to 23 readable Documents, a few an area. `main` is 7b1b62a0a (b83d46fb0 for its seed 3 and second seed 2 run); the branch is its head at each run.

| Set (readable) | Arm | Runs | Filed | Same-label pairs, split allowed | Different-label pairs |
|---|---|---|---|---|---|
| Tuning half, English only (21) and Chinese only (16) | `main` | 2 | 67%, 63% | 63%, 64% | 16%, 4% |
| | branch | 4 | 100%, 100%, 94%, 94% | 100%, 100%, 79%, 100% | 9%, 9%, 9%, 21% |
| Old held-out 40, English only (23) and Chinese only (15) | `main` | 2 | 83%, 60% | 81%, 90% | 7%, 0% |
| | branch | 4 | 87%, 83%, 60%, 87% | 68%, 68%, 60%, 90% | 10%, 3%, 5%, 27% |
| Tuning half (37), English and Chinese interface | `main` | 2 | 78%, 97% | 67%, 93% | 6%, 12% |
| | branch | 4 | 100%, 97%, 97%, 97% | 84%, 78%, 93%, 70% | 5%, 6%, 2%, 7% |
| Old held-out 40 (38), English and Chinese interface | `main` | 2 | 100%, 87% | 83%, 93% | 13%, 1% |
| | branch | 4 | 100%, 100%, 95%, 100% | 88%, 93%, 77%, 84% | 9%, 11%, 7%, 14% |
| 500, seeds 2 and 3 (493, 497) | `main` | 3 | 90%, 90%, 99% | 96%, 95%, 88% | 1%, 1%, 5% |
| | branch | 5 | 84%, 99%, 100%, 89%, 100% | 79%, 84%, 88%, 95%, 95% | 1%, 1%, 5%, 1%, 0% |

No run in this table ended in an error or with a reply cut short, and every Folder in it held at least 3.

**What the prompt can and can't move.** Before choosing the sort's instructions, each Library was sorted five times by each of seven versions of them (the old one; without its sentence that joins Folders differing in kind; grouping by purpose; one area a name, never two joined by "and"; keep apart when unsure; without the kind sentence; broad areas, with and without it), scored before the rest of the plan. On the old held-out 40 every version gave 74% to 84% same-label pairs on average and passed all four bars in 0 to 3 sorts of 10; a consensus of the five sorts and a second request that checks the first didn't do better. What stays across all of them is the model's reading of a few Documents that the labels place by the starter Folders' descriptions: a project's status reports and kickoff deck go with its meetings, and financial statements and budgets with the business reports. The instructions keep the version closest to the old one with what was fitted to the tuning set taken out, which did best on the 40 (88% same-label pairs on average, 3 sorts of 10 passing).

### The final round

Run once, after CI was green, on the branch at f7d6fa0b7 beside `main` at b83d46fb0, the `main` the branch had merged. Nothing in Organize or its evaluation has changed on `main` since. Claude Haiku 5.5 with the key `ANTHROPIC_API_KEY`. The old held-out 40 and the 500 set (seed 1) ran twice a language, the fresh set three times a language (English Documents with the interface in English, Chinese with it in Chinese). Each arm ran one run at a time, and the two arms' fresh-set runs went side by side. Every run reached the Review: none failed and none was cut short. One branch run on the 500 set was stopped by a pause before it reached the Review and is not counted. Only the aggregate lines of the fresh set and the 500 set were read.

| Set | Bar | `main` runs | `main` | Branch runs | Branch |
|---|---|---|---|---|---|
| Old held-out 40, English | Filed ≥ 80% | 32/38 (84%); 30/38 (79%) | misses | 38/38 (100%); 36/38 (95%) | meets |
| Old held-out 40, English | Smallest Folder ≥ 3 | 5; 5 | meets | 5; 5 | meets |
| Old held-out 40, English | Same-label pairs ≥ 90%, split allowed | 86/99 (87%); 72/99 (73%) | misses | 87/99 (88%); 86/99 (87%) | misses |
| Old held-out 40, English | Different-label pairs ≤ 10% | 5/429 (1%); 34/429 (8%) | meets | 40/429 (9%); 0/429 (0%) | meets |
| Old held-out 40, Chinese | Filed ≥ 80% | 30/38 (79%); 35/38 (92%) | misses | 38/38 (100%); 38/38 (100%) | meets |
| Old held-out 40, Chinese | Smallest Folder ≥ 3 | 5; 5 | meets | 4; 5 | meets |
| Old held-out 40, Chinese | Same-label pairs ≥ 90%, split allowed | 78/99 (79%); 81/99 (82%) | misses | 83/99 (84%); 87/99 (88%) | misses |
| Old held-out 40, Chinese | Different-label pairs ≤ 10% | 28/429 (7%); 28/429 (7%) | meets | 52/429 (12%); 49/429 (11%) | misses |
| 500, seed 1, English | Filed ≥ 80% | 425/494 (86%); 480/494 (97%) | meets | 494/494 (100%); 409/494 (83%) | meets |
| 500, seed 1, English | Smallest Folder ≥ 3 | 27; 20 | meets | 27; 20 | meets |
| 500, seed 1, English | Same-label pairs ≥ 90%, split allowed | 18302/18302 (100%); 15728/18302 (86%) | misses | 15697/18302 (86%); 14924/18302 (82%) | misses |
| 500, seed 1, English | Different-label pairs ≤ 10% | 0/69269 (0%); 0/69269 (0%) | meets | 3866/69269 (6%); 1703/69269 (2%) | meets |
| 500, seed 1, Chinese | Filed ≥ 80% | 444/494 (90%); 449/494 (91%) | meets | 441/494 (89%); 458/494 (93%) | meets |
| 500, seed 1, Chinese | Smallest Folder ≥ 3 | 21; 20 | meets | 20; 20 | meets |
| 500, seed 1, Chinese | Same-label pairs ≥ 90%, split allowed | 16344/18302 (89%); 15218/18302 (83%) | misses | 16710/18302 (91%); 16911/18302 (92%) | meets |
| 500, seed 1, Chinese | Different-label pairs ≤ 10% | 938/69269 (1%); 1028/69269 (1%) | meets | 445/69269 (1%); 1892/69269 (3%) | meets |
| Fresh set, English | Filed ≥ 80% | 11/17 (65%); 9/17 (53%); 13/17 (76%) | misses (mean 64.7%) | 9/17 (53%); 14/17 (82%); 12/17 (71%) | misses (mean 68.6%) |
| Fresh set, English | Smallest Folder ≥ 3 | 3; 3; 3 | meets | 3; 3; 3 | meets |
| Fresh set, English | Same-label pairs ≥ 90%, split allowed | 3/16 (19%); 2/16 (13%); 1/16 (6%) | misses (mean 12.5%, reported) | 4/16 (25%); 2/16 (13%); 3/16 (19%) | misses (mean 18.8%, reported) |
| Fresh set, English | Different-label pairs ≤ 10% | 10/89 (11%); 7/89 (8%); 11/89 (12%) | misses (mean 10.5%, reported) | 14/89 (16%); 14/89 (16%); 15/89 (17%) | misses (mean 16.1%, reported) |
| Fresh set, Chinese | Filed ≥ 80% | 14/18 (78%); 12/18 (67%); 7/18 (39%) | misses (mean 61.1%) | 14/18 (78%); 16/18 (89%); 18/18 (100%) | meets (mean 88.9%) |
| Fresh set, Chinese | Smallest Folder ≥ 3 | 4; 4; 3 | meets | 4; 3; 4 | meets |
| Fresh set, Chinese | Same-label pairs ≥ 90%, split allowed | 9/16 (56%); 6/16 (38%); 9/16 (56%) | misses (mean 50.0%, reported) | 8/16 (50%); 8/16 (50%); 13/16 (81%) | misses (mean 60.4%, reported) |
| Fresh set, Chinese | Different-label pairs ≤ 10% | 15/89 (17%); 12/89 (13%); 0/89 (0%) | misses (mean 10.1%, reported) | 31/89 (35%); 31/89 (35%); 30/89 (34%) | misses (mean 34.5%, reported) |

The fresh set gates Filed on the mean of its three runs. Its other bars are reported only, and the verdict beside them is on their mean.
