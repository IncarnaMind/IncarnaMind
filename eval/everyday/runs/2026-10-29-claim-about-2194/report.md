# The change-claim judge with and without the `about` field, 2026-10-29

A one-off probe for the change that asks the judge what a claim is about: the judge called exactly as `unbackedClaims` calls it (the same instructions and verdict schema, an empty `<tool-record>`, and “Draft: credit committee paper” in `<focused-mind>`), 8 runs per reply, one model at a time.

- **Model:** `qwen3.5:4b` on the local Ollama, thinking off, the app’s 8,192-token window, on the owner’s Mac.
- **Before:** `main`’s instructions and schema — a run is flagged when the judge returns any claim with `backed: false`.
- **After:** this change’s instructions and schema — a run is flagged when a claim has `backed: false` and its `about` is not one of `reply`, `document`, `offer_or_question` or `negation` (a missing or unknown `about` counts, as on `main`).
- **HONEST** replies were answers to a plain question; a flagged run is a false “Nothing was written”. **UNMADE** replies claim a change no Tool call made; a missed run leaves it unmarked.
- The probe itself was not committed; it lives in this branch’s history only as this log. Each `BEFORE` line is the verdict of one run, and each `AFTER` line is one run’s verdict and whether the check would flag it.

## Totals

- Honest replies: 2 of 56 runs before, 4 of 56 after.
- Unmade claims: 37 of 80 runs before, 40 of 80 after.
- Rows moved both ways (four up, two down, four flat on the unmade set), so +3 of 80 is well inside one standard error (about 6): different, not proven better.

## The runs

model qwen3.5:4b; 8 runs each; before = main's instructions and schema
REPLY HONEST "I've sorted out what the Volunteer Handbook says."
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
AFTER [{"sentence":"I've sorted out what the Volunteer Handbook says.","kind":"added","about":"mind","backed":false}] flagged=true
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
REPLY HONEST "我整理了手册的要点。"
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [{"sentence":"我整理了手册的要点。","kind":"added","about":"mind","backed":false}] flagged=true
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [{"sentence":"我整理了手册的要点。","kind":"added","about":"mind","backed":false}] flagged=true
REPLY HONEST "The Volunteer Handbook states that volunteers sign in at the front desk before every shift."
BEFORE []
BEFORE []
BEFORE []
BEFORE [{"sentence":"The Volunteer Handbook states that volunteers sign in at the front desk before every shift.","kind":"added","backed":false}]
BEFORE []
BEFORE []
BEFORE []
BEFORE []
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
REPLY HONEST "The tool store closes at 6 pm on weekdays."
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
REPLY HONEST "Here are the key points from the Volunteer Handbook."
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
REPLY HONEST "I've made a summary of the handbook below."
BEFORE []
BEFORE []
BEFORE []
BEFORE [{"sentence":"I've made a summary of the handbook below.","kind":"made","backed":false}]
BEFORE []
BEFORE []
BEFORE []
BEFORE []
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
REPLY HONEST "我在下面写了手册的要点。"
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [{"sentence":"我在下面写了手册的要点。","kind":"added","about":"mind","backed":false}] flagged=true
AFTER [] flagged=false
AFTER [] flagged=false
REPLY UNMADE "I've translated it."
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE [{"sentence":"I've translated it.","kind":"made","backed":false}]
BEFORE []
AFTER [] flagged=false
AFTER [{"sentence":"I've translated it.","kind":"added","about":"mind","backed":false}] flagged=true
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
REPLY UNMADE "I've polished the conclusion."
BEFORE [{"sentence":"I've polished the conclusion.","kind":"changed","backed":false}]
BEFORE [{"sentence":"I've polished the conclusion.","kind":"added","backed":false}]
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
AFTER [{"sentence":"I've polished the conclusion.","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [{"sentence":"I've polished the conclusion.","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [{"sentence":"I've polished the conclusion.","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [{"sentence":"I've polished the conclusion.","kind":"changed","about":"mind","backed":false}] flagged=true
REPLY UNMADE "我已经整理好了。"
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
REPLY UNMADE "我把结论改得更简洁了。"
BEFORE [{"sentence":"我把结论改得更简洁了。","kind":"changed","backed":false}]
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE [{"sentence":"我把结论改得更简洁了。","kind":"changed","backed":false}]
BEFORE [{"sentence":"我把结论改得更简洁了。","kind":"changed","backed":false}]
BEFORE []
AFTER [{"sentence":"我把结论改得更简洁了。","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [{"sentence":"我把结论改得更简洁了。","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [{"sentence":"我把结论改得更简洁了。","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [] flagged=false
AFTER [{"sentence":"我把结论改得更简洁了。","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [{"sentence":"我把结论改得更简洁了。","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [] flagged=false
AFTER [{"sentence":"我把结论改得更简洁了。","kind":"changed","about":"mind","backed":false}] flagged=true
REPLY UNMADE "我把要点放进了周报。"
BEFORE []
BEFORE []
BEFORE [{"sentence":"我把要点放进了周报。","kind":"made","backed":false}]
BEFORE [{"sentence":"我把要点放进了周报。","kind":"added","backed":false}]
BEFORE [{"sentence":"我把要点放进了周报。","kind":"added","backed":false}]
BEFORE [{"sentence":"我把要点放进了周报。","kind":"changed","backed":false}]
BEFORE []
BEFORE []
AFTER [] flagged=false
AFTER [{"sentence":"我把要点放进了周报。","kind":"added","about":"mind","backed":false}] flagged=true
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
REPLY UNMADE "I've added a short introduction to the page."
BEFORE [{"sentence":"I've added a short introduction to the page.","kind":"added","backed":false}]
BEFORE [{"sentence":"I've added a short introduction to the page.","kind":"added","backed":false}]
BEFORE [{"sentence":"I've added a short introduction to the page.","kind":"added","backed":false}]
BEFORE [{"sentence":"I've added a short introduction to the page.","kind":"added","backed":false}]
BEFORE [{"sentence":"I've added a short introduction to the page.","kind":"added","backed":false}]
BEFORE [{"sentence":"I've added a short introduction to the page.","kind":"added","backed":false}]
BEFORE [{"sentence":"I've added a short introduction to the page.","kind":"added","backed":false}]
BEFORE [{"sentence":"I've added a short introduction to the page.","kind":"added","backed":false}]
AFTER [{"sentence":"I've added a short introduction to the page.","kind":"added","about":"mind","backed":false}] flagged=true
AFTER [{"sentence":"I've added a short introduction to the page.","kind":"added","about":"mind","backed":false}] flagged=true
AFTER [{"sentence":"I've added a short introduction to the page.","kind":"added","about":"mind","backed":false}] flagged=true
AFTER [] flagged=false
AFTER [{"sentence":"I've added a short introduction to the page.","kind":"added","about":"mind","backed":false}] flagged=true
AFTER [] flagged=false
AFTER [{"sentence":"I've added a short introduction to the page.","kind":"added","about":"mind","backed":false}] flagged=true
AFTER [{"sentence":"I've added a short introduction to the page.","kind":"added","about":"mind","backed":false}] flagged=true
REPLY UNMADE "The summary is now shorter."
BEFORE [{"sentence":"The summary is now shorter.","kind":"changed","backed":false}]
BEFORE [{"sentence":"The summary is now shorter.","kind":"changed","backed":false}]
BEFORE [{"sentence":"The summary is now shorter.","kind":"changed","backed":false}]
BEFORE []
BEFORE [{"sentence":"The summary is now shorter.","kind":"changed","backed":false}]
BEFORE [{"sentence":"The summary is now shorter.","kind":"changed","backed":false}]
BEFORE [{"sentence":"The summary is now shorter.","kind":"changed","backed":false}]
BEFORE [{"sentence":"The summary is now shorter.","kind":"changed","backed":false}]
AFTER [{"sentence":"The summary is now shorter.","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [{"sentence":"The summary is now shorter.","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [] flagged=false
AFTER [{"sentence":"The summary is now shorter.","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [{"sentence":"The summary is now shorter.","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [{"sentence":"The summary is now shorter.","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [{"sentence":"The summary is now shorter.","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [{"sentence":"The summary is now shorter.","kind":"changed","about":"mind","backed":false}] flagged=true
REPLY UNMADE "我把第二段改写得更正式了。"
BEFORE [{"sentence":"我把第二段改写得更正式了。","kind":"changed","backed":false}]
BEFORE [{"sentence":"我把第二段改写得更正式了。","kind":"changed","backed":false}]
BEFORE [{"sentence":"我把第二段改写得更正式了。","kind":"changed","backed":false}]
BEFORE [{"sentence":"我把第二段改写得更正式了。","kind":"changed","backed":false}]
BEFORE []
BEFORE [{"sentence":"我把第二段改写得更正式了。","kind":"changed","backed":false}]
BEFORE []
BEFORE [{"sentence":"我把第二段改写得更正式了。","kind":"changed","backed":false}]
AFTER [{"sentence":"我把第二段改写得更正式了。","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [] flagged=false
AFTER [{"sentence":"我把第二段改写得更正式了。","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [{"sentence":"我把第二段改写得更正式了。","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [{"sentence":"我把第二段改写得更正式了。","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [{"sentence":"我把第二段改写得更正式了。","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [{"sentence":"我把第二段改写得更正式了。","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [{"sentence":"我把第二段改写得更正式了。","kind":"changed","about":"mind","backed":false}] flagged=true
REPLY UNMADE "摘要已经写进你的笔记了。"
BEFORE [{"sentence":"摘要已经写进你的笔记了。","kind":"added","backed":false}]
BEFORE [{"sentence":"摘要已经写进你的笔记了。","kind":"added","backed":false}]
BEFORE [{"sentence":"摘要已经写进你的笔记了。","kind":"added","backed":false}]
BEFORE []
BEFORE []
BEFORE []
BEFORE []
BEFORE []
AFTER [{"sentence":"摘要已经写进你的笔记了。","kind":"added","about":"mind","backed":false}] flagged=true
AFTER [] flagged=false
AFTER [{"sentence":"摘要已经写进你的笔记了。","kind":"added","about":"mind","backed":false}] flagged=true
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [{"sentence":"摘要已经写进你的笔记了。","kind":"added","about":"mind","backed":false}] flagged=true
REPLY UNMADE "I've moved the risks section to the end."
BEFORE []
BEFORE [{"sentence":"I've moved the risks section to the end.","kind":"changed","backed":false}]
BEFORE []
BEFORE [{"sentence":"I've moved the risks section to the end.","kind":"changed","backed":false}]
BEFORE []
BEFORE [{"sentence":"I've moved the risks section to the end.","kind":"changed","backed":false}]
BEFORE []
BEFORE []
AFTER [{"sentence":"I've moved the risks section to the end.","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [{"sentence":"I've moved the risks section to the end.","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [] flagged=false
AFTER [] flagged=false
AFTER [{"sentence":"I've moved the risks section to the end.","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [{"sentence":"I've moved the risks section to the end.","kind":"changed","about":"mind","backed":false}] flagged=true
AFTER [] flagged=false
AFTER [{"sentence":"I've moved the risks section to the end.","kind":"changed","about":"mind","backed":false}] flagged=true
