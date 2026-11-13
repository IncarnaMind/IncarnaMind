# #3019: the ask for a check's missing records, gated

Written and committed on 2026-11-13, before any request this plan gates. Every change of plan goes in a dated section below, before the runs it affects. No bar moves after a run.

## What changes

When a check's verdict names Citation markers but records none the check can take, the check asks for the records again. The ask said only "Missing Citation markers: [1, 2]". Claude Haiku 5.5 then answered with a paper's own reference numbers, "A residual connection [1] wraps each sub-layer, and layer normalisation [2] follows it.", and the sentence ended with no evidence. That was 19 of the 29 table-row sentences with no evidence in the saved records.

The ask now also says:

- **what the markers were for**, in the verdict's own lines: "They are the markers of your verdict's own lines. Evidence: [1, 2]. Covered: …";
- **that a bracketed number inside a Passage isn't one of them**: "A number in square brackets inside a Passage, such as [1], is the Document's own reference, never one of these markers."

That is `evidenceParts` in `src/core/answers/checks/prompt.ts`, sent by `askForEvidence` in `looks.ts`. Nothing else changes what a model reads. The records the reply writes into its text are read as on `main`, with #3063's two forms if it has merged by the run; the run names the `main` commit.

## The run

- **Arms:** `main` at the commit the run starts from, and this branch on top of the same commit. They run as alternating arms: each item is asked of `main`, then of the branch, in turn.
- **Cases, two sets:**
  1. **The four research requests:** `research-attention-long`, `research-gpt3-energy` and their Chinese twins, 6 runs each per arm, so 24 Answers per arm. That is the record of #3019's runs.
  2. **A wrong sentence beside every right one.** Six table-row restatements as Haiku wrote them in the saved records, three English and three Chinese, each with a wrong twin. The twin swaps one figure or one row: "O(n) for weighted keys against O(1) for recurrent layers". Each sentence cites the Answer's own Citation quote for its row and is checked by Check against Documents (`checkClaim`), 3 times per arm. That is 12 sentences, 36 checks per arm. The list is committed with the plan's next entry, before any request, and never changed after.
- **Models:** Claude Haiku 5.5 for the Answers and the checks, and Claude Sonnet 5.5 as judge. Never Fable or Opus.
- **Key:** the key slot cory gives, after the allowance probe, starting only above 90%.
- **Void rule:** a run with any request refused, failed or timed out is void, a retried one included. It is kept, struck with the reason, and run again once; its numbers aren't read. A second void of the same item leaves that pair out on both arms.
- **Free dry run first.** The whole run is played once on the scripted chat model, with no request to any provider: both arms, both case sets, the report and the script that reads the bars. It must give a full report, and the bars read on its fake numbers, before any priced request.
- **Then a priced pilot of three items:**
  1. `research-attention-long` on `main`;
  2. the same on the branch;
  3. one right/wrong pair on both arms.

  Its spend times the run's size must fit the stop, or the run doesn't start and the numbers go to #3019.
- **Size and stop.** The 48 Answers come to about US$1.26 at #3042's measured cost for 24 pairs. The 72 checks of the second set come to about US$0.35 at about US$0.005 a check. The judge comes to about US$0.06. That is **about US$1.70 in all. Stop: US$2.50**, the pilot and one rerun of a void run included.

## Bars, each read against `main` in the same run

1. **Asks answered with a Document's own reference numbers.** An evidence ask counts when its reply's record quotes a bracketed number from a Passage that the sentence doesn't hold. The branch must have at most half of `main`'s count, and at most 2 in all.
2. **Table-row sentences with no evidence.** These are sorted by the rule written for #3019's cause read, before any count: the sentence or one of its quotes holds "O(", or a quote reads as a table row. The branch must have fewer than `main`, given by language.
3. **✓ on wrong sentences must not rise.**
   - **The wrong twins:** the branch gives no wrong twin a ✓ that `main` didn't give it, and no more ✓ on wrong twins in all.
   - **The research Answers:** the judge reads every ✓ sentence against the words of its Citations. The branch has no more ✓ the judge finds unstated than `main` has.
4. **Not checked, by language.** On each arm, the share of cited sentences Not checked, in English and in Chinese, and the gap between them. In neither language may the branch's share be higher than `main`'s by more than 12 points, the spread unchanged code shows at 24 Answers an arm (#3042).

A failed bar means nothing ships from this run. The numbers and the list of failures go to #3019. Every new ✓ on the branch, in either case set, is listed and read by hand, and each doubtful one is named.

## What the run's record also gives: the conclusion inside a fact part

#3062's record keeps, for each cited sentence, the Answer panel's chip beside the part-by-part result, and every run's replies, a Supported sentence's too. From it, the conclusion inside a fact part (kind B on #3019) is read this way, with the rule fixed here, before the run:

- **Which sentences.** Every sentence the part-by-part check counts ✓, on either arm.
- **The reading.** Two readers, blind to the arm, mark each as kind B or not. Kind B means a fact part holds a conclusion, judgement or comparison that its Passage doesn't state: "so…", "points the other way", "its main advantage". A third reader settles any disagreement before the reply is read.
- **For each kind B sentence, three facts from the record:**
  1. whether the panel's chip showed ✓ beside it in the Answer, from `panel.shown`;
  2. whether the check's verdict reply says Supported and names the conclusion under "Not covered" in the same reply, so that code could take the ✓ away;
  3. whether its Not covered names nothing, so only what the check's model is told could change it.
- **What is reported.** Counted by language, with each sentence listed. Nothing is built from it before #3019 rules on it.

## Changes of plan

None yet.
