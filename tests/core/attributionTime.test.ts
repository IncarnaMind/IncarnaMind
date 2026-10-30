import { utimes } from "node:fs/promises";
import { expect, test } from "vitest";
import type { ClaimCheckResult, ClaimFacetPeriod } from "../../src/core/api";
import { formatClaimFacetPeriod } from "../../src/shared/dates";
import { translate } from "../../src/shared/i18n";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { type ModelCall, scriptedModel } from "../helpers/models";

type TimeCase = {
  language: "en" | "zh-CN";
  title: string;
  quote: string;
  period?: ClaimFacetPeriod;
  expected: "supported" | "unsupported";
};

const CASES: TimeCase[] = [
  {
    language: "en",
    title: "Rate notice — March 2023",
    quote: "As of March 2023, the base rate was 5%.",
    period: { start: "2023-03-01", end: "2023-03-31", precision: "month" },
    expected: "unsupported",
  },
  {
    language: "zh-CN",
    title: "利率通知——2023年3月",
    quote: "截至2023年3月，基准利率为5%。",
    period: { start: "2023-03-01", end: "2023-03-31", precision: "month" },
    expected: "unsupported",
  },
  {
    language: "en",
    title: "Rate statement — September 2025",
    quote: "For the period 1–30 September 2025, the base rate was 5%.",
    period: { start: "2025-09-01", end: "2025-09-30", precision: "month" },
    expected: "unsupported",
  },
  {
    language: "zh-CN",
    title: "利率说明——2025年9月",
    quote: "在2025年9月1日至30日期间，基准利率为5%。",
    period: { start: "2025-09-01", end: "2025-09-30", precision: "month" },
    expected: "unsupported",
  },
  {
    language: "en",
    title: "Base rate statement",
    quote: "The base rate is 5%.",
    expected: "unsupported",
  },
  { language: "zh-CN", title: "基准利率说明", quote: "基准利率为5%。", expected: "unsupported" },
  {
    language: "en",
    title: "Rate statement — March 2026",
    quote: "For the period 1–31 March 2026, the base rate was 5%.",
    period: { start: "2026-03-01", end: "2026-03-31", precision: "month" },
    expected: "supported",
  },
  {
    language: "zh-CN",
    title: "利率说明——2026年3月",
    quote: "在2026年3月1日至31日期间，基准利率为5%。",
    period: { start: "2026-03-01", end: "2026-03-31", precision: "month" },
    expected: "supported",
  },
];

type TimeOptions = {
  time?: "present" | "this-year" | "last-year" | "explicit";
  qualifier?: string;
  claim?: string;
  at?: string;
  period?: unknown;
  neighbor?: { title: string; quote: string };
};

async function setUp(row: TimeCase, options: TimeOptions = {}) {
  const frames: ModelCall[] = [];
  const qualifier = options.qualifier ?? (row.language === "en" ? "currently" : "目前");
  const claim =
    options.claim ??
    (row.language === "en" ? "The base rate is currently 5%." : "基准利率目前为5%。");
  const declared = Object.hasOwn(options, "period") ? options.period : (row.period ?? null);
  const quotes = [row.quote, ...(options.neighbor ? [options.neighbor.quote] : [])];
  const wire = [
    { kind: "fact", text: qualifier, facet: { kind: "time" } },
    { kind: "fact", text: "5%" },
  ];
  const model = scriptedModel((call) => {
    frames.push(call);
    const searched = call.results.find((result) => result.tool === "search_documents");
    if (!searched)
      return {
        text: `Parts: ${JSON.stringify(wire)}`,
        calls: [
          {
            tool: "search_documents",
            input: { query: row.language === "en" ? "base rate" : "基准利率" },
          },
        ],
      };
    if (!call.results.some((result) => result.tool === "cite")) {
      const citations = quotes.map((quote, at) => {
        const passage = shownPassages(searched.text).find((each) => each.text.includes(quote));
        if (!passage)
          throw new Error(`The time check did not find its actual rate quote: ${quote}`);
        return { marker: at + 1, passage: passage.id, quote };
      });
      return { calls: [{ tool: "cite", input: { citations } }] };
    }
    return {
      text: [
        "Verdict: supported",
        "Scope: none, same",
        "Topic: found",
        "Absence: no",
        "Roles: none, same",
        "Calculation: none",
        `Evidence: ${JSON.stringify(quotes.map((_, at) => at + 1))}`,
        `${row.quote} [^1]`,
        `Facets: ${JSON.stringify({
          items: [
            {
              text: qualifier,
              kind: "time",
              occurrence: 1,
              verdict: "supported",
              scope: "same",
              topic: "found",
              roles: "same",
              says: row.quote,
              evidence: [1],
              time: options.time ?? "present",
              ...(declared !== undefined && { period: declared }),
            },
          ],
        })}`,
      ].join("\n"),
    };
  });
  const clock = manualClock(options.at ?? "2026-10-29T12:00:00.000Z");
  const { core } = await setUpWithDocuments(model, [], { now: clock.now });
  const { settings } = await core.getLibrary();
  await core.saveLibrarySettings({ ...settings, automatic: false });
  const folder = await createTempDataFolder();
  const path = await writeSourceFile(folder, `${row.title}.md`, `# ${row.title}\n\n${row.quote}`);
  const fileDate = new Date("2026-10-29T09:00:00.000Z");
  await utimes(path, fileDate, fileDate);
  const extra = options.neighbor
    ? [
        await writeSourceFile(
          folder,
          `${options.neighbor.title}.md`,
          `# ${options.neighbor.title}\n\n${options.neighbor.quote}`,
        ),
      ]
    : [];
  const [document] = await addAndProcess(core, [path, ...extra]);
  if (!document) throw new Error("The time Source was not imported.");
  expect(document.tagging).toBe("off");
  await core.updateSettings({ user: { language: row.language } });
  const check = async () => {
    const before = model.doStreamCalls.length + model.doGenerateCalls.length;
    const frameStart = frames.length;
    const result = await core.checkClaim({ claim });
    expect(model.doStreamCalls.length + model.doGenerateCalls.length - before).toBe(3);
    expect(frames.slice(frameStart).map((call) => call.results.map(({ tool }) => tool))).toEqual([
      [],
      ["search_documents"],
      ["search_documents", "cite"],
    ]);
    for (const frame of frames.slice(frameStart)) {
      expect(frame.prompt).toContain(claim);
      expect(`${frame.system}\n${frame.prompt}`).not.toContain(clock.now().toISOString());
    }
    expect(frames.at(-1)?.results.find(({ tool }) => tool === "cite")?.text).toContain(
      "Recorded [^1]",
    );
    return result;
  };
  return { check, clock, claim, qualifier, document, frames };
}

function timePart(result: ClaimCheckResult) {
  const part = result.parts?.find((part) => part.facet?.kind === "time");
  if (!part) throw new Error("The public result lost its time facet.");
  return part;
}

test.each(CASES)(
  "present time uses only its checked statement period: $language $title",
  async (row) => {
    const setup = await setUp(row);
    const result = await setup.check();
    expect(result.verdict).toBe(row.expected);
    const part = timePart(result);
    expect(part).toMatchObject({
      kind: "fact",
      verdict: row.expected,
      span: {
        start: setup.claim.indexOf(setup.qualifier),
        end: setup.claim.indexOf(setup.qualifier) + setup.qualifier.length,
      },
      facet: { kind: "time", ...(row.period && { period: row.period }) },
      evidence: [{ documentId: setup.document.id, quote: row.quote, check: "found" }],
    });
    if (!row.period) {
      expect(part.facet).toEqual({ kind: "time" });
      expect(part.unsupported?.reason).toBe(
        translate(row.language, "claim.time.noPeriod", { document: setup.document.name }),
      );
    } else {
      const text = translate(
        row.language,
        row.expected === "supported" ? "claim.time.supported" : "claim.time.stale",
        {
          document: setup.document.name,
          period: formatClaimFacetPeriod(row.period, row.language),
        },
      );
      expect(row.expected === "supported" ? part.says : part.unsupported?.reason).toBe(text);
    }
  },
);

test.each(["en", "zh-CN"] as const)(
  "a period cannot borrow another row or file date (%s)",
  async (language) => {
    const row = CASES.find((row) => row.language === language && row.period === undefined);
    if (!row) throw new Error("Missing undated rate fixture");
    const neighbor = CASES.find((row) => row.language === language && row.expected === "supported");
    if (!neighbor?.period) throw new Error("Missing dated neighbor fixture");
    const setup = await setUp(row, { period: neighbor.period, neighbor });
    const result = await setup.check();
    const part = timePart(result);
    expect(result.verdict).toBe("unsupported");
    expect(part).toMatchObject({
      verdict: "unsupported",
      facet: { kind: "time" },
      evidence: [{ documentId: setup.document.id, quote: row.quote, check: "found" }],
    });
    expect(part.facet).toEqual({ kind: "time" });
    expect(part.unsupported?.reason).toBe(
      translate(language, "claim.time.noPeriod", { document: setup.document.name }),
    );
    expect(result.parts?.find((part) => !part.facet)?.evidence).toHaveLength(2);
  },
);

test.each([
  { language: "en", reply: "missing", period: undefined },
  { language: "zh-CN", reply: "missing", period: undefined },
  {
    language: "en",
    reply: "unreadable",
    period: { start: "2026-02-30", end: "2026-03-31", precision: "month" },
  },
  {
    language: "zh-CN",
    reply: "unreadable",
    period: { start: "2026-02-30", end: "2026-03-31", precision: "month" },
  },
] as const)(
  "a $reply period is Not checked, never decided from a date ($language)",
  async ({ language, period }) => {
    const row = CASES.find((row) => row.language === language && row.expected === "supported");
    if (!row) throw new Error("Missing recent rate fixture");
    const setup = await setUp(row, { period });
    const result = await setup.check();
    expect(result.verdict).not.toBe("supported");
    expect(timePart(result)).toMatchObject({
      verdict: "not-checked",
      reason: "malformed",
      facet: { kind: "time" },
    });
    expect(result.parts?.find((part) => !part.facet)?.verdict).toBe("supported");
  },
);

test.each(["en", "zh-CN"] as const)(
  "an explicit later Check re-evaluates the calendar anniversary (%s)",
  async (language) => {
    const row: TimeCase = {
      language,
      title: language === "en" ? "Daily rate" : "每日利率",
      quote:
        language === "en"
          ? "On 29 October 2025, the base rate was 5%."
          : "2025年10月29日，基准利率为5%。",
      period: { start: "2025-10-29", end: "2025-10-29", precision: "day" },
      expected: "supported",
    };
    const setup = await setUp(row);
    const first = await setup.check();
    expect(first.verdict).toBe("supported");
    expect(timePart(first).facet).toEqual({ kind: "time", period: row.period });
    setup.clock.advance(24 * 60 * 60 * 1000);
    const second = await setup.check();
    expect(second.verdict).toBe("unsupported");
    expect(timePart(second).facet).toEqual({ kind: "time", period: row.period });
    expect(timePart(first).verdict).toBe("supported");
    expect(first.versions).toEqual(second.versions);
    expect(setup.frames).toHaveLength(6);
  },
);

test.each([
  {
    language: "en",
    time: "this-year",
    qualifier: "This year",
    claim: "This year, the base rate is 5%.",
    year: "2026",
    expected: "supported",
  },
  {
    language: "zh-CN",
    time: "this-year",
    qualifier: "今年",
    claim: "今年基准利率为5%。",
    year: "2026",
    expected: "supported",
  },
  {
    language: "en",
    time: "this-year",
    qualifier: "This year",
    claim: "This year, the base rate is 5%.",
    year: "2025",
    expected: "unsupported",
  },
  {
    language: "zh-CN",
    time: "this-year",
    qualifier: "今年",
    claim: "今年基准利率为5%。",
    year: "2025",
    expected: "unsupported",
  },
  {
    language: "en",
    time: "last-year",
    qualifier: "Last year",
    claim: "Last year, the base rate was 5%.",
    year: "2025",
    expected: "supported",
  },
  {
    language: "zh-CN",
    time: "last-year",
    qualifier: "去年",
    claim: "去年基准利率为5%。",
    year: "2025",
    expected: "supported",
  },
  {
    language: "en",
    time: "last-year",
    qualifier: "Last year",
    claim: "Last year, the base rate was 5%.",
    year: "2026",
    expected: "unsupported",
  },
  {
    language: "zh-CN",
    time: "last-year",
    qualifier: "去年",
    claim: "去年基准利率为5%。",
    year: "2026",
    expected: "unsupported",
  },
] as const)("the same-Run $time reading uses the injected year ($language/$year)", async (row) => {
  const fixture: TimeCase = {
    language: row.language,
    title: row.language === "en" ? "Yearly rate" : "年度利率",
    quote:
      row.language === "en"
        ? `In ${row.year}, the base rate was 5%.`
        : `${row.year}年，基准利率为5%。`,
    period: { start: `${row.year}-01-01`, end: `${row.year}-12-31`, precision: "year" },
    expected: row.expected,
  };
  const setup = await setUp(fixture, row);
  const result = await setup.check();
  expect(result.verdict).toBe(row.expected);
  expect(timePart(result)).toMatchObject({
    verdict: row.expected,
    facet: { kind: "time", period: fixture.period },
  });
});

test.each(["en", "zh-CN"] as const)(
  "explicit history and fiscal ending-year keep their stated day (%s)",
  async (language) => {
    const historical: TimeCase = {
      language,
      title: language === "en" ? "Historical rate" : "历史利率",
      quote:
        language === "en"
          ? "On 29 February 2024, the base rate was 5%."
          : "2024年2月29日，基准利率为5%。",
      period: { start: "2024-02-29", end: "2024-02-29", precision: "day" },
      expected: "supported",
    };
    const history = await setUp(historical, {
      time: "explicit",
      qualifier: language === "en" ? "On 29 February 2024" : "2024年2月29日",
      claim:
        language === "en"
          ? "On 29 February 2024, the base rate was 5%."
          : "2024年2月29日，基准利率为5%。",
    });
    const result = await history.check();
    expect(result.verdict).toBe("supported");
    expect(timePart(result).facet).toEqual({ kind: "time", period: historical.period });
    const fiscal: TimeCase = {
      language,
      title: language === "en" ? "Fiscal rate" : "财年利率",
      quote:
        language === "en"
          ? "For the fiscal year ended 30 June 2025, the base rate was 5%."
          : "截至2025年6月30日的财年，基准利率为5%。",
      period: { start: "2025-06-30", end: "2025-06-30", precision: "day" },
      expected: "supported",
    };
    const ending = await setUp(fiscal, {
      time: "last-year",
      qualifier: language === "en" ? "Last year" : "去年",
      claim: language === "en" ? "Last year, the base rate was 5%." : "去年基准利率为5%。",
    });
    const checked = await ending.check();
    expect(checked.verdict).toBe("supported");
    expect(timePart(checked).facet).toEqual({ kind: "time", period: fiscal.period });
  },
);
