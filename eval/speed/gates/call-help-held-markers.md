# The gate for call help's Citations, second try (#2847)

Written and committed on 2026-11-08, before any run it gates, together with the slice it runs on (`../callHelpTwins.ts`) and before this try's code. The first try's gate, `call-help-own-markers.md`, failed: Haiku 5.5 lost its Citations when the core stopped placing its records, and Sonnet 5.5's judged right fell with the reply's rule.

## The change, in two parts gated apart

**Part A, the check.** In call help, a Citation shows only where the model wrote its marker, or where its own record's quote holds the words it is placed after.

- **A record the model left unmarked is placed only where its quote holds the claim.** The quote must hold a clause, or a run of clauses, of an option, a reading's quoted moment or a short line:
  - it holds every figure of those words, by kind and unit;
  - it doesn't say the opposite: no word it negates is affirmed there, and no word it affirms is negated there;
  - it holds most of their words.

  The marker goes right after those words. A record that fits no such words shows nowhere, and is never a ✓. It is never placed at a paragraph's end, on a → line or on a reading's own sentence.
- **The core still adds no Citation of its own** to a sentence the model left uncited, from a quotation or a near-duplicate, as the first try had it.
- **Quotations are counted fairly across scripts.** Everywhere the core matches a quotation to a Passage, Chinese or Japanese characters count in pairs, as the Citation card's nearest words already count them ("3 words, or 6 Chinese or Japanese characters"). Today each two neighbouring characters count as a word, so four characters made three words: "律师预期" became a Citation where "lawyer expected" got none. Call help no longer makes those matches, so this gate can't see this part; unit tests hold it, in English and Chinese.

**Part B, the reply's rule:** "A sentence with a Citation marker says only what its quotes state, beside what the User would promise, offer or ask now…", as the first try had it.

## The runs

- **Two paired runs**, as `../README.md` › Paired runs says:
  1. **Part A:** `help-marks-as-before` (main's path, its form reworded to main's word for word) against `help-own-only`, which is this branch with the form reworded the same way, so only the check differs.
  2. **Part B:** `help-own-only` against `today`, which is this branch whole, so only the form differs.
- **The presses:** the fresh slice `call-help-twins`, 15 English cases each with a Chinese twin. No run, prompt or probe has seen them.
- **Models:** Claude Sonnet 5.5 and Claude Haiku 5.5, each as the Answers model, with call help on it. They run on a direct Anthropic key, passed only through the environment. The judge is Claude Opus 5.5 for every arm.
  - If the key runs out of credit, the run goes on with another direct Anthropic key on the same model, noted here with its time.
- **Samples:** one run of every press on each model and in each paired run, within the cap. False Supported is counted over the set (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`).
- **Load:** a run starts only once the 15-minute load is 24 or less.
- **Spend:** about $2.30 for each paired run: a Sonnet pair costs about $0.06–0.10 with the judge, and a Haiku pair about $0.015. The cap for this try is $5, and the ledger (`INCARNAMIND_EVAL_SPEED_LEDGER`, its own for this try) stops a run before the next item once $4.90 is spent. A one-press smoke run may go first, on a call-help set press, never on `call-help-twins`.

## The bar

Counts are of the 15 presses for each model, language and arm.

**Part A ships only if,** on each model and in each language, against `help-marks-as-before`:

- `help-own-only` gives no more presses with a false Supported;
- it gives no fewer presses with the expected Passages cited, judged right, or with every Citation found.

**Part B ships only if,** on each model and in each language, against `help-own-only`, the same holds for `today`.

**The issue's bar** is read on what ships, from the run that has it (`today` if both parts ship, `help-own-only` if only Part A does): on each model, Chinese false Supported is no higher than English's. When it holds, the pull request closes #2847; when it doesn't, it is "Part of #2847" with the numbers.

If a part fails, it doesn't ship; the numbers go on #2847.

**Reported, not held:**

- The time to the first whole option and to the end (medians).
- Every press with a false Supported on any arm, by kind.
- The spend and the load.

## Amendment, 2026-11-09, before any press of `call-help-twins`

**What a smoke press showed.** A one-press Haiku smoke on the call-help set's en-answer-two ($0.02) gave no Citation on the branch. Haiku had written its reply with no Citation and called no `cite`. On main, the core asks the model once for the Citations such a reply left out (`citeUnmarked`), and Haiku's records come from that ask. The first try dropped that ask together with the core's own matches, which is why Haiku's Citations fell there.

**So Part A keeps the ask.** The model's own answer to it is its own record, and it is placed like any unmarked record: only after words its quote holds. The core still matches no quotation or sentence itself.

A unit test holds this in English and Chinese, and fails on main, where the asked records go at the end of the line the model names. The bar is unchanged.

## Second amendment, 2026-11-09, before any press of `call-help-twins`

From the independent pre-review:

- **The held rule is stricter.** Each clause of a run must have 0.7 of its own words in the quote, so a clause the quote doesn't hold never rides on one it does. Figures are read in words too ("sixty days", 百分之二十, 九五折, 六十人), and a negation reaches the next two words or character pairs (没有包含, "no longer available"). Chinese pairs with a character that says little alone (的, 们) count no more than "our" or "the" do. A record is placed only when its quote is found as given.
- **The unit tests of the rule** had first used this slice's Document lines word for word. They were replaced with other made-up lines before any press. No run has seen the slice, and no constant was set from its presses, but the rule's first tests were written having read its Documents.
- **`help-marks-as-before` is main's path except for one thing:** quotations are counted fairly there too, since that count is shared code. On that arm a Chinese quotation of four or five characters is no longer turned into a Citation in call help. This makes main's arm cleaner than main, so the bar only gets harder for the branch.

## Third amendment, 2026-11-09, before any press of `call-help-twins`

The pre-review read the fixes again and found four more ways a record could land on words its quote doesn't hold. Each is fixed, and each has a test that fails without the fix:

- **Figures.** A numeral that starts a common word (一样, 十分) is left as words, so its count is still compared: 十分钟 is no 五分钟, 一个月 no 三个月. A classifier keeps the unit after it: 5 个工作日 is no 5 个月.
- **Negations of a figure.** A negation now reaches a figure: "not $200" against "$200", 不是 200 元 against 是 200 元, 不一样 against 一样.
- **之 and 在** count as words again: 之前 is no 之后.
- **More English negations:** neither, nothing, nobody, nowhere.

**Opposite pairs.** A clause and a quote that each say only one side of a pair of opposites (before/after, 前/后, 以上/以下, 最高/最低 and a few more) never hold, however many words they share.

**Chinese pairs.** A Chinese pair counts as held when both its characters are in the quote, as an English word does wherever it stands. 个 counts no more than "a".

**Known limits that only lose a ✓:**

- A correct negative sentence in another word order can be refused ("Basic doesn't cover refrigerated goods").
- "one" as a pronoun reads as a figure.
- When records exist but none fits, the press asks the model once for its Citations, as main asks whenever a reply shows none.

