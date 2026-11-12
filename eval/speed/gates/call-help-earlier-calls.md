# The gate for call help telling this call from an earlier one (#3005)

Written and committed on 2026-11-12, before any run it gates, with its cases (`../callHelpEarlierCalls.ts`) and its runner (`../earlierCalls.ts`). No run has read the cases, and none of their lines is in a prompt's examples.

## What it gates

In the second pressure test of main, 5 of 69 Chinese call-help replies put an earlier call's words on the live call: "对方问的是留在欧洲" when only the earlier call had said Europe. Every press sends the earlier calls' Transcripts of the Note's Folder, named and dated exactly like this call's, so the model can't tell the calls apart, and the sources under a reply show two identical lines.

The change (commit 85799c87a), in what the model is sent:

- Every Transcript Passage of a call carries its call after its place: this call's `call="this" started="<date and time>"`, an earlier call's `call="earlier" note="<its Note's name>" started="<date and time>"`, the time from `src/shared/dates.ts`. Every block a Passage is shown in goes through the one formatting: `<live-transcript>`, `<found-in-documents>`, search results and a Folder's whole text.
- One instruction line in the system prompt during a call: "A Transcript Passage marked call="this" is this call's. One marked call="earlier" is another call, named by its note and started: it was not said in this call. Say they or you said something only from call="this" lines; give an earlier call's line as said in that call, saying when, and cite it."
- The help buttons' Documents line reads "A Document fact, or an earlier call's line (call="earlier"), was not said in this call", where it read "A Document fact was not said in this call".

And in what the User sees: a cited Transcript in the sources under a reply, and in its chip's title, shows its call's start ("started 09:00", "开始于 09:00") when it is an earlier call's, or when another cited Transcript has the same name.

## The cases

- Two calls with the same buyer, each in a Note of its own in one Folder, both Notes named for the day, as the User's calls with one company pile up. The earlier call is recorded and stopped; then the live call records. Every name, figure and company is made up.
- One pair of calls in English and its twin in Chinese. Each pair runs in both orders, so each call is the earlier one once and the live one once: 4 cases.
- In one call the buyer says their data has to stay in Europe, that they want to start in January and that the budget is twelve thousand a year. In the other the buyer asks where their data would be stored, says they now start in March, and asks whether the budget can be fifteen thousand with onboarding.
- On each live call:
  - "What should I say?" and "Answer their question" are pressed, as the panel presses them. They are the ask bar's first two prompts, and they are sent the Folder's Documents found for the newest lines, an earlier call's Transcript among them; "Sum up so far" and "What do they want?" read this call alone. Neither reply may give what only the earlier call holds as said in this call.
  - "What did they say last time?" (上次他们说了什么？) is typed in the assistant on the live call's Note. The reply must give what the earlier call holds, cited to that call's Transcript.

## The arms

Paired as `../README.md` › Paired runs says, the order turning within each cell:

- `calls-unmarked`, main's path: the core's evaluation switch `callsUnmarked` sends and shows an earlier call's Transcript as before, and leaves out the new instruction lines. `tests/core/` holds that this arm's request is main's, byte for byte.
- `today`, this branch.

## What is read, per item, from `report.json`

The judge reads each reply against both calls' lines (`../earlierCalls.ts`, its `JUDGE`):

- **earlierAsThis**: the reply gives something only the earlier call holds as said, asked or wanted in this call, or as where the other side stands now, without saying it comes from the earlier call. It is the failure `earlier-as-this`.
- **grade**: for a button, right when what it gives the User to say fits this call's newest lines and isn't earlierAsThis; for "last time", right when it gives the earlier call's words as from that call. Partly and wrong as in the call-help set.
- **unstated**: the numbers whose sentence states something its quote doesn't. Those that show ✓ count as false Supported.
- **cited** (the "last time" question only): a found Citation of the earlier call's Transcript.
- **places**, kept for every reply so the judge's reading can be checked against the record: each line or sentence with a Citation, the number it shows, the source line the panel shows for it (its Document, start time and place), whose call its Transcript is (`this`, `earlier` or `other`), its quote and whether the quote was found.

## The bars, per model, on the items both arms finished

1. **Never this call's.** No button reply on the branch is `earlier-as-this`. Main's count is reported beside it. Every `earlier-as-this` on either arm is listed in the results with its reply and its places, and read by hand; the bar counts the judge's verdict as given.
2. **Last time still answered.** On the branch, the "last time" replies graded right or partly and `cited` are no fewer than main's, and at least 6 of the 8 on Claude Haiku 5.5 (two runs) and 3 of the 4 on Claude Sonnet 5.5 (one run).
3. **No worse on this call.** The button replies graded right on the branch are no fewer than main's.
4. **No new false Supported.**
5. **No more items failing to run.**

A bar that fails stops the gate there, and the change doesn't ship as it is.

## Models, judge, keys

- **Claude Haiku 5.5 runs first:** the proof, since 4 of the 5 wrong replies were seen there. Two runs of every item (`INCARNAMIND_EVAL_SPEED_RUNS=2`): 16 button presses and 8 "last time" questions an arm.
- **Claude Sonnet 5.5 runs second,** only if every bar holds on Haiku: the guard that the change doesn't hurt elsewhere. One run: 8 presses and 4 questions an arm.
- **Meant and ran.** The issue names DeepSeek V4.1 Flash 1017 as the second model. This gate runs Claude Sonnet 5.5 in its place, because DeepSeek's key has no credit to spare.
- Each model is the Answers model, with call help on Same as Answers.
- **The judge is Claude Sonnet 5.5** for both models (`INCARNAMIND_EVAL_SPEED_JUDGE=anthropic/claude-sonnet-5-5`). No request of this gate goes to Claude Opus or Claude Fable.
- **One route and one key:** the first direct Anthropic key. Each run holds the key's lock for its whole length, one lock a run, released between the two. Before each run, one smallest request reads the key's allowance from its rate-limit headers; the run starts only above 90%, and the figure is recorded with it.

## Voids, load and the stop

- A run counts only if none of its requests was refused, failed or timed out, read from the outcome of every request in the run's `report.json` (`requests[].outcome`). Otherwise it is void: kept, struck here with the reason, run again, and its numbers not read. A judge's call that throws fails its item as "The judge failed" and voids the run too.
- The runs go strictly one after another, each at a 15-minute load of 24 or less, and the record keeps the one-minute load at its start and end.
- **Spend.** About $0.10 for Haiku (the second call-help marks gate measured its Haiku presses at under $0.001 each; the Sonnet judge here costs about $0.003 a reply) and about $0.55 for Sonnet (about $0.02 a press there). The stop is **$1.50** for both models together, held by one ledger (`INCARNAMIND_EVAL_SPEED_LEDGER`) and `INCARNAMIND_EVAL_SPEED_STOP_USD=1.50`.

## Free first

Before any paid request, `tests/eval/earlierCallsSet.test.ts` runs the set on scripted models and checks:
- each of the 4 cases, English and Chinese, records the earlier call, stops it and records the live one in one Folder, and runs its three items, the typed question cited to the earlier call;
- a press is sent this call's lines in `<live-transcript>` and the earlier call's in `<found-in-documents>`;
- on one case run on both arms, the branch's request marks the earlier call's Passages as an earlier call's and main's arm sends them as before;
- the judge's reading, `cited`, the places and the failure are read as this file says.

## Results

None yet.
