/**
 * The checks evaluation keeps every reply the judge gave, with its Tool calls, beside each
 * outcome (#2910), and tells why a sentence came back "no evidence": through a core with a
 * scripted model that gives literal replies, so a change to the wording the evaluation reads
 * the core's requests by fails here.
 */
import { describe, expect, test } from "vitest";
import {
  type CauseCounts,
  causeOf,
  countCauses,
  type JudgeRequest,
} from "../../eval/checks/lib/judge";
import { corePipeline } from "../../eval/checks/lib/pipeline";
import type { CheckOutcome } from "../../eval/checks/lib/scoring";
import { watchRequests } from "../../eval/repeats/requests";
import { checkingModel, type Plan } from "../helpers/checks";
import { type SourceFile, setUpWithDocuments } from "../helpers/citations";

const TIDES: SourceFile = {
  name: "Tides.md",
  contents: "# Tides\n\nSpring tides happen at new moon and at full moon.\n",
};
const BOARD: SourceFile = {
  name: "Board update.md",
  contents:
    "# Board update\n\nNet debt was £1,234m at the end of 2025.\n\nEBITDA was £942m in 2025.\n",
};

const SPRING = "Spring tides come at new moon.";
const RATIO = "Net debt to EBITDA fell to 1.3x.";
const NET_DEBT = {
  name: "nd",
  label: "Net debt 2025",
  quote: "Net debt was £1,234m",
  number: "£1,234m",
};
const EBITDA = { name: "e", label: "EBITDA 2025", quote: "EBITDA was £942m", number: "£942m" };

/** The check the evaluation runs for a sentence, as the evaluation runs it, over the Documents given. */
async function checked(
  sentence: string,
  plan: Plan,
  files: readonly SourceFile[],
  language: "en" | "zh-CN" = "en",
): Promise<CheckOutcome> {
  const model = checkingModel({ [sentence]: plan });
  const watch = watchRequests([]);
  const { core, documents } = await setUpWithDocuments(model, files, {
    createChatModel: watch.chatModels(() => model),
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-synthetic-test-key",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("checks", saved.service.id);
  await core.updateSettings({ user: { language } });
  const folder = await core.createLibraryGroup({ name: "Folder", description: "The Documents." });
  await core.moveToFolder({ documentIds: documents.map(({ id }) => id), folderId: folder.id });
  const names = new Map(documents.map((document) => [document.id, document.name]));
  const pipeline = corePipeline({
    core,
    generate: async () => {
      throw new Error("Only claim extraction asks for a reply of its own.");
    },
    scope: { folderIds: [folder.id], tagIds: [], documentIds: [] },
    nameOf: (passage) => names.get(passage.documentId) ?? passage.documentName,
    citedName: (citation) => names.get(citation.documentId) ?? citation.documentName,
    watch,
  });
  return pipeline.check(sentence);
}

const callsOf = (outcome: CheckOutcome) => outcome.judge?.flatMap((request) => request.calls) ?? [];

const repliesOf = (outcome: CheckOutcome, kind: string) =>
  (outcome.judge ?? [])
    .filter((request) => request.kind === kind && request.reply !== "")
    .map((request) => request.reply);

describe("A check's outcome keeps what the judge said", () => {
  test("a quote the Citation check doesn't find: the cite call, what the app told the model, and the verdict", async () => {
    const outcome = await checked(
      SPRING,
      { verdict: "supported", quote: "Spring tides happen twice a year", says: "It says so." },
      [TIDES],
    );

    expect(outcome).toMatchObject({ verdict: "not-checked", code: "no-evidence" });
    expect(causeOf(outcome.code, outcome.judge)).toBe("quote-not-found");
    const [search, cite] = callsOf(outcome);
    expect(search).toMatchObject({
      tool: "search_documents",
      input: JSON.stringify({ query: SPRING }),
      result: null,
    });
    expect(cite?.tool).toBe("cite");
    expect(cite?.input).toContain("Spring tides happen twice a year");
    expect(cite?.result).toContain("the quote isn't word for word");
    expect(repliesOf(outcome, "check")).toEqual([
      "Verdict: supported\nAbsence: no\nDuty: none / none, same\nCondition: none / none, same\nIt says so. [^1]",
    ]);
  });

  test("a calculation the app turned away: the calculate call and what the app answered", async () => {
    const outcome = await checked(
      "Net debt to EBITDA was 1.31x.",
      {
        verdict: "unsupported",
        calculation: {
          inputs: [{ ...NET_DEBT, quote: "Net debt was £1,235m" }, EBITDA],
          formula: "nd / e",
          as: "times",
          stated: "1.31x",
        },
      },
      [BOARD],
    );

    expect(outcome).toMatchObject({ verdict: "not-checked", code: "no-evidence" });
    expect(causeOf(outcome.code, outcome.judge)).toBe("calculation-not-made");
    const calculate = callsOf(outcome).find((call) => call.tool === "calculate");
    expect(JSON.parse(calculate?.input ?? "{}")).toMatchObject({
      figures: [{ formula: "nd / e", stated: "1.31x" }],
    });
    expect(calculate?.result).toContain("Nothing was recorded");
    expect(calculate?.result).toContain("Fix these with another calculate call");
  });

  test("a calculation made that settles nothing: its figure was recorded, and the sentence's bare number isn't compared with it", async () => {
    const outcome = await checked(
      "Net debt to EBITDA was 1.31.",
      {
        verdict: "unsupported",
        calculation: { inputs: [NET_DEBT, EBITDA], formula: "nd / e", as: "times", stated: "1.31" },
      },
      [BOARD],
    );

    expect(outcome).toMatchObject({ verdict: "not-checked", code: "number-not-worked-out" });
    expect(causeOf(outcome.code, outcome.judge)).toBe("calculation-not-made");
    const calculate = callsOf(outcome).find((call) => call.tool === "calculate");
    expect(calculate?.result).toMatch(/^Recorded \[=1\] = 1\.31x/);
  });

  test("a calculation the judge was sent back to make and never made", async () => {
    const outcome = await checked(
      RATIO,
      { verdict: "supported", quote: "Net debt was £1,234m", says: "The update gives net debt." },
      [BOARD],
    );

    expect(outcome).toMatchObject({ verdict: "not-checked", code: "number-not-worked-out" });
    expect(causeOf(outcome.code, outcome.judge)).toBe("calculation-not-made");
    expect(callsOf(outcome).map((call) => call.tool)).toEqual(["search_documents", "cite"]);
    expect(outcome.judge?.filter((request) => request.calculateAsked)).toHaveLength(1);
    expect(repliesOf(outcome, "check")).toHaveLength(2);
  });

  test("a reply with no verdict is malformed, and is kept as it was given", async () => {
    const outcome = await checked(SPRING, { reply: { text: "It reads well to me." } }, [TIDES]);

    expect(outcome).toMatchObject({ verdict: "not-checked", code: "malformed" });
    expect(causeOf(outcome.code, outcome.judge)).toBe("malformed");
    expect(repliesOf(outcome, "check")).toEqual(["It reads well to me."]);
  });

  test("a refusal is none of the three", async () => {
    const outcome = await checked(
      SPRING,
      { reply: { text: "I'm sorry, I can't help with that." } },
      [TIDES],
    );

    expect(outcome).toMatchObject({ verdict: "not-checked", code: "refused" });
    expect(causeOf(outcome.code, outcome.judge)).toBe("other");
  });

  test("an explanation asked for again in the interface's language is its own request", async () => {
    const outcome = await checked(
      "比率是 36.8%。",
      {
        verdict: "contradicted",
        quote: "The rate is 38.6%.",
        says: "The report gives the rate as 38.6%, not 36.8%.\nChange 1: 36.8%\nTo 1: 38.6%",
        restated: "报告写的比率是 38.6%，不是 36.8%。",
      },
      [{ name: "Report.md", contents: "The rate is 38.6%.\n比率是报告的比率。\n" }],
      "zh-CN",
    );

    expect(outcome.verdict).toBe("contradicted");
    expect(repliesOf(outcome, "restate")).toEqual(["报告写的比率是 38.6%，不是 36.8%。"]);
    expect(repliesOf(outcome, "check").join("\n")).toContain(
      "The report gives the rate as 38.6%, not 36.8%.",
    );
  });

  test("keeps no key: only the model's words and its calls", async () => {
    const outcome = await checked(
      SPRING,
      { verdict: "supported", quote: "Spring tides happen at new moon", says: "It says so." },
      [TIDES],
    );

    expect(outcome.verdict).toBe("supported");
    expect(outcome.judge?.length).toBeGreaterThan(1);
    expect(JSON.stringify(outcome)).not.toContain("sk-synthetic-test-key");
    expect(JSON.stringify(outcome)).not.toMatch(/api[-_]?key|authorization|bearer/i);
  });
});

describe("Why a sentence came back Not checked", () => {
  const request = (
    text: string,
    calls: JudgeRequest["calls"] = [],
    kind = "check",
  ): JudgeRequest => ({
    kind,
    part: null,
    calculateAsked: false,
    reply: text,
    calls,
  });
  const turnedAway = {
    tool: "cite",
    input: '{"citations":[{"marker":1,"quote":"Spring tides happen twice a year"}]}',
    result:
      "Recorded [^1]. Fix these with another cite call:\n- [^1]: the quote isn't word for word in P1; copy it exactly, and check where it is.",
  };
  const recorded = {
    tool: "cite",
    input: '{"citations":[{"marker":1,"quote":"Net debt was £1,234m"}]}',
    result: "Recorded [^1]. Write the Answer now if you haven't yet; don't repeat it.",
  };
  const worked = {
    tool: "calculate",
    input: '{"figures":[{"marker":1,"formula":"nd / e"}]}',
    result: "Recorded [=1] = 1.31x (Net debt to EBITDA: £1,234m ÷ £942m).",
  };

  test("malformed is the core's own reason, whatever was replied", () => {
    expect(causeOf("malformed", [request("Perhaps.")])).toBe("malformed");
    expect(causeOf("malformed", undefined)).toBe("malformed");
  });

  test("a verdict whose quote the app turned away is a quote not found", () => {
    expect(
      causeOf("no-evidence", [request("Verdict: supported\nEvidence: [1]", [turnedAway])]),
    ).toBe("quote-not-found");
    expect(causeOf("no-evidence", undefined)).toBe("quote-not-found");
  });

  test("a number no quote gives, as the core names it, is a calculation not made (#3022)", () => {
    expect(causeOf("number-unquoted", undefined)).toBe("calculation-not-made");
    expect(causeOf("number-not-worked-out", undefined)).toBe("calculation-not-made");
  });

  test("a quote not found is the cause first, whatever else was asked of the judge", () => {
    expect(
      causeOf("no-evidence", [
        request("Verdict: supported\nCalculation: 1.3x", [turnedAway, worked]),
        { ...request("Verdict: supported"), calculateAsked: true },
      ]),
    ).toBe("quote-not-found");
  });

  test("a quote the app took after turning one away is no cause", () => {
    expect(
      causeOf("no-evidence", [
        request("", [turnedAway]),
        request("Verdict: supported\nCalculation: 1.3x", [recorded]),
      ]),
    ).toBe("calculation-not-made");
  });

  test("a calculate call with no usable figure from it, turned away or recorded, is a calculation not made", () => {
    const attempt = (result: string) => [
      request("Verdict: supported", [{ tool: "calculate", input: '{"figures":[]}', result }]),
    ];
    expect(
      causeOf(
        "no-evidence",
        attempt(
          "Nothing was recorded. Fix these with another calculate call:\n- give each figure with its marker, inputs and formula.",
        ),
      ),
    ).toBe("calculation-not-made");
    expect(causeOf("no-evidence", attempt(worked.result))).toBe("calculation-not-made");
  });

  test("a reply that names a calculation it never made is a calculation not made", () => {
    expect(
      causeOf("no-evidence", [request("Verdict: supported\nCalculation: 1.3x\nIt says so.")]),
    ).toBe("calculation-not-made");
    expect(
      causeOf("no-evidence", [request("Verdict: supported\nCalculation: none\nIt says so.")]),
    ).toBe("quote-not-found");
  });

  test("a check the app sent back to calculate, and that never did, is a calculation not made", () => {
    expect(
      causeOf("no-evidence", [
        request("Verdict: supported"),
        { ...request("Verdict: supported"), calculateAsked: true },
      ]),
    ).toBe("calculation-not-made");
  });

  test("every other reason the core gives is other", () => {
    for (const code of ["refused", "empty", "failed", "rate-limit", "unread", undefined]) {
      expect(causeOf(code, [request("")])).toBe("other");
    }
  });

  test("counts each cause of the Not checked", () => {
    const counts: CauseCounts = countCauses([
      { code: "no-evidence" },
      { code: "no-evidence", judge: [request("Verdict: supported\nCalculation: 1.3x")] },
      { code: "malformed" },
      { code: "refused" },
      { code: "failed" },
    ]);

    expect(counts).toEqual({
      "quote-not-found": 1,
      "calculation-not-made": 1,
      malformed: 1,
      other: 2,
    });
  });
});
