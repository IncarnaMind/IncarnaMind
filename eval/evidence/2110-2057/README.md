# Evidence for #2110 and #2057

The real-model runs behind the pull request's numbers, made on 2026-10-29 on the funded
Anthropic account. `main` is `401f7af2f`; `branch` is the pull request's head. The request spend
is in the pull request. A key or token appears in none of these files.

## The four measurements

1. **`wrap-*.md`** — the README film's question on its own credit Documents
   (`resources/examples/credit/<language>/`), ten repeats for each language. The committed
   harness is `eval/repeats/run.cjkWrap.ts`:

   ```sh
   INCARNAMIND_EVAL_CHAT_KIND=anthropic INCARNAMIND_EVAL_CHAT_MODEL=claude-haiku-5-5 \
   INCARNAMIND_EVAL_CHAT_KEY=… INCARNAMIND_EVAL_CJK_WRAP_LABEL=main \
   npx vitest run --config eval/repeats/vitest.cjkWrap.config.ts
   ```

   Run in the `main` worktree for `main` and in this branch's worktree for `branch`. Each
   report lists every stored quote; `mid` marks a quote that ends at the PDF's line break
   (`…上升，7` in Chinese, `…37.5% a year` in English).

2. **`skills-*.md`** — `npm run eval:skills`, all twelve finance and law cases, once in each
   worktree. Each report holds the note the model wrote, every Citation's check and the facts
   the case asks for.

3. **`paired-*.json`** — the gating and hard sets from `eval/speed/paired.ts`. Both arms
   alternate over one indexed Library per set, the baseline core built from `401f7af2f` and the
   branch core in the same process; Sonnet 5.5 judges. The branch half of the Sonnet run was
   split over alternating items, whose reports are `paired-sonnet-p0.json` and `-p1.json`. The
   harness itself isn't committed (it loads two core builds); these files are its output: the
   guard counts, the ambiguity requests and the spend.

4. **`mixed-library.json`** — the shipped example Library (`resources/examples`, 19 PDFs, five
   Word files and two Markdown files) processed by `401f7af2f` with embeddings on, then opened
   by the branch so the wider pipeline re-read it. Counts Passages joined in place, unchanged
   and replaced, and the embeddings added.
