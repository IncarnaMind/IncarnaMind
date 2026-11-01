# Calculations evaluation, first runs (#441)

The Answers of the runs published in `eval/calculations/README.md`, as each run kept them (`report.json` with its scores taken out): every Answer's text, calculated figures and written numbers, and each run's usage and spend from the core's meter. The Questions are about the set's made-up Documents only.

| File | Model | Run | Harness |
|---|---|---|---|
| `claude-haiku-5-5.json` | Claude Haiku 5.5 | 2026-11-01, Tools on and off, 72 Questions | 08f100568 |
| `deepseek-flash.json` | DeepSeek Flash | 2026-11-01, Tools on and off, 72 Questions | a8067b194 |
| `claude-sonnet-5-5.json` | Claude Sonnet 5.5 | 2026-11-01, Tools on, en-20, zh-20, en-31 | bb3ce32c6 |

Each file's `run.commit` says "with uncommitted changes": the run's folder held untracked scratch files. The Questions, Documents and the harness that asked them are those of the commit named; the scoring has changed since, and `tests/eval/calculationEvidence.test.ts` scores the Answers again with the scoring as it is now and checks the published table.
