/**
 * The script that reads the bars of the gate for the ask for a check's missing records
 * (eval/everyday/recordsAskBars.ts, `gates/records-ask.md`): what each cell counted comes first and
 * an empty one is an error, a void try is left out by the list that strikes it, bars 1 and 2 are
 * not settled while `main` barely shows the fault, and bar 3 counts a wrong ✓ only when an ask
 * brought it.
 */
import { describe, expect, test } from "vitest";
import type { EvidenceAsk } from "../../eval/everyday/checkRequests";
import { statedIn } from "../../eval/everyday/judge";
import {
  type Arm,
  type ItemRecord,
  underTheStop,
  voidReasons,
} from "../../eval/everyday/recordsAsk";
import {
  type ArmInfo,
  answeredWithReferences,
  bar1,
  bar2,
  bar3Pairs,
  bar3Research,
  cellsOf,
  emptyCells,
  halfOfMain,
  judgeKey,
  offItsRows,
  offRows,
  readBars,
  scoreOf,
  twoQuotesUnderOneMarker,
} from "../../eval/everyday/recordsAskBars";
import type { CheckedPart, SentenceSupport } from "../../eval/everyday/support";

const ROWS = ["Weighted keys O(n2 d) O(1) O(1)", "Recurrent O(n d2) O(n) O(n)"];

const REFERENCES: EvidenceAsk = {
  text: "Missing Citation markers: [1,2]",
  reply:
    '{"citations":[{"marker":1,"passage":"P3","quote":"A residual connection [1] wraps each sub-layer"},{"marker":2,"passage":"P3","quote":"layer normalisation [2] follows it"}]}',
};
const THE_ROWS: EvidenceAsk = {
  text: "Missing Citation markers: [1,2]\nThey are the markers of your verdict's own lines. Evidence: [1,2]",
  reply: `{"citations":[{"marker":1,"passage":"P7","quote":"${ROWS[0]}"},{"marker":2,"passage":"P7","quote":"${ROWS[1]}"}]}`,
};

function sentence(
  text: string,
  verdict: SentenceSupport["verdict"],
  { reason = null, asks = [] }: { reason?: SentenceSupport["reason"]; asks?: EvidenceAsk[] } = {},
): SentenceSupport {
  return {
    sentence: text,
    verdict,
    reason,
    detail: null,
    unsupported: null,
    cites: ROWS.map((quote) => ({ documentName: "Weighted Keys Shorter Paths", quote })),
    parts: [],
    checks: [{ claim: text, quotes: [], replies: ["Verdict: supported"], asks }],
  };
}

const RIGHT =
  "Its Table 1 lists weighted-key layers at O(1) path length and recurrent layers at O(n).";
const WRONG =
  "Its Table 1 lists weighted-key layers at O(n) path length and recurrent layers at O(1).";

function record(
  arm: Arm,
  key: string,
  sentences: SentenceSupport[],
  { attempt = 1, failed = [] as string[], language = "en" as ItemRecord["language"] } = {},
): ItemRecord {
  const pair = /^pair-(\d)-(right|wrong)/u.exec(key);
  const base = {
    arm,
    key,
    kind: pair ? ("pair" as const) : ("research" as const),
    language,
    name: key,
    pair: pair ? Number(pair[1]) : null,
    twin: pair ? (pair[2] as "right" | "wrong") : null,
    run: 1,
    attempt,
    sentences,
    answer: null,
    error: null,
    requests: {
      answered: 3,
      failed,
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0 },
      dollars: 0.001,
    },
    seconds: 1,
  };
  return { ...base, void: voidReasons(base) };
}

/** Both arms with something in every cell: a research Answer and a pair's check, in each language. */
function fullRun(extra: ItemRecord[] = []): ItemRecord[] {
  return (["main", "branch"] as const).flatMap((arm) => [
    record(arm, "research-attention-long#1", [sentence(RIGHT, "supported")]),
    record(arm, "research-attention-long-zh#1", [sentence("表 1 显示……", "supported")], {
      language: "zh-CN",
    }),
    record(arm, "pair-2-right#1", [sentence(RIGHT, "supported")]),
    record(arm, "pair-5-right#1", [sentence("表 1 显示……", "supported")], { language: "zh-CN" }),
    ...extra.filter((each) => each.arm === arm),
  ]);
}

const ARM = (arm: Arm, source: string): ArmInfo => ({
  arm,
  commit: "abc1234",
  source,
  model: "anthropic/claude-haiku-5-5",
  judge: "anthropic/claude-sonnet-5-5",
  dry: true,
  fetchCalls: 0,
  items: [],
  startedAt: "2026-11-13T00:00:00.000Z",
  endedAt: "2026-11-13T01:00:00.000Z",
});
const ARMS = [ARM("main", "aaa"), ARM("branch", "bbb")];
const RUN_MAIN = { commit: "abc1234", source: "aaa" };

const partOf = (reason: CheckedPart["reason"]): CheckedPart => ({
  text: RIGHT,
  kind: "fact",
  verdict: "not-checked",
  reason,
  detail: null,
  unsupported: null,
  evidence: [],
  figures: [],
});

describe("The records ask's bars", () => {
  // protects=a cell (arm, language, case set) with nothing counted is an error that stops the bars, after the cells are printed, never a bar that holds; fails_when=an arm with no Chinese checks reads as holding, or the cells come after the bars; no_claim=what a full run counts.
  test("an empty cell is an error, printed with the cells before any bar", () => {
    const records = fullRun().filter(
      (each) => !(each.language === "zh-CN" && each.kind === "pair"),
    );
    expect(emptyCells(cellsOf(scoreOf(records).read))).toEqual([
      "main, zh-CN, pairs",
      "branch, zh-CN, pairs",
    ]);
    const reading = readBars({
      arms: ARMS,
      records,
      judged: { model: "judge", sentences: [], failedTries: [] },
      judgeDollars: 0,
      runMain: RUN_MAIN,
    });
    expect(reading.errors.join(" ")).toContain(
      "Empty cells, which no bar reads: main, zh-CN, pairs; branch, zh-CN, pairs",
    );
    const text = reading.lines.join("\n");
    expect(text).toContain("## What each cell counted");
    expect(text).toContain("| branch | zh-CN | pairs | 0 | 0 | 0 |");
    expect(text).not.toContain("## 1.");
    expect(text).not.toContain("holds");
  });

  // protects=the cells use the language keys as the record writes them, "en" and "zh-CN", so Chinese records are counted in the Chinese cell; fails_when=a record's "zh-CN" is read under another key and its cell is empty; no_claim=which languages a run holds.
  test("the cells count by the record's own language keys", () => {
    const cells = cellsOf(scoreOf(fullRun()).read);
    expect(cells.map((cell) => cell.language)).toEqual(expect.arrayContaining(["en", "zh-CN"]));
    expect(
      cells.find((cell) => cell.arm === "main" && cell.language === "zh-CN" && cell.set === "pairs")
        ?.items,
    ).toBe(1);
    expect(emptyCells(cells)).toEqual([]);
  });

  // protects=a try with a failed request is struck, and the list that strikes it leaves it out of the score: its rerun is read instead, and an item void twice is left out on both arms; fails_when=a void try's ✓ or no-evidence counts, or a twice-void item is read on the other arm; no_claim=why the provider failed.
  test("a void try is left out of the score by the same list that strikes it", () => {
    const voided = record(
      "main",
      "pair-1-right#1",
      [sentence(RIGHT, "not-checked", { reason: "no-evidence", asks: [REFERENCES] })],
      {
        failed: ["AI_APICallError 529, asked with “You check one sentence”"],
      },
    );
    const rerun = record(
      "main",
      "pair-1-right#1",
      [sentence(RIGHT, "supported", { asks: [THE_ROWS] })],
      { attempt: 2 },
    );
    const branch = record("branch", "pair-1-right#1", [sentence(RIGHT, "supported")]);
    const twice = [1, 2].map((attempt) =>
      record("branch", "pair-2-wrong#1", [sentence(WRONG, "not-checked", { reason: "failed" })], {
        attempt,
      }),
    );
    const onMain = record("main", "pair-2-wrong#1", [
      sentence(WRONG, "supported", { asks: [THE_ROWS] }),
    ]);
    const scored = scoreOf(fullRun([voided, rerun, branch, ...twice, onMain]));
    expect(scored.struck.map((each) => `${each.arm} ${each.key} ${each.attempt}`)).toEqual([
      "main pair-1-right#1 1",
      "branch pair-2-wrong#1 1",
      "branch pair-2-wrong#1 2",
    ]);
    expect(scored.leftOut).toEqual(["pair-2-wrong#1"]);
    expect(
      scored.read.main.filter((each) => each.key === "pair-1-right#1").map((each) => each.attempt),
    ).toEqual([2]);
    expect(scored.read.main.some((each) => each.key === "pair-2-wrong#1")).toBe(false);
    expect(bar2(scored.read).main).toBe(0);
    expect(bar3Pairs(scored.read).main).toBe(0);
  });

  // protects=bars 1 and 2 read "not settled" while main shows the fault fewer than 4 times, whatever the branch shows, and are read from 4 on; fails_when=3 on main against 0 on the branch reads as holding; no_claim=what a real run shows.
  test("bars 1 and 2 are not settled below 4 on main", () => {
    expect(halfOfMain(3, 0).reading).toBe("not settled");
    expect(halfOfMain(4, 2).reading).toBe("holds");
    expect(halfOfMain(4, 3).reading).toBe("fails");
    expect(halfOfMain(10, 3, 2).reading).toBe("fails");
    const asked = (arm: Arm, count: number, ask: EvidenceAsk) =>
      Array.from({ length: count }, (_, run) =>
        record(arm, `pair-1-right#${run + 1}`, [
          sentence(RIGHT, "not-checked", { reason: "no-evidence", asks: [ask] }),
        ]),
      );
    const read = scoreOf([...asked("main", 3, REFERENCES), ...asked("branch", 3, THE_ROWS)]).read;
    expect(bar1(read)).toEqual({ main: 3, branch: 0, reading: "not settled" });
    expect(bar2(read)).toEqual({ main: 3, branch: 3, reading: "not settled" });
  });

  // protects=bar 2 counts a right sentence's check that ends with no evidence or found elsewhere, its evidence not on its own rows, settles on main's two kinds together, lists each check by its kind and gives both kinds by arm and language; a wrong twin's check isn't counted, a check holding both kinds is no evidence, and the main arm must have run the run's main's src; fails_when=a found-elsewhere check is missed and main's 4 reads as 2, not settled, or a wrong twin is counted; no_claim=why the check ended so.
  test("bar 2 counts a right sentence's check that ends with no evidence or found elsewhere, by kind", () => {
    const ended = (
      arm: Arm,
      key: string,
      reason: SentenceSupport["reason"],
      language: ItemRecord["language"] = "en",
    ) =>
      record(
        arm,
        key,
        [sentence(RIGHT, reason === null ? "supported" : "not-checked", { reason })],
        { language },
      );
    const records = fullRun([
      ended("main", "pair-1-right#1", "no-evidence"),
      ended("main", "pair-1-right#2", "found-elsewhere"),
      ended("main", "pair-1-right#3", "found-elsewhere"),
      ended("main", "pair-4-right#1", "no-evidence", "zh-CN"),
      ended("main", "pair-1-wrong#1", "found-elsewhere"),
      ended("branch", "pair-1-right#1", "found-elsewhere"),
      ended("branch", "pair-1-right#2", null),
      ended("branch", "pair-1-right#3", null),
      ended("branch", "pair-4-right#1", null, "zh-CN"),
      ended("branch", "pair-1-wrong#1", "found-elsewhere"),
    ]);
    const read = scoreOf(records).read;
    expect(bar2(read)).toEqual({ main: 4, branch: 1, reading: "holds" });
    expect(offRows(read.main).map(({ record: { key }, kind }) => `${key} ${kind}`)).toEqual([
      "pair-1-right#1 no evidence",
      "pair-1-right#2 found elsewhere",
      "pair-1-right#3 found elsewhere",
      "pair-4-right#1 no evidence",
    ]);
    const both = {
      ...sentence(RIGHT, "not-checked", { reason: "found-elsewhere" }),
      parts: [partOf("found-elsewhere"), partOf("no-evidence")],
    };
    expect(offItsRows(both)).toBe("no evidence");
    const reading = readBars({
      arms: ARMS,
      records,
      judged: { model: "judge", sentences: [], failedTries: [] },
      judgeDollars: 0,
      runMain: RUN_MAIN,
    });
    const text = reading.lines.join("\n");
    for (const row of [
      "| main | en | 1 | 2 |",
      "| main | zh-CN | 1 | 0 |",
      "| branch | en | 0 | 1 |",
      "| branch | zh-CN | 0 | 0 |",
      `- main, pair-1-right#2, found elsewhere: ${RIGHT}`,
    ])
      expect(text).toContain(row);
    expect(text).toContain("not settled under 4 on main, its two kinds together: holds");
    expect(
      readBars({
        arms: ARMS,
        records,
        judged: null,
        judgeDollars: null,
        runMain: { commit: "abc1234", source: "zzz" },
      }).errors,
    ).toContain("The main arm didn't run the src of the run's main, abc1234.");
  });

  // protects=an ask counts for bar 1 when its reply quotes a bracketed number the sentence doesn't hold, and not when it gives the table's rows; fails_when=the rows' "O(1)" or a fenced reply is miscounted; no_claim=whether the quote is found.
  test("an ask answered with a Document's own reference numbers", () => {
    expect(answeredWithReferences(REFERENCES, RIGHT)).toBe(true);
    expect(answeredWithReferences(THE_ROWS, RIGHT)).toBe(false);
    expect(
      answeredWithReferences({ reply: `\`\`\`json\n${REFERENCES.reply}\n\`\`\`` }, RIGHT),
    ).toBe(true);
    expect(answeredWithReferences(REFERENCES, "The paper's [1] and [2] are cited.")).toBe(false);
  });

  // protects=bar 3 counts a wrong twin's ✓ only when an evidence ask brought it, and lists one with no ask without counting it; fails_when=a ✓ with no ask fails the bar, or one through an ask on a twin main never ticked passes; no_claim=whether the ✓ is right.
  test("bar 3 counts a wrong ✓ reached through an ask, and only lists one reached with no ask", () => {
    const noAsk = (arm: Arm) => record(arm, "pair-2-wrong#1", [sentence(WRONG, "supported")]);
    const listedOnly = scoreOf(
      fullRun([
        noAsk("branch"),
        record("main", "pair-2-wrong#1", [sentence(WRONG, "contradicted")]),
      ]),
    );
    expect(bar3Pairs(listedOnly.read)).toEqual({
      main: 0,
      branch: 0,
      newTwins: [],
      reading: "holds",
    });
    const lines = readBars({
      arms: ARMS,
      records: fullRun([
        noAsk("branch"),
        record("main", "pair-2-wrong#1", [sentence(WRONG, "contradicted")]),
      ]),
      judged: { model: "judge", sentences: [], failedTries: [] },
      judgeDollars: 0,
      runMain: RUN_MAIN,
    }).lines.join("\n");
    expect(lines).toContain(`- branch, pair-2-wrong#1, no ask: ${WRONG}`);

    const throughAsk = record("branch", "pair-2-wrong#1", [
      sentence(WRONG, "supported", { asks: [THE_ROWS] }),
    ]);
    const counted = scoreOf(
      fullRun([
        throughAsk,
        record("main", "pair-2-wrong#1", [sentence(WRONG, "contradicted", { asks: [REFERENCES] })]),
      ]),
    );
    expect(bar3Pairs(counted.read)).toEqual({
      main: 0,
      branch: 1,
      newTwins: [2],
      reading: "fails",
    });
  });

  // protects=the count with no bar reads a record line that puts two quotes under one marker, and not one quote with its location in quotation marks; fails_when=the saved form "[^1]: …, p. 4 — “…” and “…”" is missed; no_claim=whether the reader takes any line.
  test("a reply that puts two quotes under one marker", () => {
    expect(
      twoQuotesUnderOneMarker(
        `Verdict: supported\n[^1]: Weighted Keys, p. 4 — “${ROWS[0]}” and “${ROWS[1]}”`,
      ),
    ).toBe(true);
    expect(
      twoQuotesUnderOneMarker(`- marker 1: passage P2, location "p. 4", quote "${ROWS[0]}"`),
    ).toBe(false);
    expect(twoQuotesUnderOneMarker(`[^1]: “${ROWS[0]}”\n[^2]: “${ROWS[1]}”`)).toBe(false);
    expect(twoQuotesUnderOneMarker(`The table gives “${ROWS[0]}” and “${ROWS[1]}”.`)).toBe(false);
  });

  // protects=each numbered line of the judge's reply gives its sentence stated or the words it names, its last line for a number winning, with list marks and bold around the number read; a sentence with no line is counted unstated, saying the reply didn't read for it; fails_when=an unstated line reads as stated, a correction is ignored, or a missing line drops out of the count; no_claim=how well the judge reads.
  test("the judge's reply is read for each sentence's last line, and one with none as unread", () => {
    const reply = [
      "1: stated",
      "- 2: unstated: “only on short inputs”",
      "**3**: unstated: “承认”",
      "1: unstated",
    ].join("\n");
    expect(statedIn(reply, 4)).toEqual([
      "(no words named)",
      "“only on short inputs”",
      "“承认”",
      expect.stringContaining("the judge's reply doesn't read for it"),
    ]);
    expect(statedIn("1. stated\n2) Stated", 2)).toEqual([null, null]);
  });

  // protects=bar 3 on the research Answers reads "not judged" while a ✓ has no judge's line, or a line the judge's reply didn't give, and counts only the unstated lines the judge gave; fails_when=an unread line counts as unstated on both arms and the bar reads as holding; no_claim=how well the judge reads.
  test("bar 3 on the research Answers is not judged while a ✓ is unread", () => {
    const ticked = sentence(RIGHT, "supported");
    const read = scoreOf(fullRun()).read;
    const judged = (unstated: string | null) => ({
      model: "judge",
      failedTries: [],
      sentences: [ticked, sentence("表 1 显示……", "supported")].map((each) => ({
        key: judgeKey(each),
        sentence: each.sentence,
        cites: each.cites,
        unstated,
      })),
    });
    expect(bar3Research(read, judged(null))).toEqual({
      main: 0,
      branch: 0,
      unjudged: 0,
      reading: "holds",
    });
    const unread = judged(statedIn("", 1)[0] ?? null);
    expect(bar3Research(read, unread)).toEqual({
      main: 0,
      branch: 0,
      unjudged: 4,
      reading: "not judged",
    });
    expect(bar3Research(read, judged("“only”"))).toEqual({
      main: 2,
      branch: 2,
      unjudged: 0,
      reading: "holds",
    });
  });

  // protects=the plan's stop of US$2.50 holds what was spent before, every try of the run and the most one try has cost so far, and a try whose cost isn't known stops the run; fails_when=a try that could pass the stop runs, or an unpriced try is counted as free; no_claim=what the provider bills.
  test("the stop leaves room for the most one try has cost", () => {
    const kept = underTheStop(0.1, [0.5, 0.25, 0.5]);
    expect(kept?.spent).toBeCloseTo(1.35);
    expect(kept).toMatchObject({ most: 0.5, within: true });
    expect(underTheStop(0.5, [0.8, 0.8])?.within).toBe(false);
    expect(underTheStop(0, [0.01, null])).toBeNull();
    expect(underTheStop(0, [])).toEqual({ spent: 0, most: 0, within: true });
  });
});
