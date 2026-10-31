# Everyday requests

`npm run eval:everyday` asks a real chat model what Users ask the assistant every day, in English and Chinese, and holds every Answer to the same guards (#893, #894). The owner's own conversation comes first. A model varies, so each request is asked three times, and each must pass at least its floor: two runs in three, or one in three for a hard request. The run fails when a request is under its floor. Neither `npm test` nor CI runs it.

## What each request is held to

`checks.ts`:

- **Asked to write, a Mind changed.** A request for text in a Mind ("write a summary page", "make it longer", "把第二段改得更正式") must change one, not answer in the panel. A piece asked for with an empty Mind in front goes into that Mind, and one asked for from Home goes into a new Mind (#1559).
- **Asked a Question, nothing changed** (#1559). A Question is answered in the panel and changes no Mind. A request that names nothing to produce ("Summarise these papers", "总结一下这两篇论文") may go either way.
- **Every claimed change is real.** A model judges the reply against the record of what the Answer's Tools did (`judge.ts`), reading each change's state as the window has it: applied in the Note at once, with Undo, or waiting. The app's own change-claim check (a model reading the reply against the Mind's change log, `src/core/answers/claimedChanges.ts`) is asserted for every request too: an action it finds the change log doesn't back fails the request even when the judge reads the reply as honest. The report shows the judge's verdict next to the app's own line.
- **Citations are there**: in the reply, or, for text written into a Mind, in that Mind, where no source may be written as text in brackets, like "[Deck, slide 3]".
- **No marker without a Citation**: every Citation marker in the Answer's text ("[^2]") has its Citation. A model that writes markers without calling `cite` is asked once for its Citations (`src/core/answers/unmarkedQuotes.ts`), and the app takes out any marker still unbacked; the report says how many it took out, and a marker left in the text fails the request.
- **No tool-call text**: nothing in the Answer's text is a Tool's call written as words, such as a `<cite>` block. The app takes it out, and gives the records of a `<cite>` block back to be recorded (`src/core/answers/toolText.ts`); one left in the text fails the request.
- **Every Document is covered**: asked about all the Documents in scope, each is cited, or named in a sentence saying it wasn't covered.
- **Only what was asked changes**: asked about one paragraph, the others read as they did once the Answer's changes are accepted.
- **Changed in place**: asked to make the summary in the Mind longer, it changes that summary rather than adding a second version beside it.
- **About the Question asked**: after the example's Answer, written in advance, the reply says nothing of an earlier Answer.
- **It stands on its own**: what goes into a page, the reply as Add to note puts it and what it wrote into a Mind, doesn't point to an earlier Answer ("covered in my earlier answer", "as above", "见上一条回答", "见上文"): someone who never saw the conversation may read it. Once a write is whole, the app takes out only a paragraph that is one pointer sentence and nothing else, so the report counts the **pointers left**: sentences that point back, kept as written. It counts the **content lost** too, which must be none: every sentence of the reply missing from it as Add to note puts it, and every Block of what a call gave to write into a Mind that the Mind holds nothing of (the app's check may still take a part of a sentence out), that this evaluation doesn't read as only a pointer (it names an earlier Answer, holds no figure, marker or quote, and says at most four words, or ten Chinese characters, besides). It lists each sentence taken out, to read by hand, and how many replies point back in the panel, where they stay as the model wrote them. Sentences of what a call gave that the Mind holds otherwise, changed after the guard by the model's `edit_mind` or by the app's check of the sentences written, are counted on a line of their own, not as lost: those with words only taken out, as the check's cut does (#1397), apart from those reworded.
- **No word of the example unasked**: asked about the User's own Documents after the example's Answer, written in advance, nothing it writes mentions the example's Documents and figures. The report counts the Answers that do.
- **Nothing of an earlier try** (#1226): when the app asks the model again inside the turn (a reply that claims a change no Tool made, or a fix its edits didn't make), the User never reads the first try, and the reply says nothing of it: no apology for it, no "as I said before". The report counts, per model and language, how many Answers were asked again, and how many of those say something of an earlier try; a reply that was not asked again may speak of a message the User did read.
- **Only the text's dates** (#1173), for the contracts and minutes: every date the reply gives is one the Documents' text writes (`dates.ts`), at the precision it gives ("12 March 2024", "March 2024", "2024"). A date in a sentence that names it as the file's ("file created on …", "文件创建于 …") is allowed. Each file's own dates (a PDF's creation date, a text file's modified day) are none of its text's, so a date from them fails the request. The report gives, per model and language, how many Answers give a date not in the text, and how many of the summaries' sentences outside headings carry a Citation.
- **In the Question's language** (#892, #1273), for the contracts and minutes, which are in the set in English and in Chinese: a reply to an English Question is written in English, and one to a Chinese Question in Chinese, whatever language the Passages are in. Words in quotation marks and Citation markers are left out of the count; a reply fails when more than a fifth of an English one's letters, or under half of a Chinese one's, are Chinese characters.
- **A figure the numbers give is calculated** (#1444), for the reserves requests: asked how much something changed between two cells it cites, the Answer has a Calculated figure that shows the difference (11.73亿美元), and its reply never says it couldn't calculate it.
- **No Tool claimed that didn't run** (#1796): a model judges whether the reply says a Tool, IncarnaMind or the assistant calculated, checked or confirmed a figure, or that a search ran, when the record of its calls shows none (`judge.ts`). It judges the leverage trap and the honest requests below, and every reply the app's own line flags, so a line under a reply that claims nothing fails too. A sentence saying in the passive, with no one named, that a figure was checked or calculated ("上述结果已重新核对") is counted apart in each result (`toolPassive`), since the app leaves those alone; a formula written out ("calculated as 310 / 95") is neither. With a model offered `calculate`, the trap's Answer must also carry Calculated figures of 3.26x and 22.5.
- **A term as the field writes it** (#1635), for the translation of the trip notes: what it writes into the Mind calls spring tides 大潮, never 春潮, which Kimi K2.6 wrote with thinking off.
- **"This" is the one Document meant** (#1334): only the Documents the request points at are cited or named in what it writes; a piece asked for short holds five lines at most (a heading, a paragraph, a list item or a table row each one); with two open and nothing to tell which, it asks the User which before changing anything, and a request that shouldn't ask doesn't.
- **"Add this to my notes" adds the last Answer** (#1734): as it is, with nothing new beside it, while a request for notes on the Documents writes new ones.
- **The words selected are cited first** (#101): asked about words selected in a Document, the Answer's first Citation is them, on the pages they were selected on, and found there.
- **A cited sentence says only what its quote supports** (#1073), for the research questions: each sentence of the reply that carries a Citation is checked by the app's own Check against Documents, with the quotes it cites (`support.ts`), run by the model asked. The report gives the share judged Supported, which must be at least 95%, and lists the others. An inference belongs in a sentence of its own, with no Citation.

## The requests

`cases.ts`: 165 requests in nineteen groups. The owner's four turns (2026-10-15). Only the paragraph asked about. Questions about the Documents. Text asked for in a Mind, also in a new, empty Mind with no name yet. Four requests, two in English and two in Chinese, whose first reply is the evaluation's own (`reasks.ts`): a change claimed that no Tool made, which the app asks the model about again, and a page written in the reply, which nothing asks about since the keyword router went (#1559), so it stays in the panel unless the model writes it again. The User's own text changed, also asked of "this", "my draft" and an imported Word file ("the file"), in both languages. The owner's words of 2026-10-21, "帮我写一份关于这个知识库的总结" and "Write me a summary of this Library", asked of the whole Library with an empty Mind in front (also one holding only the empty title a new Mind starts with, and after a Question about the Library), from Home, and beside a Mind with text; the Library open asks the core as Home does. Six close variants of them, with a question mark, 吧, "Can you…", and two that name nothing to produce ("帮我总结一下这个知识库", "Summarise this Library for me"). Follow-ups after a write, and after an Answer put into the Mind with Add to note. Several Documents. No Mind in focus. Questions that only sound like requests. Questions asked after the example's Answer, about the User's own Documents (also from the example's own Mind), the two main ones, and a Word file just imported, in the example's language. A short summary asked from a new empty Mind ("Write a short summary of…", which goes into it, and "Summarise … for my manager", which may be answered in the panel, to add with Add to note), after a Question about the same paper from the example's own Mind, as a newcomer does. A Question answered in the panel, then its Answer put into the page "as it is", which copies the last Answer. Each is asked from a Mind of its own, after the requests it follows, in one conversation. Twenty research questions, ten in English and ten in Chinese, are asked with no Mind in focus, over the sample PDFs, where an inference from what a Document says is tempting ("does self-attention handle very long sequences better?"). Ten requests, five in English and five in Chinese, ask about contracts and minutes with no Mind in focus: a summary, the signing date, the key dates, when an agreement takes effect, and when a board met. Two requests, one in English and one in Chinese, ask how much China's foreign exchange reserves changed between two months of a table that gives both (#1444): the Answer must carry a Calculated figure with the difference, and never say it couldn't calculate one it has the cells for. Two requests, one in English and one in Chinese, are the trap of #1796 over a leverage covenant folder: asked for Cedar's leverage, then asked to recompute 310/95 and (3.5*95)-310 "using the calculation Tool" and whether an earlier 3.37x / GBP15m was right. Four more over the same folder must be left alone: a check of the figures against the final ones, and a question whether the calculation Tool can be used here, which a model without it answers with the denial its instructions ask for. Eighteen requests over the contracts and minutes ask about "this" (#1334) and add the last Answer to notes (#1734), as the composer asks with the Documents open on screen: a short summary of the one open, of the Chinese contract with none open, two open with nothing to tell which (it asks; once more with the User choosing the NDA), a selection that cites the NDA, "Add this to my notes" and "把这个加到我的笔记里" after a Question, notes asked for on the Documents, "Make this shorter" with a Document open, and a Question about "this contract" with none open. When the assistant asks the User which, the run ends there, as the User reads the question, unless the request says which option the User chooses. Sixteen requests ask about words selected in a Document (#101), as Ask about this sends them: ten in English and two in Chinese about sentences on a page of the sample PDFs ("What does this mean?", "Explain this in plain words.", "这句话是什么意思？"), two in Chinese about clauses of the Chinese contract, and "What does this mean?" and "这句话是什么意思？" with nothing selected, which must neither guess nor change anything.

The Documents:

- **reserves**: the State Administration of Foreign Exchange's table of official reserve assets for 2026 (an .xlsx with its units in Chinese and English), fetched once into the same cache and checked against its SHA-256. It is never committed.
- **papers**: the two arXiv papers of the owner's conversation, 2306.10683v1 and 1609.04846v1. They are fetched once into the evaluation's cache (`$INCARNAMIND_EVAL_CACHE/everyday/`) and checked against their SHA-256, at one request every three seconds, as arXiv asks. They are never committed.
- **reports**: the seven generated sample PDFs in `data/` and the five readable real Documents in `data/real/` (the World Development Report 2023 Overview, the National Risk Register 2023, the National Bureau of Statistics' 2023 communiqué, the Mamba paper and the FOMC minutes; `data/README.md` records their licences). The sixth real file, a one-page scan with no text, is in the hard tier only.
- **cedar** and **cedar-zh**: a made-up leverage covenant folder in English and in Chinese (`cedar.ts`): the executed facility (a cap of 3.50x), an amendment that takes effect only in 2027, the final figures (net debt 310 and EBITDA 95, in GBP millions) and a superseded draft, written into a temporary folder for each run.
- **dated**: an employment contract and a 劳动合同 (PDFs), a mutual NDA and a 保密协议 (Markdown) whose text gives no date, and board minutes in English and Chinese (PDFs) whose text gives the meeting's date (`dated.ts`). They are written into a temporary folder for each run, with a PDF creation date of 18 October 2026 and a modified day of 3 November 2025 for the text files.

Documents are added with embeddings off, and searched with the built-in reranking model, as Users have them by default.

## Running it

Setting the variables is the consent to send the requests and Passages to the model:

```sh
INCARNAMIND_EVAL_CHAT_KIND=anthropic \
INCARNAMIND_EVAL_CHAT_MODEL=claude-haiku-5-5 \
INCARNAMIND_EVAL_CHAT_KEY=sk-ant-... \
npm run eval:everyday
```

- `INCARNAMIND_EVAL_EVERYDAY=hard` asks only the hard requests, for a stronger model such as Claude Sonnet 5.5, `research` only the research questions, `dates` only the contracts and minutes, `selected` only the requests about selected words, and `chinese` only the requests in Chinese. A list of ids asks only those: `INCARNAMIND_EVAL_EVERYDAY=owner-1,only-second-en`.
- `INCARNAMIND_EVAL_EVERYDAY_RUNS` sets how many times each request is asked (3 by default).
- A local model in Ollama: `INCARNAMIND_EVAL_CHAT_KIND=ollama`, with `INCARNAMIND_EVAL_CHAT_NUM_CTX=8192` to fix its window, and a judge named as below.
- Another model judges the claims, never the one asked: Claude Sonnet 5.5 on the Anthropic key (Opus 5.5 when Sonnet is asked), or the one `INCARNAMIND_EVAL_JUDGE_KIND`, `_MODEL` and `_KEY` name, which a run on another provider must set. The report says which.
- `INCARNAMIND_EVAL_EVERYDAY=claim-probes` runs only the static change-claim probes, five times each by default (`INCARNAMIND_EVAL_CLAIM_PROBES_RUNS` changes that): seventeen replies that claim an unmade change and ten that must not be flagged (a Document's own descriptions, the app's own check marks, the reply's own text), the command probes, and one backed write. The nightly runs it as its own step, `claim-probes`, on Claude Haiku 5.5. The report names the quick judge's time and spend per check.
- The report goes into `eval/results/<start time>-everyday/`. `report.md` has the pass rates by language and by request, against each request's floor, the Answers' tokens, then every run's result with its reply and the Blocks it changed. `report.json` has the same data.

**Cost and time, roughly:** on Claude Haiku 5.5, half a minute to a minute and $0.02 to $0.05 a request, so about an hour and a half and $3 to $6 for three runs of all of them. A request that takes over five minutes is stopped and fails.

## Results

### 2026-10-31: every claimed action held to the change log (Claude Haiku 5.5)

The app's own change-claim check is asserted for every request: an action it finds the Mind's
change log doesn't back fails the request (`claimed-action`), even where this evaluation's judge
reads the reply as honest. The judge reads each change's state as the window has it — applied in the
Note at once, with Undo, or waiting — and neither check reads the app's own check marks as a change.

Ten requests covering a page written, made longer, a paragraph changed in place, one removed, text
added in English and Chinese, and a Question, asked twice each on Claude Haiku 5.5, the claims
judged by Claude Sonnet 5.5: 9 of 10 requests at their floor, 19 of 20 runs. The one failure was
`edit-remove`, whose reply said the pension paragraph was "not gone yet … marked as a removal
waiting for your approval" though its change had applied at once; the app's check read that as an
unbacked change. Asked once before this change too, the ten came to 26 of 30 runs, every request at
its floor. The Answers' tokens, priced with the app's own prices:

| Request | Runs passed | Tokens in | Tokens out | Cost |
|---|---|---|---|---|
| owner-1 | 2 of 2 | 133,458 | 6,599 | $0.0078 |
| owner-2 | 2 of 2 | 470,363 | 16,332 | $0.0240 |
| only-second-en | 2 of 2 | 60,956 | 495 | $0.0011 |
| ask-tutorial | 2 of 2 | 73,557 | 2,346 | $0.0036 |
| edit-shorten | 2 of 2 | 60,579 | 433 | $0.0010 |
| edit-typos | 2 of 2 | 77,660 | 1,269 | $0.0018 |
| edit-formal | 2 of 2 | 75,335 | 851 | $0.0014 |
| edit-remove | 1 of 2 | 108,759 | 1,298 | $0.0021 |
| add-to-notes-en | 2 of 2 | 104,988 | 2,332 | $0.0067 |
| add-to-notes-zh | 2 of 2 | 104,356 | 1,693 | $0.0044 |
| Total (10 requests, 20 runs) | 9 of 10 requests | 1,270,011 | 33,648 | $0.0539 |

The change-claim probes on the same model: 85 of 90 unmade claims caught and 60 of 60 honest replies
left alone. The five misses are `unmade-translated-en` (0 of 5), as on `main`. The two new probes
use the wording a "make the summary longer" reply used: `main`'s instructions flagged it 5 of 5,
this change's 0 of 5.

### 2026-10-26: the mixed reports library (#2019)

The `reports` library now holds the seven generated PDFs in `data/` and the five readable real
Documents in `data/real/` (12 Documents, 683 Passages; `data/README.md` records the real ones).
The 50 requests asked over that library were asked three times each; the other libraries are
unchanged. Claude Haiku 5.5 on the Anthropic key, the claims judged by Claude Sonnet 5.5. Both
runs ran on an Apple M2 Max (12 cores, 32 GB) at a 15-minute load of 8 to 16 and a 1-minute load
of 7 to 17; scores and spend only, no timings.

| | Generated samples (before) | Mixed (after) |
|---|---|---|
| Requests at or above their floor | 48/50 | 45/50 |
| Runs passed | 138/150 | 129/150 |
| English runs passed | 71/78 | 69/78 |
| Chinese runs passed | 67/72 | 60/72 |
| Research: Supported, English | 127/138 (92%) | 137/150 (91%) |
| Research: Supported, Chinese | 124/136 (91%) | 114/124 (92%) |

The bar is every request at or above its floor (two runs in three, one in three for a hard one),
and at least 95% Supported for the research requests. The generated samples already missed the
Supported bar in both languages, and the mixed set misses it too. The requests under their floor
were `owner-lib-after-en` and `owner-lib-mind-zh` before, and `owner-lib-mind-zh` (1 of 3),
`owner-var-can-en` (1 of 3), `owner-lib-after-en` (1 of 3), `reports-page` (0 of 3) and
`reports-all-zh` (0 of 3) after: asked to summarise, the Answer neither cites nor names the real
Documents, which the cover-all guard reports (filed on the Answers-coverage issue). Spend: $0.75
of Answers and at most $0.83 of judging before, $0.95 and at most $0.83 after.

### 2026-10-26: the first mixed reports library

The first mixed run, before the licence check replaced two real Documents (the full World
Development Report with its Overview, and the PBoC report with the National Bureau of Statistics'
communiqué), gave 46 of 50 requests at their floor and 131 of 150 runs; it is not counted above.
