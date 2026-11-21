/**
 * The checks evaluation keeps every reply the judge gave, with its Tool calls, beside each
 * outcome (#2910), and tells why a sentence came back Not checked: through a core with a
 * scripted model that gives literal replies, so a change to the wording the evaluation reads
 * the core's requests by fails here.
 */
import { describe, expect, test } from "vitest";
import { type CauseCounts, causeOf, countCauses } from "../../eval/checks/lib/judge";
import { corePipeline } from "../../eval/checks/lib/pipeline";
import type { CheckOutcome } from "../../eval/checks/lib/scoring";
import { watchRequests } from "../../eval/repeats/requests";
import { checkingModel, type Plan } from "../helpers/checks";
import { type SourceFile, setUpWithDocuments } from "../helpers/citations";

const TIDES: SourceFile = {
  name: "Tides.md",
  contents: "# Tides\n\nSpring tides happen at new moon and at full moon.\n",
};

const SPRING = "Spring tides come at new moon.";

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
    expect(causeOf(outcome.code)).toBe("quote-not-found");
    // The search for the sentence was made for the model: its Passages are kept with its first request.
    const [cite] = callsOf(outcome);
    expect(outcome.judge?.[0]?.handed.map((passage) => passage.document)).toEqual(["Tides"]);
    expect(cite?.tool).toBe("cite");
    expect(cite?.input).toContain("Spring tides happen twice a year");
    expect(cite?.result).toContain("the quote isn't word for word");
    expect(repliesOf(outcome, "check")).toEqual([
      "Verdict: supported\nExplanation: It says so. [^1]\nEvidence: [1]",
    ]);
  });

  test("a reply with no verdict is malformed, and is kept as it was given", async () => {
    const outcome = await checked(SPRING, { reply: { text: "It reads well to me." } }, [TIDES]);

    expect(outcome).toMatchObject({ verdict: "not-checked", code: "malformed" });
    expect(causeOf(outcome.code)).toBe("malformed");
    expect(repliesOf(outcome, "check")).toEqual(["It reads well to me."]);
  });

  test("a refusal counts as other", async () => {
    const outcome = await checked(
      SPRING,
      { reply: { text: "I'm sorry, I can't help with that." } },
      [TIDES],
    );

    expect(outcome).toMatchObject({ verdict: "not-checked", code: "refused" });
    expect(causeOf(outcome.code)).toBe("other");
  });

  test("an explanation asked for again in the interface's language is its own request", async () => {
    const outcome = await checked(
      "比率是 36.8%。",
      {
        verdict: "contradicted",
        quote: "The rate is 38.6%.",
        says: "The report gives the rate as 38.6%, not 36.8%.",
        change: { from: "36.8%", to: "38.6%" },
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
  test("malformed is the core's own reason", () => {
    expect(causeOf("malformed")).toBe("malformed");
  });

  test("a verdict with no quote the Citation check found is a quote not found", () => {
    expect(causeOf("no-evidence")).toBe("quote-not-found");
  });

  test("every other reason the core gives is other", () => {
    for (const code of ["refused", "empty", "failed", "rate-limit", "unread", undefined]) {
      expect(causeOf(code)).toBe("other");
    }
  });

  test("counts each cause of the Not checked", () => {
    const counts: CauseCounts = countCauses([
      { code: "no-evidence" },
      { code: "no-evidence" },
      { code: "malformed" },
      { code: "refused" },
      { code: "failed" },
    ]);

    expect(counts).toEqual({ "quote-not-found": 2, malformed: 1, other: 2 });
  });
});
