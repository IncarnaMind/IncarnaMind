# Repeated checks of an unchanged Mind

`npm run eval:repeats` presses Check this Mind again and again on Minds nobody edits, with a real chat model and the app's real search, and counts what each sentence gets each time (#1608). A User who checks the same text twice expects the same verdicts, and never to be told a sentence a Document states wasn't found. Neither `npm test` nor CI runs it.

## What it does

1. A temporary data folder, as for the other evaluations, with the Library of a first run: the example's Documents (`createExamples`) beside the set's own agreement (and, for the conflict Minds, a short flat-and-laptop agreement between the same parties, which only their Library holds), so the search weighs the agreement against other Documents as it does for a newcomer. Documents are added with embeddings off and searched with the built-in reranking model, as Users have them by default. The interface is in the set's language.
2. For each set, a Mind with its sentences, one paragraph each.
3. Check this Mind, as the button does on an unchanged Mind: the first time the model names the claims and checks the new sentences ("changed"), every later time it checks them all ("all"). `INCARNAMIND_EVAL_REPEATS` times (10 by default).
4. After each check, every sentence's result is read from its mark, as the editor reads it, and named by how its card shows it:
   - **supported**, **contradicted**;
   - **partly**: unsupported, and the card says what the Documents support and what they don't, quoting the Passage the check read;
   - **differs**: unsupported, and the card quotes a line that says something different;
   - **absent**: unsupported, and the card says "I didn’t find this in “{scope}”";
   - **not checked**, with why.
5. The report: per set and model, each sentence's outcomes and how many checks gave its most frequent verdict (partly, differs and absent are one verdict, unsupported), false Supported, absent on a sentence the Documents state, the partly-supported card on a sentence whose topic the Documents don't hold, how many checks gave other verdicts than the check before, every result that isn't the expected verdict in the check's own words, and what a sentence's check cost on average: its requests, its searches, how many checks were asked to search again before saying a sentence isn't found (#1608), the tokens and the requests' time. It goes into `eval/results/<start time>-repeats/` (`report.md`, and `report.json` with each check's requests: the searches, the Passages handed and the replies, `requests.ts`).

The cases are in `cases.ts`; `repeat.ts` checks any Mind's sentences in any core, so other sets can use it with their own Documents.

## The sets

An employment agreement in English and a 劳动合同 in Chinese (two-page PDFs, invented for this evaluation), an annual report and a supply agreement in each language for the periods sets, and twelve Minds:

| Set | Sentences |
|---|---|
| `en`, `zh` | The three sentences of #1608 (notice as a paraphrase; holiday with a wrong figure; "Staff" for "the Employee"), the agreement's own words, a car allowance it doesn't mention, and a near miss that names days it doesn't |
| `en-control`, `zh-control` | The home-working clause four ways: a paraphrase about the same Employee, the Employee by name, "Staff" (员工) and "Employees" (职工) |
| `en-conflicts`, `zh-conflicts` | Genuine contradictions of the agreements, one of each kind, each expected Contradicted: a number, a date and a year, a start date and a length of time (the probation, the notice), a negation, a unit (per month for per year), the parties reversed (who reports to whom, who pays whom, employer and employee, seller and buyer, landlord and tenant), a name, a condition (seven days' notice for 24 hours), a scope word ("only during employment"), a place (the governing law), an entitlement turned off, and "unlimited"; in English also the pension shares swapped; in both, a duty for a permission and the reverse ("must" for "may", 须 for 可) in several sentences, and more parties reversed (who keeps whose secrets, who may pay in lieu of notice, who pays the social insurance, who may call whom in); a duty or permission in words other than must, may, 须 and 可 (shall, should and can for may or must, the Employee "entitled to" what the Company may do; 需, 应, 应当 for 可, 可以 for 须, 不得 for 可); and a figure for 2026 ("In 2026 … 25 days"), a year the dated holiday clause covers |
| `en-paraphrases`, `zh-paraphrases` | A clause's duty or permission in other words, each expected Supported: "shall" for "must", "can" for "may", "is entitled to" for "may" and as the agreement says it; 需, 应, 应当, 必须 for 须, 可以 for 可, 不得泄露 for 须保密 |
| `en-near-misses`, `zh-near-misses` | Near misses, each expected not Contradicted: a figure or a detail of another person or role than the agreement's (the Director of People, 人力资源总监, Managers, 经理), and "Staff" (员工) with a detail the agreement doesn't give (named days, a condition, bank transfer); and a holiday figure for 2024, the year before the holiday clause starts, expected "I didn’t find this" |
| `en-periods`, `zh-periods` | An annual report for 2025 with the figures for 2024 beside it, and a supply agreement that runs from 2025 to 2027, in their own Library: a 2024 figure, a fourth-quarter figure and a 2026 delivery, each expected Supported; a wrong 2024 figure and a wrong 2026 price, expected Contradicted; and a 2023 figure, which neither states, expected "I didn’t find this" |

## Running it

Setting the variables is the consent to send the sentences and Passages to the model:

```sh
INCARNAMIND_EVAL_CHAT_KIND=anthropic \
INCARNAMIND_EVAL_CHAT_MODEL=claude-haiku-5-5 \
INCARNAMIND_EVAL_CHAT_KEY=sk-ant-... \
npm run eval:repeats
```

- `INCARNAMIND_EVAL_REPEATS`: checks of each Mind (10).
- `INCARNAMIND_EVAL_REPEATS_SETS`: only these sets, by id (`en,zh`).
- `INCARNAMIND_EVAL_REPEATS_BUDGET`: stops after the check that takes the spend past this many dollars, at the app's own count (5).

## Check against a Document, read whole

`npm run eval:whole-read` checks sentences against invented residential leases of about 40,000 or 120,000 tokens, read whole in ordered windows rather than ranked by search (#1554). English and Chinese clauses sit early, in the middle and late, with paraphrase, near-miss, wrong-figure and absent sentences. The report records every actual verdict, the Citation quote, pages read, requests' seconds and spend, and whether a search would have handed the clause to the model.

Use the same chat variables as above, plus:

- `INCARNAMIND_EVAL_WHOLE_READ_CASES`: only `en-40`, `en-120`, `zh-40` or `zh-120`.
- `INCARNAMIND_EVAL_WHOLE_READ_SENTENCES`: only these sentence keys, such as `pet,rent,deposit`.
- `INCARNAMIND_EVAL_WHOLE_READ_SEARCHED=1`: also run the ordinary ranked-search check for comparison.
- `INCARNAMIND_EVAL_WHOLE_READ_BUDGET`: stop after the check that takes total spend past this many dollars (1).

Setting the variables is consent to send the sentences and the whole lease to the model. The generated PDFs and all other run data stay in temporary folders; the report goes into `eval/results/<start time>-whole-read/`.

**Cost and time:** ten checks of the first four Minds take about 5 minutes and $0.10 on Claude Haiku 5.5, and about 9 minutes and $2.20 on Claude Sonnet 5.5. The two conflict Minds add about 9 minutes and $0.25 on Haiku 5.5, and roughly $4 on Sonnet 5.5 (from the other sets' ratio, not measured), so run them there with fewer checks.

**The conflicts:** a change to a verdict's instructions or to a judgement is measured against the conflicts it loses, not only the near misses it fixes. The report gives "Genuine conflicts Contradicted: n of m", and counts a conflict Supported as a false Supported. A sentence the check misses today is marked with its issue (`knownMiss` in `cases.ts`), stays in its set, and is listed with its counts under a heading of its own, "Known misses (#…)", outside every other count; take the mark off once the issue is fixed. Marked today: near misses about another person or role that the check's first verdict calls contradicted (#1718), the figures for a year the Documents don't cover, which should say "I didn’t find this" (#1765), and the Chinese wrong 2026 price, shown as "says something different" about half the time (#1708).

## The request log, on the scripted model

`npm run eval:repeats` also runs `requests.repeats.ts`, which needs no key, no network and no cost: it checks 14 sentences with a figure, one of them Chinese, 20 times on the scripted model, and prints each sentence's requests as the real run's cost line does (#2256). It fails when a judgement or the evidence the scripted model was asked for is not logged against its sentence, or when a sentence has no request at all; the request that names a whole Mind's sentences is no sentence's and isn't counted. The scripted replies leave 5 of the 14 Not checked — a part whose reply they never answer, no Passage for another's evidence, one verdict with no search — so those sentences' counts are the requests such a check still makes, not verdicts.

## The claims request, asked again and again

Check this Mind asks the model once which of a Mind's sentences make claims, and keeps the answer: a sentence it leaves out isn't checked again until it is edited (#1682). `npm run eval:claims` asks that request again and again, each time on a new Mind of the same sentences, so every request is independent (the app never sorts a sentence twice), with a real chat model, and counts what each request made of each sentence. Nothing is checked, so it is cheap.

- **The claim kinds group** (`KIND_SETS` in `cases.ts`, `en-kinds` and `zh-kinds`): a User's notes on each agreement, three or four claims of each kind the agreement states (a negation, a number, a name, a modal, a party) between seven sentences that make no claim (an opinion said as one and one that isn't, a question, advice, thanks, a request and a proposal). The conflict sets are asked too, each sentence of the kind its key says (`claimKindOf`), and `en-long` and `zh-long`, every sentence of a language's sets in one Mind of about 80, as a long Note is asked.
- **What it counts,** for each set, model and kind: how often a claim isn't named (left out, or undecided when no reply decided it even asked again, which the Mind says it didn't examine) and how often a sentence that makes no claim is named. A sentence with a figure is a claim without asking and isn't shown to the request; the report names those.
- `INCARNAMIND_EVAL_REPEATS`: independent calls on each Mind (20). `INCARNAMIND_EVAL_REPEATS_SETS`: which sets (`en-conflicts,zh-conflicts,en-kinds,zh-kinds` by default). `INCARNAMIND_EVAL_REPEATS_BUDGET`: stops past this many dollars (2).
- **Cost and time:** 100 calls on each of the six Minds cost about $0.15 on Claude Haiku 5.5 and take about 4 minutes; 20 calls on each cost about $0.55 on Claude Sonnet 5.5.

## Scope of a check from a Mind

`npm run eval:scope` checks a Mind that summarises one Document, in a Library of that Document and 5 or 20 other invented Documents, to see whether searching every Document, as a Mind in no Folder does, costs it verdicts. The cases are `unfiled-5`, `filed-5`, `unfiled-20` and `filed-20`: the Mind either in no Folder or filed into the Folder that holds the agreement, with the other Documents outside it. `scoped-5` and `scoped-20` are the Mind in no Folder with the agreement as the Search scope the User set for it in the composer (#1623). The same six with the Chinese 劳动合同 and Documents (`scopeDocumentsZh.ts`) have the prefix `zh-`. `unfiled-no-agreements-17` is the 17 other Documents that remain once the other agreements are left out.

- The Documents are the English agreement of `cases.ts` and the first 5 or all 20 of `scopeDocuments.ts`: two or three more employment agreements in the agreement's layout with other figures, policies an employer keeps, and Documents of other kinds. None states what a sentence says (`tests/eval/scopeScoring.test.ts`). There are no example Documents, so the number of others is exact.
- The sentences are four of the `en` set, worded as there: the notice paraphrase and the agreement's own words, which it states, and the car allowance it doesn't mention and the holiday sentence with a wrong figure, which it doesn't state.
- The report counts, per case and model, the faithful sentences that didn't come back Supported, the other sentences that did, and for every wrong check whether a Passage handed to the model held the clause that settles the sentence. The model's requests are watched for the Passages (`passagesHanded.ts`), and the Passages of each Library are kept in `passages-<case>.json`.
- `INCARNAMIND_EVAL_SCOPE_CASES` picks cases by id, `INCARNAMIND_EVAL_SCOPE_BUDGET` stops the run past that many dollars (1), and `INCARNAMIND_EVAL_REPEATS` is the checks a case (10). Ten checks of one case cost $0.02 to $0.05 on Claude Haiku 5.5 and $0.30 to $0.60 on Claude Sonnet 5.5, a Mind in no Folder the most.

## Results

### 2026-10-30: a sentence with a figure keeps a contradiction whose quote the model never recorded (#2184)

A sentence with a figure is checked figure by figure, and the reply's own verdict on the sentence counts beside its figures. On Claude Haiku 5.5, about one contradicted reply in seven gave no recorded quote: it wrote its record into the reply instead of calling `cite`, most often in a long reply that corrects a first verdict. The figure step then had no quote to judge the contradiction on, and the card showed Unsupported. Now the check asks once for the deciding quote, as it does for a sentence without figures, and judges the contradiction on it. A reply reads as a refusal only when it gives no verdict ("两万元无法核对" is a reason), and the Figures line is never shown as what the Document says.

`npm run eval:repeats`, 20 checks, the 13 sentences with a figure of `en-conflicts` and `zh-conflicts`, each language's as one Mind in that set's Library. Claude Haiku 5.5 through OpenRouter (`anthropic/claude-haiku-5.5`, thinking off), on 2026-10-30. Before is 660aa879e, after 47f1867f8. Both ran without the OpenRouter option that keeps to endpoints supporting every parameter, which makes OpenRouter refuse a forced Tool on Claude (#2248). Counts are Contradicted, Unsupported, Supported and Not checked.

| Sentence | Before | After |
|---|---|---|
| The salary is 65,000 per year, paid monthly in arrears. | 19, 1, 0, 0 | 20, 0, 0, 0 |
| The salary is 61,500 per month. | 17, 3, 0, 0 | 16, 4, 0, 0 |
| The Company pays the Employee a rent of 950 per month for the flat. | 18, 2, 0, 0 | 20, 0, 0, 0 |
| At the end of employment the Employee may sell the work laptop to the Company for 450. | 13, 7, 0, 0 | 18, 2, 0, 0 |
| The Employee is the landlord of the flat at 14 Mill Lane and the Company the tenant. | 18, 2, 0, 0 | 20, 0, 0, 0 |
| Up to 5 unused holiday days must be carried over into the next year. | 19, 1, 0, 0 | 17, 3, 0, 0 |
| The Company contributes 4 percent of salary to the pension and the Employee 6 percent. | 12, 8, 0, 0 | 19, 1, 0, 0 |
| Up to 5 unused days should be carried over into the next year. | 6, 13, 1, 0 | 6, 13, 1, 0 |
| 乙方月工资为人民币两万元。 | 17, 2, 0, 1 | 20, 0, 0, 0 |
| 乙方年工资为人民币一万八千元。 | 9, 11, 0, 0 | 16, 4, 0, 0 |
| 甲方每月向乙方支付租金人民币一千五百元。 | 13, 4, 3, 0 | 13, 2, 5, 0 |
| 劳动合同终止时，乙方可按人民币三千元将笔记本电脑出售给甲方。 | 13, 7, 0, 0 | 19, 1, 0, 0 |
| 乙方将明川路14号2室出租给甲方。 | 19, 1, 0, 0 | 20, 0, 0, 0 |

- **Contradicted:** English 122 of 160 before, 136 after; Chinese 71 of 100 before, 88 after. Sentences Contradicted in at least 19 of 20 checks: 3 of 13 before, 7 after.
- **The reply's last `Verdict:` line against the card:** it said contradicted in 229 checks before and 225 after; the card showed Contradicted in 193 of them before and 224 after. The one left is a contradiction the strict judgement didn't uphold ("must" for "may", judged "neither"). Every other card follows the reply's own last verdict.
- **Not checked:** 1 before (an empty reply), 0 after. Cards that gave the Figures line as what the Document says: 11 before, 0 after.
- **False Supported:** 4 before, 6 after, every one a reply whose last verdict said supported with the parties the same: the Chinese rent payer 3 and 5, "should be carried over" 1 and 1.
- **What stays short of 19 of 20 is the model's own last verdict:** unsupported in 13 checks (the salary "per month" and "年工资" 4 each, the Document's figure for another period taken for a near miss; "should" 3, "must" 1, the English laptop 1), and supported with its Roles line or its figures saying the parties or the duty differ, which the card shows as Unsupported, in 16 ("should" 10, the Chinese rent payer 2, the laptop 1 in each language, "must" 1, the pension shares 1).
- **Cost:** the quote was asked for in 18 of the 260 checks, each one short request, and its contradiction judged twice. $0.55 at OpenRouter's billing for the after run, $0.57 at the app's own count.

### 2026-10-29: every sentence gets its own decision when the claims are named (#1682)

The claims request asked the model for the numbers of the sentences that make claims, and the app took every number it didn't list for a sentence that makes no claim, for good. Now the model decides each sentence ("claim" or "no", by its number), the sentences a reply says nothing of are asked about once more, in one request for their batch, and one still undecided isn't taken for one that makes no claim: it stays to check, the next Check asks about it again, and the line under the check says how many sentences it didn't examine.

`npm run eval:claims`, `main` at 401f7af2f against this version, on the same day; 100 independent calls a Mind on Claude Haiku 5.5, 20 on Claude Sonnet 5.5. A claim is counted wrong when a call doesn't name it; a sentence that makes no claim, when a call names it.

| Model | Language | Kind | `main` | This version |
|---|---|---|---|---|
| Haiku 5.5 | EN | modal | 200 of 2,000 | 200 of 2,000 |
| Haiku 5.5 | ZH | modal | 168 of 2,200 | 8 of 2,200 |
| Haiku 5.5 | ZH | party | 57 of 1,800 | 0 of 1,800 |
| Haiku 5.5 | ZH | other | 1 of 2,400 | 0 of 2,400 |
| Sonnet 5.5 | EN | modal | 40 of 400 | 36 of 400 |

Every other kind (negation, number, name, party, other, and sentences that make no claim), in both languages and on both models, was 0 before and after. The Chinese negation of the conflict set ("试用期内任何一方都不得解除本合同。") was named in 100 of 100 calls on Haiku 5.5 and 20 of 20 on Sonnet 5.5, before and after, so it is an ordinary member of `zh-conflicts` again.

- **What `main` left out:** "公司可以通知林晓在居家工作日到岗。" in 57 of 100 calls, and "林晓应事先与主管商定居家工作的日子。" in 99 of 100 in its Mind and 69 of 100 in the long one (after: 2 and 6 of 100; 1 and 9 in a second run). In other runs of `main` the same day: "The Director of People reports to the Employee." in 17 of 100 and 7 of 40 calls in the long English Mind, which the reply skipped in a run of numbers ("…30, 31, 33, 34…"), and advice and an opinion named in 25 of 700. No call of this version's wording left a sentence undecided: 0 in 2,400.
- **Left out by both:** "Tunde should agree his home-working days with his manager in advance." in every call on Haiku 5.5 and in 36 of 40 on Sonnet 5.5, read as the writer's advice, which the request leaves out (#737). Whether the User's "should" is advice is the opinion rule's question, and #2002 shows the opinions a check leaves out.
- **The request before sentences with figures skipped it** (the commit before #1932, every sentence shown): the list left out "公司可以通知林晓在居家工作日到岗。" in 100 of 100 calls in one version of `zh-kinds` (0 of 100 once two sentences were added before it) and the seven days' notice in 2 of 100; asking for every decision, none of them. There, though, a decision for each left out "Up to 5 unused days should be carried over into the next year." in 59 of 100 calls on Haiku 5.5 (0 with the list). Today that sentence has a figure and isn't asked.
- **Wordings tried,** Haiku 5.5, 20 to 100 calls a Mind:

| Reply | Claims not named | Sentences that make no claim named |
|---|---|---|
| The numbers of the claims (`main`) | as above | 25 of 700 in one run |
| Two lists, claims and every other sentence | 15 of 480 (duties and permissions put in "other") | 0 |
| The numbers of the sentences to leave out | 331 of 3,760 | 0 |
| A decision for each (this version) | as above | 0 |
| The same, and "when unsure, decide claim" | 0 | Sonnet 5.5: a proposal for a meeting in 35 of 60 calls |
| The same, and "a sentence that says what someone must, should or may do is a claim" | "should be carried over" 81 of 100, before #1932 | Sonnet 5.5: thanks in 6 of 20 |
| The same, and "when unsure whether a sentence states something or gives the writer's own view, decide claim" | 0, but the English "should agree" | Haiku 5.5: "总体来看，这份合同还算公平。" in 38 of 100 |

- **The checks, `main` against this version, Haiku 5.5, 10 checks:** `en`, `zh`, `en-control` and `zh-control` gave each sentence the same verdicts but for single checks either way: the near miss about named days Contradicted once after, and a check not checked for a reply with no evidence in 5 checks before and 2 after. Conflicts Contradicted: 230 and 229 of 320 in English, 189 of 300 and 204 of 310 in Chinese, the negation now counted. Sonnet 5.5, 5 checks of the four sets and 2 of the conflict sets: the same verdicts, and 47 and 46 of 64, 45 and 46 of 62. Every sentence of these Minds was named in every check after.
- **Cost and time:** the reply names every sentence, so it is about three times as long (44 to 173 tokens out before, 136 to 454 after); a call on Haiku 5.5 took 0.9 to 1.3 s before and 1.0 to 2.9 s after, on Sonnet 5.5 1.8 to 2.7 s and 2.5 to 3.3 s. A call costs at most $0.0004 on Haiku 5.5 and $0.008 on Sonnet 5.5, once a check for the sentences not sorted before, ahead of the checks it starts.
- **Found on the way:** on `main`, conflicts whose sentence holds a figure ("The salary is 61,500 per month.", "乙方月工资为人民币两万元。", the rent, the laptop, the flat) come back not checked or unsupported in most checks, before and after this change.
- **Spend:** about $21 over this work, Haiku 5.5 and Sonnet 5.5, at the app's own count.

### 2026-10-25: a check searches again before it says a sentence isn't found (#1608)

Before a check says nothing in its scope states a sentence, it asks the model once to search again with other words: the sentence's key terms, a plainer paraphrase, or the Documents' language (`src/core/answers/checks/searchAgain.ts`). The model writes the query. A check that already searched more than once isn't asked, and neither is a reply that says a Passage is about the sentence or names a part one states. When the check finds no Passage about a sentence with no Citation, even after the second search, its card is headed "Not found" (未找到). When it finds one that doesn't back the sentence, the result keeps that (`UnsupportedReason.found`) and the card says "Unsupported", with the check's words. The card, the margin, the health card and the Word comment all decide this by `saysNotFound`. The measurements below were made before the reply's `Topic: found` was taken as a Passage found, which can only mean fewer asks: none was made in them.

**Why a sentence the Documents state came back unsupported.** On `main` at f46093a4c, with every request logged, the deciding clause was among the first search's Passages in every check of these four sets: 160 checks on Claude Haiku 5.5 and 200 on Claude Sonnet 5.5. It was never a search miss. The issue's flip was "Staff…" on Sonnet 5.5, unsupported with no parts so the card said nothing was found. That was the model's first verdict, and since the `Scope` field it gets the partly-supported card in 40 of 40 checks. Where a sentence the agreement states still comes back unsupported, as in `unfiled-20` below, the clause was handed every time: the model reads a sentence that names no party, in a Library of several agreements, as a rule for all of them. The Mind's Search scope (#1623) settles that.

Counts are of checks, `main` and this version, interleaved within three hours on 2026-10-25; another change to the period rule was being measured on `main` in parallel. `main` ran Haiku 5.5 twice.

| | Haiku 5.5 `main` | Haiku 5.5 this version | Sonnet 5.5 `main` | Sonnet 5.5 this version |
|---|---|---|---|---|
| Sentences the agreement states, unsupported (of 40), English | 0; 2 | 0 | 0 | 0 |
| The same, Chinese | 0; 0 | 0 | 0 (1 not checked) | 0 |
| Pairs of checks in a row that agree, of 9: en, en-control, zh, zh-control | 9, 7, 9, 9; 7, 4, 7, 9 | 9, 6, 9, 7 | 9, 9, 7, 9 | 9, 9, 9, 9 |
| Checks asked to search again | | 0 of 200 | | 0 of 200 |

- **The pairs that disagree:** a general word Supported in about 1 check in 10 ("Employees…", 员工…; the `Scope` field, #1708), a near miss Contradicted once, "can" for "may" given the partly-supported card by a `Roles` line that says differs, a quote not found once on Haiku 5.5, and on Sonnet 5.5 a reply with no verdict line (#1673). The ask to search again never ran in these checks, so it can't have caused or fixed any of them.
- **Cost:** none on the common path. On this version a sentence's check took 3.1, 3.1, 2.7 and 2.2 requests on Haiku 5.5 (en, en-control, zh, zh-control), against 3.1, 2.9, 2.7 and 2.3 on `main`. It took 15,300, 17,200, 12,300 and 11,000 tokens in, against 15,300, 16,200, 12,600 and 11,600, and 3.3 to 4.8 s of requests, against 3.4 to 4.1 s. On Sonnet 5.5 it took 4.1, 3.9, 3.4 and 3.0 requests, against 4.1, 4.0, 3.4 and 3.0, and 6.6 to 8.1 s against 7.2 to 8.0 s, and 22,400, 21,800, 15,600 and 16,300 tokens in, against 21,400, 21,800, 16,000 and 16,200. Both models already search twice for a sentence they don't find: the car allowance had two searches or more in all 100 checks of these runs, so an ask would have nothing to add there. When it does run, it is one more request, with the check's own context, before the verdict.
- **The other sets,** Haiku 5.5, 5 checks, `main` against this version. Conflicts Contradicted: 129 and 125 of 145 in English, 114 and 110 of 140 in Chinese. False Supported: 8 and 6 in English, 3 and 0 in Chinese conflicts, 3 and 1 in the Chinese near misses. Results not as expected: paraphrases 5 and 5 (en), 0 and 1 (zh); near misses 5 and 6 (en), 9 and 6 (zh). No check in any of these sets was asked to search again (0 of 415), so the differences are draws.
- **Scope cases,** Haiku 5.5, 10 checks: sentences the agreement states that weren't Supported in `unfiled-20` went from 6 of 20 on `main` to 1 of 20 in English, and from 1 of 20 to 2 of 20 in Chinese. Every one was the partly-supported card with the clause in hand. With the agreement as the Mind's scope it was 0 of 20 in both languages. No check was asked to search again (0 of 160).
- **Spend:** $5.47 at the app's own count: Haiku 5.5 $1.25 (with the scope cases), Sonnet 5.5 $4.22.

### 2026-10-25: figures of their own period, and dates and lengths that stay conflicts (#1765)

New sets and members: the periods sets (`en-periods`, `zh-periods`), and in the conflict sets a start date in another month (in English; the Chinese set had one), a longer probation and a shorter notice. `main` (its check unchanged), Claude Haiku 5.5, 40 checks a sentence, measured on 2026-10-25:

| Sentence | Expected | English | Chinese |
|---|---|---|---|
| A 2024 figure of the report's comparatives | Supported | 40 of 40 | 38 of 40 (1 partly, 1 not checked) |
| A fourth-quarter figure of the 2025 report | Supported | 40 of 40 | 40 of 40 |
| A 2026 delivery under the 2025–2027 agreement | Supported | 40 of 40 | 37 of 40 (3 partly) |
| A wrong 2024 figure | Contradicted | 40 of 40 | 37 of 40 (3 says something different) |
| A wrong 2026 price | Contradicted | 39 of 40 | 18 of 40 (19 says something different, 3 partly), known miss (#1708) |
| A 2023 figure neither Document states | "I didn’t find this" | 7 of 40 (33 says something different), known miss | 27 of 40 (8 partly, 5 says something different), known miss |
| The start date (another year, another month), the carry-over deadline, the probation and notice lengths, "only during employment" | Contradicted | 40 of 40 each | 40 of 40 each |

- The 2024 holiday sentences of the near-miss sets are known misses too: "I didn’t find this" in 0 of 20 checks in each language (partly 12 and 16, says something different 8 and 4).
- A field in the check's reply for the period (the sentence's period, inside or outside the Documents', with the check reading "outside" as not found) was tried on the same Documents and left out. On Haiku 5.5 it gave the 2024 sentences "I didn’t find this" in 20 of 20 checks in each language and lost no Supported figure of the periods sets, but it took a date the sentence states as its own detail for the period the claim holds for: "The Employee starts on 11 January 2028." became "I didn’t find this" in 20 of 20 checks (乙方自2028年1月11日起入职。 7 of 20). Worded with examples of a start date and a length of time as no period, it still did in 16 and 15 of 20; with the Passage's own period beside the sentence's, Haiku wrote the agreement's start date as that period ("11 January 2028 / 11 January 2027, outside") and lost both start dates and the carry-over deadline. A question about the period asked apart, only of a sentence found contradicted, is the next thing to try (#1765).

### 2026-10-24: the holiday clause is dated, so the 2026 sentences are conflicts (#1765)

The test agreements say the Employee starts on 11 January 2027 and give no year for the holiday clause, so a sentence about holiday in 2026 was a claim about a year the agreement might not cover, and Sonnet 5.5 called it a near miss in 8 of 10 checks. The holiday clause now starts on 1 January 2025 ("From 1 January 2025 the Employee is entitled to 27 working days of paid holiday per year…", "自2025年1月1日起，乙方每年享有带薪年休假10天…"); the employment start date and the other sentences are as they were. A new expected value, `absent`, is for a figure about a year before the clause starts ("In 2024 the Employee was entitled to 25 days of paid holiday.", "2024年乙方享有带薪年休假15天。"): the card should say "I didn’t find this".

`main`'s agreements and these, Haiku 5.5, same day, interleaved; Sonnet 5.5 on these only. Counts are of checks.

| Sentence | Model | These agreements | `main`'s agreements |
|---|---|---|---|
| "In 2026 the Employee was entitled to 25 days of paid holiday." Contradicted | Haiku 5.5 | 39 of 39 | 37 of 39 |
| the same | Sonnet 5.5 | 20 of 20 | 2 of 10 (an earlier run) |
| "2026年乙方享有带薪年休假15天。" Contradicted | Haiku 5.5 | 40 of 40 | 39 of 39 |
| the same | Sonnet 5.5 | 20 of 20 | not measured |
| "经理每年享有带薪年休假15天。" Contradicted or Supported (wrong) | Haiku 5.5 | 20 of 80 | 19 of 80 |
| "The Employee shall work from home two days a week." not Contradicted (wrong) | Haiku 5.5 | 34 of 79 | 25 of 79 |
| "2024年乙方享有带薪年休假15天。" says "I didn’t find this" | Haiku 5.5 | 0 of 79 | not in `main`'s sets |

- The 2024 sentences are a known miss: the check calls them conflicts or partly supported, because its rule for a conflict says nothing about the period (#1765).
- A fixture that moved the employment start date to 2025 as well made "经理每年享有带薪年休假15天。" wrong in 38 of 79 checks (19 of 80 on `main`); only the holiday clause is dated for that reason.
- "The Employee shall…" is within the spread of `main` alone (8 of 40 in an earlier run, 25 of 79 here).

### 2026-10-24: a Supported reply with a wider scope keeps its partly-supported card (#1708)

Claude Haiku 5.5 on the same Documents, Library and search as below, against `main` measured the same day with the same sentences (main's check, these sets). The change: a Supported reply with a wider scope that names its parts keeps the partly-supported card with the Passage it cited, also when its parts came from the request for them, and no nearest line is asked about. It changes no verdict: only the amber "says something different" card becomes the partly-supported one, and a request goes. In 169 such checks the nearest-line request was made 13 times (where the roles differ), against 130 of 174 on `main`, a median of 0.8 s each.

New sets and members: near misses about another person or role, or "Staff" with a detail the agreement doesn't give (`en-near-misses`, `zh-near-misses`); paraphrases with other duty and permission words (`en-paraphrases`, `zh-paraphrases`); and, in both conflict sets, duties and permissions in other words and a figure for 2026, whose cases change in #1765.

Counts of checks, this version and `main`. The first five rows are of this version; the others were measured with an earlier step of this branch still in it (a nearest line that could make a wider-scope sentence Contradicted, taken out since), which can only have added Contradicted:

| Sentences | Checks | This version | `main` |
|---|---|---|---|
| "Staff may work from home on Mondays and Fridays." Contradicted | 40 | 2 | 1 |
| "Managers are entitled to 30 days of paid holiday per year." Contradicted | 40 | 2 | 7 |
| "人力资源总监每年享有带薪年休假15天。" Contradicted | 40 | 1 | 2 |
| "员工的工资于每月最后一个工作日通过银行转账发放。" Supported | 40 | 3 | 5 |
| "乙方月工资为人民币一万八千元，通过银行转账发放。" Supported | 40 | 4 | 6 |
| "Employees may work from home two days a week." Supported | 40 | 7 | 4 |
| 职工, "Staff", 员工 for the Employee (three rows) Supported | 40 each | 0, 0, 1 | 0, 0, 0 |
| "should" for "may" Supported | 40 | 39 | 39 |
| Other duties for permissions and the reverse (must, shall, is entitled to, 需, 应当) Supported | 40 each | 1 of 200 | 4 of 200 |
| The paraphrases, names and own words (eight rows) not Supported | 20 each | 3 of 160 | 2 of 160 |
| Both conflict Minds, 10 checks of 58 sentences: Contradicted, Supported | 580 | 478, 12 | 484, 16 |

- The prompt is `main`'s, so differences in Supported are draws, not this change: "Employees…" Supported in 7 of 40 here and 4 of 40 on `main` come from first verdicts that call the plural the Employee itself ("Scope: Employees, same").
- 均可 and 可以 for 须, and 应 for 可, were left out by the claims step in the smaller Minds; in the whole conflicts Mind, 10 checks: Supported 0 and 0, 1 and 1, 1 and 0.
- Taken back on this branch: the nearest line that could make a wider-scope sentence Contradicted made "Staff may work from home on Mondays and Fridays." Contradicted in 3 of 40 checks through that path, against 1 of 40 on `main`; it can return with a test of the period and the party (#1765). A `Scope` clause counting the Passage's own word in the plural as wider made three Chinese duty-for-permission swaps Supported in 22 of 120 checks against 4 of 120. Two `Roles` wordings made near misses about another person Contradicted at the first verdict.
- Spend: $11.51 in all over this work, Haiku 5.5 and Sonnet 5.5; this version's measurement $2.45.

### 2026-10-23: a Mind's chosen scope narrows its check (#1623)

The scope cases on this version, where a check from a Mind searches the Search scope the User set for it, else its Folder, else every Document. "Before" is the measurement on the version this one is built on, where a Mind in no Folder searched every Document whatever scope it had; "filed" is the same Mind in the agreement's Folder, which this version doesn't change. Counts are of 20 checks of the two faithful sentences (false Unsupported) and of the two the agreement doesn't state (false Supported); 10 checks a case.

| Model | Language | Others | Before: in no Folder | Now: in no Folder, scope the agreement | Now: filed | False Supported now |
|---|---|---|---|---|---|---|
| Haiku 5.5 | English | 5 | 9 of 20 | 0 of 20 | 0 of 20 | 0 of 40 |
| Haiku 5.5 | English | 20 | 13 of 20 | 0 of 20 | 0 of 20 | 0 of 40 |
| Haiku 5.5 | Chinese | 5 | 10 of 20 | 1 of 20 | 0 of 20 | 0 of 40 |
| Haiku 5.5 | Chinese | 20 | 11 of 20 | 0 of 20 | 0 of 20 | 0 of 40 |
| Sonnet 5.5 | English | 20 | 0 of 20 | 0 of 20 | not run | 0 of 20 |
| Sonnet 5.5 | Chinese | 20 | 1 of 20 | 0 of 20 | not run | 0 of 20 |

- Every check of a Mind with its scope set was handed the agreement alone, as every filed check was. The car allowance was "I didn’t find this" and the holiday sentence Contradicted in all 140 checks.
- The one miss is Haiku's partly-supported card on the Chinese notice paraphrase, with the agreement alone in hand: it took the sentence as wider than the agreement's two parties ("Not covered: 适用于所有劳动者").
- A first run on this change before the check's newer reply wording was merged in gave 0 of 20 in every case, the Chinese one with 5 others included.
- Spend at the app's own count: $1.57 for both runs (Haiku $0.27, Sonnet $1.30).
- After main's second, strict judgement of a contradiction (#1647) was merged in, Haiku 5.5 ran the scoped cases again, 10 checks each: 0 of 20 false Unsupported and 0 of 20 false Supported in English and in Chinese, with 5 and with 20 others, the agreement alone handed to every check, and 8 of 20 false Unsupported for the same Mind in no Folder with no scope. $0.11.

### 2026-10-23: who does what for whom, and must or may (#1668)

On the same Documents, Library and search as below. "Before" is the version below as first measured (8d28d4dad); "after" is this version, whose changes are:

- The check's reply has a field of its own, `Roles`, after `Scope` and `Topic`: who does it, for or to whom, and each side's own obligation or permission word copied as written (须, 可, must and may are given as examples, never matched by the app), then `same` or `differs`. A Supported reply whose roles differ gets the partly-supported card, with its own parts or, when it named none, "I didn't find this".
- A contradiction the first confirmation calls "same" gets the partly-supported card, never Supported: in one word it called the parties the other way round the same.
- A reply that repeats its verdict line at the end keeps the fields above it, and a corrected `Roles` line counts.

Checks of sentences that turn a permission into a duty or the reverse, or reverse the parties (they are now members of `en-conflicts` and `zh-conflicts`), 20 a sentence; S Supported, C Contradicted, P partly supported, D a line that says something different, A absent, N not checked:

| Sentence | Haiku 5.5 before | after | Sonnet 5.5 before | after | Kimi K2.6 before | after |
|---|---|---|---|---|---|---|
| The Company must pay salary in lieu of notice instead of… | 14 S, 6 C | 8 C, 12 D | 20 C | 20 C | 20 S | 20 C |
| The Company must pay salary in lieu of notice. | 1 S, 18 C, 1 P | 20 C | | | | |
| The Employee must work from home two days a week. | 19 C, 1 D | 18 C, 1 D, 1 P | | | | |
| Up to 5 unused holiday days must be carried over… | 10 S, 9 C, 1 D | 1 S, 18 C, 1 D | | | | |
| The Employee may keep the Company's confidential information secret… | 13 S, 7 C | 20 C | 20 C | | 20 S | 20 P |
| The Director of People reports to the Employee. | 20 C | 20 C | | | | |
| The Company must keep the Employee's confidential information secret… | 1 S, 18 C, 1 P | 20 C | | | | |
| The Employee may pay salary in lieu of notice instead of… | 4 S, 10 C, 6 D | 15 C, 5 D | | 20 C | | |
| 乙方每周须在家工作两天。 | 15 C, 5 P | 14 C, 4 D, 2 P | | 20 C | | |
| 乙方每周必须居家办公两天。 | 17 C, 3 P | 17 C, 3 P | | | | |
| 乙方在职期间及离职后均可对甲方的商业秘密保密。 | 18 S, 1 C, 1 P | 2 S, 11 C, 7 P | not a claim | | 20 S | |
| 乙方依法为甲方缴纳社会保险和住房公积金。 | 20 S | 2 C, 18 P | 20 C | 20 C | 20 C | |
| 社会保险和住房公积金由乙方为甲方缴纳。 | 20 S | 6 C, 14 P | | | | |
| 人力资源总监向乙方汇报。 | 2 S, 3 C, 15 P | 2 S, 16 C, 2 P | | | 20 C | |
| 甲方每月向乙方支付租金人民币一千五百元。 | 5 S, 5 C (10 checks) | 2 S, 16 C, 2 D | | | | |
| 甲方须对乙方的商业秘密保密。 | 7 S, 13 A | 6 P, 14 A | | | | |
| 乙方可提前24小时通知甲方在居家工作日到岗。 | 20 C | 20 C | | | | |

On Haiku 5.5 the English rows come from a Mind of these sentences alone, and the Chinese rows after from the whole `zh-conflicts` Mind, where the claims request names the reporting line (in a Mind of the key sentences alone it often doesn't).

- **Still open (#1708):** the reversed reporting line is Supported in about 1 of 4 checks on Haiku 5.5, unchanged from before (2 of 20 in the run above, 11 of 40 in a reviewer's runs on this code, 5 of 10 before): this change doesn't fix it. How often the claims request names it varies from run to run, so 20 checks can give 2 or 7. The reversed rent payer and 均可 for 须 are Supported in up to 1 of 10, and "Employees…" in 2 to 3 of 20 (about 1 in 20 before). The `Roles` field comes after the verdict line, so when the verdict has already misread the sentence, the field follows it: "乙方 reports to 人力资源总监 / 乙方 reports to 人力资源总监, same" for "人力资源总监向乙方汇报". Other wordings of the field moved these between 0 and 2 of 20, within the noise of 20 checks.

- **The two causes:** a duty for a permission was Supported by the check's own verdict, written first: Haiku 5.5 then named the difference in the lines after it ("Not covered: an obligation to pay (the Agreement says may, not must)"). The Chinese parties reversed were Contradicted by the verdict in every check and Supported by the first confirmation's "same".
- **The other sets, after:** Haiku 5.5, 10 checks of `en` and 40 of `zh`, 20 of `en-control` and `zh-control`. The notice, the own words and the named and same-subject paraphrases were Supported in every check, "The Employee can work from home for two days each week." and "乙方每周有两天可以在家办公。" in 20 of 20. "Staff…", 员工 and 职工 got the partly-supported card in 19 of 20 each in the control Minds and in every check in `en` and `zh`. "Employees…" got it in 17 of 20, and was Supported in 2, its reply's `Scope` saying "same", as in a run below. The car allowance was "I didn't find this" in every check. The holiday was Contradicted in 10 of 10 in English and 39 of 40 in Chinese: in the one miss the verdict was unsupported and the nearest line was judged different (#1708). Before the last reading fix, 职工 was Supported in 2 of 10 by replies that ended by repeating their verdict line. Sonnet 5.5, 2 checks of the four sets: every sentence as expected.
- **The conflict sets, after:** Haiku 5.5, 10 checks: Supported only "must pay salary in lieu of notice instead of…" (2 of 10; 1 read with this version's reader, its `Roles` line corrected) and "must be carried over" (1 of 10). In Chinese, 20 checks: the reversed rent payer and 均可 for 须, 2 of 20 each, and the reversed reporting line 2 of 20 in this run but about 1 in 4 across runs, as before (still open, above); every other sentence 0. The Chinese negation and the Chinese seven days' notice were left unmarked, both from the one claims request of the run (#1682). Sonnet 5.5, 1 check: all 47 Contradicted.
- **Wordings tried** (Haiku 5.5, the sentences above 20 times and the four other sets 10 times): the generic instruction, without the four example words, left a duty for a permission Supported in up to 8 to 10 of 20 checks, against at most 1 or 2 with them. Placed after the reply's sentence instead of before it, the field copied the Passage's word for both sides. Placed before the verdict, it decided the verdict well but swayed `Scope` ("职工" Supported in 3 to 6 of 10), and leading a Supported reply into the contradiction's judgements made the notice and "Staff" Contradicted in a few checks. Words other than the four are measured only as far as 需 in the notice (#1708).
- **Not checked:** a reply that writes its fields beside `cite` with no marker loses them as a preamble (#1673): 0 to 7 of 320 checks a wording on the sentences above with the field before the reply's sentence, 0 to 1 after it, none in the other sets.
- **Cost and time:** the field adds about 30 to 50 output tokens a check on Haiku 5.5 (the verdict's reply, median 258 tokens before and 285 after), about 34 on Sonnet 5.5 (102 to 136) and 24 to 31 on Kimi K2.6 (47 to 78), and no request; the check's time moved within its spread from run to run (Haiku 3.0 to 3.3 s a sentence; Sonnet 6.2 to 7.0 s), about 0.2 s at Haiku's speed.
- **Spend:** $9.09 in all: Haiku 5.5 $4.79 (the measurement, nine wordings and the final runs), the judgement trials $0.05, Sonnet 5.5 $3.66, Kimi K2.6 $0.59.

### 2026-10-23: a contradiction needs a second, strict judgement (#1647)

On the same Documents, Library and search as below. "Before" is the version below ("now" there: Haiku 5.5's two runs, Sonnet 5.5's one); "after" is this version, whose changes are:

- A sentence the check calls contradicted, and the first confirmation upholds, is judged once more beside its quote, by a judgement that writes the sentence's detail ("on Mondays and Fridays (two named days)") and what the quote states of it before its word, in English. Only "conflict" keeps it Contradicted. Otherwise the two judgements disagree and the card is the partly-supported one, quoting the Passage, with the reply's own parts or, when it named none, parts asked for once. A judgement that fails or can't be read leaves the sentence not checked, with why.
- The reply's `Scope` field names the sentence's own word for the party before `same` or `wider` ("Scope: Staff, wider"; "Scope: none, same" when the sentence names none).
- A Supported reply with a wider scope whose parts can't be shown asks for them once.

Haiku 5.5 ran twice after (runs 1 and 2, the last two commits; the second only adds the third change). Sonnet 5.5 ran once after; `en-control` again on the last commit, the run shown. Counts are of 10 checks, as below.

| Set · sentence | Haiku before (1; 2) | Haiku after (1; 2) | Sonnet before | Sonnet after |
|---|---|---|---|---|
| en · own words | 8 S, 2 P; 10 S | 10 S; 10 S | 10 S | 10 S |
| zh · notice (paraphrase) | 10 S; 10 S | 10 S; 10 S | 10 S | 10 S |
| zh · near miss (每周一和周五) | 2 P, 8 C; 3 P, 7 C | 10 P; 10 P | 10 P | 10 P |
| en · near miss (Mondays and Fridays) | 5 D, 5 C; 7 D, 3 C | 5 P, 5 D; 4 P, 5 D, 1 C | 10 P | 10 P |
| en · staff-home ("Staff…") | 10 P; 10 P | 10 P; 10 P | 10 P | 10 P |
| en-control · staff-home | 10 P; 10 P | 10 P; 9 P, 1 S | 10 P | 10 P |
| en-control · employees-home | 9 P, 1 S; 9 P, 1 not checked | 10 P; 9 P, 1 S | 10 P | 10 P |
| zh · staff-home (员工…) | 10 P; 10 P | 10 P; 10 P | 10 P | 10 P |
| zh-control · staff-home | 10 P; 10 P | 10 P; 10 P | 10 P | 10 P |
| zh-control · employees-home | 10 P; 10 P | 10 P; 9 P, 1 D | 10 P | 10 P |
| en · holiday (wrong figure) | 10 C; 10 C | 10 C; 10 C | 10 C | 10 C |
| zh · holiday (wrong figure) | 10 C; 10 C | 10 C; 10 C | 10 C | 10 C |
| en · car allowance (absent) | 10 A; 10 A | 10 A; 10 A | 10 A | 10 A |
| zh · car allowance (absent) | 10 A; 10 A | 10 A; 10 A | 10 A | 10 A |

Every other sentence was Supported in every check of every run. No check gave a false Supported, and none after was not checked.

- **The near miss:** rarely Contradicted on Haiku 5.5 after, not never: 3 of 30 checks in Chinese and 1 of 30 in English in a re-test (0 of 20 and 1 of 20 in the runs above), against 15 of 20 and 8 of 20 before. Its "D" cards are unsupported verdicts whose nearest line the existing nearest-line judgement (#770) calls different, as before.
- **With only the strict "neither" downgrading** (see the conflicts below), Haiku 5.5, 20 checks of `en` and `zh`, 10 of each control: the near miss Contradicted in 2 of 20 in Chinese and 0 of 20 in English; the own words and the notice paraphrase Supported in 20 of 20 in both languages; "Staff…" partly in 19 of 20 and 20 of 20, and in 10 of 10 in both control Minds, "Employees…" too; the holiday Contradicted in 20 of 20 and 19 of 20 (one "D"); the car allowance "I didn't find this" in all 40; no false Supported. Sonnet 5.5, 5 checks of the four sets: every sentence as expected in every check.
- **Genuine conflicts** (`en-conflicts`, `zh-conflicts`, added after): with the strict judgement downgrading on any word but "conflict", the Chinese reversed reporting line, "人力资源总监向乙方汇报。", got the partly-supported card in 5 of 5 checks: writing it in English, the strict judgement read the direction backwards and said "same" (8 of 10 requests alone). So only its "neither" (the quote doesn't state the detail) downgrades a contradiction; its "same" leaves it Contradicted. Since then, on Haiku 5.5, 5 checks: Contradicted in 80 of 80 in English and 63 of 65 in Chinese, known misses left out, the reversed reporting line in 5 of 5. Asked alone 10 times each, the strict judgement said "neither" to none of the reversed parties. What isn't Contradicted comes before it: a reversed party Supported by the first verdict (in English employer and employee once in 5; in Chinese who pays the rent twice and landlord and tenant once), employer and employee reversed in Chinese "I didn't find this" twice (the first confirmation said "neither"), and the Chinese negation left unmarked in every check (the claims weren't named with it). One Chinese check of the date was not checked in an earlier run: its reply wrote the verdict lines beside `cite` with no marker, which the Answer engine drops as a preamble, so what was left had no verdict. The two known misses (#1668), "must" for "may" and the swapped social insurance, were Supported in 5 of 5 and 4 of 5, by the first verdict. Sonnet 5.5, one check of each: 16 of 16 in English and 13 of 13 in Chinese, known misses left out (of them, employer and employee reversed got the partly-supported card from the check itself, the strict judgement alone saying "conflict" to it in 5 of 5; the others were Contradicted).
- **Why a second judgement and not the existing one:** asked for one word, both existing judgements called the near miss a conflict in 10 of 10 requests each, in English and Chinese, on Haiku 5.5 with thinking off, as checks run. The strict one did in 0 of 10 in English and 1 of 30 in Chinese; with its lines in the sentence's language, 9 of 60 in Chinese. It still called every genuine conflict tried a conflict, 10 of 10 each: the two holiday figures, three days a week, "Mondays, Wednesdays and Fridays" against two days a week (in English and Chinese), other hours, another manager, a later date, another pension share and a longer probation; and Sonnet 5.5 judged all 12 cases tried as expected. Asking it for the parts in the same request swayed its word (the Chinese near miss a conflict in 15 of 20), so the parts are a request of their own.
- **Time:** the strict judgement is one more request for a sentence the check calls contradicted: a median of 1.0 to 1.2 s (90th percentile 1.5 to 2.0 s) on Haiku 5.5, 1.9 s (3.7 s) on Sonnet 5.5. The parts request, when needed, about 1 s. Sentences are checked several at once, so a Mind's check takes longer only by what its slowest sentence adds.
- **Spend:** $6.22 in all: Haiku 5.5 $1.52 (the runs while building it, the conflict sets and the diagnosis), the judgement trials $0.65 (Sonnet 5.5 $0.42 of it), Sonnet 5.5's runs of the sets $4.05.

### 2026-10-23: the card says where it looked, and a part covered needs the same claim

Three versions on the same Documents, Library and search: `main` at bf47b4631 ("main"); the first partly-supported card for a sentence with no Citation ("first"); and this version ("now"). Now, the check's reply says in fields of its own whether a Passage is about the sentence's topic (`Topic: found` or `not found`) and whether the sentence names the Passage's party in general words (`Scope: same` or `wider`); "Covered" and "Not covered" are asked for only when a Passage states part of what the sentence itself says, never for a neighbouring thing. A Supported reply with `Scope: wider` shows the partly-supported card; a sentence no Passage states says "I didn’t find this in “{scope}”". Haiku 5.5 ran twice now (run 1; run 2). Counts are of 10 checks; S supported, C contradicted, P the partly-supported card, A absent, D a line that says something different. `zh-control` didn't run on `main`.

| Set · sentence | Haiku main | Haiku first | Haiku now (1; 2) | Sonnet main | Sonnet first | Sonnet now |
|---|---|---|---|---|---|---|
| en · staff-home ("Staff…") | 10 S | 9 S, 1 A | 10 P; 10 P | 5 S, 5 A | 8 S, 2 P | 10 P |
| en · own words | 10 S | 10 S | 8 S, 2 P; 10 S | 10 S | 10 S | 10 S |
| en · car allowance (absent) | 10 A | 9 A, 1 P | 10 A; 10 A | 10 A | 10 A | 10 A |
| en · holiday (wrong figure) | 10 C | 10 C | 10 C; 10 C | 10 C | 10 C | 10 C |
| en · near miss (Mondays and Fridays) | 5 D, 5 C | 4 D, 6 C | 5 D, 5 C; 7 D, 3 C | 10 A | 10 P | 10 P |
| en-control · staff-home | not run | 10 S | 10 P; 10 P | 8 S, 2 A | 9 S, 1 P | 10 P |
| en-control · employees-home | not run | 10 S | 9 P, 1 S; 9 P, 1 not checked | 10 S | 10 S | 10 P |
| zh · staff-home (员工…) | 9 S, 1 A | 9 S, 1 P | 10 P; 10 P | 9 S, 1 A | 10 S | 10 P |
| zh · notice (paraphrase) | 10 S | 10 S | 10 S; 10 S | 10 S | 10 S | 10 S |
| zh · car allowance (absent) | 10 A | 9 A, 1 P | 10 A; 10 A | 10 A | 9 A, 1 P | 10 A |
| zh · holiday (wrong figure) | 10 C | 10 C | 10 C; 10 C | 10 C | 10 C | 10 C |
| zh · near miss (每周一和周五) | 10 A | 10 P | 2 P, 8 C; 3 P, 7 C | 10 A | 10 P | 10 P |
| zh-control · staff-home | not run | 9 S, 1 P | 10 P; 10 P | not run | 8 S, 2 P | 10 P |
| zh-control · employees-home | not run | 9 S, 1 D | 10 P; 10 P | not run | 10 S | 10 P |

Every other sentence (the notice in English, the controls' paraphrase and name) was Supported in every check of every version. No check gave a false Supported.

- **The partly-supported card on the absent car allowance:** 0 of 40 checks on Haiku 5.5 and 0 of 20 on Sonnet 5.5 now, against 2 of 20 and 1 of 20 in the first version.
- **Absent, for a sentence the agreement states:** 9 checks on `main` (Sonnet 8, Haiku 1), 1 in the first version, 0 now.
- **Misses now, all on Haiku 5.5:** the near miss is Contradicted in 8 and 7 of 10 in Chinese (never on `main`, 5 of 10 in the version pushed before this one) and in 5 and 3 of 10 in English (5 on `main`); the agreement's own words get a partly card in 2 of 10 in one English run.
- **Spend:** `main` $1.78 (with the diagnosis), the first version $2.26, a version in between $2.28, now $2.19 (Haiku 5.5 $0.23, Sonnet 5.5 $1.96).
