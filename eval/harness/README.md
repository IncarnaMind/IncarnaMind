# Harness bake-off

`npm run eval:harness` asks the same requests of IncarnaMind's Run engine and of two outside agent harnesses, on the same model, with the same Document and Citation Tools (#1208). Only the harness differs, so the results say how much the loop itself adds. Neither `npm test` nor CI runs it.

## The harnesses

- **(a) IncarnaMind:** the assistant, asked through the core as `npm run eval:everyday` asks it (`eval/everyday/asking.ts`), with its own Tools, instructions and checks.
- **(b) Claude Code**, headless: `claude --bare -p`.
- **(c) Codex CLI**: `codex exec --json`.

(b) and (c) reach the Documents only through IncarnaMind's own MCP server (#351), through `shim.ts`, which speaks the app's handshake and shows them six Tools: `search`, `read_passages`, `cite`, `check_citations`, `list_minds` and `read_mind`. `ask` is hidden, since it runs IncarnaMind's own engine, and so is `show_citation`, which opens a window. Each run gets a new pairing over every Document of its library, the same Documents (a) searches. The server's instructions and the Agent Skill reach them as the app ships them (`wording.ts`), without what they say of the two hidden Tools; the Skill's text goes through each harness's own instructions channel (`--append-system-prompt`, `developer_instructions`), since with its built-in Tools off a harness can't open a Skill's file.

Every built-in Tool of (b) and (c) is off:

- **Claude Code:** `--tools ""`, `--strict-mcp-config` and `--allowedTools` for IncarnaMind's six; anything else would ask, and nobody answers (`--permission-prompts none`). `--bare` reads Anthropic's credentials only from `ANTHROPIC_API_KEY`.
- **Codex:** the shell, images, the web, plugins, apps, subagents and the rest are turned off (`CODEX_OFF` in `codex.ts`), with the read-only sandbox, no user config or rules, and analytics off. The Tools each request offers are kept in the run's record, those Code Mode sends as `additional_tools` included, so one left on shows. Codex 0.162 still offers a few whatever the flags: its MCP resource Tools and `request_user_input`, and in Code Mode also `apply_patch` and its sub-agent Tools. The read-only sandbox refuses a write, and a call to any of them shows in the run's record. On GPT-6.1 Sol, Codex offers the Tools through its Code Mode: the model calls the same Tools from a JavaScript cell.
- Each run has a temporary home and config folder (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), and no environment of the evaluation's but PATH and what it needs. Nobody's own sign-in, settings or keychain is read.

**The model.** Codex 0.162 speaks only OpenAI's Responses API, so its model provider is `modelProxy.ts` on 127.0.0.1:

- **OpenAI:** requests go on as they came, and the stream comes back as it went.
- **Anthropic:** each request is translated into Anthropic's Messages API and the reply back into the Responses stream, with Claude's thinking carried in reasoning items and the app's prompt-cache breakpoints. Codex is given a token for the run, never the key. The report checks the adapter on every Codex run: each Tool call the model made reached IncarnaMind's server with the same arguments, and each result came back to the model whole.

Claude Code speaks only Anthropic's API, so it isn't run on an OpenAI model.

**Reasoning effort** is matched to the app's: low on Claude (the app asks for low, and high for a Question it judges careful), medium on OpenAI (OpenAI's default, which the app uses).

## The requests

`cases.ts`: 30, 15 in English and 15 in Chinese, each asked with no Mind open, since an outside harness has none:

- 22 everyday requests as `eval/everyday` has them: questions over the two arXiv papers, "Add a risks section" with no Mind open, ten research questions where an inference is tempting, and six over the contracts and minutes whose files' dates are none of their text's (#1173).
- Two-turn requests (#1172): a question about the employment contract, then "Write a short summary of this agreement"; the credit example's question, then one about the GraphST paper.
- Drafts with wrong figures, on the credit example's Documents: its own draft (36.8% for 38.6%), and a sentence with 3.4 for 3.1 times and 4.0 for 3.5 times.

Each is tagged with the persona it stands in for (analyst, litigator, student). Requests that ask for text in a Mind are left out: the MCP server has no Tool that writes.

## What it measures

The same way for every harness, from the reply the User reads. An outside harness's `[cite:…]` tokens become Citation markers with the Citations minted for its own pairing (`score.ts`); a token minted for no one, or for another pairing, is a marker without a Citation.

- **Completed:** the run passes every guard `eval/everyday/checks.ts` holds its request to, and, for a draft, gives the Documents' figure for each wrong one.
- **Supported, Unsupported, Contradicted:** the research questions' cited sentences, as the app's own Check against Documents judges them (`eval/everyday/support.ts`), on the model under test or on the one `INCARNAMIND_EVAL_HARNESS_CHECK_*` names.
- **Invented facts:** Contradicted sentences, plus dates the Documents' text doesn't give (`eval/everyday/dates.ts`).
- **Wrong figures caught** (new): the reply gives the Documents' figure for a wrong one, in any of the ways it is written ("38.6%", "3.5:1", "3.1 倍").
- **Claimed, not done:** the claims judge (`eval/everyday/judge.ts`) finds a sentence claiming a change no Tool made. An outside harness's record lists its MCP calls, none of which changes a Mind.
- **Context leaks:** a two-turn request's reply points to the earlier turn or the example (`checks.ts`'s guard), or uses one of the further pointers #1172 names (new: "as above", "see above", "上一条回答", "见上文").
- **Cost per request:** all its turns, at the catalog's list price, from each harness's token counts (the adapter's for Codex on Claude, which count cache writes). Claude Code's own figure is kept beside it.
- **Time per request:** from starting the request to its last reply, an outside harness's start-up included, and the time after start-up.

## Running it

Setting the variables is the consent to send the requests and Passages to the model. One model a run, and one results table for it:

```sh
INCARNAMIND_EVAL_CHAT_KIND=anthropic \
INCARNAMIND_EVAL_CHAT_MODEL=claude-sonnet-5-5 \
INCARNAMIND_EVAL_CHAT_KEY=sk-ant-... \
npm run eval:harness
```

On an OpenAI model, also name the judge: `INCARNAMIND_EVAL_JUDGE_KIND`, `_MODEL` and `_KEY` (another model than the one asked, as in `eval/everyday`). To compare two models' results, keep the judge and the support check the same for both: set the judge, and `INCARNAMIND_EVAL_HARNESS_CHECK_KIND`, `_MODEL` and `_KEY` for the check.

| Variable | Default | |
|---|---|---|
| `INCARNAMIND_EVAL_HARNESS` | all three | Harnesses separated by commas: `incarnamind`, `claude-code`, `codex`. |
| `INCARNAMIND_EVAL_HARNESS_REQUESTS` | all 30 | Request ids separated by commas. |
| `INCARNAMIND_EVAL_HARNESS_RUNS` | `2` | Runs of each request per harness. |
| `INCARNAMIND_EVAL_HARNESS_SEED` | `1208` | The seed of the order the runs go in. |
| `INCARNAMIND_EVAL_HARNESS_EFFORT` | `low` on Anthropic, `medium` on OpenAI | The outside harnesses' reasoning effort. |
| `INCARNAMIND_EVAL_HARNESS_TIMEOUT_S` | `300` | A turn that takes longer is stopped and fails. |
| `INCARNAMIND_EVAL_HARNESS_CLAUDE`, `_CODEX` | on the PATH | The harnesses' binaries. |
| `INCARNAMIND_EVAL_HARNESS_RESUME` | none | A results folder to go on with: runs already in it are skipped. |
| `INCARNAMIND_EVAL_HARNESS_CHECK_KIND`, `_MODEL`, `_KEY` | the model under test | The model the support check runs on, saved beside the one under test. |
| `INCARNAMIND_EVAL_HARNESS_KEEP_REQUESTS` | off | `1` keeps each request Codex sent to the model, next to the run's record. |

The runs go one at a time, in an order shuffled with the seed, the harnesses mixed. Each is appended to `eval/results/<start>-harness-<model>/runs.jsonl` as it ends, with each harness's events in `events/`; `report.md` and `report.json` are written at the end. The report gives each harness's version, its MCP config (without the pairing's token, which is each run's own and is revoked when the run ends) and the Tools it offered the model.

The same fixtures and seed give the same requests in the same order, and the same scoring of what the models reply.

**Cost and time, roughly:** on Claude Sonnet 5.5, $0.03 to $0.10 and 10 to 60 seconds a request and harness, so about $15 and three hours for 30 requests twice through three harnesses, with the judge and the checks.
