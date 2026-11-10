/**
 * The offline step of #2184's diagnosis: each kept claims reply read by `replyJson` before the
 * change and after it. With INCARNAMIND_CLAIMS_REPLIES naming a repeats `report.json`, it prints a
 * line for each of that report's claims requests.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { readingLines, readingOf } from "../../eval/repeats/claimsReading";

const SORTED = JSON.stringify({
  sentences: [
    { number: 1, parts: [{ kind: "fact", text: "乙方可保持地块无杂草。" }] },
    { number: 2, parts: [{ kind: "fact", text: "乙方可每月清理地块内的垃圾。" }] },
  ],
});

// protects=a claims reply whose words close a bracket before its JSON is read by the changed reader and not by main's (#2184); fails_when=the readers read it alike; no_claim=what a real model writes.
test("words that close a bracket before the JSON: main's reader reads nothing, the changed one both records", () => {
  expect(readingOf(`第 [1] 句和第 [2] 句都写的是乙方的权利。\n\n${SORTED}`)).toEqual({
    main: null,
    changed: 2,
  });
});

// protects=a plain claims reply reads the same before and after the change (#2184); fails_when=either reader misses its records; no_claim=what a real model writes.
test("a plain reply: both readers read both records", () => {
  expect(readingOf(SORTED)).toEqual({ main: 2, changed: 2 });
});

// protects=a report's kept claims requests each get one line naming both readings and a request that never finished; fails_when=a line is missing or misread; no_claim=what a real model writes.
test("one line for each kept claims request", () => {
  expect(
    readingLines({
      claims: [
        {
          set: "zh-allotment-conflicts",
          repeat: 1,
          requests: [
            { reply: `Sentences [1] and [2]:\n${SORTED}`, ms: 900 },
            { reply: "", ms: 0 },
          ],
        },
      ],
    }),
  ).toEqual([
    "zh-allotment-conflicts check 1 request 1: main's reader not read; this one read, 2 records",
    "zh-allotment-conflicts check 1 request 2 (never finished): main's reader not read; this one not read",
  ]);
});

const REPORT = process.env.INCARNAMIND_CLAIMS_REPLIES;

test.runIf(REPORT)("the kept claims replies of a report", () => {
  for (const line of readingLines(JSON.parse(readFileSync(REPORT ?? "", "utf8"))))
    console.log(line);
});
