# Uncited sentences beside a Passage

The pair set of #3410: an Answer's sentence with no Citation, beside a Passage of a Document, in English and Chinese. Some say what the Passage says, in its words (`same-words`) or in others (`paraphrase`): a Citation of the Passage is right on them. The rest are near-twins that change one thing that matters: the party, may, must or shall, where a negation sits, a number's unit or period, a condition, a direction, or the claim around words quoted from the Passage. A Citation of the Passage is wrong on them. Every Document, name and figure in `pairs.ts` is made up.

A third of the pairs are held out: reports count them and never print them, so a change can't be fitted to them.

## The rules alone, no model

```sh
npx vitest run --config eval/uncited/vitest.config.ts eval/uncited/rules.uncited.ts
```

Each pair's sentence goes through the end of an Answer's citing step (`citeUnmarked` in `src/core/answers/unmarkedQuotes.ts`), as an Answer of one sentence beside its Document's text, the one Passage shown, the one request for Citations not sent. It prints, by kind and language, how many got a Citation code added by itself, and of those that didn't, how many would make the Answer ask the model once for its Citations. Until #3410 two rules there cited an uncited sentence by its words: 46 of the 48 twins, and 6 of the 12 sentences that say the same; since, none. `eval/results/uncited/rules.json` holds each pair's result.

## Through a real Answer

```sh
INCARNAMIND_EVAL_CHAT_KIND=anthropic INCARNAMIND_EVAL_CHAT_MODEL=claude-haiku-5-5 INCARNAMIND_EVAL_CHAT_KEY=… \
INCARNAMIND_EVAL_UNCITED_CAP_USD=0.5 npx vitest run --config eval/uncited/vitest.config.ts eval/uncited/answers.uncited.ts
```

Each pair's sentence is the User's draft in a Note of its own ("Draft for the client: …"), above a Question that asks for it, in a reply, as a note to the client in its own wording, and for what its Document says of another clause. So the Answer restates the sentence, cited by the model or not, once it has read the Document. Asked in the Note, the Note is then checked as Check this Note checks it, on the same model; asked in the assistant, with the Note in focus, the Answer judges its own sentences as it ends, its uncited ones too (#3410). `INCARNAMIND_EVAL_UNCITED_PLACES` takes `note`, `assistant` or both (the default). `INCARNAMIND_EVAL_UNCITED_ONLY` takes pair ids, comma-separated. `eval/results/uncited/answers-<model>.json` holds, for each pair and place, the Answer, the sentence that restates the draft with its Citations, the mark the assistant's judgement gave it when it cites nothing, the check's result for it in the Note, and the requests and time the Answer took.
