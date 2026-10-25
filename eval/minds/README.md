# Requests that change several Minds

`npm run eval:minds` asks the assistant, on a real chat model, for changes that reach several Minds in one request, in English and Chinese, and holds every run to what a User would see: the right Minds changed with the right text and nothing else touched, the card's rows and counts, a reply that claims no change that wasn't made, and Accept all, Reject all and Undo (#1781). Neither `npm test` nor CI runs it.

## What it does

1. For each run, a core on a new temporary data folder (never the User's), with the chat model given as a User gives it in Settings and no Documents. The workspace is nine test Minds (`cases.ts`), seeded through the core's public interface:
   - **Weekly update**, **Monthly report**, **Board brief**: a Summary of three sentences and one more section each.
   - **Project plan** (Goals, Milestones, Risks) and **Meeting notes** (Attendees, Decisions, Action items).
   - **Harbour plan**, **Harbour budget**, **Harbour risks**: the word "supplier" in 3, 3 and 2 paragraphs (once in a heading), and **Warehouse notes**, which also says "supplier" and is no one's business.
   - The same nine in Chinese (周报, 月报, 董事会简报, 项目计划, 会议纪要, 港口计划, 港口预算, 港口风险, 仓库笔记).
2. One request in a new conversation, through `askInConversation` as the assistant's composer asks it, from Home or from the Mind in front.
3. Once the Answer has ended, the Minds as the core holds them (the Answer's changes wait there as Proposals, which the window applies), then what the card's buttons do, in this order, reading every Mind from the core after each step: **Reject all**, **Undo**, **Accept all**, **Undo**. They are applied to a copy of each Mind with the functions the card uses (`decideProposals`, a `Y.UndoManager` over the Mind and its requests, `deleteMind` and `restore` for a Mind the Answer made), not through the window (`state.ts`).

Each run uses its own core, so runs can go in parallel (`INCARNAMIND_EVAL_MINDS_PARALLEL`).

## The requests

`cases.ts`: seven, each in English and Chinese.

| Request | Asked from | What must hold afterwards |
|---|---|---|
| `shorten-three`: "Shorten the summary in Weekly update, Monthly report and Board brief to two sentences each." | Home | The three Summary sections have at most two sentences, are shorter, and keep one of their figures; nothing outside them changes |
| `decision-two`: "Today we decided to open the beta to 50 customers. Add that to the Milestones in the Project plan and to the Decisions in the Meeting notes." | Home | Each named section holds "50", and every paragraph already in it reads as it did; nothing else changes |
| `term-three`: "In Harbour plan, Harbour budget and Harbour risks, change “supplier” to “vendor” everywhere." | Home | Every Block of the three reads as it did with the word swapped (“Supplier” too) and nothing else; Warehouse notes is untouched |
| `term-one-open`: the same request | Harbour budget, which is in front; the other two are not open | The same |
| `new-from-two`: "Make a new Mind called Launch brief from my Project plan Mind and my Meeting notes Mind: the milestones from the plan and the decisions from the notes." | Home | One new Mind, titled Launch brief, holding a milestone of the plan and a decision of the notes; both sources unchanged |
| `new-from-two-plain`: the same asked as "a new note … from the Project plan and the Meeting notes", never saying Mind | Home | The same |
| `missing-mind`: "Shorten the summary in my Budget forecast Mind." | Project plan, which is in front | Nothing changes, and the reply (or its question) names Budget forecast |

## What a run is held to

`checks.ts`, in code unless it says a model judges:

- **Exactly the Minds asked for changed**: none missing, none changed without being asked for, none made or gone beyond the one new Mind a request asks for.
- **The right text**: the rule of its request above, on the Minds after Accept all. A text must keep the User's own paragraphs: a rewrite that joins the new decision onto the line above, or rewords a milestone, fails "add".
- **The card**: it lists exactly the Minds that changed (`changedMinds`, which the card is drawn from), a new Mind as new, and each row's count (`changed` plus `wrote`) is the number of paragraphs and headings of that Mind that differ, are added or are removed, counting an added heading either way.
- **The reply claims no change that wasn't made** (a model judges, since a sentence's claim is not something code reads: `eval/everyday/judge.ts` with the extra instructions in `run.minds.ts`). It reads the record the app keeps of what the Tools did, with each change marked as applied at once or waiting for the User as the app tells the model in its own turn. A change that waits is not made: a reply that says it was applied, with nothing about its waiting, is flagged. A question the assistant asked in place of a reply counts as what it said.
- **The Mind that isn't there is named** by the reply or the question.
- **Reject all** leaves every Mind as it was: the same Blocks and title, nothing waiting, a Mind the Answer made gone.
- **Undo** after Reject all and after Accept all brings back every Mind as it was before that step, with its waiting changes marked as they were.
- **Accept all** keeps everything: nothing left waiting, and the text above.

A run that fails to run (the provider's error, no Answer in five minutes) counts as not passed. A busy provider (429, overloaded) is not the assistant's failure: that run is asked again, up to twice.

## What it does not see

- **The window.** The core hands the changes over as Proposals and the window applies them, in one Undo step for each Mind, and draws the line of a Mind that isn't open yet as "opening" (`src/renderer/src/askedChanges.ts`). A Mind not in front is not "not open" here, so a change that reads as done before it applies (#1658) is for the built app's e2e tests. "One of the Minds is open" means the Mind in front of the conversation, which the model reads as `<mind>`.
- **A second request.** Each run is one request in a new conversation, so "make it longer" after a summary (#893) is not asked here.
- **Documents.** The workspace has none, so the model has no search Tool, which it has in a Library.

## Running it

Setting the variables is the consent to send the requests to the model. A judge of claims other than the model asked is needed (Claude Sonnet 5.5 on the Anthropic key by default; on another provider, set `INCARNAMIND_EVAL_JUDGE_*`):

```sh
INCARNAMIND_EVAL_CHAT_KIND=anthropic \
INCARNAMIND_EVAL_CHAT_MODEL=claude-haiku-5-5 \
INCARNAMIND_EVAL_CHAT_KEY=sk-ant-... \
npm run eval:minds
```

Kimi K2.6 sees only this evaluation's made-up Minds: `INCARNAMIND_EVAL_CHAT_KIND=kimi`, `_MODEL=kimi-k2.6`, `_ENDPOINT=intl`, and the judge `INCARNAMIND_EVAL_JUDGE_KIND=anthropic`, `_MODEL=claude-sonnet-5-5`, `_KEY`.

- `INCARNAMIND_EVAL_MINDS`: only these requests (ids, comma separated) or `en` or `zh-CN`.
- `INCARNAMIND_EVAL_MINDS_RUNS`: runs of each request (10).
- `INCARNAMIND_EVAL_MINDS_PARALLEL`: runs at once (1). Times in the report are a run's own, but parallel runs share the provider's capacity.
- `INCARNAMIND_EVAL_MINDS_BUDGET`: stops after the run that takes the spend past this many dollars (3).

The report goes into `eval/results/<start time>-minds/`. `report.md` has the pass count of each request and model against the bar of 9 in 10 runs, the median time to the end of the Answer and the tokens in and out of a run (the rewrites `edit_mind` asks for included), why runs failed, every run's result, and the transcript of every failure: what the model said, called and was told, what the app recorded its Tools doing, the card's rows and the reply. `report.json` has the same, with `rows` in the shape of the everyday evaluation's (`scripts/nightlyRealModel.ts` reads it).

**Cost and time:** 140 runs (ten of each request) take about four minutes and $0.20 on Claude Haiku 5.5, and about nine minutes and $1.20 on Kimi K2.6, three at a time. The judge is a part of that.

## The nightly run

`npm run eval:minds` needs only the variables above, and no key is in the repository. The nightly real-model job (`scripts/nightlyRealModel.ts`) doesn't run it yet. For that, its `STEPS` need an entry that runs `npm run eval:minds` with `INCARNAMIND_EVAL_MINDS_RUNS=3` on Claude Haiku 5.5 (and one on Kimi K2.6 with its judge), and the driver needs to read `report.json` from a `*-minds` folder as it does from `*-everyday`. The secrets are the job's: `NIGHTLY_ANTHROPIC_KEY_1` and `_2`, and `NIGHTLY_KIMI_KEY`, from capped keys.

## Results

The first measurement, 2026-10-24: [RESULTS.md](RESULTS.md).
