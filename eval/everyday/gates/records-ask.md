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
- **Key:** the key slot the lead engineer gives, after the allowance probe, starting only above 90%.
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

### 2026-11-13, before any request this plan gates: two quotes under one marker are counted

- **Added to what the run reads, with no bar:** how often a check reply puts two quotes under one marker on one record line. It is given by arm and language, read from every run's replies in the record.
- **Why it is counted.** The reader can't take such a line. In the saved records the reply gives the next marker a line of its own, so both quotes are the first marker's (#3063). The ask is the only place that can be fixed.

### 2026-11-13, before any request this plan gates: the second reader's six changes, and the cases

1. **The run starts from a `main` that holds #3063.** That pull request adds one form, the cite call written as code. The reader then takes that form on both arms, so an ask counted here is one that would still go out. "What changes" named "#3063's two forms"; it is one form.
2. **Bars 1 and 2 can come out "not settled".**
   - Bar 1 is not settled if `main` has fewer than 4 asks answered with a Document's own reference numbers.
   - Bar 2 is not settled if `main` has fewer than 4 checks with no evidence on the fixed right sentences.
   - Not settled means nothing ships and the numbers go to #3019. A second run is new money and needs a new yes.
3. **Bar 2 is read on the fixed sentences only.** Of the 18 checks of the six right sentences on each arm, it counts how many end with no evidence. The branch must have at most half of `main`'s count. The research Answers' table-row sentences with no evidence are given by language beside it, with no bar: their sentences differ from run to run.
4. **Bar 3, which wrong ✓ counts.** Each ✓ on a wrong twin is listed with whether an evidence ask was sent for it.
   - **Reached through an ask:** it counts, and the bar holds as written: none that `main` didn't give, and no more in all. It counts even when the verdict was the model's own from the start. On `main` that verdict is lost by accident.
   - **Reached with no ask:** that is the same request on both arms. It is listed and read, and not counted against this change.
5. **The six pairs come from two Documents' tables**, listed below.
6. **The script that reads the bars:**
   - It prints what each cell counted, by arm, language and case set, before any bar. An empty cell is an error, never "holds".
   - It uses the language keys as the record writes them ("en", "zh-CN").
   - A run struck as void is left out of the score by the same list that strikes it.
   - The dry run builds every file a reader gets and fails on an empty field.

**Model.** Only Claude Haiku 5.5 is measured; the ask's lines are told to every model. The reading of the conclusion inside a fact part gates nothing and stays as planned above.

**The cases, fixed here.** Each right sentence is one Claude Haiku 5.5 wrote in the saved research records. Each wrong twin changes one figure or swaps two rows. Each sentence of a pair cites the same quotes, the table rows its Answer cited.

| # | Language | Document | Right sentence | Wrong twin | Cites |
|---|---|---|---|---|---|
| 1 | en | Weighted Keys Shorter Paths | Per-layer work: a weighted-key layer costs O(n²d) against O(nd²) for a recurrent layer, where n is sequence length and d is width. | Per-layer work: a weighted-key layer costs O(nd²) against O(n²d) for a recurrent layer, where n is sequence length and d is width. | "Weighted keys O(n2 d) O(1) O(1)"; "Recurrent O(n d2) O(n) O(n)" |
| 2 | en | Weighted Keys Shorter Paths | Its Table 1 lists weighted-key layers at O(1) path length and recurrent layers at O(n). | Its Table 1 lists weighted-key layers at O(n) path length and recurrent layers at O(1). | the same two rows |
| 3 | en | Demonstrations Not Weights | Compute: Table 4 lists the 220B model at 210B tokens and 2,740 accelerator days. | Compute: Table 4 lists the 220B model at 210B tokens and 274 accelerator days. | "220 B 210 B 2,740" |
| 4 | zh-CN | Weighted Keys Shorter Paths | 表 1 中，循环层的运算量是 O(n d²)，加权键层是 O(n² d)。 | 表 1 中，循环层的运算量是 O(n² d)，加权键层是 O(n d²)。 | the same two rows as 1 |
| 5 | zh-CN | Weighted Keys Shorter Paths | 表 1 显示，循环层的顺序步数是 O(n)，而加权键层是 O(1)。 | 表 1 显示，循环层的顺序步数是 O(1)，而加权键层是 O(n)。 | the same two rows as 1 |
| 6 | zh-CN | Demonstrations Not Weights | 文档《Demonstrations Not Weights》给出的是训练算力：220B 模型的训练用了 2,740 个加速器天（accelerator days），训练数据为 210B tokens。 | the same with 274 个加速器天 | "220 B 210 B 2,740" |

**The Passages that hold a number in square brackets:**
- **Weighted Keys Shorter Paths:**
  - p. 3: "A residual connection [1] wraps each sub-layer, and layer normalisation [2] follows it.", the one the saved asks were answered with;
  - p. 8: "Label smoothing of ε = 0.04 [3] was applied throughout.";
  - p. 12: the references [1]–[5].
- **Demonstrations Not Weights:** p. 75, the references [1]–[5].
- Table 1 is on p. 4 and Table 4 on p. 38. Neither table holds a bracketed number.

### 2026-11-13, after the free dry run and before any request this plan gates: bar 2's two kinds, the run's `main`, and the key slot

1. **Bar 2 counts a right sentence's check that ends with no evidence or found elsewhere.**
   - Found elsewhere means its evidence isn't on its own rows. A check that takes a Document's own reference line as its evidence ends so, as the free dry run showed. For the User it is the same failure: the right sentence doesn't end on its own rows.
   - Each check is listed by its kind, by arm and language. A check that holds both kinds is listed as no evidence.
   - Bar 2 is not settled when `main` has fewer than 4 of the two kinds together. The branch must have at most half of `main`'s.
   - The research Answers' table-row count beside it is given by the same two kinds, still with no bar.
2. **The run's `main` is 35c8b3196**, merged into this branch at 33a335624.
   - The `main` arm is built from that commit's `src`, and the run names it.
   - The runner refuses a `main` arm that names another commit, and a branch that doesn't hold it.
   - The bars refuse a `main` arm whose `src` isn't that commit's.
3. **The key slot** is the one the lead engineer gives ("Key" above).
