# The gate for searching at once (#2706)

Written and committed on 2026-11-07, before any run it gates. A model is on the searches-at-once list (`src/core/providers/catalog/answerPaths.ts`) only while it holds every line below.

## What it changes

On a model the list names, in an ordinary Answer's or the assistant's searches only:

- the instructions ask for every search in one step, and for a Question about what a Document says to be answered from what its searches find, not read page after page;
- a search the model makes in one Document hands the one search's 12 Passages, from up to four places in it, instead of the Tool's 6 from two.

It was shaped on eval:speed's question flow, the two Questions the every-flow table timed ("What does the Vantrell report say about emissions?" and its Chinese twin). It was shaped by probes of DeepSeek V4.1 Flash 1017's requests, four runs a language a variant: main took 5 rounds of searches and reads before it wrote (median), the variant 2. Those two Questions decide nothing here.

## The runs

- **Arms:** `today` (main's path, the list empty) against `search-at-once`, paired as `eval/speed/README.md` › Paired runs says.
- **Model:** DeepSeek V4.1 Flash 1017 (`deepseek/deepseek-flash`) on DeepSeek's own API. It cites first on both arms.
- **Judge:** Claude Sonnet 5.5, on a direct Anthropic key. If one key runs out of credit, another account's key for the same model is used, with a line here saying which items each key ran. The judge also reads each found Citation's sentence against its quote for false Supported, and a change an Answer claims, as the Question sets measure them since #2706.
- **Sets, in order:**
  - `search-at-once-held-out`: 20 Questions (`eval/speed/searchAtOnceHeldOut.ts`), 10 English and 10 Chinese, six in the other language from their Document's, each asking what one Document says on a topic. They were written and committed before any run of the path, and their quotes were checked on the stored pages.
  - `gating`: the gating set's 65 Questions.
- English and Chinese are counted together; each language is reported beside them. One run of each set decides it, and a set that fails isn't run again to pass.

## The bar

On the items both arms finished, `INCARNAMIND_EVAL_SPEED_MARGIN=1`, with the same tolerance every speed gate here uses for run-to-run noise:

- expected Passages cited, judged right and every Citation found no lower, within one item in 30, rounded down (none on the held-out set, two on gating);
- no new false Supported (the run stops at the first), duplicate Answer, change claimed and not made, Tool call left as text, or item failing to run;
- first words and done sooner: the paired median differences below zero on both sets.

## Reported, not gated

Model calls, searches and Document reads per Answer, the times on both arms by language, the load during the runs, and the spend. The runs stop at $8, of the $12 this work has.
