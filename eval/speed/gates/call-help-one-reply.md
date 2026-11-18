# The gate for call help in one reply (#3354)

The marks below were written on 2026-11-18 before each run they judge, at the times given, and are committed here with the results. The arm is `one-reply` (`../arms.ts`), paired against `today` as `../README.md` › Paired runs says; the judge is Claude Sonnet 5.5, or Claude Opus 5.5 where Sonnet 5.5 is under test.

## The change

A call-help press, or a question typed in the panel during a call, is answered in one request: one JSON object with the Citation records first, then the reply, from the Passages the press already holds (the live transcript and the Documents found ahead). A reply whose `more` says those Passages don't hold what it needs goes on to the Tool loop. Today's path is two requests one after the other (`cite`, then the reply), and no words show before the second writes.

## The marks (21:55Z, before the first run)

The call-help set, 30 presses. C0 for GPT-6.1 Sol is main's two samples of 21:32Z (cited 27 and 26, judged right 25 and 22, every Citation found 30 and 29, false Supported 0 and 2, first whole option 4.3 and 4.5 s, done 4.8 and 4.9 s) and the run's own `today` arm; for the Claude models, the run's `today` arm. It ships for a model only if, over all 30:

- judged right, expected Passages cited and every Citation found are each not below the lowest C0 sample by more than 2;
- false Supported is not above the highest C0 sample by more than 2;
- the median first whole option and the median done are both below every C0 sample;
- replies that show nothing or break the form are not more than today's plus 1.

Typed questions (22:09Z, before their run): `call-help-typed`, 18, the same marks with the run's `today` arm as C0, GPT-6.1 Sol. If they miss, one reply is kept for buttons only.

After the first Claude run (22:29Z, before the second runs): a code change (below), so Sonnet 5.5 and Sol run again, and a model ships only if every mark holds on that run too, C0 now holding every earlier `today` sample of the model.

## Results

| Model, run | First whole option | Done | Cited | Judged right | Every Citation found | False Supported | Verdict |
|---|---|---|---|---|---|---|---|
| Sol (OpenRouter), 1st | 4.4 → 3.6 s | 4.8 → 4.5 s | 25 → 25 | 24 → 24 | 28 → 29 | 1 → 2 | holds |
| Sol, typed questions | — | 4.0 → 2.8 s | 18 → 18 | 16 → 17 | 18 → 18 | 0 → 0 | holds |
| Claude Haiku 5.5 | **0.9 → 1.7 s** | 3.1 → 2.1 s | 26 → 25 | 21 → 23 | 26 → 26 | 14 → 10 | **misses** (speed) |
| Claude Sonnet 5.5, 1st | 4.5 → 2.7 s | 4.5 → 3.3 s | 29 → 28 | 29 → 27 | 29 → 27 | 11 → 8 | holds, at the edge |
| Claude Sonnet 5.5, 2nd | 4.8 → 2.5 s | 4.8 → 3.1 s | **30 → 26** | 29 → 29 | 30 → 28 | 8 → 11 | **misses** (cited) |
| Sol (OpenRouter), 2nd | 4.4 → 3.3 s | 4.7 → 3.8 s | 26 → 24 | 22 → 20 | 30 → 29 | 2 → 3 | holds, at the edge |

No reply on either arm of any run showed nothing or broke the form. Results: `eval/results/speed-paired-2026-11-18T22-07-42-355Z`, `…T22-15-48-857Z`, `…T22-24-08-311Z`, `…T22-41-03-057Z` and `…T22-41-04-775Z`, on this computer only.

- **The change between the runs.** Both of Sonnet's first-run losses were transcript quotes cited to a Passage of the Transcript that doesn't hold them; in the loop `cite` says so and the model fixes the record, and one reply can't be told. So a one-reply record whose named Passage doesn't hold its quote is now cited where another Passage of the same Document holds it, at the time it names where it names one (#2306).
- **What Sonnet still loses on its second run:** a quote whose time is not where the line was said, which the fallback leaves as named (#2306), and twice an option that leaves out the Document's price that today's path cites.
- **Sol, over its two runs:** judged right 46 → 44 and cited 51 → 49 of 60, within main's own spread between two samples of the same path (25 and 22 judged right). On typed questions it was right once more often.

## Listed

GPT-6.1 Sol, as `openai/gpt-6.1-sol` (an OpenAI key, and the ChatGPT plan, which serves OpenAI's models through the same API) and `openrouter/openai/gpt-6.1-sol`. Claude Haiku 5.5 and Claude Sonnet 5.5 stay on the loop. The plan route was timed on screen, not run through this set (#3354).
