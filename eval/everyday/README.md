# Everyday requests

`npm run eval:everyday` asks a real chat model what Users ask the assistant every day, in English and Chinese, and holds every Answer to the same guards (#893, #894). The owner's own conversation comes first. A model varies, so each request is asked three times, and each must pass at least its floor: two runs in three, or one in three for a hard request. The run fails when a request is under its floor. Neither `npm test` nor CI runs it.

## What each request is held to

`checks.ts`:

- **Asked to write, a Mind changed.** A request for text in a Mind ("write a summary page", "make it longer", "把第二段改得更正式") must change one, not answer in the panel.
- **Every claimed change is real.** A model judges the reply against the record of what the Answer's Tools did (`judge.ts`), apart from the app's own detector, which the report shows next to it.
- **Citations are there**: in the reply, or, for text written into a Mind, in that Mind, where no source may be written as text in brackets, like "[Deck, slide 3]".
- **Every Document is covered**: asked about all the Documents in scope, each is cited, or named in a sentence saying it wasn't covered.
- **Only what was asked changes**: asked about one paragraph, the others read as they did once the Answer's changes are accepted.
- **Changed in place**: asked to make the summary in the Mind longer, it changes that summary rather than adding a second version beside it.
- **About the Question asked**: after the example's Answer, written in advance, the reply says nothing of an earlier Answer or of the example's Documents and figures.

## The requests

`cases.ts`: 52 requests in eight groups. The owner's four turns (2026-10-15). Only the paragraph asked about. Questions about the Documents. Text asked for in a Mind. The User's own text changed. Follow-ups after a write, and after an Answer put into the Mind with Add to note. Several Documents. No Mind in focus. Questions that only sound like requests. Questions asked after the example's Answer, about the User's own Documents (also from the example's own Mind), the two main ones, and a Word file just imported, in the example's language. Each is asked from a Mind of its own, after the requests it follows, in one conversation.

The Documents:

- **papers**: the two arXiv papers of the owner's conversation, 2306.10683v1 and 1609.04846v1. They are fetched once into the evaluation's cache (`$INCARNAMIND_EVAL_CACHE/everyday/`) and checked against their SHA-256, at one request every three seconds, as arXiv asks. They are never committed.
- **reports**: the seven sample PDFs in `data/`.

Documents are added with embeddings off, and searched with the built-in reranking model, as Users have them by default.

## Running it

Setting the variables is the consent to send the requests and Passages to the model:

```sh
INCARNAMIND_EVAL_CHAT_KIND=anthropic \
INCARNAMIND_EVAL_CHAT_MODEL=claude-haiku-5-5 \
INCARNAMIND_EVAL_CHAT_KEY=sk-ant-... \
npm run eval:everyday
```

- `INCARNAMIND_EVAL_EVERYDAY=hard` asks only the hard requests, for a stronger model such as Claude Sonnet 5.5. A list of ids asks only those: `INCARNAMIND_EVAL_EVERYDAY=owner-1,only-second-en`.
- `INCARNAMIND_EVAL_EVERYDAY_RUNS` sets how many times each request is asked (3 by default).
- Another model judges the claims, never the one asked: Claude Sonnet 5.5 on the Anthropic key (Opus 5.5 when Sonnet is asked), or the one `INCARNAMIND_EVAL_JUDGE_KIND`, `_MODEL` and `_KEY` name, which a run on another provider must set. The report says which.
- The report goes into `eval/results/<start time>-everyday/`. `report.md` has the pass rates by language and by request, against each request's floor, the Answers' tokens, then every run's result with its reply and the Blocks it changed. `report.json` has the same data.

**Cost and time, roughly:** on Claude Haiku 5.5, half a minute to a minute and $0.02 to $0.05 a request, so about an hour and a half and $3 to $6 for three runs of all of them. A request that takes over five minutes is stopped and fails.
