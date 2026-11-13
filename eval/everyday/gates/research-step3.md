# Step 3 of #3019: what the Answer and the check's second look read, gated

Written and committed on 2026-11-13, before any request this plan gates. Every change of plan goes in a dated section below, before the runs it affects. No bar moves after a run.

## What changes

1. **C: what the search didn't find is a sentence of its own, with no Citation.** The Answer's instructions (`src/core/answers/prompt.ts`, `notCovered` and `readingRules`) say so in both languages, and the example that joins the two today ("I didn't find a Board approval in the Documents; the 14 May memo asks for one.") becomes two sentences.
2. **"Only this Document covers it" carries no Citation.** A sentence about what the other Documents don't say is said without a marker, beside C's rule.
3. **I's second look.** An Unsupported part is asked once more when its reply's own words don't hold it up: its Not covered names words that aren't in the part, or its reason says the Passage states the part. The second look sends the same sentence and the same Passages to the same model, the way `plainVerdict.ts` already asks a reply whose fields say "found" and "same". Its later verdict is the model's.
   - **Cap:** at most one second look for each part, so an Answer gets at most as many as its cited sentences have parts. The run reports each Answer's count.
   - A reply whose reason says the Passage doesn't state the part is never asked again.
4. **The evidence ask's wording changes only if a measured need remains.** That means "Missing Citation markers: [1]" read as a Document's own reference still costing 5 or more parts in main's arm of this run. If it does, it is its own change with its own run, not this one.

Nothing else changes what a model reads.

## The run

- **Arms:** main at the commit the run starts from (5fe364b78 or later) and this branch, run as alternating arms: each request is asked of main, then of the branch, in turn.
- **Requests:** `research-attention-long`, `research-gpt3-energy` and their Chinese twins, 6 runs each per arm, so 24 Answers per arm.
- **Models:** Claude Haiku 5.5 for the Answers and the checks, Claude Sonnet 5.5 as judge.
- **Key and leases:** the first direct Anthropic key, under its key lease with the judge lease nested, on the slot the lead gives.
- **Allowance:** the allowance probe first, starting only above 90%.
- **Void rule:** a run with any request refused, failed or timed out is void. It is kept, struck with the reason, run again once, and its numbers aren't read.
- **Pilot:** one run of each request per arm (8 Answers) first, then the rest. Its spend decides whether the whole fits the stop.
- **Stop: US$2.00 in all,** the pilot and one rerun of a void run included.

## Bars, each read against main in the same run

1. **Supported share of judged:** the branch's is no lower than main's, less 12 points. The 12 points come from random halves of main's two saved runs (#3019): unchanged code stays inside them 19 times in 20 at 24 Answers an arm.
2. **Wrong ✓:**
   - **Unstated ✓:** the judge reads every ✓ sentence against the words of its Citations. The branch has no more ✓ the judge finds unstated than main has.
   - **Second-look ✓:** every ✓ that I's second look turns is listed and read by hand. One whose Passage doesn't state the part fails this bar.
   - **The negative beside I's positives:** a sentence whose reason says the Passage doesn't state it stays as it is after the second look. That is a unit test, and every such reply in the run is listed.
3. **H's seven stay Unsupported.** Every sentence that adds a conclusion or a word no Passage states reads Unsupported or Not checked on the branch, never ✓, read by hand from the record.
4. **C:**
   - **Joined absence:** sentences that join a quote to what wasn't found are on the branch under 10% of main's count.
   - **Nothing dropped:** the Answers that say what wasn't found are no fewer on the branch than main's, less 2 of 24. An Answer never drops what it didn't find to keep its marks tidy.
5. **"Only this Document":** no such sentence carries a marker on the branch.
6. **What the second look costs:** reported for both arms, per Answer. That is the requests, the cost and the check's time. It is also each Answer's second-look count against the cap.
7. **The ✓ resting on a record taken from the reply** (#3032) are listed apart for both arms and read by hand.

A failed bar means nothing ships from this run. The numbers and the list of failures go to #3019.

## Changes of plan

### 2026-11-13, before any request this plan gates: I's second look, as the second reader ruled

- **What sets it off.** Only the first reply's Not covered, by a plain comparison. It fires when Not covered names none of the part's own words. The words are read by the Answer's own word reader (`wordsOf`, which tells which sentence a Citation's record supports): words of three letters or more, a word of four or more by its first four letters; numbers; and pairs of Chinese characters. Function words and the phrase's words for the sentence itself are left out. Not covered is compared only in a script the part has words in, so a Chinese part is never held to an English phrase. The other trigger, "its reason says the Passage states the part", is not used: code can't tell it from the reason's free prose without guessing, and a Chinese interface writes that reason in Chinese.
- **The free count behind it**, on main's two saved runs: 35 Unsupported the model gave, read by hand against the Documents. It fires 5 times: 3 on a wrong Unsupported, 2 on a doubtful one, none on a right one, and none of H's seven. Without the four-letter rule it fired 6 times (4, 2 and 0), but the scripted check's "the yearly floods" then fired against "they flood the harbour every year".
- **The second look is the check's own Run, asked again from its start**, with the same sentence, Passages, model and instructions. It is not shown its first reply, nor told what was wrong or which way to answer. It is not #2313's recheck, which "What changes" item 3 named by "the way `plainVerdict.ts` already asks". That recheck tells the model its last check disagreed with itself.
- **Its reply is read as a first reply**, with every guard that takes a ✓ away. A second reply that contradicts itself is Not checked and is asked nothing more. A second whole Unsupported stands. Every other second ask keeps #2816's reading.
- **Reading it.** At about 3 second looks an arm there are too few for a rate. So each one is listed by hand, with the first reply's fields, the second reply's verdict, and whether its ✓ is right. That list is bar 2's "Second-look ✓".
- **The negative**: a reply whose Not covered names the part's own words is never asked again. It is a unit test in both languages (`tests/core/unsupportedSecondLook.test.ts`).
- **The bars are read by one script**, `eval/everyday/arms.ts`, from both arms' report folders. It refuses a void run.
- **The answering prompt grows** by the line on what wasn't found. The run reports the input tokens added to each answering request, read against main's for the same request.

### 2026-11-13, later, before any request this plan gates: I's second look is taken out

The second reader ruled the look out on a free count the trigger above hadn't been shaped on. The count covered 2,718 saved Unsupported with a Not covered line, from earlier check-quality runs: the duty, condition and role probes, and the contradicted-figures checks. Nearly all came from Claude Haiku 5.5, and 11 from Claude Sonnet 5.5. The trigger was counted with the second reader's script rule in: a phrase in one script is never held to the few words of that script inside a sentence written in another.

| | |
|---|---|
| Ask again | 247 of 2,718 (9.1%); 189 distinct sentence-and-phrase pairs, each read by hand |
| Another script | 0 |
| Another sentence | 44 |
| The gap by its kind, or in other words | 145 |
| On a right verdict | 162 of 189 (154 of them contradicted) |
| On a wrong Unsupported | 27, of which 9 are the case the look exists for |

It would give 162 right catches a second chance at a ✓, to mend 9, at 9% more check requests.

- **"What changes" item 3 and the entry above are withdrawn.** There is no trigger, no second Run and no switch, and an Unsupported reply is read as on `main`.
- **Struck bars:** bar 2's "Second-look ✓" and "The negative beside I's positives", and bar 6, "What the second look costs". The check's requests, cost and time are still reported for each arm, for the record, and no bar reads them.
- **Bars 1, 2's "Unstated ✓", 3, 4, 5 and 7 stay as written.** They are read by `eval/everyday/arms.ts`, which also refuses arms that don't hold the same requests, models and languages, and a run with any failed try, a retried one included.
- **The case stays open on #3019:** a wrong Unsupported whose Not covered belongs to another sentence, 9 here and 3 of the 35 on the two saved runs. Its cause comes first: what the check was given when it named another sentence's gap. A second look comes back only with a trigger counted first on records it hasn't seen.
