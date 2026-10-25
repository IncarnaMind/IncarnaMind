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
