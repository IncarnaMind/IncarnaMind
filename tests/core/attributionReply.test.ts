import { describe, expect, test } from "vitest";
import { readAttributionReply } from "../../src/core/answers/checks/attributionReply";
import { checkInstructions } from "../../src/core/answers/checks/prompt";
import type { ClaimPartPlan } from "../../src/core/api";

const source = (text: string, more: Record<string, unknown> = {}) => ({
  text,
  kind: "source",
  ...(more.kind === undefined || more.kind === "source" ? { sourceName: text } : {}),
  ...(more.kind === "speaker" && {
    claimedSpeaker: "张三",
    actualSpeaker: "张三",
    actualSpeakerNamed: true,
    speakerOrigin: "quote",
  }),
  occurrence: 1,
  verdict: "supported",
  scope: "same",
  topic: "found",
  roles: "same",
  says: null,
  evidence: [1],
  ...more,
});

const reply = (items: unknown[]) => `Facets: ${JSON.stringify({ items })}`;

describe("same-Run facet reply binding", () => {
  test.each([
    ["According to Atlas", "Atlas"],
    ["据阿特拉斯", "阿特拉斯"],
  ])("reads the exact offered source words %s", (text, sourceName) => {
    const original = `${text}, revenue was 100.`;
    const plans: ClaimPartPlan[] = [
      { kind: "fact", span: { start: 0, end: text.length }, facet: { kind: "source" } },
    ];
    expect(readAttributionReply(reply([source(text, { sourceName })]), original, plans)).toEqual([
      {
        verdict: "supported",
        scope: "same",
        topic: "found",
        roles: "same",
        says: null,
        covered: null,
        uncovered: null,
        evidence: [1],
        sourceName,
      },
    ]);
  });

  test("reads a next-line Source field after an ordinary verdict", () => {
    const original = "According to the 2023 Annual Report, revenue for 2023 was GBP 12 million.";
    const plans: ClaimPartPlan[] = [
      { kind: "fact", span: { start: 0, end: 35 }, facet: { kind: "source" } },
    ];
    const text =
      'Verdict: supported\nAbsence: no\nEvidence: [1]\nCalculation: none\n\nFacets:\n{"items":[{"text":"According to the 2023 Annual Report","kind":"source","sourceName":"2023 Annual Report","occurrence":1,"verdict":"supported","scope":"same","topic":"found","roles":"same","says":null,"evidence":[1]}]}\n\nCitations:\n[^1] Revenue for 2023 was GBP 12 million.';
    expect(readAttributionReply(text, original, plans)[0]).toMatchObject({
      verdict: "supported",
      sourceName: "2023 Annual Report",
      evidence: [1],
    });
  });

  test.each([
    {
      words: "According to Atlas",
      title: "Atlas",
      says: 'A } and "quoted" word; Facets: is literal text.',
    },
    { words: "据阿特拉斯", title: "阿特拉斯", says: "原文包含 } 和“引号”，Facets: 也是原文。" },
  ])("inline and multiline JSON preserve exact row binding: $words", ({ words, title, says }) => {
    const plans: ClaimPartPlan[] = [
      { kind: "fact", span: { start: 0, end: words.length }, facet: { kind: "source" } },
    ];
    const items = [source(words, { sourceName: title, says })];
    const inline = readAttributionReply(reply(items), words, plans);
    for (const text of [
      `Facets:\n${JSON.stringify({ items })}`,
      `Facets: \n\t${JSON.stringify({ items }, null, 2)}`,
      `Facets:\r\n${JSON.stringify({ items }, null, 2).replace(/\n/g, "\r\n")} [^1][^2]\r\nEvidence: [1]`,
    ])
      expect(readAttributionReply(text, words, plans)).toEqual(inline);
    expect(inline[0]?.says).toBe(says);
  });

  test("multiline decoding never borrows another field or an earlier valid object", () => {
    const words = "Atlas";
    const plans: ClaimPartPlan[] = [
      { kind: "fact", span: { start: 0, end: words.length }, facet: { kind: "source" } },
    ];
    const valid = JSON.stringify({ items: [source(words)] });
    for (const text of [
      `Evidence: ${valid}`,
      `Facets:\nEvidence: [1]\n${valid}`,
      `Facets: unavailable\n${valid}`,
      `Facets: ${valid}\nFacets:\n{broken}\nCoverage: ${valid}`,
      `Facets: ${valid}\nFacets:\n{"items":[`,
      'Facets:\n{"items": [unquoted]}',
      'Facets:\n{"items": [],}',
      `Facets:\n${valid} unexplained`,
      `Facets:\n${valid} ${valid}`,
      `Facets:\n${valid} [^0]`,
      `Facets:\n${valid.replace('"Atlas"', '"At\nlas"')}`,
    ])
      expect(readAttributionReply(text, words, plans)).toEqual([null]);
  });

  test("binds repeated literal words by occurrence in the whole assertion, not reply order", () => {
    const original = "Atlas says X; Atlas says Y.";
    const plans: ClaimPartPlan[] = [
      { kind: "fact", span: { start: 0, end: 10 }, facet: { kind: "source" } },
      { kind: "fact", span: { start: 14, end: 24 }, facet: { kind: "source" } },
    ];
    const items = [
      source("Atlas says", { occurrence: 2, verdict: "unsupported", evidence: [2] }),
      source("Atlas says"),
    ];
    const parsed = readAttributionReply(reply(items), original, plans);
    expect(parsed.map((row) => row && [row.verdict, row.evidence])).toEqual([
      ["supported", [1]],
      ["unsupported", [2]],
    ]);
    const later = plans[1];
    if (!later) throw new Error("The later facet plan is missing.");
    expect(readAttributionReply(reply([items[0]]), original, [later])[0]?.evidence).toEqual([2]);
  });

  test("counts overlapping Chinese literal starts in the original", () => {
    const plans: ClaimPartPlan[] = [
      { kind: "fact", span: { start: 1, end: 3 }, facet: { kind: "source" } },
    ];
    expect(
      readAttributionReply(reply([source("哈哈", { occurrence: 2 })]), "哈哈哈", plans)[0]?.verdict,
    ).toBe("supported");
  });

  test.each([
    { scope: "unknown" },
    { topic: "maybe" },
    { roles: "same sometimes" },
    { says: 4 },
    { evidence: [0] },
    { evidence: [-1] },
    { evidence: [1.5] },
    { evidence: [1, 1] },
    { evidence: [10000] },
    { evidence: ["1"] },
    { evidence: null },
    { verdict: "checking" },
    { kind: "speaker" },
    { period: null },
    { time: "present" },
  ])("isolates an invalid requested row %j", (fields) => {
    const plans: ClaimPartPlan[] = [
      { kind: "fact", span: { start: 0, end: 5 }, facet: { kind: "source" } },
      { kind: "fact", span: { start: 7, end: 12 }, facet: { kind: "speaker" } },
    ];
    const parsed = readAttributionReply(
      reply([source("Atlas", fields), source("张三说的话", { kind: "speaker" })]),
      "Atlas, 张三说的话。",
      plans,
    );
    expect(parsed[0]).toBeNull();
    expect(parsed[1]?.verdict).toBe("supported");
  });

  test.each(["scope", "topic", "roles", "says", "evidence", "sourceName"])(
    "requires the own %s field",
    (field) => {
      const item: Record<string, unknown> = source("Atlas");
      delete item[field];
      const plans: ClaimPartPlan[] = [
        { kind: "fact", span: { start: 0, end: 5 }, facet: { kind: "source" } },
      ];
      expect(readAttributionReply(reply([item]), "Atlas", plans)).toEqual([null]);
    },
  );

  test("invalidates duplicate known rows and keeps valid neighbors despite unknown rows", () => {
    const plans: ClaimPartPlan[] = [
      { kind: "fact", span: { start: 0, end: 5 }, facet: { kind: "source" } },
      { kind: "fact", span: { start: 7, end: 11 }, facet: { kind: "speaker" } },
    ];
    const parsed = readAttributionReply(
      reply([
        source("Atlas"),
        source("not in the sentence"),
        source("Atlas", { verdict: "checking" }),
        source("张三说了", { kind: "speaker" }),
      ]),
      "Atlas, 张三说了。",
      plans,
    );
    expect(parsed[0]).toBeNull();
    expect(parsed[1]?.verdict).toBe("supported");
  });

  test.each(["present", "this-year", "last-year", "explicit"])(
    "reads time interpretation %s with a shaped period",
    (time) => {
      const plans: ClaimPartPlan[] = [
        { kind: "fact", span: { start: 0, end: 9 }, facet: { kind: "time" } },
      ];
      const period = { start: "2026-01-01", end: "2026-12-31", precision: "year" };
      const parsed = readAttributionReply(
        reply([source("currently", { kind: "time", time, period })]),
        "currently 5%",
        plans,
      );
      expect(parsed[0]).toMatchObject({ verdict: "supported", evidence: [1], time, period });
    },
  );

  test("retains a time row whose quote states no period", () => {
    const plans: ClaimPartPlan[] = [
      { kind: "fact", span: { start: 0, end: 2 }, facet: { kind: "time" } },
    ];
    const parsed = readAttributionReply(
      reply([source("目前", { kind: "time", time: "present", period: null })]),
      "目前5%",
      plans,
    );
    expect(parsed[0]).toMatchObject({ verdict: "supported", evidence: [1], time: "present" });
    expect(parsed[0]).not.toHaveProperty("period");
  });

  test.each([
    undefined,
    {},
    { start: "2026-02-30", end: "2026-03-31", precision: "month" },
    { start: "2026-01-01", end: "2025-12-31", precision: "year" },
  ])("drops a time row whose period is missing or unreadable %j", (period) => {
    const plans: ClaimPartPlan[] = [
      { kind: "fact", span: { start: 0, end: 2 }, facet: { kind: "time" } },
    ];
    const parsed = readAttributionReply(
      reply([source("目前", { kind: "time", time: "present", period })]),
      "目前5%",
      plans,
    );
    expect(parsed).toEqual([null]);
  });

  test.each([undefined, null, "now", 1])(
    "rejects a missing or illegal time interpretation %j",
    (time) => {
      const plans: ClaimPartPlan[] = [
        { kind: "fact", span: { start: 0, end: 2 }, facet: { kind: "time" } },
      ];
      expect(
        readAttributionReply(reply([source("目前", { kind: "time", time })]), "目前5%", plans),
      ).toEqual([null]);
    },
  );

  test.each([0, -1, 1.5, "1", 99])("rejects an invalid or unknown occurrence %j", (occurrence) => {
    const plans: ClaimPartPlan[] = [
      { kind: "fact", span: { start: 0, end: 5 }, facet: { kind: "source" } },
    ];
    expect(readAttributionReply(reply([source("Atlas", { occurrence })]), "Atlas", plans)).toEqual([
      null,
    ]);
  });

  test.each([
    "Verdict: supported",
    "Facets: {broken}",
    "Facets: []",
    "Facets: {}",
    'Facets: {"items":null}',
  ])("does not infer rows from %s", (text) => {
    const plans: ClaimPartPlan[] = [
      { kind: "fact", span: { start: 0, end: 5 }, facet: { kind: "source" } },
    ];
    expect(readAttributionReply(text, "Atlas", plans)).toEqual([null]);
  });

  test.each([" unexplained", ' {"items":[]}', " [^0]"])(
    "rejects unexpected trailing payload %s",
    (tail) => {
      const plans: ClaimPartPlan[] = [
        { kind: "fact", span: { start: 0, end: 5 }, facet: { kind: "source" } },
      ];
      expect(readAttributionReply(reply([source("Atlas")]) + tail, "Atlas", plans)).toEqual([null]);
    },
  );

  test("accepts only a narrow trailing Citation annotation without changing JSON strings", () => {
    const plans: ClaimPartPlan[] = [
      { kind: "fact", span: { start: 0, end: 5 }, facet: { kind: "source" } },
    ];
    const text = reply([source("Atlas", { says: 'The quote contains a } and "brackets".' })]);
    expect(readAttributionReply(`${text} [^1][^2]`, "Atlas", plans)[0]?.says).toBe(
      'The quote contains a } and "brackets".',
    );
  });

  test.each(["Facets: unavailable", "Facets: {broken}"])(
    "a newer malformed line supersedes older rows: %s",
    (last) => {
      const plans: ClaimPartPlan[] = [
        { kind: "fact", span: { start: 0, end: 5 }, facet: { kind: "source" } },
      ];
      expect(readAttributionReply(`${reply([source("Atlas")])}\n${last}`, "Atlas", plans)).toEqual([
        null,
      ]);
    },
  );

  test("uses UTF16-safe offered spans and rejects half a surrogate", () => {
    const plans: ClaimPartPlan[] = [
      { kind: "fact", span: { start: 1, end: 2 }, facet: { kind: "source" } },
      { kind: "fact", span: { start: 2, end: 7 }, facet: { kind: "source" } },
    ];
    const parsed = readAttributionReply(
      reply([source("\ude00"), source("Atlas")]),
      "😀Atlas",
      plans,
    );
    expect(parsed[0]).toBeNull();
    expect(parsed[1]?.verdict).toBe("supported");
  });

  test("does not use provider offsets or name normalization to bind an unknown row", () => {
    const plans: ClaimPartPlan[] = [
      { kind: "fact", span: { start: 0, end: 5 }, facet: { kind: "source" } },
    ];
    expect(
      readAttributionReply(
        reply([source("atlas", { span: { start: 0, end: 5 } })]),
        "Atlas",
        plans,
      ),
    ).toEqual([null]);
  });
});

describe("transient exact source title", () => {
  test.each([undefined, null, "", " ", 12, "Elsewhere"])(
    "rejects a missing or unbound source title %j",
    (sourceName) => {
      const plan: ClaimPartPlan = {
        kind: "fact",
        span: { start: 0, end: 18 },
        facet: { kind: "source" },
      };
      expect(
        readAttributionReply(
          reply([source("According to Atlas", { sourceName })]),
          "According to Atlas, revenue rose.",
          [plan],
        ),
      ).toEqual([null]);
    },
  );
  test.each(["speaker", "time"] as const)("refuses sourceName on a %s row", (kind) => {
    const text = kind === "speaker" ? "Nora said" : "currently";
    const plan: ClaimPartPlan = {
      kind: "fact",
      span: { start: 0, end: text.length },
      facet: { kind },
    };
    expect(
      readAttributionReply(
        reply([
          source(text, { kind, sourceName: text, ...(kind === "time" && { time: "present" }) }),
        ]),
        text,
        [plan],
      ),
    ).toEqual([null]);
  });
  test.each([
    ["According to Atlas", "Atlas"],
    ["据《年度报告》", "年度报告"],
  ])("keeps the literal title %s", (words, sourceName) => {
    const plan: ClaimPartPlan = {
      kind: "fact",
      span: { start: 0, end: words.length },
      facet: { kind: "source" },
    };
    expect(
      readAttributionReply(reply([source(words, { sourceName })]), words, [plan])[0],
    ).toMatchObject({ sourceName });
  });
});

test.each([
  { words: "currently", claim: "The office is currently open." },
  { words: "目前", claim: "办公室目前开放。" },
])(
  "the instructions' time-row example is a supported, period-only reply: $words",
  ({ words, claim }) => {
    const instructions = checkInstructions("tools", "en", "", false, false, true, true);
    const example = [
      ...instructions.matchAll(/Facets: (\{"items":\[\{"text":"([^"]+)".*?\}\]\})/g),
    ].find((match) => match[2] === words)?.[1];
    if (!example) throw new Error(`The instructions lost their ${words} time-row example.`);
    const start = claim.indexOf(words);
    const parsed = readAttributionReply(`Facets: ${example}`, claim, [
      { kind: "fact", span: { start, end: start + words.length }, facet: { kind: "time" } },
    ]);
    expect(parsed[0]).toMatchObject({
      verdict: "supported",
      evidence: [1],
      time: "present",
      period: { start: "2024-06-01", end: "2024-06-30", precision: "month" },
    });
  },
);
