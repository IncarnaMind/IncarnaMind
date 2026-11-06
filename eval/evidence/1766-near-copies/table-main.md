# The table-cell set on main, few cells

`tests/live/tableCellChecks.live.test.ts` with `INCARNAMIND_LIVE_TABLE_ONLY=few`, on the check of `main` (9d23dc0a4) in place of this pull request's. Each line is a cell as its mark shows it.

## claude-haiku-5-5 · zh-CN · 1 run(s) · few · $0.0095
right cells: 2 supported, 0 unsupported, 0 contradicted, 0 not checked
wrong cells: 1 contradicted, 3 unsupported, 0 supported, 0 not checked
- wrong 120 → unsupported
- wrong 30 → unsupported
- right 100 → supported: 2024年收入为100万元
- wrong 70 → unsupported
- wrong 78 → contradicted: 2025年利润为42万元，78为成本
- right 120 → supported: 2025年收入为120万元

## claude-haiku-5-5 · en · 1 run(s) · few · $0.0089
right cells: 2 supported, 0 unsupported, 0 contradicted, 0 not checked
wrong cells: 4 contradicted, 0 unsupported, 0 supported, 0 not checked
- wrong 120 → contradicted: Revenue for 2024 is 100 thousand tonnes in the Budget, not 120.
- wrong 30 → contradicted: The Budget gives Revenue for 2025 as 120 thousand tonnes.
- right 100 → supported: The Budget table gives 2024 Revenue as 100 thousand tonnes.
- wrong 70 → contradicted
- wrong 78 → contradicted: The Budget table gives Profit for 2025 as 42 thousand tonnes; 78 is the Cost for 2025.
- right 120 → supported: Revenue for 2025 is 120 thousand tonnes.

## claude-sonnet-5-5 · zh-CN · 1 run(s) · few · $0.1768
right cells: 2 supported, 0 unsupported, 0 contradicted, 0 not checked
wrong cells: 4 contradicted, 0 unsupported, 0 supported, 0 not checked
- wrong 120 → contradicted: 2024年收入为100万元，120万元是2025年的收入
- wrong 30 → contradicted: 2025年收入为120万元
- right 100 → supported
- wrong 70 → contradicted: 2024年成本为70万元
- wrong 78 → contradicted
- right 120 → supported: 2025年收入为120万元

## claude-sonnet-5-5 · en · 1 run(s) · few · $0.2268
right cells: 2 supported, 0 unsupported, 0 contradicted, 0 not checked
wrong cells: 4 contradicted, 0 unsupported, 0 supported, 0 not checked
- wrong 120 → contradicted: The Budget gives Revenue for 2024 as 100 thousand tonnes; 120 is the 2025 value.
- wrong 30 → contradicted: The Budget gives 2025 revenue as 120 thousand tonnes.
- right 100 → supported: Revenue for 2024 is 100 thousand tonnes.
- wrong 70 → contradicted: The Budget gives the 2024 cost as 70 thousand tonnes.
- wrong 78 → contradicted: The Budget gives Profit for 2025 as 42 thousand tonnes; 78 is the Cost figure.
- right 120 → supported
