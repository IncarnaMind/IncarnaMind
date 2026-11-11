/**
 * The checks evaluation's report keeps the judge's replies readable per case and counts the Not
 * checked by cause (#2910), and two arms are compared by the sentences that flip the same way in
 * every run, each with the replies of both. Literal reports, no model.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  type Arm,
  comparisonMarkdown,
  flipsBetween,
  parseReport,
} from "../../eval/checks/lib/compare";
import type { JudgeRequest } from "../../eval/checks/lib/judge";
import {
  type ChecksReport,
  markdownReport,
  type ReportedSentence,
  repliesReport,
  summaryLines,
  writeChecksReport,
} from "../../eval/checks/lib/report";
import {
  type CheckOutcome,
  gates,
  scoreFindSupport,
  scoreVerify,
} from "../../eval/checks/lib/scoring";
import type { CheckLabel, FindSupportItem } from "../../eval/checks/lib/set";

const request = (reply: string, calls: JudgeRequest["calls"] = []): JudgeRequest => ({
  kind: "check",
  part: null,
  calculateAsked: false,
  reply,
  calls,
});

const SUPPORTED = "Verdict: supported\nEvidence: [1]\nThe update gives net debt.";
const NO_QUOTE = {
  tool: "cite",
  input: '{"citations":[{"marker":1,"quote":"Net debt fell"}]}',
  result:
    "Recorded [^1]. Fix these with another cite call:\n- [^1]: the quote isn't word for word.",
};

const found = (judge: JudgeRequest[]): CheckOutcome => ({
  verdict: "supported",
  evidence: { document: "Board update.md", units: [1, 1], quote: "Net debt was £1,234m" },
  judge,
});
const quoteNotFound: CheckOutcome = {
  verdict: "not-checked",
  reason: "no-evidence",
  code: "no-evidence",
  evidence: null,
  judge: [request("", [NO_QUOTE]), request(SUPPORTED)],
};
const calculationNotMade: CheckOutcome = {
  verdict: "not-checked",
  reason: "no-evidence",
  code: "no-evidence",
  evidence: null,
  judge: [request("Verdict: supported\nCalculation: 1.3x")],
};
const malformed: CheckOutcome = {
  verdict: "not-checked",
  reason: "malformed",
  code: "malformed",
  evidence: null,
  judge: [request("It reads well to me.")],
};
const unsupported = (judge: JudgeRequest[]): CheckOutcome => ({
  verdict: "unsupported",
  evidence: null,
  judge,
});

const sentence = (id: string, label: CheckLabel, outcome: CheckOutcome): ReportedSentence => ({
  id,
  sentence: `Sentence ${id}.`,
  label,
  outcome,
});

function reportOf(commit: string, results: ReportedSentence[]): ChecksReport {
  const items: FindSupportItem[] = results.map(({ id, label }) => ({
    id,
    set: "find-support",
    language: "en",
    document: "Board update.md",
    sentence: `Sentence ${id}.`,
    label,
    evidence: null,
    contradiction: null,
    note: null,
    confirmed: false,
  }));
  const findSupport = scoreFindSupport(items, results, () => "markdown");
  const verify = scoreVerify([], []);
  return {
    run: {
      startedAt: "2026-11-09T10:00:00.000Z",
      seconds: 60,
      commit,
      model: "anthropic/claude-haiku-5-5",
      pipeline: "the app's claim check",
    },
    set: {
      findSupport: results.length,
      verify: 0,
      received: 0,
      confirmed: 0,
      review: { by: null, at: null },
    },
    gating: false,
    gates: gates(findSupport, verify),
    findSupport,
    verify,
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    results: { findSupport: results, verify: [] },
  };
}

const RUN = reportOf("a1b2c3d", [
  sentence("fs-001", "supported", found([request(SUPPORTED)])),
  sentence("fs-002", "supported", quoteNotFound),
  sentence("fs-003", "supported", calculationNotMade),
  sentence("fs-004", "unsupported", malformed),
]);

describe("A run's report", () => {
  test("counts the Not checked by cause, in the report and the summary", () => {
    const counts =
      "3 (no evidence 2: quote not found 1, calculation not made 1; malformed reply 1; other 0)";
    expect(markdownReport(RUN)).toContain(`- Not checked: ${counts}.`);
    expect(summaryLines(RUN, "results/run")).toContain(`  Find support not checked: ${counts}`);
    expect(summaryLines(RUN, "results/run")).toContain(
      "  Every judge reply: results/run/replies.md",
    );
  });

  test("keeps every reply and Tool call per case, readable", () => {
    const sections = repliesReport(RUN).split("\n### ");
    const caseOf = (id: string) => sections.find((each) => each.startsWith(`${id}\n`)) ?? "";

    expect(caseOf("fs-002")).toContain("Sentence fs-002.");
    expect(caseOf("fs-002")).toContain(
      "Labelled supported; the check said not checked, quote not found (no-evidence).",
    );
    expect(caseOf("fs-002")).toContain("#### Request 1: check");
    expect(caseOf("fs-002")).toContain(
      'Tool call `cite`:\n\n```text\n{"citations":[{"marker":1,"quote":"Net debt fell"}]}\n```',
    );
    expect(caseOf("fs-002")).toContain("The app answered:");
    expect(caseOf("fs-002")).toContain("the quote isn't word for word");
    expect(caseOf("fs-002")).toContain(`Reply:\n\n\`\`\`text\n${SUPPORTED}\n\`\`\``);
    expect(caseOf("fs-003")).toContain("calculation not made");
    expect(caseOf("fs-004")).toContain("malformed reply (malformed)");
    expect(caseOf("fs-004")).toContain("It reads well to me.");
    expect(caseOf("fs-001")).toContain("the check said supported.");
  });

  test("fences a reply that holds fences of its own", () => {
    const outcome = found([request("Here:\n```json\n{}\n```")]);
    const replies = repliesReport(reportOf("a1b2c3d", [sentence("fs-001", "supported", outcome)]));

    expect(replies).toContain("````text\nHere:\n```json\n{}\n```\n````");
  });

  test("says when no replies were kept, and when the check asked the model nothing", () => {
    const none: CheckOutcome = { verdict: "unsupported", evidence: null };
    const asked = unsupported([]);
    const replies = repliesReport(
      reportOf("a1b2c3d", [
        sentence("fs-001", "unsupported", none),
        sentence("fs-002", "unsupported", asked),
      ]),
    );

    expect(replies).toContain("No replies were kept for this run.");
    expect(replies).toContain("The check made no request to the model.");
  });

  test("is written with its replies beside it, and compares once read back", async () => {
    const dir = await writeChecksReport(RUN, await mkdtemp(join(tmpdir(), "incarnamind-checks-")));

    expect(await readFile(join(dir, "replies.md"), "utf8")).toContain("It reads well to me.");
    const read = parseReport(await readFile(join(dir, "report.json"), "utf8"), dir);
    expect(read.results.findSupport[1]?.outcome.judge).toEqual(quoteNotFound.judge);
  });

  test("is not read when it was written before the replies were kept", () => {
    const old = JSON.stringify(RUN, (key, value: unknown) => (key === "judge" ? undefined : value));

    expect(() => parseReport(old, "eval/results/old")).toThrow(
      "eval/results/old holds no judge replies",
    );
  });
});

describe("Two arms compared", () => {
  const arm = (name: string, ...runs: ReportedSentence[][]): Arm => ({
    name,
    runs: runs.map((results, index) => ({
      dir: `eval/results/${name}-${index + 1}`,
      report: reportOf(`${name}${index + 1}`, results),
    })),
  });
  const lost = request("Verdict: supported\nCalculation: none");

  const main = arm(
    "main",
    [
      sentence("fs-050", "supported", found([lost])),
      sentence("fs-056", "supported", found([request("main run 1 on fs-056")])),
      sentence("fs-008", "supported", found([request("main run 1 on fs-008")])),
      sentence("fs-140", "unsupported", unsupported([request("main run 1 on fs-140")])),
    ],
    [
      sentence("fs-050", "supported", found([lost])),
      sentence("fs-056", "supported", found([request("main run 2 on fs-056")])),
      sentence("fs-008", "supported", quoteNotFound),
      sentence("fs-140", "unsupported", unsupported([request("main run 2 on fs-140")])),
    ],
  );
  const pr = arm(
    "pr",
    [
      sentence("fs-050", "supported", calculationNotMade),
      sentence("fs-056", "supported", quoteNotFound),
      sentence("fs-008", "supported", found([request("pr run 1 on fs-008")])),
      sentence("fs-140", "unsupported", malformed),
    ],
    [
      sentence("fs-050", "supported", calculationNotMade),
      sentence("fs-056", "supported", quoteNotFound),
      sentence("fs-008", "supported", found([request("pr run 2 on fs-008")])),
      sentence("fs-140", "unsupported", unsupported([request("pr run 2 on fs-140")])),
    ],
  );

  test("lists a sentence that is one verdict in every run of an arm and another in every run of the other", () => {
    expect(flipsBetween(main, pr).map(({ id, from, to }) => [id, from, to])).toEqual([
      ["fs-050", "supported", "not-checked"],
      ["fs-056", "supported", "not-checked"],
    ]);
  });

  test("leaves out a sentence that differs in only some runs, or whose verdict an arm doesn't hold in every run", () => {
    const ids = flipsBetween(main, pr).map(({ id }) => id);

    expect(ids).not.toContain("fs-008");
    expect(ids).not.toContain("fs-140");
  });

  test("prints each flip with the replies of both arms, run by run", () => {
    const markdown = comparisonMarkdown(main, pr);

    expect(markdown).toContain("### Supported in main, Not checked in pr: 2");
    expect(markdown).toContain("#### fs-050\n\nSentence fs-050.\n\nLabelled supported.");
    expect(markdown).toContain("##### main, run 1: supported");
    expect(markdown).toContain("##### main, run 2: supported");
    expect(markdown).toContain("##### pr, run 1: not checked, calculation not made (no-evidence)");
    expect(markdown).toContain("##### pr, run 2: not checked, calculation not made (no-evidence)");
    expect(markdown).toContain("Every reply: eval/results/pr-2/replies.md#fs-050");
    expect(markdown).toContain("Calculation: none");
    expect(markdown).toContain("Calculation: 1.3x");
    expect(markdown).toContain("##### pr, run 1: not checked, quote not found (no-evidence)");
    expect(markdown).toContain("Fix these with another cite call");
  });

  test("counts each arm's correct Supported and Not checked by cause over its runs", () => {
    const markdown = comparisonMarkdown(main, pr);

    expect(markdown).toContain(
      "- main: 2 runs at main1, main2 with anthropic/claude-haiku-5-5. Correct Supported 3 + 2 = 5;",
    );
    expect(markdown).toContain(
      "- pr: 2 runs at pr1, pr2 with anthropic/claude-haiku-5-5. Correct Supported 1 + 1 = 2;",
    );
    expect(markdown).toContain(
      "- main, over its runs: 1 (no evidence 1: quote not found 1, calculation not made 0; malformed reply 0; other 0).",
    );
    expect(markdown).toContain(
      "- pr, over its runs: 5 (no evidence 4: quote not found 2, calculation not made 2; malformed reply 1; other 0).",
    );
  });

  test("says when each arm has one run, whose flips may be the run-to-run spread", () => {
    const one = comparisonMarkdown(
      arm("main", [sentence("fs-050", "supported", found([lost]))]),
      arm("pr", [sentence("fs-050", "supported", calculationNotMade)]),
    );

    expect(one).toContain("Each arm has one run, so a flip here may be the run-to-run spread.");
    expect(one).toContain("1 in all.");
  });

  test("lists nothing when no sentence flips", () => {
    expect(comparisonMarkdown(main, main)).toContain("None.");
  });
});

describe("The comparison command", () => {
  const run = async (args: string[]) => {
    const argv = process.argv;
    const printed: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((line: string) => void printed.push(line));
    process.argv = ["node", "compare.ts", ...args];
    vi.resetModules();
    try {
      await import("../../eval/checks/compare");
    } finally {
      process.argv = argv;
      log.mockRestore();
    }
    return printed.join("\n");
  };

  test("prints the comparison of the arms from their results folders", async () => {
    const folder = await mkdtemp(join(tmpdir(), "incarnamind-compare-"));
    const kept = (name: string, ...results: ReportedSentence[]) =>
      writeChecksReport(reportOf(name, results), join(folder, name));
    const lost = sentence("fs-050", "supported", found([request("Verdict: supported")]));
    const missed = sentence("fs-050", "supported", calculationNotMade);

    const printed = await run([
      "--arm",
      "main",
      await kept("main-1", lost),
      await kept("main-2", lost),
      "--arm",
      "pr",
      await kept("pr-1", missed),
      await kept("pr-2", missed),
    ]);

    expect(printed).toContain("# Checks evaluation: main against pr (#2910)");
    expect(printed).toContain("### Supported in main, Not checked in pr: 1");
    expect(printed).toContain("Calculation: 1.3x");
  });

  test("says how it is used when there aren't two arms with runs", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(run(["--arm", "main", "eval/results/one"])).rejects.toThrow("exit 2");
      expect(error).toHaveBeenCalledWith(expect.stringContaining("--arm <name> <run folder>"));
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});
